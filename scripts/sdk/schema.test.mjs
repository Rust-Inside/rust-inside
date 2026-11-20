import assert from 'node:assert/strict';
import test from 'node:test';
import schema from '../../rust-inside.schema.json' with { type: 'json' };
import { parseManifest } from './generate.mjs';

test('the editor offers every release backend, with an explicit selection', () => {
  assert.ok(schema.required.includes('backend'));
  assert.equal(schema.properties.backend.type, 'string');
  assert.deepEqual(schema.properties.backend.enum, ['node', 'jvm', 'rust']);
});

test('the editor accepts nullable destinations and limits direct Rust backend repositories to null', () => {
  const repos = schema.properties.repositories;
  assert.ok(!schema.required.includes('repositories'));
  assert.deepEqual(repos.type, ['object', 'null']);
  assert.equal(repos.required, undefined);
  assert.deepEqual(Object.keys(repos.properties), ['backend', 'ios', 'android', 'flutter', 'web']);
  for (const platform of Object.values(repos.properties)) assert.equal(platform.$ref, '#/definitions/repository');
  assert.deepEqual(schema.definitions.repository.type, ['string', 'null']);
  assert.equal(schema.if.properties.backend.const, 'rust');
  assert.deepEqual(schema.then.properties.repositories.properties.backend, { type: 'null' });
});

test('explicit exports and Rust source use the same platform selector vocabulary', () => {
  const manifest = {
    backend: 'jvm', repositories: { flutter: 'team/flutter' },
    exports: [{ path: 'value', platforms: ['app', 'ios', 'server'] }],
  };
  const parsed = parseManifest(manifest);
  assert.deepEqual(parsed.repositories, { flutter: 'team/flutter' });
  assert.deepEqual(parsed.exports[0].platforms, ['ios', 'android', 'flutter', 'backend']);
  assert.equal(parseManifest({ ...manifest, exports: [{ path: 'value' }] }).exports[0].platforms, undefined);
  for (const platforms of [[], 'app', ['server', 'server'], ['mobile'], null]) {
    assert.throws(() => parseManifest({ ...manifest, exports: [{ path: 'value', platforms }] }), /platform/);
  }
});

test('an existing UniFFI crate selects its own API and an optional iOS destination', () => {
  const base = { backend: 'rust', uniffi: { crate: 'crates/bridge/Cargo.toml' } };
  const parsed = parseManifest({ ...base, repositories: { ios: 'https://github.com/team/mobile-kit.git', web: null } });
  assert.equal(parsed.crate, base.uniffi.crate);
  assert.deepEqual(parsed.repositories, { ios: 'team/mobile-kit' });
  assert.deepEqual(parseManifest({ ...base, repositories: { ios: null } }).repositories, {});
  for (const overrides of [
    { api: 'src/api.rs' }, { exports: [] }, { name: 'unused' }, { crate: 'Cargo.toml' },
    { uniffi: {} }, { uniffi: { crate: '/tmp/Cargo.toml' } }, { repositories: { web: 'team/web' } },
  ]) assert.throws(() => parseManifest({ ...base, ...overrides }));
});
