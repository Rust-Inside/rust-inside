import { appendFileSync, readFileSync } from 'node:fs';
import { parseManifest } from './generate.mjs';
import { requireBackend } from './distribute.mjs';

const planning = process.argv[2] === '--plan';
const input = JSON.parse(readFileSync(process.argv[planning ? 3 : 2], 'utf8'));
const sdk = planning ? parseManifest(input) : input;
const backend = requireBackend(sdk.backend);
const repos = sdk.repositories ?? {};
const buildJvm = backend === 'jvm' && Boolean(repos.backend);
const buildNode = backend === 'node' && Boolean(repos.backend);
const builds = [];
if (repos.web || buildNode) {
  builds.push({ platform: 'js', runner: 'ubuntu-latest', targets: 'wasm32-unknown-unknown' });
}
if (repos.ios) {
  builds.push({ platform: 'ios', runner: 'macos-15', targets: 'aarch64-apple-ios aarch64-apple-ios-sim', jvm_native: buildJvm });
} else if (buildJvm) {
  // The JAR includes a macOS native library even when no iOS package is requested.
  builds.push({ platform: 'jvm-macos', runner: 'macos-15', jvm_native: true });
}
if (repos.android) {
  builds.push({ platform: 'android', runner: 'ubuntu-latest', targets: 'aarch64-linux-android x86_64-linux-android' });
}
if (repos.flutter) {
  builds.push(
    { platform: 'flutter-ios', runner: 'macos-15', targets: 'aarch64-apple-ios aarch64-apple-ios-sim x86_64-apple-ios' },
    { platform: 'flutter-android', runner: 'ubuntu-latest', targets: 'armv7-linux-androideabi aarch64-linux-android x86_64-linux-android' },
  );
}
if (buildJvm) {
  builds.push(
    { platform: 'jvm-x64', runner: 'ubuntu-22.04', jvm_native: true },
    { platform: 'jvm-arm64', runner: 'ubuntu-22.04-arm', jvm_native: true },
  );
}
const outputs = {
  backend,
  repositories: JSON.stringify(repos),
  has_packages: builds.length > 0,
  build_jvm: buildJvm,
  build_flutter: Boolean(repos.flutter),
  matrix: JSON.stringify({ include: builds }),
};
for (const [key, value] of Object.entries(outputs)) {
  appendFileSync(process.env.GITHUB_OUTPUT, key + '=' + value + '\n');
}

if (!builds.length) {
  const reason = planning ? 'No package repositories selected.' : 'No public API matches the selected package destinations.';
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, reason + ' Skipping package builds and distribution.\n');
} else if (!planning) {
  const targets = item => (item.platforms ?? Object.keys(repos)).filter(platform => repos[platform]);
  const signatures = sdk.exports.filter(api => targets(api).length).map(api => {
    const args = Object.entries(api.args).map(([name, type]) => name + ': ' + type).join(', ');
    return '- `' + api.jsName + '(' + args + ') -> ' + api.returns + '` ← `' + api.path + '` · ' + targets(api).join(', ');
  });
  const tag = 'v' + process.env.VERSION;
  const cargoRevision = process.env.GITHUB_REF === 'refs/tags/' + tag
    ? 'tag = ' + JSON.stringify(tag) : 'rev = ' + JSON.stringify(process.env.GITHUB_SHA);
  const cargo = 'core_sdk = { package = ' + JSON.stringify(sdk.corePackage)
    + ', git = "https://github.com/' + process.env.GITHUB_REPOSITORY + '.git", ' + cargoRevision + ' }';
  const summary = ['## ' + sdk.name + ' SDK', '', 'Backend: `' + sdk.backend + '`', '', ...signatures];
  for (const client of sdk.clients ?? []) {
    for (const method of client.methods) {
      const platforms = targets(method);
      if (!platforms.length) continue;
      const args = Object.entries(method.args).map(([name, type]) => name + ': ' + type).join(', ');
      summary.push('- `' + client.name + '.' + method.jsName + '(' + args + ') -> ' + method.returns + '`' + (method.async ? ' (async)' : '') + ' · ' + platforms.join(', '));
    }
  }
  if (buildJvm) {
    summary.push('', 'Gradle: `implementation("' + sdk.kotlinPackage + ':' + sdk.name + '-jvm:' + process.env.VERSION + '")`');
  }
  if (repos.flutter) {
    const name = sdk.name.replaceAll('-', '_') + '_flutter';
    summary.push('', 'Flutter (pubspec.yaml):', '', '```yaml', 'dependencies:', '  ' + name + ':', '    git:',
      '      url: https://github.com/' + repos.flutter + '.git', '      ref: ' + tag, '      path: flutter', '```');
  }
  summary.push('', 'Rust (Cargo.toml):', '', '```toml', cargo, '```', '');
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary.join('\n'));
}
