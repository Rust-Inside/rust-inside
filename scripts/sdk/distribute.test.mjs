import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { githubClient, planDistribution, publishDistribution } from './distribute.mjs';

async function packages(t) {
  const directory = await mkdtemp(join(tmpdir(), 'rust-inside-distribute-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  for (const [platform, name] of Object.entries({
    backend: 'backend.tgz', ios: 'SDK.xcframework.zip', android: 'android.aar', web: 'web.tgz',
  })) {
    const artifact = join(directory, `rust-inside-${platform}`);
    await mkdir(artifact);
    await writeFile(join(artifact, name), platform);
  }
  const swift = join(directory, 'rust-inside-ios', 'swift-package');
  await mkdir(join(swift, 'Sources', 'SDK'), { recursive: true });
  await writeFile(join(swift, 'Package.swift'), 'url: "@RUST_INSIDE_BINARY_URL@", checksum: "@RUST_INSIDE_BINARY_SHA256@"');
  await writeFile(join(swift, 'Sources', 'SDK', 'SDK.swift'), 'public func sdk() {}');

  return {
    backend: 'node',
    version: '1.2.3', source: `team/core@${'a'.repeat(40)}`, directory,
    destinations: {
      backend: 'team/backend-sdk', ios: 'https://github.com/team/ios-sdk.git',
      android: 'team/android-sdk', web: 'team/web-sdk',
    },
  };
}

function githubFixture() {
  const repositories = new Map();
  const published = [];
  let blocked;
  let uploads = 0;
  const api = githubClient('test-token', async (url, request) => {
    assert.equal(request.headers.Authorization, 'Bearer test-token');
    const [, , owner, name, ...rest] = url.pathname.split('/');
    assert.equal(owner, 'team');
    const path = rest.join('/');
    const { method } = request;
    if (!repositories.has(name)) repositories.set(name, { tag: null, release: null, blobs: new Map() });
    const repo = repositories.get(name);
    const json = () => JSON.parse(request.body);
    const response = (data, status = 200) => Response.json(data, { status });

    if (method === 'GET' && path === '') return response({ default_branch: 'main' });
    if (method === 'GET' && path === 'commits/main') {
      return response({ sha: 'default-commit', commit: { tree: { sha: 'default-tree' } } });
    }
    if (method === 'GET' && path === 'git/trees/default-tree') {
      const files = ['LICENSE', 'README.md', 'README.ko.md', 'obsolete.dylib'];
      return response({ tree: files.map(path => ({ path, mode: '100644', type: 'blob', sha: `original-${path}` })) });
    }
    if (method === 'GET' && path === 'git/ref/tags/v1.2.3') {
      return repo.tag ? response({ object: { sha: repo.tag } }) : response({}, 404);
    }
    if (method === 'GET' && path === 'releases/tags/v1.2.3') {
      return repo.release && !repo.release.draft ? response(repo.release) : response({}, 404);
    }
    if (method === 'GET' && path === 'releases') return response(repo.release ? [repo.release] : []);
    if (method === 'POST' && path === 'git/blobs') {
      const { encoding, content } = json();
      assert.equal(encoding, 'base64');
      const bytes = Buffer.from(content, 'base64');
      const sha = createHash('sha1').update(bytes).digest('hex');
      repo.blobs.set(sha, bytes);
      return response({ sha }, 201);
    }
    if (method === 'POST' && path === 'git/trees') {
      repo.tree = json().tree;
      if (name === 'ios-sdk') {
        assert.match(repo.tree.find(file => file.path === 'Package.swift').content,
          /https:\/\/github\.com\/team\/ios-sdk\/releases\/download\/v1\.2\.3\/SDK\.xcframework\.zip", checksum: "[a-f0-9]{64}"/);
      }
      return response({ sha: 'package-tree' }, 201);
    }
    if (method === 'POST' && path === 'git/commits') {
      repo.commit = json();
      assert.equal(repo.commit.tree, 'package-tree');
      return response({ sha: 'package-commit' }, 201);
    }
    if (method === 'POST' && path === 'releases') {
      assert.equal(repo.release, null);
      assert.equal(json().draft, true);
      repo.release = { ...json(), id: 1, assets: [],
        upload_url: `https://uploads.github.com/repos/team/${name}/releases/1/assets{?name,label}`,
        html_url: `https://github.com/team/${name}/releases/tag/v1.2.3`,
      };
      return response(repo.release, 201);
    }
    if (method === 'POST' && path === 'releases/1/assets') {
      assert.equal(url.hostname, 'uploads.github.com');
      assert.equal(repo.release.draft, true);
      const asset = {
        state: 'uploaded', name: url.searchParams.get('name'),
        digest: `sha256:${createHash('sha256').update(await request.body.bytes()).digest('hex')}`,
      };
      repo.release.assets.push(asset);
      uploads++;
      return response(asset, 201);
    }
    if (method === 'POST' && path === 'git/refs') {
      assert.equal(json().ref, 'refs/tags/v1.2.3');
      assert.equal(json().sha, repo.tree ? 'package-commit' : 'default-commit');
      repo.tag = json().sha;
      return response({}, 201);
    }
    if (method === 'PATCH' && path === 'releases/1') {
      assert.ok([...repositories.values()].every(item => item.tag && item.release.assets.length));
      if (blocked === name) return response({ message: 'Try again' }, 503);
      assert.equal(json().draft, false);
      repo.release.draft = false;
      published.push(name);
      return response(repo.release);
    }
    assert.fail(`${method} ${url}`);
  });
  return { api, published, repositories, countUploads: () => uploads, block: name => { blocked = name; } };
}

test('publishes one version to four requested repositories and resumes a partial release', async t => {
  const options = await packages(t);
  const plans = await planDistribution(options);
  const remote = githubFixture();
  remote.block('ios-sdk');
  await assert.rejects(publishDistribution(remote.api, plans), /HTTP 503/);
  assert.deepEqual(remote.published, ['backend-sdk']);
  assert.equal(remote.countUploads(), 4);
  assert.deepEqual(remote.repositories.get('ios-sdk').release.assets.map(asset => asset.name), ['SDK.xcframework.zip']);

  remote.block(null);
  const urls = await publishDistribution(remote.api, plans);
  assert.deepEqual(remote.published, ['backend-sdk', 'ios-sdk', 'android-sdk', 'web-sdk']);
  assert.equal(remote.countUploads(), 4);
  assert.equal(urls.length, 4);

  await writeFile(join(options.directory, 'rust-inside-web', 'web.tgz'), 'different build');
  await assert.rejects(publishDistribution(remote.api, await planDistribution(options)), /belongs to another build/);
});

test('validates all platform inputs and allows packages to share a destination', async t => {
  const options = await packages(t);
  options.destinations.web = 'https://github.com/TEAM/backend-sdk/';
  const [combined] = await planDistribution(options);
  assert.deepEqual(combined.platforms, ['backend', 'web']);
  assert.deepEqual(combined.assets.map(asset => asset.name), ['backend.tgz', 'web.tgz']);

  options.destinations.web = 'https://example.com/team/sdk';
  await assert.rejects(planDistribution(options), /Expected a GitHub repository/);
  options.destinations.web = 'team/web-sdk';
  await rm(join(options.directory, 'rust-inside-android', 'android.aar'));
  await assert.rejects(planDistribution(options), /No assets in rust-inside-android/);
});

test('a release commit keeps the destination license and guides alongside the current package', async t => {
  const options = await packages(t);
  options.destinations = { ios: 'team/ios-sdk' };
  await writeFile(join(options.directory, 'rust-inside-ios', 'swift-package', 'README.md'), 'Guide for this build');
  const remote = githubFixture();
  await publishDistribution(remote.api, await planDistribution(options));

  const { commit, tree } = remote.repositories.get('ios-sdk');
  const identity = { name: 'Rust Inside', email: 'release@rust-inside.invalid' };
  assert.deepEqual(commit.author, identity);
  assert.deepEqual(commit.committer, identity);
  assert.deepEqual(commit.parents, ['default-commit']);
  assert.deepEqual(tree.filter(file => file.path === 'README.md'), [
    { path: 'README.md', mode: '100644', type: 'blob', content: 'Guide for this build' },
  ]);
  for (const path of ['LICENSE', 'README.ko.md']) {
    assert.equal(tree.find(file => file.path === path)?.sha, `original-${path}`);
  }
  assert.ok(!tree.some(file => file.path === 'obsolete.dylib'));
});

test('a backend type is required even when the release only ships a web package', async t => {
  const options = await packages(t);
  await assert.rejects(planDistribution({ ...options, backend: undefined }), /backend is required/);
  await assert.rejects(planDistribution({ ...options, backend: 'rust' }), /omit the backend/);
  for (const platform of ['backend', 'ios', 'android']) {
    await rm(join(options.directory, 'rust-inside-' + platform), { recursive: true });
  }
  options.destinations = { backend: null, ios: '', web: 'team/web-sdk' };
  for (const backend of ['node', 'jvm', 'rust']) {
    const plans = await planDistribution({ ...options, backend });
    assert.deepEqual(plans.map(plan => plan.platforms), [['web']]);
    const remote = githubFixture();
    await publishDistribution(remote.api, plans);
    assert.deepEqual([...remote.repositories.keys()], ['web-sdk']);
  }
  for (const invalid of [false, '   ', 'http://wrong.url']) {
    options.destinations.web = invalid;
    await assert.rejects(planDistribution(options), /Expected a GitHub repository/);
  }
});

test('only selected packages are grouped when destinations share a repository', async t => {
  const options = await packages(t);
  options.destinations = { android: 'team/shared', web: 'https://github.com/Team/Shared.git' };
  const plans = await planDistribution(options);
  assert.deepEqual(plans.map(plan => plan.platforms), [['android', 'web']]);
  const remote = githubFixture();
  await publishDistribution(remote.api, plans);
  assert.deepEqual(remote.published, ['shared']);
  assert.equal(remote.countUploads(), 2);
});

test('an empty release succeeds without an artifact directory or a token', async () => {
  const version = '1.2.3';
  const source = 'team/core@' + 'a'.repeat(40);
  for (const destinations of [undefined, null, {}, { backend: null, android: '', ios: null }]) {
    assert.deepEqual(await planDistribution({ backend: 'node', version, source, destinations }), []);
  }
  const script = fileURLToPath(new URL('./distribute.mjs', import.meta.url));
  for (const dryRun of ['true', 'false']) {
    const stdout = execFileSync(process.execPath, [script], {
      encoding: 'utf8',
      env: {
        RUST_INSIDE_VERSION: version, RUST_INSIDE_SOURCE: source, RUST_INSIDE_BACKEND: 'jvm',
        RUST_INSIDE_DRY_RUN: dryRun, BACKEND_REPOSITORY: '', WEB_REPOSITORY: '',
      },
    });
    assert.match(stdout, /No package destinations configured/);
  }
});

test('a JVM release needs both the JAR and its matching Ivy descriptor', async t => {
  const options = { ...await packages(t), backend: 'jvm' };
  const directory = join(options.directory, 'rust-inside-backend');
  await assert.rejects(planDistribution(options), /versioned JAR/);
  await rm(join(directory, 'backend.tgz'));
  await writeFile(join(directory, 'catalog-jvm-1.2.3.jar'), 'jar');
  await assert.rejects(planDistribution(options), /matching Gradle Ivy descriptor/);
  await writeFile(join(directory, 'catalog-jvm-1.2.3.xml'), 'descriptor');
  const [backend] = await planDistribution(options);
  assert.deepEqual(backend.assets.map(asset => asset.name), ['catalog-jvm-1.2.3.jar', 'catalog-jvm-1.2.3.xml']);
});

test('Flutter Pub can resolve its sources and binary files from the tag, including in a shared iOS repository', async t => {
  const options = await packages(t);
  const artifact = join(options.directory, 'rust-inside-flutter');
  const pkg = join(artifact, 'flutter-package');
  const pubspec = 'name: account_core_flutter\nversion: 1.2.3\n';
  const binary = Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0xff, 0, 0xc0]);
  const archive = 'account-core-flutter-1.2.3.tar.gz';
  for (const folder of ['lib', 'hook']) await mkdir(join(pkg, folder), { recursive: true });
  await writeFile(join(artifact, archive), 'archive');
  await writeFile(join(pkg, 'pubspec.yaml'), pubspec);
  await writeFile(join(pkg, 'lib/account_core_flutter.dart'), 'class AccountClient {}');
  await writeFile(join(pkg, 'hook/build.dart'), 'void main() {}');
  for (const target of ['android-arm', 'android-arm64', 'android-x64', 'ios-arm64', 'ios-sim-arm64', 'ios-sim-x64']) {
    const dir = join(pkg, 'native', target);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'libaccount_core_flutter.' + (target.startsWith('ios') ? 'dylib' : 'so')), binary);
  }

  for (const repository of ['team/flutter-sdk', 'team/ios-sdk']) {
    const shared = repository === 'team/ios-sdk';
    options.destinations = { flutter: repository, ios: shared ? repository : null };
    const plans = await planDistribution(options);
    const remote = githubFixture();
    await publishDistribution(remote.api, plans);
    const repo = remote.repositories.get(repository.split('/')[1]);
    assert.equal(repo.tag, 'package-commit');
    const tree = new Map(repo.tree.map(file => [file.path, file]));
    assert.equal(tree.has('Package.swift'), shared);
    assert.equal(repo.blobs.get(tree.get('flutter/pubspec.yaml').sha).toString(), pubspec);
    const native = tree.get('flutter/native/android-arm64/libaccount_core_flutter.so');
    assert.equal(native.mode, '100755');
    assert.deepEqual(repo.blobs.get(native.sha), binary);
    assert.deepEqual(repo.release.assets.map(asset => asset.name), shared ? ['SDK.xcframework.zip', archive] : [archive]);
    await publishDistribution(remote.api, plans);
    assert.equal(remote.published.length, 1);
  }

  await rm(join(pkg, 'native/ios-sim-arm64/libaccount_core_flutter.dylib'));
  await assert.rejects(planDistribution(options), /missing native\/ios-sim-arm64/);
  await rm(join(artifact, archive));
  await assert.rejects(planDistribution(options), /No assets in rust-inside-flutter/);
});
