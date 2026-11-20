import { execFileSync, spawnSync } from 'node:child_process';
import { copyFile, lstat, mkdir, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { repositoryName, requireBackend } from './distribute.mjs';
import { discoverApi, selectedPlatforms } from './discover-api.mjs';
import { rpcWrapperSource, wrapperSource } from './wrapper-source.mjs';

const platforms = ['backend', 'ios', 'android', 'flutter', 'web'];
const scalarTypes = ['bool', 'i8', 'u8', 'i16', 'u16', 'i32', 'u32', 'i64', 'u64', 'f32', 'f64', 'String'];
const types = new Set([...scalarTypes, 'Vec<u8>', 'Vec<u32>', 'Vec<String>']);
const rustKeywords = new Set(('as break const continue crate else enum extern false fn for if impl in let loop match mod move mut pub ref return self Self static struct super trait true type unsafe use where while async await dyn abstract become box do final gen macro override priv typeof unsized virtual yield try _').split(' '));
const jsReserved = new Set(('await break case catch class const continue debugger default delete do else enum export extends false finally for function if implements import in instanceof interface let new null package private protected public return static super switch this throw true try typeof var void while with yield arguments eval then initSync').split(' '));
const snake = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/;
const identifier = /^[A-Za-z_][A-Za-z_0-9]*$/;
const apiName = /^[A-Za-z_][A-Za-z_0-9]*(?:\.[A-Za-z_][A-Za-z_0-9]*)?$/;
const capitalize = word => word.charAt(0).toUpperCase() + word.slice(1);
const camel = name => name.replace(/_([a-z0-9])/g, (_, next) => next.toUpperCase());

function object(value, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Expected ${label} to be an object`);
  }
  return value;
}

function fields(value, keys, label) {
  const typo = Object.keys(object(value, label)).find(key => !keys.includes(key));
  if (typo !== undefined) throw new Error(`Unknown ${label} field: ${typo}`);
}

function uniqueName(names, name, label) {
  if (names.has(name)) throw new Error(`Duplicate ${label} name: ${name}`);
  names.add(name);
}

function validateRequirements(requirements, destinations) {
  fields(requirements, platforms, 'requiredApi');
  for (const [platform, names] of Object.entries(requirements)) {
    if (!Array.isArray(names) || !names.length || new Set(names).size !== names.length ||
        names.some(name => typeof name !== 'string' || !apiName.test(name))) {
      throw new Error(`requiredApi.${platform} must list unique SDK names such as report or AccountClient.getMe`);
    }
    if (!destinations.includes(platform)) {
      throw new Error(`requiredApi.${platform} lists ${names.join(', ')} but ${platform} is not a generation target`);
    }
  }
}

export function parseManifest(input, { rpc = false } = {}) {
  fields(input, ['$schema', 'crate', 'name', 'backend', 'repositories', 'exports', 'api', 'uniffi', 'requiredApi'], 'manifest');
  if (input.$schema !== undefined && (typeof input.$schema !== 'string' || input.$schema.length === 0)) {
    throw new Error('$schema must be a nonempty reference to the manifest schema');
  }
  const crate = input.crate ?? 'Cargo.toml';
  if (typeof crate !== 'string' || isAbsolute(crate) || basename(crate) !== 'Cargo.toml') {
    throw new Error('crate must point to a relative library Cargo.toml');
  }
  if (input.name !== undefined && (typeof input.name !== 'string' || !/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(input.name))) {
    throw new Error('The SDK name must start with a letter and use lowercase kebab-case');
  }
  const backend = requireBackend(input.backend);
  const destinations = input.repositories ?? {};
  fields(destinations, platforms, 'repositories');
  if (backend === 'rust' && destinations.backend != null) {
    throw new Error('Omit repositories.backend or set it to null for backend "rust": Cargo consumes the core repository directly');
  }
  const repositories = {};
  for (const [platform, destination] of Object.entries(destinations)) {
    if (destination == null) continue;
    if (typeof destination !== 'string') throw new Error(`Expected repositories.${platform} to be a GitHub repository or null`);
    repositories[platform] = repositoryName(destination);
  }
  if (input.uniffi !== undefined) {
    if (input.requiredApi !== undefined) throw new Error('requiredApi does not support existing UniFFI bindings');
    fields(input.uniffi, ['crate'], 'uniffi');
    if (['exports', 'api', 'name', 'crate'].some(key => key in input)) {
      throw new Error('uniffi uses the public API and module name of its own crate; omit api, exports, name and top-level crate');
    }
    const manifest = input.uniffi.crate;
    if (typeof manifest !== 'string' || isAbsolute(manifest) || basename(manifest) !== 'Cargo.toml') {
      throw new Error('uniffi.crate must point to a relative Cargo.toml');
    }
    if (Object.keys(repositories).some(platform => platform !== 'ios')) {
      throw new Error('Existing UniFFI bindings currently support only an iOS package destination');
    }
    return { uniffi: true, crate: manifest, backend, repositories };
  }
  const config = { crate, name: input.name, backend, repositories };
  if (input.requiredApi !== undefined) {
    validateRequirements(input.requiredApi, rpc ? ['ios', 'backend'] : Object.keys(repositories));
    config.requiredApi = input.requiredApi;
  }
  if (input.api !== undefined) {
    if (input.exports !== undefined) throw new Error('Choose exactly one of api or exports');
    if (typeof input.api !== 'string' || isAbsolute(input.api) || !input.api.endsWith('.rs')) {
      throw new Error('api must point to a Rust source file relative to the library Cargo.toml');
    }
    return { ...config, api: input.api };
  }
  if (!Array.isArray(input.exports) || !input.exports.length) throw new Error('Specify api or declare at least one function in exports');
  const names = new Set();
  const exports = input.exports.map((entry, index) => {
    fields(entry, ['path', 'name', 'args', 'returns', 'platforms'], `exports[${index}]`);
    const path = entry.path;
    if (typeof path !== 'string' || !path.split('::').every(part => identifier.test(part) && !rustKeywords.has(part))) {
      throw new Error(`exports[${index}].path must be a public Rust path relative to the library root`);
    }
    const name = entry.name ?? path.split('::').at(-1);
    if (typeof name !== 'string' || !snake.test(name) || rustKeywords.has(name) || jsReserved.has(camel(name))) {
      throw new Error(`Choose a portable snake_case export name for ${path} (use the name field to rename it)`);
    }
    const jsName = camel(name);
    uniqueName(names, jsName, 'export');
    const parameters = entry.args === undefined ? [] : entry.args;
    if (!Array.isArray(parameters)) throw new Error(`${path}.args must be an ordered array of {name, type} parameters`);
    const argNames = new Set();
    const args = Object.fromEntries(parameters.map(parameter => {
      fields(parameter, ['name', 'type'], `${path} parameter`);
      const { name: arg, type } = parameter;
      if (typeof arg !== 'string' || !snake.test(arg) || rustKeywords.has(arg)) throw new Error(`Invalid argument name on ${path}: ${arg}`);
      uniqueName(argNames, camel(arg), `${path} argument`);
      if (!types.has(type)) throw new Error(`Unsupported type for ${path}.${arg}: ${type}`);
      return [arg, type];
    }));
    const returns = entry.returns === undefined ? '()' : entry.returns;
    if (!types.has(returns) && returns !== '()') throw new Error(`Unsupported return type for ${path}: ${returns}`);
    const api = { path, name, jsName, args, returns };
    if (entry.platforms !== undefined) api.platforms = selectedPlatforms(entry.platforms, path);
    return api;
  });
  return { ...config, exports };
}

function packageNames(crate) {
  const name = crate.replace(/([A-Z])([A-Z][a-z])/g, '$1-$2').replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .toLowerCase().replace(/[_-]+/g, '-').replace(/^-|-$/g, '');
  if (!/^[a-z][a-z0-9-]*$/.test(name)) throw new Error(`Cannot derive portable SDK package names from Cargo package ${crate}`);
  const stem = name.replaceAll('-', '_');
  return {
    name, module: name.split('-').map(capitalize).join('') + 'SDK',
    library: stem + '_sdk', kotlinPackage: `dev.rustinside.${stem}sdk`,
    flutterLibrary: stem + '_flutter', flutterPackage: stem + '_flutter',
    wasmLibrary: stem + '_wasm_sdk', mobilePackage: name + '-mobile-sdk', wasmPackage: name + '-wasm-sdk',
  };
}

function runCargo(args, cwd, options = {}) {
  return execFileSync('cargo', args, { cwd, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, ...options });
}

// Cargo reads these sections only from a workspace root. Preserve the producer's
// resolver overrides and compilation profiles when building a separate wrapper workspace.
function workspaceSettings(root, output) {
  const script = fileURLToPath(new URL('./workspace-settings.py', import.meta.url));
  return execFileSync('python3', [script, root, output], { encoding: 'utf8' });
}

function bindingsForPlatform(api, platform) {
  const visible = item => !item.platforms || item.platforms.includes(platform);
  const exports = api.exports.filter(visible);
  if (!api.clients) return { exports };
  const clients = api.clients.map(client => ({ ...client, methods: client.methods.filter(visible) }))
    .filter(client => client.methods.length);
  const returnTypes = list => new Set(list.flatMap(client => client.methods.map(method => method.returns)));
  const used = returnTypes(api.clients);
  const exposed = returnTypes(clients);
  const records = api.records.filter(record => exposed.has(record.name) || (!used.has(record.name) && visible(record)));
  return { exports, clients, records };
}

function checkRequiredApi(platform, required, surface) {
  if (!required?.length) return;
  const names = new Set(surface.exports.map(fn => fn.jsName));
  for (const client of surface.clients ?? []) {
    for (const method of client.methods) names.add(`${client.name}.${method.jsName}`);
  }
  const missing = required.filter(name => !names.has(name));
  if (missing.length) throw new Error(`Required API missing from ${platform} SDK: ${missing.join(', ')}`);
}

function warnEmptySdk(platform) {
  const message = `${platform} is configured for release but has no public API. Skipping its package.`;
  if (process.env.GITHUB_ACTIONS === 'true') console.log(`::warning::${message}`);
  else console.warn(`Warning: ${message}`);
}

function adapterFor(platform, backend) {
  if (platform === 'flutter') return 'flutter';
  if (platform === 'web' || (platform === 'backend' && backend === 'node')) return 'wasm';
  return 'mobile';
}

async function writeWorkspace(out, members, sdk, crateDirectory, workspaceRoot) {
  await mkdir(out, { recursive: true });
  const asyncClients = Boolean(sdk.clients?.length);
  const settings = workspaceSettings(workspaceRoot, out);
  const dependency = path => `sdk_core = { package = ${JSON.stringify(sdk.corePackage)}, path = ${JSON.stringify(relative(path, crateDirectory))} }`;
  await writeFile(join(out, 'Cargo.toml'), `[workspace]\nmembers = ${JSON.stringify(members)}\n${settings}`);
  for (const platform of members) {
    const mobile = platform === 'mobile';
    const directory = join(out, platform);
    await mkdir(join(directory, 'src'), { recursive: true });
    if (platform === 'flutter') {
      const { flutterNativeSource } = await import('./flutter-source.mjs');
      const manifest = [
        '[package]', `name = "${sdk.name}-flutter-sdk"`, 'version = "0.0.0"', 'edition = "2024"', 'publish = false',
        '', '[lib]', `name = "${sdk.flutterLibrary}"`, 'crate-type = ["cdylib"]',
        '', '[dependencies]', dependency(directory), 'serde_json = "1"',
      ];
      if (asyncClients) manifest.push('tokio = { version = "1", features = ["rt-multi-thread", "time", "net"] }');
      await writeFile(join(directory, 'Cargo.toml'), manifest.join('\n') + '\n');
      await writeFile(join(directory, 'src/lib.rs'), flutterNativeSource(sdk));
      continue;
    }
    const cargo = [
      '[package]', `name = "${mobile ? sdk.mobilePackage : sdk.wasmPackage}"`,
      'version = "0.0.0"', 'edition = "2024"', 'publish = false', '',
      '[lib]', `name = "${mobile ? sdk.library : sdk.wasmLibrary}"`,
      mobile ? 'crate-type = ["cdylib", "staticlib", "rlib"]' : 'crate-type = ["cdylib"]', '',
      '[dependencies]', dependency(directory),
    ];
    if (mobile) {
      if (asyncClients) cargo.push('uniffi = { version = "=0.32.2", features = ["tokio"] }', 'thiserror = "2"');
      else cargo.push('uniffi = "=0.32.2"');
      cargo.push('', '[features]', 'bindgen = ["uniffi/cli"]', '', '[[bin]]',
        'name = "rust-inside-bindgen"', 'path = "src/bin/bindgen.rs"', 'required-features = ["bindgen"]');
      await mkdir(join(directory, 'src/bin'));
      await writeFile(join(directory, 'src/bin/bindgen.rs'), 'fn main() {\n    uniffi::uniffi_bindgen_main();\n}\n');
      await writeFile(join(directory, 'uniffi.toml'), [
        '[bindings.swift]', `module_name = "${sdk.module}"`, `ffi_module_name = "${sdk.module}FFI"`, '',
        '[bindings.kotlin]', `package_name = "${sdk.kotlinPackage}"`, `cdylib_name = "${sdk.library}"`, '',
      ].join('\n'));
    } else {
      cargo.push('wasm-bindgen = "=0.2.130"');
      if (asyncClients) cargo.push('wasm-bindgen-futures = "=0.4.80"');
    }
    await writeFile(join(directory, 'Cargo.toml'), cargo.join('\n') + '\n');
    await writeFile(join(directory, 'src/lib.rs'), sdk.rpc ? rpcWrapperSource(sdk) : wrapperSource(sdk, mobile));
  }

  try {
    await copyFile(join(workspaceRoot, 'Cargo.lock'), join(out, 'Cargo.lock'));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  runCargo(['update', '--workspace', '--manifest-path', join(out, 'Cargo.toml')], crateDirectory, { stdio: 'inherit' });
  await writeFile(join(out, 'sdk.json'), JSON.stringify(sdk, null, 2) + '\n');
}

export async function generate(manifestFile, outputDirectory, { rpc = false } = {}) {
  const manifestPath = await realpath(manifestFile);
  const config = parseManifest(JSON.parse(await readFile(manifestPath, 'utf8')), { rpc });
  if (rpc && (config.backend !== 'jvm' || !config.api)) {
    throw new Error('RPC generation requires backend "jvm" and a Rust api file');
  }
  if (!rpc && !Object.keys(config.repositories).length) return null;
  const crateFile = await realpath(resolve(dirname(manifestPath), config.crate));
  const crateDirectory = dirname(crateFile);
  const metadata = JSON.parse(runCargo(['metadata', '--no-deps', '--format-version', '1', '--manifest-path', crateFile], crateDirectory));
  const producer = metadata.packages.find(pkg => pkg.manifest_path === crateFile);
  await mkdir(outputDirectory, { recursive: true });
  const out = await realpath(outputDirectory);
  if ((await readdir(out)).length) throw new Error(`Choose an empty directory for generated Rust Inside bindings: ${out}`);
  // Keep the producer's notice with the bindings as they move between CI runners.
  const gitRoot = spawnSync('git', ['rev-parse', '--show-toplevel'], { cwd: dirname(manifestPath), encoding: 'utf8' });
  const sourceRoot = gitRoot.status === 0 ? gitRoot.stdout.trimEnd() : dirname(manifestPath);
  const license = join(sourceRoot, 'LICENSE');
  const licenseFile = await lstat(license).catch(error => {
    if (error.code !== 'ENOENT') throw error;
  });
  if (licenseFile?.isFile()) await copyFile(license, join(out, 'LICENSE'));
  if (config.uniffi) {
    const types = producer?.targets.flatMap(target => target.crate_types) ?? [];
    if (!types.includes('staticlib')) {
      throw new Error('The UniFFI crate must produce a staticlib library for iOS');
    }
    const sdk = {
      name: producer.name, corePackage: producer.name, backend: config.backend, repositories: config.repositories,
      uniffiManifest: relative(out, crateFile), exports: [],
    };
    await writeFile(join(out, 'sdk.json'), JSON.stringify(sdk, null, 2) + '\n');
    return sdk;
  }
  const libraryTarget = producer?.targets.find(target => target.crate_types.some(type => type === 'lib' || type === 'rlib'));
  if (!libraryTarget) {
    throw new Error(`${config.crate} must identify a Rust library crate with a lib or rlib target`);
  }

  const api = config.api
    ? discoverApi(await realpath(resolve(crateDirectory, config.api)), libraryTarget.src_path, { rpc, allowEmpty: !rpc || Boolean(config.requiredApi) })
    : { exports: config.exports };

  const names = packageNames(config.name ?? producer.name);
  const describe = (surface, repositories) => {
    const requiredApi = Object.fromEntries(Object.entries(config.requiredApi ?? {})
      .filter(([platform]) => Object.hasOwn(repositories, platform)));
    return {
      ...names, corePackage: producer.name, backend: config.backend, repositories,
      exports: surface.exports,
      ...(surface.clients ? { clients: surface.clients, records: surface.records } : {}),
      ...(surface.clients?.length ? { kotlinCoroutinesVersion: '1.7.3' } : {}),
      ...(Object.keys(requiredApi).length ? { requiredApi } : {}),
    };
  };
  if (rpc) {
    const exports = api.exports.filter(fn => fn.platforms?.length === 1 && fn.platforms[0] === 'backend');
    for (const [platform, required] of Object.entries(config.requiredApi ?? {})) {
      checkRequiredApi(platform, required, { exports });
    }
    if (!exports.length) throw new Error('Declare at least one public RPC function with #[rust_inside::server]');
    const scalarTypes = new Set(['i32', 'i64', 'String']);
    const selected = new Set(exports.flatMap(fn => [...Object.values(fn.args), fn.returns]));
    const records = api.records.filter(record => selected.has(record.name));
    for (const record of records) {
      for (const field of record.fields) selected.add(field.type);
    }
    const enums = api.enums.filter(item => selected.has(item.name));
    if (enums.some(item => item.name === 'RpcContext')) {
      throw new Error('RpcContext must be a record of server-supplied fields');
    }
    const values = new Set([...scalarTypes, ...enums.map(item => item.name)]);
    for (const { name, fields } of records) {
      const unsupported = fields.find(field => !values.has(field.type));
      if (unsupported) throw new Error(`Unsupported RPC field type ${unsupported.type} for ${name}.${unsupported.name}`);
    }
    const types = new Set([...values, ...records.map(record => record.name)]);
    for (const fn of exports) {
      const args = Object.values(fn.args);
      if (![...args, fn.returns].every(type => types.has(type))) {
        throw new Error(`Unsupported RPC argument or return type for ${fn.name}`);
      }
      if (args.filter(type => type === 'RpcContext').length > 1 || fn.returns === 'RpcContext') {
        throw new Error(`${fn.name}: RpcContext is available once as a server-supplied argument`);
      }
    }
    const context = records.find(record => record.name === 'RpcContext');
    if (context && (context.fields.length !== 2 || !['principal', 'request_id'].every(name =>
      context.fields.some(field => field.name === name && field.type === 'String')))) {
      throw new Error('RpcContext must declare public String fields principal and request_id');
    }
    const sdk = {
      ...describe({ exports }, {}), rpc: true, records, enums, version: producer.version,
      ...(Object.keys(config.requiredApi ?? {}).length ? { requiredApi: config.requiredApi } : {}),
    };
    await writeWorkspace(out, ['mobile'], sdk, crateDirectory, metadata.workspace_root);
    return sdk;
  }
  const scoped = api.exports.some(fn => fn.platforms) || api.records?.some(record => record.platforms) ||
    api.clients?.some(client => client.methods.some(method => method.platforms));
  const surfaces = Object.keys(config.repositories).map(platform => [platform, bindingsForPlatform(api, platform)]);
  for (const [platform, surface] of surfaces) {
    checkRequiredApi(platform, config.requiredApi?.[platform], surface);
  }
  const repositories = {};
  const shared = new Set();
  for (const [platform, surface] of surfaces) {
    if (!surface.exports.length && !surface.clients?.length) {
      warnEmptySdk(platform);
      continue;
    }
    const repository = config.repositories[platform];
    repositories[platform] = repository;
    const adapter = adapterFor(platform, config.backend);
    if (scoped || platform === 'flutter') {
      const target = describe(surface, { [platform]: repository });
      // Two scoped adapters can target the same architecture and Cargo target directory.
      if (adapter === 'mobile') target.library += '_' + platform;
      if (adapter === 'wasm') target.wasmLibrary += '_' + platform;
      const platformDirectory = join(out, 'platforms', platform);
      await writeWorkspace(platformDirectory, [adapter], target, crateDirectory, metadata.workspace_root);
      if (licenseFile?.isFile()) await copyFile(join(out, 'LICENSE'), join(platformDirectory, 'LICENSE'));
    } else {
      shared.add(adapter);
    }
  }
  const sdk = describe(api, repositories);
  if (shared.size) {
    // Projects with a common API keep their shared lockfile and adapter layout.
    await writeWorkspace(out, ['mobile', 'wasm'].filter(member => shared.has(member)), sdk, crateDirectory, metadata.workspace_root);
  } else {
    await writeFile(join(out, 'sdk.json'), JSON.stringify(sdk, null, 2) + '\n');
  }
  return sdk;
}

if (import.meta.main ?? (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))) {
  if (process.argv.length !== 4) {
    console.error('Usage: node scripts/sdk/generate.mjs <rust-inside.json> <empty output directory>');
    process.exitCode = 1;
  } else {
    generate(process.argv[2], process.argv[3]).then(sdk => {
      if (!sdk) {
        console.log('No package repositories selected. Skipping SDK generation.');
        return;
      }
      const packages = Object.keys(sdk.repositories);
      console.log(packages.length
        ? `Generated ${sdk.name} bindings for ${packages.join(', ')}`
        : 'No public API matches the selected package destinations.');
    }).catch(error => {
      console.error(error.message);
      process.exitCode = 1;
    });
  }
}
