import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const publisher = fileURLToPath(new URL('./publish-swift-package.sh', import.meta.url));
const git = (...args) => execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

function swiftPackage(folder, module, ffi) {
  mkdirSync(join(folder, 'Sources', module), { recursive: true });
  mkdirSync(join(folder, ffi + '.xcframework'), { recursive: true });
  writeFileSync(join(folder, 'Package.swift'), '// test manifest\n');
  writeFileSync(join(folder, 'Sources', module, module + '.swift'), 'public func value() {}\n');
  writeFileSync(join(folder, ffi + '.xcframework', 'Info.plist'), '<plist/>\n');
}

test('standalone Swift packages preserve the destination branch and reject conflicting retries', t => {
  const root = mkdtempSync(join(tmpdir(), 'swift-git-release-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const remote = join(root, 'remote.git');
  const pack = join(root, 'package');
  const tag = 'v1.2.3';
  const source = 'example/tide-calculations';
  const revision = 'b'.repeat(40);
  git('init', '--bare', '--initial-branch=main', remote);
  swiftPackage(pack, 'TideCalculator', 'HarborBridge');
  const publish = (dir, repo, sha) => spawnSync('bash', [publisher, dir, tag, repo, sha, remote], { encoding: 'utf8' });
  let run = publish(pack, source, revision);
  assert.equal(run.status, 0, run.stderr);
  const destination = (...args) => git('--git-dir=' + remote, ...args);
  const head = destination('rev-parse', 'refs/heads/main');
  const firstTag = destination('rev-parse', tag);
  assert.notEqual(head, firstTag);
  assert.match(destination('show', 'main:README.md'), /TideCalculator/);
  assert.equal(destination('rev-list', '--count', tag), '1');
  assert.equal(destination('show', tag + ':SDK-PROVENANCE'), `source=${source}\ntag=${tag}\ncommit=${revision}`);
  assert.ok(destination('show', tag + ':HarborBridge.xcframework/Info.plist'));
  assert.ok(destination('show', tag + ':.github/workflows/publish-ios-release.yml'));
  writeFileSync(join(pack, 'HarborBridge.xcframework', 'Info.plist'), '<plist>rebuilt</plist>\n');
  run = publish(pack, source, revision);
  assert.equal(run.status, 0, run.stderr);
  assert.notEqual(publish(pack, 'another/producer', revision).status, 0);
  assert.notEqual(publish(pack, source, 'c'.repeat(40)).status, 0);
  const other = join(root, 'other-package');
  swiftPackage(other, 'WeatherMap', 'HarborBridge');
  assert.notEqual(publish(other, source, revision).status, 0);
  assert.equal(destination('rev-parse', tag), firstTag);
  assert.equal(destination('rev-parse', 'main'), head);
});

test('an SDK destination with an existing default branch receives only the package tag', t => {
  const root = mkdtempSync(join(tmpdir(), 'swift-existing-destination-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const remote = join(root, 'remote.git');
  const seed = join(root, 'seed');
  git('init', '--bare', '--initial-branch=trunk', remote);
  git('init', '--initial-branch=trunk', seed);
  writeFileSync(join(seed, 'README.md'), 'Existing SDK repository.\n');
  git('-C', seed, 'add', 'README.md');
  git('-C', seed, '-c', 'user.name=SDK', '-c', 'user.email=sdk@example.com', 'commit', '-m', 'Initial guide');
  git('-C', seed, 'push', remote, 'trunk');
  const pack = join(root, 'package');
  swiftPackage(pack, 'SignalKit', 'SignalKitFFI');
  execFileSync('bash', [publisher, pack, 'v0.2.0', 'tools/signal', 'a'.repeat(40), remote], { stdio: 'pipe' });
  assert.equal(git('--git-dir=' + remote, 'rev-parse', 'HEAD'), git('-C', seed, 'rev-parse', 'HEAD'));
  assert.equal(git('--git-dir=' + remote, 'for-each-ref', '--format=%(refname)', 'refs/heads'), 'refs/heads/trunk');
});
