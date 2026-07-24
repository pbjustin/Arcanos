import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const repositoryRoot = path.resolve(import.meta.dirname, '..');
const compiledContractsPath = path.join(
  repositoryRoot,
  'dist',
  'services',
  'localAgent',
  'contracts.js'
);
const outputPaths = [
  path.join(
    repositoryRoot,
    'packages',
    'protocol',
    'schemas',
    'v1',
    'local-agent',
    'capability-catalog.generated.json'
  ),
  path.join(
    repositoryRoot,
    'daemon-python',
    'arcanos',
    'local_agent',
    'capability-catalog.generated.json'
  )
];
const checkOnly = process.argv.includes('--check');

const contracts = await import(pathToFileURL(compiledContractsPath).href);
const catalog = {
  schemaVersion: 'local-agent-capability-catalog-v1',
  module: contracts.LOCAL_AGENT_MODULE_NAME,
  actions: contracts.LOCAL_AGENT_ACTIONS.map(
    (action) => contracts.LOCAL_AGENT_CAPABILITY_CATALOG[action]
  )
};
const serialized = `${JSON.stringify(catalog, null, 2)}\n`;

if (checkOnly) {
  for (const outputPath of outputPaths) {
    let current = '';
    try {
      current = await readFile(outputPath, 'utf8');
    } catch {
      process.stderr.write(`Missing generated catalog: ${outputPath}\n`);
      process.exitCode = 1;
    }
    if (current && current !== serialized) {
      process.stderr.write(
        `Generated local-agent capability catalog is out of sync: ${outputPath}\n`
      );
      process.exitCode = 1;
    }
  }
} else {
  for (const outputPath of outputPaths) {
    await mkdir(path.dirname(outputPath), { recursive: true });
    await writeFile(outputPath, serialized, 'utf8');
    process.stdout.write(`${outputPath}\n`);
  }
}
