import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const [metadata, platform, project] = process.argv.slice(2);
const compileTask = {
  backend: 'compileTestKotlin',
  android: ':compileReleaseUnitTestKotlin',
}[platform];
if (!metadata || !project || !compileTask) {
  throw new Error('Usage: write-kotlin-api-check.mjs <sdk.json> <backend|android> <Gradle project>');
}

const sdk = JSON.parse(await readFile(metadata, 'utf8'));
const names = sdk.requiredApi?.[platform];
if (names?.length) {
  const symbols = names.map((name, index) => {
    const [owner, method] = name.split('.');
    const alias = `RequiredSdkSymbol${index}`;
    return {
      import: `import ${sdk.kotlinPackage}.\`${owner}\` as ${alias}`,
      reference: method ? `${alias}::\`${method}\`` : `::${alias}`,
    };
  });
  const contractPackage = `${sdk.kotlinPackage}.contract`;
  const source = join(project, 'src/test/kotlin', ...contractPackage.split('.'));
  await mkdir(source, { recursive: true });
  await writeFile(join(source, 'RequiredSdkApi.kt'), `package ${contractPackage}

${symbols.map(symbol => symbol.import).join('\n')}

private val requiredRustInsideApi = listOf<kotlin.reflect.KFunction<*>>(
${symbols.map(symbol => `    ${symbol.reference},`).join('\n')}
)
`);
  console.log(compileTask);
}
