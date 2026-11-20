import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { copyFile, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { flutterDartSource } from './flutter-dart.mjs';

const [workspace, version, natives, output] = process.argv.slice(2);
if (!output || !/^\d+\.\d+\.\d+$/.test(version)) {
  throw new Error('Usage: flutter-package.mjs <generated workspace> <X.Y.Z> <native libraries> <output>');
}
const sdk = JSON.parse(await readFile(join(workspace, 'sdk.json'), 'utf8'));
const { name, flutterLibrary: library, flutterPackage: pkg } = sdk;
const dest = join(resolve(output), 'flutter-package');
await mkdir(dest, { recursive: true });
if ((await readdir(dest)).length) throw new Error(`Use an empty Flutter package directory: ${dest}`);
const license = join(workspace, 'LICENSE');
if (existsSync(license)) await copyFile(license, join(dest, 'LICENSE'));
for (const slice of ['android-arm', 'android-arm64', 'android-x64', 'ios-arm64', 'ios-sim-arm64', 'ios-sim-x64']) {
  const ext = slice.startsWith('ios') ? 'dylib' : 'so';
  await mkdir(join(dest, 'native', slice), { recursive: true });
  await copyFile(join(natives, `${name}-${slice}.${ext}`), join(dest, 'native', slice, `lib${library}.${ext}`));
}
await mkdir(join(dest, 'lib'));
await mkdir(join(dest, 'hook'));
await writeFile(join(dest, 'lib', pkg + '.dart'), flutterDartSource(sdk));
await writeFile(join(dest, 'pubspec.yaml'), `name: ${pkg}
description: Mobile Flutter bindings for the ${name} Rust library.
version: ${version}
publish_to: none
environment:
  sdk: '>=3.10.0 <4.0.0'
dependencies:
  code_assets: ^1.0.0
  hooks: ^1.0.0
  ffi: ^2.1.4
`);
await writeFile(join(dest, 'hook', 'build.dart'), `import 'package:code_assets/code_assets.dart';
import 'package:hooks/hooks.dart';

void main(List<String> args) async {
  await build(args, (input, output) async {
    if (!input.config.buildCodeAssets) return;
    final config = input.config.code;
    final slice = switch ((config.targetOS, config.targetArchitecture)) {
      (OS.android, Architecture.arm) => 'android-arm',
      (OS.android, Architecture.arm64) => 'android-arm64',
      (OS.android, Architecture.x64) => 'android-x64',
      (OS.iOS, Architecture.x64) when config.iOS.targetSdk == IOSSdk.iPhoneSimulator => 'ios-sim-x64',
      (OS.iOS, Architecture.arm64) => config.iOS.targetSdk == IOSSdk.iPhoneSimulator
          ? 'ios-sim-arm64' : 'ios-arm64',
      _ => throw UnsupportedError('Unsupported target for ${pkg}: \${config.targetOS} \${config.targetArchitecture}'),
    };
    final suffix = config.targetOS == OS.iOS ? 'dylib' : 'so';
    final file = input.packageRoot.resolve('native/\$slice/lib${library}.\$suffix');
    output.dependencies.add(file);
    output.assets.code.add(CodeAsset(
      package: input.packageName,
      name: '${pkg}.dart',
      linkMode: DynamicLoadingBundled(),
      file: file,
    ));
  });
}
`);
const archive = resolve(output, `${name}-flutter-${version}.tar.gz`);
// Write a reproducible archive so retries have the same release digest.
const python = `
import gzip, pathlib, sys, tarfile
root = pathlib.Path(sys.argv[1])
with open(sys.argv[2], 'wb') as raw, gzip.GzipFile(fileobj=raw, mode='wb', filename='', mtime=0) as stream, tarfile.open(mode='w|', fileobj=stream) as tar:
    for path in sorted(root.rglob('*')):
        if path.is_file():
            info = tarfile.TarInfo(path.relative_to(root).as_posix())
            info.size = path.stat().st_size
            with path.open('rb') as file:
                tar.addfile(info, file)
`;
execFileSync('python3', ['-c', python, dest, archive]);
console.log(basename(archive));
