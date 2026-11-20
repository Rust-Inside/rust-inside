import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { generate, parseManifest } from './generate.mjs';

const repositories = { backend: 'team/backend', ios: 'team/ios', android: 'https://github.com/team/android.git', web: 'team/web' };
const contract = { backend: 'node', repositories, exports: [{ path: 'domain::freight', name: 'shipping_cost', args: [{ name: 'grams', type: 'u32' }], returns: 'u32' }] };

test('an existing UniFFI package keeps its own Cargo target and relocates with the source checkout', async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'rust-inside-uniffi-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, 'source');
  const crate = join(source, 'interfaces', 'Cargo.toml');
  await mkdir(join(source, 'interfaces', 'src'), { recursive: true });
  await writeFile(crate, '[package]\nname="unit-converter"\nversion="0.1.0"\nedition="2024"\n[lib]\nname="units"\ncrate-type=["staticlib"]\n');
  await writeFile(join(source, 'interfaces', 'src', 'lib.rs'), '');
  const manifest = join(source, 'rust-inside.json');
  await writeFile(manifest, JSON.stringify({ backend: 'rust', uniffi: { crate: 'interfaces/Cargo.toml' }, repositories: { ios: 'weather/units-ios' } }));
  const out = join(root, 'generated');
  await generate(manifest, out);
  const sdk = JSON.parse(await readFile(join(out, 'sdk.json'), 'utf8'));
  assert.equal(resolve(out, sdk.uniffiManifest), crate);
  assert.equal(sdk.corePackage, 'unit-converter');
  assert.deepEqual(sdk.repositories, { ios: 'weather/units-ios' });
  assert.deepEqual(await readdir(out), ['sdk.json']);
});

test('validates portable export names, signatures and every destination before generation', () => {
  const parsed = parseManifest(contract);
  assert.equal(parsed.crate, 'Cargo.toml');
  assert.equal(parsed.backend, 'node');
  assert.equal(parseManifest({ ...contract, $schema: './rust-inside.schema.json' }).backend, 'node');
  assert.equal(parseManifest({ ...contract, backend: 'jvm' }).backend, 'jvm');
  const { backend, ...clients } = repositories;
  const rust = parseManifest({ ...contract, backend: 'rust', repositories: clients });
  assert.equal(rust.backend, 'rust');
  assert.equal(Object.hasOwn(rust.repositories, 'backend'), false);
  assert.equal(parsed.exports[0].jsName, 'shippingCost');
  assert.equal(parsed.repositories.android, 'team/android');
  const { exports: _, ...fromRust } = contract;
  assert.equal(parseManifest({ ...fromRust, api: 'src/sdk.rs' }).api, 'src/sdk.rs');
  assert.throws(() => parseManifest({ ...contract, api: 'src/sdk.rs' }), /exactly one/);
  assert.throws(() => parseManifest({ ...fromRust, api: '/sdk.rs' }), /relative/);
  assert.throws(() => parseManifest({ ...fromRust, api: 'src/sdk.json' }), /Rust source/);
  for (const [overrides, expected] of [
    [{ exports: [] }, /at least one/],
    [{ name: 'other_project' }, /SDK name/],
    [{ backend: undefined }, /backend is required/],
    [{ backend: null }, /backend is required/],
    [{ backend: 'python' }, /backend is required/],
    [{ $schema: '' }, /nonempty reference/],
    [{ backendType: 'node' }, /Unknown manifest field/],
    [{ backend: 'rust' }, /Omit repositories.backend/],
    [{ exports: [{ path: 'a', args: { x: 'u32' } }] }, /ordered array/],
    [{ crate: '/Cargo.toml' }, /relative library/],
    [{ repositories: { ...repositories, backend: 'https:\/\/example.com/vendor' } }, /GitHub repository/],
    [{ exports: [{ path: 'run::<T>' }] }, /public Rust path/],
    [{ exports: [{ path: 'a', returns: 'Result<String, E>' }] }, /Unsupported return type/],
    [{ exports: [{ path: 'a', args: [{ name: 'input', type: '&str' }] }] }, /Unsupported type/],
    [{ exports: [{ path: 'a', args: [{ name: 'type', type: 'String' }] }] }, /Invalid argument/],
    [{ exports: [{ path: 'a', name: 'init_sync' }] }, /portable snake_case/],
    [{ exports: [{ path: 'a', name: 'cost2' }, { path: 'b', name: 'cost_2' }] }, /Duplicate export/],
    [{ exports: [{ path: 'a', comment: 'typo' }] }, /Unknown/],
    [{ requiredApi: null }, /requiredApi.*object/],
    [{ requiredApi: { ios: [] } }, /requiredApi\.ios.*unique SDK names/],
    [{ requiredApi: { ios: ['shippingCost', 'shippingCost'] } }, /requiredApi\.ios.*unique SDK names/],
    [{ requiredApi: { ios: ['Type::name'] } }, /requiredApi\.ios.*unique SDK names/],
    [{ requiredApi: { linux: ['shippingCost'] } }, /Unknown requiredApi field: linux/],
    [{ requiredApi: { flutter: ['shippingCost'] } }, /flutter.*shippingCost.*not a generation target/],
  ]) assert.throws(() => parseManifest({ ...contract, ...overrides }), expected);
});

test('only configured platforms get a repository', () => {
  const none = { backend: null, ios: null, android: null, web: null };
  for (const backend of ['node', 'jvm', 'rust']) {
    const manifest = { backend, api: 'src/api.rs' };
    assert.deepEqual(parseManifest(manifest).repositories, {});
    for (const destinations of [null, {}, none]) {
      assert.deepEqual(parseManifest({ ...manifest, repositories: destinations }).repositories, {});
    }
    const onlyWeb = { backend: null, ios: null, web: 'https://github.com/team/web.git' };
    assert.deepEqual(parseManifest({ ...manifest, repositories: onlyWeb }).repositories, { web: 'team/web' });
  }
  assert.deepEqual(parseManifest({ ...contract, repositories: { backend: 'team/backend' } }).repositories, { backend: 'team/backend' });
  for (const invalid of [false, 42, [], '', { android: '' }, { web: ' ' }, { ios: false }, { be: null }, { '': null }]) {
    assert.throws(() => parseManifest({ ...contract, repositories: invalid }), /repositor/i);
  }
});

test('rejects an omitted backend before accessing Cargo or building old SDK bindings', async t => {
  const base = await mkdtemp(join(tmpdir(), 'rust-inside-missing-backend-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const manifest = join(base, 'rust-inside.json');
  await writeFile(manifest, JSON.stringify({ repositories, exports: contract.exports }));
  await assert.rejects(generate(manifest, join(base, 'generated')), /backend is required/);

  await writeFile(join(base, 'sdk.json'), JSON.stringify({ name: 'example', wasmLibrary: 'example_wasm_sdk' }));
  const script = fileURLToPath(new URL('./build-js.sh', import.meta.url));
  assert.throws(() => execFileSync('bash', [script, base, '1.2.3', join(base, 'packages')], { stdio: 'pipe' }),
    error => error.status !== 0 && error.stderr.toString().includes('backend is required'));
});

test('an empty selection skips Cargo, API discovery and output creation', async t => {
  const checkout = await mkdtemp(join(tmpdir(), 'rust-inside-empty-'));
  t.after(() => rm(checkout, { recursive: true, force: true }));
  const manifest = join(checkout, 'rust-inside.json');
  await writeFile(manifest, JSON.stringify({ backend: 'jvm', api: 'src/api.rs', repositories: { web: null } }));
  const output = join(checkout, 'generated');
  assert.equal(await generate(manifest, output), null);
  const cli = fileURLToPath(new URL('./generate.mjs', import.meta.url));
  const log = execFileSync(process.execPath, [cli, manifest, output], { encoding: 'utf8' });
  assert.match(log, /Skipping SDK generation/);
  assert.deepEqual(await readdir(checkout), ['rust-inside.json']);
});

test('partial releases resolve only their selected adapter workspace members', async t => {
  const checkout = await mkdtemp(join(tmpdir(), 'rust-inside-single-adapter-'));
  t.after(() => rm(checkout, { recursive: true, force: true }));
  const root = join(checkout, 'core');
  await mkdir(join(root, 'src'), { recursive: true });
  await writeFile(join(root, 'Cargo.toml'), '[package]\nname = "cart"\nversion = "0.1.0"\nedition = "2024"\n');
  await writeFile(join(root, 'src/lib.rs'), 'pub fn size() -> u32 { 2 }\n');
  const manifest = join(root, 'rust-inside.json');
  for (const [backend, platform, adapter] of [
    ['node', 'backend', 'wasm'], ['jvm', 'web', 'wasm'], ['jvm', 'backend', 'mobile'],
    ['node', 'ios', 'mobile'], ['rust', 'android', 'mobile'],
  ]) {
    const output = join(checkout, backend + '-' + platform);
    const repositories = { [platform]: 'team/cart' };
    await writeFile(manifest, JSON.stringify({ backend, repositories, exports: [{ path: 'size', returns: 'u32' }] }));
    assert.deepEqual((await generate(manifest, output)).repositories, repositories);
    const other = adapter === 'mobile' ? 'wasm' : 'mobile';
    const entries = await readdir(output);
    assert.ok(entries.includes(adapter));
    assert.ok(!entries.includes(other));
    const metadata = JSON.parse(execFileSync('cargo', ['metadata', '--no-deps', '--locked', '--format-version', '1'], {
      cwd: output, encoding: 'utf8',
    }));
    assert.deepEqual(metadata.packages.map(pkg => pkg.name), [`cart-${adapter}-sdk`]);
    const lock = await readFile(join(output, 'Cargo.lock'), 'utf8');
    assert.ok(!lock.includes(`name = "cart-${other}-sdk"`));
    if (adapter === 'wasm') assert.ok(!lock.includes('name = "uniffi"'));
  }
});

test('generates relocatable wrappers for a workspace member with a custom library, patch and profile', async t => {
  const base = await mkdtemp(join(tmpdir(), 'rust-inside-generator-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const checkout = join(base, 'checkout');
  const core = join(checkout, 'services', 'rates');
  const patched = join(checkout, 'vendor', 'freight');
  const out = join(base, 'generated');
  await mkdir(core, { recursive: true });
  await mkdir(join(patched, 'src'), { recursive: true });
  await writeFile(join(checkout, 'Cargo.toml'), [
    '[workspace]', 'members = ["services/rates"]', 'exclude = ["vendor/freight"]', 'resolver = "3"',
    '[workspace.package]', 'version = "0.1.0"', '[patch.crates-io]', 'ri-freight = { path = "vendor/freight" }',
    '[profile.release]', 'overflow-checks = true',
  ].join('\n'));
  await writeFile(join(patched, 'Cargo.toml'), '[package]\nname = "ri-freight"\nversion = "0.1.0"\nedition = "2024"');
  await writeFile(join(patched, 'src/lib.rs'), 'pub fn charge(n: u32) -> u32 { n * 2 }');
  await writeFile(join(core, 'Cargo.toml'), [
    '[package]', 'name = "carrier-rates"', 'version.workspace = true', 'edition = "2024"',
    '[lib]', 'name = "pricing"', 'path = "engine.rs"', '[dependencies]', 'ri-freight = "0.1"',
  ].join('\n'));
  await writeFile(join(core, 'engine.rs'), [
    'pub mod domain { pub fn freight(grams: u32) -> u32 { ri_freight::charge(grams) } }',
    'pub fn initials(names: Vec<String>) -> Vec<u32> { names.iter().map(|s| s.len() as u32).collect() }',
    'pub fn overload(n: i64) -> i64 { n + 1 }',
    'pub fn ping() {}',
  ].join('\n'));
  await writeFile(join(checkout, 'rust-inside.json'), JSON.stringify({
    ...contract, name: 'freight-core', crate: 'services/rates/Cargo.toml',
    exports: [...contract.exports, { path: 'initials', args: [{ name: 'names', type: 'Vec<String>' }], returns: 'Vec<u32>' },
      { path: 'overload', args: [{ name: 'n', type: 'i64' }], returns: 'i64' }, { path: 'ping' }],
  }));
  const sdk = await generate(join(checkout, 'rust-inside.json'), out);
  assert.equal(sdk.module, 'FreightCoreSDK');
  assert.equal(sdk.corePackage, 'carrier-rates');
  assert.equal(sdk.backend, 'node');
  assert.equal(sdk.kotlinPackage, 'dev.rustinside.freight_coresdk');
  assert.equal(sdk.library, 'freight_core_sdk');
  assert.equal(sdk.kotlinCoroutinesVersion, undefined);
  assert.deepEqual(sdk, JSON.parse(await readFile(join(out, 'sdk.json'), 'utf8')));
  assert.match(await readFile(join(out, 'Cargo.lock'), 'utf8'), /name = "ri-freight"/);
  assert.match(await readFile(join(out, 'mobile/src/lib.rs'), 'utf8'), /sdk_core::domain::freight\(grams\)/);
  assert.match(await readFile(join(out, 'wasm/src/lib.rs'), 'utf8'), /wasm_bindgen\(js_name = shippingCost\)/);
  assert.match(await readFile(join(out, 'Cargo.toml'), 'utf8'), /"overflow-checks" = true/);
  // Relocate the entire job layout as Actions does between Linux and macOS runners.
  const moved = join(base, 'other-runner');
  await mkdir(moved);
  await rename(checkout, join(moved, 'checkout'));
  await rename(out, join(moved, 'generated'));
  const metadata = JSON.parse(execFileSync('cargo', ['metadata', '--no-deps', '--locked', '--format-version', '1'],
    { cwd: join(moved, 'generated'), encoding: 'utf8' }));
  assert.deepEqual(metadata.packages.map(p => p.name), [sdk.mobilePackage, sdk.wasmPackage]);
  assert.equal(metadata.packages[0].dependencies.find(dep => dep.rename === 'sdk_core').path, await realpath(join(moved, 'checkout', 'services', 'rates')));
  execFileSync('cargo', ['check', '--locked', '--workspace', '--lib'], { cwd: join(moved, 'generated'), stdio: 'inherit' });
  // A renamed public function must break the build, even with unchanged release configuration.
  const engine = join(moved, 'checkout', 'services', 'rates', 'engine.rs');
  await writeFile(engine, (await readFile(engine, 'utf8')).replace('fn freight(', 'fn renamed('));
  assert.throws(() => execFileSync('cargo', ['check', '--locked', '-p', sdk.wasmPackage, '--lib'], {
    cwd: join(moved, 'generated'), stdio: 'pipe',
  }), error => error.status !== 0 && error.stderr.toString().includes('freight'));
});

test('builds both async adapters from a Rust API file relative to the selected crate', async t => {
  const checkout = await mkdtemp(join(tmpdir(), 'rust-inside-api-generator-'));
  t.after(() => rm(checkout, { recursive: true, force: true }));
  const core = join(checkout, 'core');
  const out = join(checkout, 'out');
  await mkdir(join(core, 'src'), { recursive: true });
  await writeFile(join(core, 'Cargo.toml'), '[package]\nname = "mailbox"\nversion = "0.1.0"\nedition = "2024"\n');
  await writeFile(join(core, 'src/lib.rs'), '#[path = "public.rs"] pub mod api;\n');
  await writeFile(join(core, 'src/public.rs'), `
pub struct Preview { pub sender_name: String, pub message_ids: Vec<u32> }
pub struct Inbox { address: String }
impl Inbox {
    pub fn new(address: String) -> Self { Self { address } }
    fn normalize(&self) -> String { self.address.trim().to_owned() }
    pub async fn read_latest(&self, limit: u32) -> Result<Preview, String> {
        Ok(Preview { sender_name: self.normalize(), message_ids: vec![limit] })
    }
}
pub fn is_online() -> bool { true }
`);
  const manifest = join(checkout, 'rust-inside.json');
  await writeFile(manifest, JSON.stringify({ backend: 'jvm', repositories, crate: 'core/Cargo.toml', api: 'src/public.rs' }));
  const sdk = await generate(manifest, out);
  assert.equal(sdk.module, 'MailboxSDK');
  assert.equal(sdk.kotlinCoroutinesVersion, '1.7.3');
  assert.deepEqual(sdk.clients[0].methods.map(m => m.jsName), ['readLatest']);
  assert.deepEqual(sdk.exports.map(f => f.jsName), ['isOnline']);
  const wasm = await readFile(join(out, 'wasm/src/lib.rs'), 'utf8');
  assert.match(wasm, /wasm_bindgen\(readonly, js_name = senderName\)/);
  assert.match(wasm, /wasm_bindgen\(js_name = readLatest\)/);
  const native = await readFile(join(out, 'mobile/src/lib.rs'), 'utf8');
  assert.match(native, /uniffi::export\(async_runtime = "tokio"\)/);
  assert.match(native, /self\.inner\.read_latest\(limit\)/);
  execFileSync('cargo', ['check', '--locked', '--workspace', '--lib'], { cwd: out, stdio: 'inherit' });
});

test('builds nested clients with inherited audiences and method overrides for each adapter', async t => {
  const root = await mkdtemp(join(tmpdir(), 'rust-inside-audience-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const macros = fileURLToPath(new URL('../../annotations', import.meta.url));
  await mkdir(join(root, 'src/api'), { recursive: true });
  await writeFile(join(root, 'Cargo.toml'), `[package]
name = "inbox"
version = "0.1.0"
edition = "2024"
[dependencies]
rust_inside = { package = "rust-inside-annotations", path = ${JSON.stringify(macros)} }
`);
  await writeFile(join(root, 'src/lib.rs'), 'pub mod api;');
  await writeFile(join(root, 'src/api.rs'), '#[rust_inside::app] pub mod inbox;');
  await writeFile(join(root, 'src/api/inbox.rs'), `
pub struct Preview { pub title: String }
pub struct Audit { pub sequence: u32 }
pub struct Badge { pub count: u32 }
pub struct Inbox;
impl Inbox { pub fn new() -> Self { Self } }
pub trait InboxApi {
    async fn preview(&self) -> Result<Preview, String>;
    #[rust_inside::server]
    async fn audit(&self) -> Result<Audit, String>;
}
impl InboxApi for Inbox {
    async fn preview(&self) -> Result<Preview, String> { Ok(Preview { title: "hello".into() }) }
    async fn audit(&self) -> Result<Audit, String> { Ok(Audit { sequence: 1 }) }
}
`);
  const manifest = join(root, 'rust-inside.json');
  const out = join(root, 'generated');
  await writeFile(manifest, JSON.stringify({
    backend: 'node',
    repositories: { ...repositories, flutter: 'team/flutter' },
    requiredApi: { ios: ['Inbox.preview'], backend: ['Inbox.audit'] },
    api: 'src/api.rs',
  }));
  const sdk = await generate(manifest, out);
  assert.deepEqual(Object.keys(sdk.repositories).sort(), ['android','backend','flutter','ios']);
  assert.deepEqual(sdk.requiredApi, { ios: ['Inbox.preview'], backend: ['Inbox.audit'] });
  assert.equal((await readdir(join(out, 'platforms'))).includes('web'), false);
  for (const target of Object.keys(sdk.repositories)) {
    const scoped = JSON.parse(await readFile(join(out, 'platforms', target, 'sdk.json'), 'utf8'));
    assert.deepEqual(scoped.requiredApi, sdk.requiredApi[target] ? { [target]: sdk.requiredApi[target] } : undefined);
    assert.deepEqual(scoped.clients[0].methods.map(method => method.name), [target === 'backend' ? 'audit' : 'preview']);
    assert.deepEqual(scoped.records.map(record => record.name).sort(), target === 'backend' ? ['Audit'] : ['Badge', 'Preview']);
    if (['backend', 'ios', 'flutter'].includes(target)) {
      execFileSync('cargo', ['check', '--locked', '--workspace', '--lib'], {
        cwd: join(out, 'platforms', target), stdio: 'inherit',
      });
    }
  }
  await writeFile(manifest, JSON.stringify({
    backend: 'node', repositories, api: 'src/api.rs', requiredApi: { ios: ['Inbox.audit'] },
  }));
  await assert.rejects(generate(manifest, join(root, 'missing-ios')), /Required API missing from ios SDK: Inbox\.audit/);
  await writeFile(manifest, JSON.stringify({ backend: 'node', repositories: { web: 'team/web' }, api: 'src/api.rs' }));
  const empty = join(root, 'empty');
  assert.deepEqual((await generate(manifest, empty)).repositories, {});
  assert.deepEqual(await readdir(empty), ['sdk.json']);
});

test('warns for each configured SDK with an empty public API', async t => {
  const root = await mkdtemp(join(tmpdir(), 'rust-inside-empty-api-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'src'));
  await writeFile(join(root, 'Cargo.toml'), '[package]\nname = "private-core"\nversion = "0.1.0"\nedition = "2024"\n');
  await writeFile(join(root, 'src/lib.rs'), 'pub mod api;\n');
  await writeFile(join(root, 'src/api.rs'), 'fn internal() {}\n');
  const manifest = join(root, 'rust-inside.json');
  const out = join(root, 'generated');
  const cli = fileURLToPath(new URL('./generate.mjs', import.meta.url));
  await writeFile(manifest, JSON.stringify({
    backend: 'jvm', api: 'src/api.rs', repositories: { ios: 'team/ios', web: 'team/web', flutter: null },
  }));
  const run = spawnSync(process.execPath, [cli, manifest, out], {
    encoding: 'utf8', env: { ...process.env, GITHUB_ACTIONS: 'true' },
  });
  assert.equal(run.status, 0, run.stderr);
  const warnings = run.stdout.split('\n').filter(line => line.startsWith('::warning::'));
  assert.equal(warnings.length, 2);
  assert.match(warnings[0], /ios.*no public API/);
  assert.match(warnings[1], /web.*no public API/);
  assert.deepEqual(JSON.parse(await readFile(join(out, 'sdk.json'), 'utf8')).repositories, {});
  assert.deepEqual(await readdir(out), ['sdk.json']);
});

test('requires named operations on the implicit Swift and JVM RPC destinations', async t => {
  const root = await mkdtemp(join(tmpdir(), 'rust-inside-required-rpc-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'src'));
  await writeFile(join(root, 'Cargo.toml'), '[package]\nname = "reports"\nversion = "0.1.0"\nedition = "2024"\n');
  await writeFile(join(root, 'src/lib.rs'), 'pub mod api;\n');
  const api = join(root, 'src/api.rs');
  const manifest = join(root, 'rust-inside.json');
  const requiredApi = { ios: ['report'], backend: ['report'] };
  await writeFile(manifest, JSON.stringify({ backend: 'jvm', api: 'src/api.rs', requiredApi }));
  await writeFile(api, '#[rust_inside::server] pub fn report(value: i64) -> i64 { value }\n');
  const sdk = await generate(manifest, join(root, 'generated'), { rpc: true });
  assert.deepEqual(sdk.requiredApi, requiredApi);
  await writeFile(api, '#[rust_inside::ios] pub fn report(value: i64) -> i64 { value }\n');
  await assert.rejects(generate(manifest, join(root, 'scoped-out'), { rpc: true }), /Required API missing from ios SDK: report/);
  await writeFile(api, 'fn report(value: i64) -> i64 { value }\n');
  await assert.rejects(generate(manifest, join(root, 'private'), { rpc: true }), /Required API missing from ios SDK: report/);
  assert.throws(() => parseManifest({
    backend: 'jvm', api: 'src/api.rs', requiredApi: { web: ['report'] },
  }, { rpc: true }), /web.*report.*not a generation target/);
});
