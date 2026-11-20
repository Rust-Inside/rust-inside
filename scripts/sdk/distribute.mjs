import { createHash } from 'node:crypto';
import { createReadStream, openAsBlob } from 'node:fs';
import { appendFile, readdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import schema from '../../rust-inside.schema.json' with { type: 'json' };

const platforms = ['backend', 'ios', 'android', 'web', 'flutter'];
const assetName = /^[a-z0-9][a-z0-9._-]*$/i;
const binaryUrl = '@RUST_INSIDE_BINARY_URL@';
const binaryChecksum = '@RUST_INSIDE_BINARY_SHA256@';
const releaseIdentity = { name: 'Rust Inside', email: 'release@rust-inside.invalid' };
const packageDocument = /^(readme|licen[cs]e|copying|notice)([.-].*)?$/i;
const sha256 = value => createHash('sha256').update(value).digest('hex');

export function requireBackend(value) {
  const choices = schema.properties.backend.enum;
  if (!choices.includes(value)) {
    throw new Error(`backend is required and must be one of ${choices.join(', ')} (received ${JSON.stringify(value)})`);
  }
  return value;
}

export function repositoryName(input) {
  const repository = typeof input === 'string' && input.trim().replace(/^https:\/\/github\.com\//i, '').replace(/\/$/, '').replace(/\.git$/, '');
  if (!repository || !/^[a-z0-9][a-z0-9-]*\/[a-z0-9_.-]+$/i.test(repository) || /\/\.{1,2}$/.test(repository)) {
    throw new Error(`Expected a GitHub repository as owner/name or an HTTPS URL, received ${JSON.stringify(input)}`);
  }
  return repository;
}

async function listFiles(directory, prefix = '') {
  const entries = (await readdir(join(directory, prefix), { withFileTypes: true }))
    .sort((left, right) => left.name.localeCompare(right.name, 'en'));
  const files = [];
  for (const entry of entries) {
    if (entry.name.toLowerCase() === '.git' || entry.isSymbolicLink()) throw new Error(`Invalid package entry ${entry.name}`);
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) files.push(...await listFiles(directory, path));
    else if (entry.isFile()) files.push(path);
    else throw new Error(`Invalid package entry ${path}`);
  }
  return files;
}

async function fileDigest(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

async function flutterPackage(directory, library) {
  const files = await listFiles(directory);
  if (!files.includes('pubspec.yaml') || !files.includes('hook/build.dart') || !files.some(path => path.startsWith('lib/') && path.endsWith('.dart'))) {
    throw new Error('Flutter package requires pubspec.yaml, hook/build.dart and a Dart library');
  }
  for (const target of ['android-arm', 'android-arm64', 'android-x64', 'ios-arm64', 'ios-sim-arm64', 'ios-sim-x64']) {
    const ext = target.startsWith('ios') ? 'dylib' : 'so';
    const binary = `native/${target}/lib${library}.${ext}`;
    if (!files.includes(binary)) throw new Error(`Flutter package is missing ${binary}`);
  }
  const entries = [];
  for (const path of files) {
    const local = join(directory, path);
    const mode = path.startsWith('native/') ? '100755' : '100644';
    entries.push({ path: `flutter/${path}`, local, mode, digest: await fileDigest(local) });
  }
  return entries;
}

async function swiftPackage(directory, archive, repository, tag) {
  const files = await listFiles(directory);
  if (!files.includes('Package.swift')) throw new Error('iOS artifact must include swift-package/Package.swift');
  return Promise.all(files.map(async path => {
    const original = await readFile(join(directory, path), 'utf8');
    let content = original;
    if (path === 'Package.swift') {
      if (!original.includes(binaryUrl) || !original.includes(binaryChecksum)) {
        throw new Error('Swift manifest must include the binary URL and checksum placeholders');
      }
      content = original
        .replaceAll(binaryUrl, `https://github.com/${repository}/releases/download/${tag}/${archive.name}`)
        .replaceAll(binaryChecksum, archive.digest);
    }
    return { path, mode: '100644', type: 'blob', content };
  }));
}

export async function planDistribution({ version, source, directory, destinations, backend }) {
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)) throw new Error('Pass a release version in X.Y.Z form');
  if (!/^[a-z0-9][a-z0-9-]*\/[a-z0-9_.-]+@[a-f0-9]{40}$/i.test(source)) throw new Error('Pass the core source as owner/repo@commit-sha');
  requireBackend(backend);
  const tag = `v${version}`;
  const plans = new Map();
  for (const platform of platforms) {
    const destination = destinations?.[platform];
    if (destination == null || destination === '') continue;
    if (platform === 'backend' && backend === 'rust') throw new Error('Direct Rust consumers use the core repository; omit the backend destination');
    const repository = repositoryName(destination);
    const key = repository.toLowerCase();
    const plan = plans.get(key) ?? { repository, tag, source, platforms: [], assets: [] };
    const artifact = join(directory, `rust-inside-${platform}`);
    const entries = (await readdir(artifact, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name, 'en'));
    const assets = [];
    for (const entry of entries) {
      if (platform === 'ios' && entry.name === 'swift-package' && entry.isDirectory()) continue;
      if (platform === 'flutter' && entry.name === 'flutter-package' && entry.isDirectory()) continue;
      if (!entry.isFile() || !assetName.test(entry.name)) throw new Error(`Invalid release asset ${platform}/${entry.name}`);
      if (plan.assets.some(asset => asset.name === entry.name)) throw new Error(`Duplicate release asset ${repository}/${entry.name}`);
      const path = join(artifact, entry.name);
      assets.push({ path, name: entry.name, digest: await fileDigest(path) });
    }
    if (!assets.length) throw new Error(`No assets in rust-inside-${platform}`);
    if (platform === 'backend' && backend === 'jvm') {
      const jars = assets.filter(asset => asset.name.endsWith(`-jvm-${version}.jar`));
      if (jars.length !== 1 || !assets.some(asset => asset.name === jars[0].name.replace(/\.jar$/, '.xml'))) {
        throw new Error('JVM backend requires a versioned JAR and its matching Gradle Ivy descriptor');
      }
    }
    if (platform === 'ios') {
      const archives = assets.filter(asset => asset.name.endsWith('.xcframework.zip'));
      if (archives.length !== 1) throw new Error('iOS artifact must have one *.xcframework.zip');
      plan.swift = await swiftPackage(join(artifact, 'swift-package'), archives[0], plan.repository, tag);
    }
    if (platform === 'flutter') {
      const suffix = `-flutter-${version}.tar.gz`;
      const archives = assets.filter(asset => asset.name.endsWith(suffix));
      if (archives.length !== 1) throw new Error('Flutter artifact must have one versioned Flutter package archive');
      const library = archives[0].name.slice(0, -suffix.length).replaceAll('-', '_') + '_flutter';
      plan.flutter = await flutterPackage(join(artifact, 'flutter-package'), library);
    }
    plan.platforms.push(platform);
    plan.assets.push(...assets);
    plans.set(key, plan);
  }
  for (const plan of plans.values()) {
    const fingerprint = sha256(JSON.stringify({
      source, tag, platforms: plan.platforms,
      assets: plan.assets.map(({ name, digest }) => [name, digest]),
      swift: plan.swift,
      flutter: plan.flutter?.map(({ path, mode, digest }) => [path, mode, digest]),
    }));
    plan.marker = `<!-- rust-inside:${fingerprint} -->`;
  }
  return [...plans.values()];
}

export function githubClient(token, request = fetch) {
  if (!token) throw new Error('Set RUST_INSIDE_RELEASE_TOKEN with Contents write access to the destination repositories');
  return async (method, path, body, { missing = false } = {}) => {
    const url = new URL(path, 'https://api.github.com');
    if (!['https://api.github.com', 'https://uploads.github.com'].includes(url.origin)) {
      throw new Error(`Unexpected GitHub API host ${url.origin}`);
    }
    const binary = body instanceof Blob;
    const response = await request(url, {
      method, redirect: 'error',
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token}`,
        'X-GitHub-Api-Version': '2022-11-28',
        'Content-Type': binary ? 'application/octet-stream' : 'application/json',
      },
      body: binary || body === undefined ? body : JSON.stringify(body),
    });
    if (missing && response.status === 404) return null;
    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      throw new Error(`${method} ${url.pathname} returned HTTP ${response.status}${error.message ? ` (${error.message})` : ''}`);
    }
    return response.status === 204 ? null : response.json();
  };
}

async function findRelease(api, path, tag) {
  const released = await api('GET', `${path}/releases/tags/${tag}`, undefined, { missing: true });
  if (released) return released;
  // GitHub's tag lookup is for published releases. Authenticated lists also include drafts.
  for (let page = 1; ; page++) {
    const releases = await api('GET', `${path}/releases?per_page=100&page=${page}`);
    const draft = releases.find(release => release.tag_name === tag);
    if (draft || releases.length < 100) return draft;
  }
}

function assetMatches(asset, uploaded) {
  return uploaded?.name === asset.name && uploaded.state === 'uploaded' && uploaded.digest === `sha256:${asset.digest}`;
}

async function preflight(api, plan) {
  const path = `/repos/${plan.repository}`;
  const repository = await api('GET', path);
  const release = await findRelease(api, path, plan.tag);
  const reference = await api('GET', `${path}/git/ref/tags/${plan.tag}`, undefined, { missing: true });
  if (release && !release.body?.includes(plan.marker)) throw new Error(`${plan.repository} ${plan.tag} belongs to another build`);
  if (reference && (!release || reference.object.sha !== release.target_commitish)) {
    throw new Error(`${plan.repository} ${plan.tag} points at a different commit`);
  }
  if (release && !release.draft && !reference) throw new Error(`${plan.repository} ${plan.tag} is missing its Git tag`);
  for (const asset of plan.assets) {
    const uploaded = release?.assets.find(item => item.name === asset.name);
    if (release?.draft && !reference && uploaded?.state === 'starter') continue;
    if ((uploaded || release && !release.draft) && !assetMatches(asset, uploaded)) {
      throw new Error(`${plan.repository} ${plan.tag} has a conflicting ${asset.name}`);
    }
  }
  return { ...plan, path, release, reference, branch: repository.default_branch };
}

async function createDraft(api, plan) {
  const { path, branch, tag, repository, source, marker } = plan;
  const parent = await api('GET', `${path}/commits/${encodeURIComponent(branch)}`);
  let target = parent.sha;
  if (plan.swift || plan.flutter) {
    const entries = [...(plan.swift ?? [])];
    // The Pub Git dependency resolves the complete package from the tag. Use Git
    // blobs for native binaries; tree entries with inline content are UTF-8 only.
    for (const file of plan.flutter ?? []) {
      const bytes = await readFile(file.local);
      if (sha256(bytes) !== file.digest) throw new Error(`Package file changed during release: ${file.path}`);
      const blob = await api('POST', `${path}/git/blobs`, { encoding: 'base64', content: bytes.toString('base64') });
      entries.push({ path: file.path, mode: file.mode, type: 'blob', sha: blob.sha });
    }
    // Keep the destination's documentation alongside a fresh package tree.
    const root = await api('GET', `${path}/git/trees/${parent.commit.tree.sha}`);
    const generatedRoots = new Set(entries.map(entry => entry.path.split('/')[0]));
    for (const { path, mode, type, sha } of root.tree) {
      if (type === 'blob' && mode.startsWith('100') && packageDocument.test(path) && !generatedRoots.has(path)) {
        entries.push({ path, mode, type, sha });
      }
    }
    const tree = await api('POST', `${path}/git/trees`, { tree: entries });
    const commit = await api('POST', `${path}/git/commits`, {
      message: `Platform packages ${tag}\n\nCore: ${source}`,
      tree: tree.sha, parents: [target], author: releaseIdentity, committer: releaseIdentity,
    });
    target = commit.sha;
  }
  console.log(`Creating draft ${repository} ${tag}`);
  return api('POST', `${path}/releases`, {
    tag_name: tag, target_commitish: target, name: tag, draft: true,
    body: `Core: ${source}\n\nPackages: ${plan.platforms.join(', ')}\n\n${marker}`,
  });
}

export async function publishDistribution(api, plans) {
  const destinations = await Promise.all(plans.map(plan => preflight(api, plan)));
  for (const plan of destinations) {
    plan.release ??= await createDraft(api, plan);
    if (!plan.release.draft) continue;
    for (const asset of plan.assets) {
      const existing = plan.release.assets.find(item => item.name === asset.name);
      if (assetMatches(asset, existing)) continue;
      if (existing?.state === 'starter') await api('DELETE', `${plan.path}/releases/assets/${existing.id}`);
      const upload = new URL(plan.release.upload_url.split('{')[0]);
      upload.searchParams.set('name', asset.name);
      const uploaded = await api('POST', upload, await openAsBlob(asset.path));
      if (!assetMatches(asset, uploaded)) throw new Error(`Upload verification failed for ${plan.repository}/${asset.name}`);
    }
  }
  // Stage every destination before exposing any release. GitHub publishes releases one repository at a time.
  for (const plan of destinations) {
    if (plan.release.draft && !plan.reference) {
      await api('POST', `${plan.path}/git/refs`, { ref: `refs/tags/${plan.tag}`, sha: plan.release.target_commitish });
    }
  }
  const published = [];
  for (const plan of destinations) {
    const release = plan.release.draft
      ? await api('PATCH', `${plan.path}/releases/${plan.release.id}`, { draft: false })
      : plan.release;
    published.push(release.html_url);
    console.log(`${plan.platforms.join(', ')}: ${release.html_url}`);
  }
  return published;
}

async function main() {
  const plans = await planDistribution({
    version: process.env.RUST_INSIDE_VERSION,
    backend: process.env.RUST_INSIDE_BACKEND,
    source: process.env.RUST_INSIDE_SOURCE,
    directory: resolve(process.argv[2] ?? 'sdk-artifacts'),
    destinations: Object.fromEntries(platforms.map(platform => [platform, process.env[`${platform.toUpperCase()}_REPOSITORY`]])),
  });
  const dryRun = process.env.RUST_INSIDE_DRY_RUN === 'true';
  const summary = plans.map(plan => {
    const link = `https://github.com/${plan.repository}` + (dryRun ? '' : `/releases/tag/${plan.tag}`);
    const files = plan.assets.map(asset => '`' + asset.name + '`').join(', ');
    return `- ${plan.platforms.join(', ')} → [${plan.repository}](${link}) · ${plan.tag} · ${files}`;
  });
  if (plans.length === 0) {
    summary.push('No package destinations configured. Skipping distribution.');
    console.log(summary[0]);
  } else if (dryRun) console.log(JSON.stringify(plans.map(({ repository, tag, assets }) => ({ repository, tag, assets: assets.map(asset => asset.name) })), null, 2));
  else await publishDistribution(githubClient(process.env.RUST_INSIDE_RELEASE_TOKEN), plans);
  if (process.env.GITHUB_STEP_SUMMARY) {
    await appendFile(process.env.GITHUB_STEP_SUMMARY, `## ${dryRun ? 'Release plan' : 'Published SDKs'}\n\n${summary.join('\n')}\n`);
  }
}

if (import.meta.main ?? (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))) {
  main().catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
