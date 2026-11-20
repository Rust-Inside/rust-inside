import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { appendFile, copyFile, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generate, parseManifest } from './generate.mjs';

// Build the Swift package whose binaries will be installed over Git. The
// multi-platform workflow uses build-apple.sh to produce a release-asset URL.
async function build(manifestFile, packageDirectory) {
  const config = parseManifest(JSON.parse(await readFile(manifestFile, 'utf8')));
  if (Object.keys(config.repositories).some(platform => platform !== 'ios')) {
    throw new Error('This workflow publishes iOS only. For other destinations use templates/release.yml.');
  }
  if (!config.repositories.ios) return;
  const crate = resolve(dirname(manifestFile), config.crate);
  const cwd = dirname(crate);
  const scratch = await mkdtemp(join(tmpdir(), 'rust-inside-ios-'));
  try {
    const ensureLock = fileURLToPath(new URL('./ensure-cargo-lock.sh', import.meta.url));
    execFileSync('bash', [ensureLock, crate], { cwd, stdio: 'inherit' });
    const sdk = await generate(manifestFile, scratch);
    if (!sdk.repositories.ios) return;
    const host = execFileSync('rustc', ['--print', 'host-tuple'], { cwd, encoding: 'utf8' }).trim();
    execFileSync('cargo', ['test', '--locked', '--workspace', '--target', host, '--manifest-path', crate], { cwd, stdio: 'inherit' });
    const scoped = join(scratch, 'platforms', 'ios');
    let mobile = crate;
    if (!sdk.uniffiManifest) mobile = join(existsSync(scoped) ? scoped : scratch, 'mobile', 'Cargo.toml');
    const builder = fileURLToPath(new URL('./build-uniffi-ios.sh', import.meta.url));
    execFileSync('bash', [builder, mobile, resolve(packageDirectory)], { cwd, stdio: 'inherit' });
    if (existsSync(join(scratch, 'LICENSE'))) {
      const framework = (await readdir(packageDirectory)).find(name => name.endsWith('.xcframework'));
      await copyFile(join(scratch, 'LICENSE'), join(packageDirectory, framework, 'LICENSE'));
    }
    if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, `repository=${sdk.repositories.ios}\n`);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

if (process.argv.length !== 4) throw new Error('Usage: build-ios-package.mjs <manifest> <new Swift package directory>');
await build(resolve(process.argv[2]), resolve(process.argv[3]));
