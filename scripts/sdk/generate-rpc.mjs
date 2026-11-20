import { mkdir, readdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generate } from './generate.mjs';
import { writeSpringRpcServer } from './rpc-spring.mjs';
import { writeSwiftRpcPackage } from './rpc-swift.mjs';

async function checkRequiredRpcApi(output, sdk) {
  const { ios, backend } = sdk.requiredApi ?? {};
  if (ios) {
    const swift = await readFile(join(output, 'swift', 'Sources', sdk.module, 'RpcClient.swift'), 'utf8');
    for (const method of ios) {
      if (!swift.includes(`public func \`${method}\`(`)) {
        throw new Error(`Required iOS RPC method ${method} is missing from the generated Swift SDK`);
      }
    }
  }
  if (backend) {
    const spring = await readFile(join(output, 'spring', 'src/main/kotlin/dev/rustinside/rpc/Application.kt'), 'utf8');
    for (const method of backend) {
      if (!spring.includes(`@PostMapping(${JSON.stringify(`/rpc/${method}`)},`)) {
        throw new Error(`Required backend RPC method ${method} is missing its generated Spring route`);
      }
    }
  }
}

export async function generateRpc(manifestFile, outputDirectory) {
  const output = resolve(outputDirectory);
  await mkdir(output, { recursive: true });
  if ((await readdir(output)).length) throw new Error(`Choose an empty directory for RPC generation: ${output}`);

  const sdk = await generate(manifestFile, join(output, 'jvm'), { rpc: true });
  await writeSpringRpcServer(join(output, 'spring'), sdk);
  await writeSwiftRpcPackage(join(output, 'swift'), sdk);
  await checkRequiredRpcApi(output, sdk);
  return sdk;
}

if (import.meta.main ?? (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))) {
  if (process.argv.length !== 4) {
    console.error('Usage: node scripts/sdk/generate-rpc.mjs <rust-inside.json> <empty output directory>');
    process.exitCode = 1;
  } else {
    generateRpc(process.argv[2], process.argv[3]).then(sdk => {
      console.log(`Generated ${sdk.module} and Spring routes for ${sdk.exports.map(fn => fn.jsName).join(', ')}`);
    }).catch(error => {
      console.error(error.message);
      process.exitCode = 1;
    });
  }
}
