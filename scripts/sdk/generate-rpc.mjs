import { mkdir, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generate } from './generate.mjs';
import { writeSpringRpcServer } from './rpc-spring.mjs';
import { writeSwiftRpcPackage } from './rpc-swift.mjs';

export async function generateRpc(manifestFile, outputDirectory) {
  const output = resolve(outputDirectory);
  await mkdir(output, { recursive: true });
  if ((await readdir(output)).length) throw new Error(`Choose an empty directory for RPC generation: ${output}`);

  const sdk = await generate(manifestFile, join(output, 'jvm'), { rpc: true });
  await writeSpringRpcServer(join(output, 'spring'), sdk);
  await writeSwiftRpcPackage(join(output, 'swift'), sdk);
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
