import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const script = fileURLToPath(new URL('./release-info.mjs', import.meta.url));

async function releasePlan(t, backend, repositories) {
  const directory = await mkdtemp(join(tmpdir(), 'rust-inside-plan-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const manifest = join(directory, 'rust-inside.json');
  const output = join(directory, 'output');
  const summary = join(directory, 'summary');
  await writeFile(manifest, JSON.stringify({ api: 'src/api.rs', backend, repositories }));
  execFileSync(process.execPath, [script, '--plan', manifest], {
    env: { ...process.env, GITHUB_OUTPUT: output, GITHUB_STEP_SUMMARY: summary },
  });
  const lines = (await readFile(output, 'utf8')).trimEnd().split('\n');
  const values = Object.fromEntries(lines.map(line => line.split('=')));
  return { values, jobs: JSON.parse(values.matrix).include, summary };
}

test('only configured packages enter the build matrix', async t => {
  for (const [backend, repositories, expected] of [
    ['jvm', { ios: 'team/ios', backend: null }, ['ios']],
    ['node', { android: 'team/android' }, ['android']],
    ['node', { backend: 'team/node' }, ['js']],
    ['jvm', { web: 'team/web' }, ['js']],
    ['rust', { backend: null, ios: 'team/ios', web: 'team/web' }, ['js', 'ios']],
    ['jvm', { flutter: 'team/flutter' }, ['flutter-ios', 'flutter-android']],
  ]) {
    const { values, jobs } = await releasePlan(t, backend, repositories);
    assert.deepEqual(jobs.map(job => job.platform), expected);
    assert.equal(values.has_packages, 'true');
    assert.equal(values.build_jvm, 'false');
    assert.equal(values.build_flutter, String(Boolean(repositories.flutter)));
    assert.deepEqual(jobs.filter(job => job.jvm_native), []);
  }
});

test('a JVM JAR includes all three host libraries independently of iOS distribution', async t => {
  for (const ios of [null, 'team/ios']) {
    const { values, jobs } = await releasePlan(t, 'jvm', { backend: 'team/server', ios });
    assert.equal(values.build_jvm, 'true');
    assert.deepEqual(jobs.filter(job => job.jvm_native).map(job => job.platform),
      [ios ? 'ios' : 'jvm-macos', 'jvm-x64', 'jvm-arm64']);
    assert.equal(jobs.length, 3);
    assert.equal(Boolean(jobs.find(job => job.targets)), Boolean(ios));
  }
});

test('an empty destination set needs no Rust project and schedules no builds', async t => {
  const { values, jobs, summary } = await releasePlan(t, 'jvm', null);
  assert.deepEqual(jobs, []);
  assert.equal(values.has_packages, 'false');
  assert.equal(values.build_jvm, 'false');
  assert.match(await readFile(summary, 'utf8'), /No package repositories selected/);
});

test('the final summary identifies the packages that can call each exported API', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'rust-inside-summary-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const summary = join(dir, 'summary');
  const sdk = join(dir, 'sdk.json');
  await writeFile(sdk, JSON.stringify({
    name: 'account-core', corePackage: 'account-core', backend: 'jvm', repositories: { flutter: 'team/flutter' },
    exports: [{ jsName: 'serverOnly', args: {}, returns: 'String', path: 'server_only', platforms: ['backend'] }],
    clients: [{ name: 'AccountClient', methods: [{ jsName: 'getMe', args: {}, returns: 'Me', async: true, platforms: ['ios', 'android', 'flutter'] }] }],
  }));
  execFileSync(process.execPath, [script, sdk], {
    env: { ...process.env, GITHUB_OUTPUT: join(dir, 'outputs'), GITHUB_STEP_SUMMARY: summary, VERSION: '1.2.3' },
  });
  const markdown = await readFile(summary, 'utf8');
  assert.match(markdown, /AccountClient\.getMe\(\) -> Me` \(async\) · flutter/);
  assert.doesNotMatch(markdown, /serverOnly|Gradle:/);
  assert.match(markdown, /url: https:\/\/github\.com\/team\/flutter\.git\n\s+ref: v1\.2\.3\n\s+path: flutter/);
});
