import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { discoverApi } from './discover-api.mjs';

function apiFile(t, source) {
  const dir = mkdtempSync(join(tmpdir(), 'rust-inside-api-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'api.rs');
  writeFileSync(file, source);
  return file;
}

function compileProducer(lib) {
  const markerDir = fileURLToPath(new URL('../../annotations/', import.meta.url));
  const manifest = join(dirname(lib), 'Cargo.toml');
  writeFileSync(manifest, `[package]
name = "sample-api"
version = "0.1.0"
edition = "2021"
[lib]
path = ${JSON.stringify(basename(lib))}
[dependencies]
rust_inside = { package = "rust-inside-annotations", path = ${JSON.stringify(markerDir)} }
[workspace]
`);
  execFileSync('cargo', ['test', '--quiet', '--manifest-path', manifest, '--lib'], { stdio: 'pipe' });
}

const recordsAndState = `
    pub struct Profile { pub display_name: String }
    pub struct Session { secret: String }
    impl Session {
        pub fn new(url: String, key: String) -> Self { todo!() }
        async fn refresh_token(&self) -> String { todo!() }
    }
    pub fn protocol_version() -> u32 { 1 }
    fn storage_key() -> &'static str { "private" }
    pub(crate) fn internal_lookup() {}
    mod storage { pub fn also_private() {} }
`;

test('discovers a trait as one SDK interface without exposing Rust-only helpers', t => {
  const file = apiFile(t, recordsAndState + `
    pub trait ProfileApi { async fn get_profile(&self) -> Result<Profile, String>; }
    impl ProfileApi for Session {
        async fn get_profile(&self) -> Result<Profile, String> { todo!() }
    }
  `);
  const api = discoverApi(file);
  assert.deepEqual(api.exports.map(fn => fn.path), ['api::protocol_version']);
  assert.deepEqual(api.records, [{ name: 'Profile', path: 'api::Profile', fields: [{ name: 'display_name', type: 'String' }] }]);
  const [client] = api.clients;
  assert.equal(client.traitName, 'ProfileApi');
  assert.equal(client.path, 'api::Session');
  assert.equal(client.traitPath, 'api::ProfileApi');
  assert.deepEqual(Object.keys(client.constructor.args), ['url', 'key']);
  assert.deepEqual(client.methods.map(method => [method.jsName, method.returns]), [['getProfile', 'Profile']]);
});

test('a public inherent async method works without a trait or repeated declaration', t => {
  const file = apiFile(t, recordsAndState + `
    impl Session {
        pub async fn get_profile(&self, page: u32) -> Result<Profile, String> { todo!() }
    }
  `);
  const [client] = discoverApi(file).clients;
  assert.equal(client.name, 'Session');
  assert.equal(client.traitName, undefined);
  assert.deepEqual(client.methods.map(method => [method.jsName, method.args]), [['getProfile', {page: 'u32'}]]);
});

test('a consumer Rust crate compiles marked functions and discovery selects their package APIs', t => {
  const source = `
    use rust_inside::{app, server};

    #[rust_inside::app]
    #[rust_inside::web]
    pub fn public_value() -> u32 { internal_rule() }
    #[server]
    pub fn server_value() -> u32 { internal_rule() }
    fn internal_rule() -> u32 { 42 }

    pub struct Profile { pub id: String }
    pub struct Account {}
    #[app]
    impl Account {
        pub fn new() -> Self { Self {} }
        #[rust_inside::web]
        pub async fn get_me(&self) -> Result<Profile, String> { todo!() }
        pub async fn version(&self) -> Result<Profile, String> { todo!() }
    }
    impl Account {
        pub async fn shared(&self) -> Result<Profile, String> { todo!() }
    }
    pub struct Device {}
    impl Device { pub fn new() -> Self { Self {} } }
    #[server]
    pub trait DeviceApi {
        #[rust_inside::ios]
        #[rust_inside::android]
        async fn info(&self) -> Result<Profile, String>;
        async fn state(&self) -> Result<Profile, String> { todo!() }
        #[rust_inside::ios]
        async fn detail(&self) -> Result<Profile, String> { todo!() }
    }
    #[app]
    impl DeviceApi for Device {
        #[rust_inside::web]
        async fn info(&self) -> Result<Profile, String> { todo!() }
    }
    pub struct RemoteDevice {}
    impl RemoteDevice { pub fn new() -> Self { Self {} } }
    impl DeviceApi for RemoteDevice {
        async fn info(&self) -> Result<Profile, String> { todo!() }
    }
    #[test]
    fn ordinary_rust_calls_still_work() { assert_eq!(public_value() + server_value(), 84); }
  `;
  const file = apiFile(t, source);
  compileProducer(file);
  const api = discoverApi(file);
  assert.deepEqual(api.exports.map(fn => fn.platforms), [['ios', 'android', 'flutter', 'web'], ['backend']]);
  const devicePlatforms = name => api.clients.find(c => c.name === name).methods.map(method => method.platforms);
  assert.deepEqual(devicePlatforms('Device'), [['web'], ['ios', 'android', 'flutter'], ['ios']]);
  assert.deepEqual(devicePlatforms('RemoteDevice'), [['ios', 'android'], ['backend'], ['ios']]);
  const [getMe, version, shared] = api.clients.find(c => c.name === 'Account').methods;
  assert.deepEqual(getMe.platforms, ['web']);
  assert.deepEqual(version.platforms, ['ios', 'android', 'flutter']);
  assert.equal(shared.platforms, undefined);
});

test('reports malformed or misplaced platform markers before generating a package', t => {
  const invalid = [
    ['#[rust_inside::wbe] pub fn foo() {}', /unknown platform/],
    ['#[rust_inside::ios("v18")] pub fn foo() {}', /takes no arguments/],
    ['#[rust_inside::web] pub struct R { pub id: u32 }', /public API function or client method/],
    ['use rust_inside::server as private_api; #[private_api] pub fn point() {}', /original names/],
    ['use self::server as private_api; use rust_inside::server; #[private_api] pub fn point() {}', /original names/],
    [recordsAndState + `
       #[rust_inside::ap] impl Session {
           #[rust_inside::web] pub async fn lookup(&self) -> Result<Profile, String> { todo!() }
       }
    `, /unknown platform ap/],
    [recordsAndState + `
       #[rust_inside::app] #[rust_inside::app] impl Session {
           #[rust_inside::web] pub async fn lookup(&self) -> Result<Profile, String> { todo!() }
       }
    `, /duplicate platform selector/],
    [`
       pub struct Session {}
       impl Session {
           #[rust_inside::web] pub fn new() -> Self { Self {} }
           pub async fn lookup(&self) -> Result<Session, String> { todo!() }
       }
    `, /constructor follows the selected client methods/],
    [recordsAndState + `
       pub trait ProfileApi { #[rust_inside::typo] async fn lookup(&self) -> Result<Profile, String>; }
       #[rust_inside::app] impl ProfileApi for Session {
           #[rust_inside::server] async fn lookup(&self) -> Result<Profile, String> { todo!() }
       }
    `, /unknown platform typo/],
    [recordsAndState + `
       pub trait ProfileApi { #[rust_inside::app] async fn lookup(&self) -> Result<Profile, String>; }
       #[rust_inside::server] impl ProfileApi for Session {
           #[rust_inside::ios(15)] async fn lookup(&self) -> Result<Profile, String> { todo!() }
       }
    `, /takes no arguments/],
  ];
  for (const [source, error] of invalid) assert.throws(() => discoverApi(apiFile(t, source)), error);
});

test('an attribute from another library does not select Rust Inside packages', t => {
  const file = apiFile(t, `
    use rust_inside::server;
    pub mod child {
        use super::*;
        use framework::server;
        #[server] pub fn shared() {}
        pub mod inner { #[super::server] pub fn also_shared() {} }
    }
  `);
  assert.deepEqual(discoverApi(file).exports.map(fn => fn.platforms), [undefined, undefined]);
});

test('resolves marker imports and qualified attributes through their Rust module paths', t => {
  const api = apiFile(t, `
    use crate::{server};
    #[server] pub fn root_import() {}
    #[crate::server] pub fn absolute() {}
    pub mod nested {
        use super::super::server;
        #[server] pub fn reimport() {}
        #[super::server] pub fn parent() {}
        #[self::server] pub fn local() {}
        #[crate::api::server] pub fn named_module() {}
        pub mod deep {
            use {super::{super::server}};
            #[server] pub fn grouped() {}
        }
    }
  `);
  const lib = join(dirname(api), 'lib.rs');
  writeFileSync(lib, 'use rust_inside::server; pub mod api;');
  compileProducer(lib);
  const { exports } = discoverApi(api, lib);
  assert.equal(exports.length, 7);
  for (const fn of exports) assert.deepEqual(fn.platforms, ['backend'], fn.path);
});

test('inherits API root selectors through inline and external public modules', t => {
  const api = apiFile(t, `
    use super::server;
    pub fn summary() {}
    pub mod account {
        use super::*;
        #[server] pub mod profile;
    }
    pub(crate) mod helpers { pub const SECRET: u32 = 123; }
  `);
  const root = dirname(api);
  const lib = join(root, 'producer.rs');
  writeFileSync(lib, 'use rust_inside::{app, server}; #[app] pub mod api;');
  const profile = join(root, 'api', 'account', 'profile');
  mkdirSync(profile, { recursive: true });
  writeFileSync(join(profile, 'mod.rs'), `
    pub fn get_profile() {}
    #[rust_inside::web] pub fn show_profile() {}
    pub struct Badge { pub count: u32 }
  `);
  compileProducer(lib);
  const { exports, records } = discoverApi(api, lib);
  assert.deepEqual(exports.map(fn => [fn.path, fn.platforms]), [
    ['api::summary', ['ios', 'android', 'flutter']],
    ['api::account::profile::get_profile', ['backend']],
    ['api::account::profile::show_profile', ['web']],
  ]);
  assert.deepEqual(records.map(record => [record.path, record.platforms]), [
    ['api::account::profile::Badge', ['backend']],
  ]);
});

test('checks the configured source and preserves Rust visibility at the API root', t => {
  const api = apiFile(t, 'pub fn status() {}');
  const lib = join(dirname(api), 'lib.rs');
  writeFileSync(lib, 'mod api;');
  assert.throws(() => discoverApi(api, lib), /pub mod api/);
  writeFileSync(lib, 'pub mod api;');
  assert.throws(() => discoverApi(lib, lib), /must match pub mod api/);
  writeFileSync(lib, '#[rust_inside::ios] pub mod api { pub fn status() {} }');
  assert.deepEqual(discoverApi(lib, lib).exports[0].platforms, ['ios']);
});

test('reports SDK methods implemented outside their client module and ignores private helper types', t => {
  const client = `
    pub struct Profile { pub id: String }
    pub struct Client {}
    impl Client {
        pub fn new() -> Self { Self {} }
        pub async fn common(&self) -> Result<Profile, String> { todo!() }
    }
  `;
  for (const [moduleAttr, implAttr, methodAttr, owner] of [
    ['', '#[rust_inside::app]', '', 'Client'],
    ['#[rust_inside::app]', '', '', 'super::Client'],
    ['', '', '#[rust_inside::ios]', 'Client'],
    ['', '', '', 'super::Client'],
  ]) {
    const file = apiFile(t, client + `
      ${moduleAttr} pub mod features {
          use super::{Client, Profile};
          ${implAttr} impl ${owner} {
              ${methodAttr} pub async fn info(&self) -> Result<Profile, String> { todo!() }
          }
      }
    `);
    assert.throws(() => discoverApi(file), /api::features: place impl .*Client containing SDK method info in the same Rust module/);
  }
  const file = apiFile(t, client + `
    #[rust_inside::app] pub mod features {
        struct Helper {}
        impl self::Helper { pub async fn info(&self) {} }
        impl AsRef<str> for super::Client { fn as_ref(&self) -> &str { "" } }
    }
  `);
  compileProducer(file);
  assert.deepEqual(discoverApi(file).clients.map(c => c.methods.map(m => m.name)), [['common']]);
});

test('reports invalid records, unsupported return types and colliding SDK method names', t => {
  const sources = [
    [recordsAndState + 'impl Session { pub async fn get(&self) -> Result<Unknown, String> {todo!()} }', /declare record Unknown/],
    [recordsAndState + 'impl Session { pub async fn get(&self) -> Profile {todo!()} }', /Result<Record, String>/],
    [recordsAndState + 'impl Session { pub fn get(&self) -> Profile {todo!()} }', /async client methods/],
    [recordsAndState + 'impl Session { pub async fn free(&self) -> Result<Profile, String> {todo!()} }', /Conflicting SDK name free/],
    ['pub enum Profile { Missing }', /exported enums are unsupported/],
  ];
  for (const [source, error] of sources) assert.throws(() => discoverApi(apiFile(t, source)), error);
});
