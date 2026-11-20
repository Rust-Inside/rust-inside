import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { generate } from './generate.mjs';

test('the Flutter adapter calls typed Rust functions and keeps distinct client instances', async t => {
  const root = await mkdtemp(join(tmpdir(), 'rust-inside-flutter-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'src'));
  await writeFile(join(root, 'Cargo.toml'), '[package]\nname = "flutter-fixture"\nversion = "0.1.0"\nedition = "2021"\n[workspace]\n');
  const notice = 'Sample library license notice.\n';
  await writeFile(join(root, 'LICENSE'), notice);
  await writeFile(join(root, 'src/lib.rs'), 'pub mod api;\n');
  await writeFile(join(root, 'src/api.rs'), `
pub fn precision(value: u64) -> u64 { value }
pub fn float(value: f64) -> f64 { value }
pub fn strings(value: Vec<String>) -> Vec<String> { value }

pub struct Profile { pub display_name: String }
pub struct Session { name: String }
impl Session {
    pub fn new(name: String) -> Self { Self { name } }
    pub async fn profile(&self) -> Result<Profile, String> {
        if self.name.is_empty() { return Err("no session".into()); }
        Ok(Profile { display_name: self.name.clone() })
    }
}
`);
  const manifest = join(root, 'rust-inside.json');
  await writeFile(manifest, JSON.stringify({ backend: 'rust', repositories: { flutter: 'team/flutter' }, api: 'src/api.rs' }));
  const generated = join(root, 'sdk');
  await generate(manifest, generated);
  const flutter = join(generated, 'platforms/flutter');
  const sdk = JSON.parse(await readFile(join(flutter, 'sdk.json')));
  const target = resolve(process.env.CARGO_TARGET_DIR ?? join(root, 'target'));
  const host = execFileSync('rustc', ['--print', 'host-tuple'], { encoding: 'utf8' }).trim();
  execFileSync('cargo', ['build', '--locked', '--lib', '--manifest-path', join(flutter, 'flutter/Cargo.toml'),
    '--target', host, '--target-dir', target]);
  const extension = process.platform === 'darwin' ? 'dylib' : 'so';
  const library = join(target, host, 'debug', `lib${sdk.flutterLibrary}.${extension}`);
  const python = `
import ctypes, json, sys
dll = ctypes.CDLL(sys.argv[1])
invoke = getattr(dll, sys.argv[2] + '_call')
release = getattr(dll, sys.argv[2] + '_free')
invoke.argtypes = [ctypes.c_char_p]
invoke.restype = ctypes.c_void_p
release.argtypes = [ctypes.c_void_p]
release.restype = None
def call(method, *args):
    result = invoke(json.dumps([method, *args]).encode())
    try:
        return json.loads(ctypes.string_at(result))
    finally:
        release(result)
assert call('precision', str(2**64 - 1)) == {'value': str(2**64 - 1)}
assert call('float', 'Infinity') == {'value':'inf'}
assert call('strings', ['한글', 'a\\0b']) == {'value':['한글', 'a\\0b']}
first, second, missing = [call('Session.new', name)['value'] for name in ['a', 'b', '']]
assert call('Session.profile', first) == {'value': {'displayName':'a'}}
assert call('Session.profile', second) == {'value': {'displayName':'b'}}
assert call('Session.profile', missing) == {'error':'no session'}
assert call('_close', first) == {'value': None}
assert 'error' in call('Session.profile', first)
`;
  execFileSync('python3', ['-c', python, library, sdk.flutterLibrary]);

  const nativeDir = join(root, 'native');
  const dist = join(root, 'dist');
  await mkdir(nativeDir);
  for (const slice of ['android-arm.so', 'android-arm64.so', 'android-x64.so', 'ios-arm64.dylib', 'ios-sim-arm64.dylib', 'ios-sim-x64.dylib']) {
    await writeFile(join(nativeDir, `${sdk.name}-${slice}`), slice);
  }
  const script = fileURLToPath(new URL('./flutter-package.mjs', import.meta.url));
  execFileSync(process.execPath, [script, flutter, '1.2.3', nativeDir, dist]);
  const tree = join(dist, 'flutter-package');
  const dart = await readFile(join(tree, 'lib', sdk.flutterPackage + '.dart'), 'utf8');
  assert.match(dart, /Future<Profile> profile\(\)/);
  assert.match(dart, /BigInt precision\(BigInt value\)/);
  assert.match(dart, /List<String> strings\(List<String> value\)/);
  const tar = execFileSync('tar', ['tzf', join(dist, sdk.name + '-flutter-1.2.3.tar.gz')], { encoding: 'utf8' });
  assert.equal(await readFile(join(tree, 'LICENSE'), 'utf8'), notice);
  assert.equal(execFileSync('tar', ['xOzf', join(dist, sdk.name + '-flutter-1.2.3.tar.gz'), 'LICENSE'], { encoding: 'utf8' }), notice);
  assert.equal(tar.trim().split('\n').length, 10);
  assert.match(tar, /native\/ios-sim-arm64\/libflutter_fixture_flutter\.dylib/);
});
