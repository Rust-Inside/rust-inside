import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import schema from '../../rust-inside.schema.json' with { type: 'json' };

const supported = new Set(schema.definitions.valueType.enum);
const tool = fileURLToPath(new URL('./discover/', import.meta.url));
const defaultTarget = fileURLToPath(new URL('../../target/sdk-tools/', import.meta.url));
const reserved = new Set('arguments await break case catch class const continue debugger default delete do else enum eval export extends false finally for function if implements import in instanceof interface let new null package private protected public return static super switch this throw true try typeof var void while with yield then initSync'.split(' '));
const objectMembers = new Set(['constructor', 'free', 'close', 'destroy']);
const selectors = schema.definitions.export.properties.platforms.items.enum;

export function selectedPlatforms(labels, context) {
  if (!Array.isArray(labels) || labels.length === 0) throw new Error(`${context}: platforms must be a nonempty array`);
  if (new Set(labels).size !== labels.length) throw new Error(`${context}: duplicate platform selector`);
  const result = new Set();
  for (const label of labels) {
    if (!selectors.includes(label)) throw new Error(`${context}: unknown platform ${JSON.stringify(label)}; choose ${selectors.join(', ')}`);
    if (label === 'app') {
      for (const target of ['ios', 'android', 'flutter']) result.add(target);
    } else {
      result.add(label === 'server' ? 'backend' : label);
    }
  }
  return [...result];
}

function sdkName(name) {
  if (!/^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/.test(name)) throw new Error(`Expected a portable snake_case SDK identifier: ${name}`);
  const camel = name.replace(/_([a-z0-9])/g, (_, c) => c.toUpperCase());
  if (reserved.has(camel)) throw new Error(`Reserved SDK identifier: ${name}`);
  return camel;
}

function addName(names, name, context) {
  if (names.has(name)) throw new Error(`Conflicting SDK name ${name} in ${context}`);
  names.add(name);
}

function checkValue(type, context, types = supported) {
  if (!types.has(type)) throw new Error(`Unsupported SDK type ${type} for ${context}`);
}

function checkArgs(args, context, types = supported) {
  const names = new Set();
  for (const [name, type] of Object.entries(args)) {
    addName(names, sdkName(name), context);
    checkValue(type, `${context}.${name}`, types);
  }
}

function checkApi(api, rpc) {
  const namespace = new Set(['RustInsideCallError', ...supported]);
  const records = new Set(api.records.map(record => record.name));
  const enums = rpc ? api.enums : [];
  const fields = rpc ? new Set([...supported, ...enums.map(item => item.name)]) : supported;
  const functionTypes = rpc ? new Set([...fields, ...records]) : supported;
  for (const item of [...api.records, ...api.clients, ...enums]) {
    if (!/^[A-Z][A-Za-z0-9]*$/.test(item.name)) throw new Error(`Expected a portable SDK type name: ${item.name}`);
    addName(namespace, item.name, 'the API module');
  }
  for (const item of enums) {
    if (item.platforms) item.platforms = selectedPlatforms(item.platforms, item.name);
    for (const variant of item.variants) {
      if (!/^[A-Z][A-Za-z0-9]*$/.test(variant)) throw new Error(`Expected a portable RPC enum case: ${item.name}::${variant}`);
    }
  }
  for (const fn of api.exports) {
    if (fn.platforms) fn.platforms = selectedPlatforms(fn.platforms, fn.name);
    fn.jsName = sdkName(fn.name);
    addName(namespace, fn.jsName, 'the API module');
    checkArgs(fn.args, fn.name, functionTypes);
    if (fn.returns !== '()') checkValue(fn.returns, fn.name, functionTypes);
  }
  for (const record of api.records) {
    if (record.platforms) record.platforms = selectedPlatforms(record.platforms, record.name);
    const names = new Set(objectMembers);
    for (const field of record.fields) {
      addName(names, sdkName(field.name), record.name);
      checkValue(field.type, `${record.name}.${field.name}`, fields);
    }
  }
  for (const client of api.clients) {
    if (client.traitName !== undefined && !/^[A-Z][A-Za-z0-9]*$/.test(client.traitName)) throw new Error(`Expected a portable SDK trait name: ${client.traitName}`);
    checkArgs(client.constructor.args, client.name);
    const methods = new Set(objectMembers);
    for (const method of client.methods) {
      if (method.platforms) method.platforms = selectedPlatforms(method.platforms, `${client.name}.${method.name}`);
      method.jsName = sdkName(method.name);
      addName(methods, method.jsName, client.name);
      checkArgs(method.args, method.name);
      if (!records.has(method.returns)) throw new Error(`${client.name}::${method.name}: declare record ${method.returns} in the SDK API file`);
    }
  }
  return api;
}

// Build the discovery tool in its own workspace for the host. A producer can have
// a different default target (for example wasm32) and independent Cargo.lock.
export function discoverApi(apiFile, crateLibFile, { rpc = false, allowEmpty = false } = {}) {
  const options = { cwd: tool, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 };
  const host = execFileSync('rustc', ['--print', 'host-tuple'], options).trim();
  const targetDir = resolve(process.env.CARGO_TARGET_DIR || defaultTarget);
  const json = execFileSync('cargo', [
    'run', '--quiet', '--locked', '--target', host, '--target-dir', targetDir, '--', resolve(apiFile),
    ...(crateLibFile ? [resolve(crateLibFile)] : []),
    ...(rpc ? ['--rpc'] : []),
    ...(allowEmpty ? ['--allow-empty'] : []),
  ], options);
  return checkApi(JSON.parse(json), rpc);
}
