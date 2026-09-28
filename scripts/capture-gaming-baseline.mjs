import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkPluginPrivateBoundary } from './check-plugin-private-boundary.mjs';
import { baselineFingerprint, captureBaseline, noSymlinkAncestors, readSafeFile,
  requireCondition, validateBaseline } from './tutor-migration.mjs';

const repositoryRoot = fileURLToPath(new URL('../', import.meta.url));
const publicSourceBase = '8f31f3eb5c95af1919e5a36e780cfb75e011a7a9';
const publicSourceManifest = 'integrations/arcanos-gaming/public-source-baseline.json';
const operations = Object.freeze([
  ['post', '/gpt/arcanos-gaming', 'queryArcanosGaming'],
  ['post', '/gpt/arcanos-gaming/canary', 'canaryArcanosGaming'],
  ['post', '/gpt-access/gaming/sources/ingestions', 'ingestGamingSources'],
  ['post', '/gpt-access/gaming/sources/refreshes', 'refreshGamingSources'],
  ['get', '/gpt-access/gaming/sources/ingestions/{ingestionId}', 'getGamingSourceIngestionStatus'],
  ['post', '/gpt-access/gaming/sources/hybrid/query', 'queryGamingHybridKnowledge'],
  ['post', '/gpt-access/gaming/sources/hybrid/candidates', 'submitGamingHybridCandidates'],
  ['post', '/gpt-access/gaming/sources/hybrid/ingestions', 'ingestGamingHybridCandidates']
]);

function validateGamingConfiguration(configuration) {
  requireCondition(configuration.displayName === 'Arcanos Gaming' &&
    ['private', 'Only me'].includes(configuration.sharingStatus), 'GAMING_PRIVATE_IDENTITY_REQUIRED');
  requireCondition(configuration.actions.length === 1, 'GAMING_ACTION_REQUIRED');
  const action = configuration.actions[0];
  requireCondition(Object.keys(action).sort().join(',') === 'authType,name,schema' &&
    ['none', 'api_key', 'api_key_basic', 'api_key_bearer', 'oauth'].includes(action.authType), 'GAMING_ACTION_AUTH_TYPE_ONLY_REQUIRED');
  const schema = action.schema;
  requireCondition(schema.openapi === '3.1.0' && schema.info?.version === '1.5.0' &&
    schema['x-arcanos-gaming-hybrid-contract-version'] === 'gaming-hybrid-v1', 'GAMING_ACTION_VERSION_INVALID');
  requireCondition(schema.paths && typeof schema.paths === 'object' && !Array.isArray(schema.paths) &&
    Object.keys(schema.paths).length === operations.length, 'GAMING_ACTION_CATALOG_INVALID');
  for (const [method, route, operationId] of operations) {
    const item = schema.paths[route];
    requireCondition(item && Object.keys(item).join(',') === method &&
      item[method]?.operationId === operationId, 'GAMING_ACTION_CATALOG_INVALID');
  }
}

/** Reuse the #1509 capture/fingerprint contract; account publication and owner review remain separate. */
export async function captureGamingBaseline(inputRoot, { publicSources } = {}) {
  await checkPluginPrivateBoundary(inputRoot, 'arcanos-gaming', { publicSources });
  const inventory = await captureBaseline(inputRoot);
  const configuration = JSON.parse((await readSafeFile(inputRoot, 'published-gpt.json')).content);
  validateGamingConfiguration(configuration);
  validateBaseline(inventory);
  return { inventory, baselineFingerprint: baselineFingerprint(inventory) };
}

async function main() {
  const args = process.argv.slice(2);
  let inputRoot;
  let output;
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === '--inputs' && args[index + 1]) inputRoot = path.resolve(args[++index]);
    else if (args[index] === '--output' && args[index + 1]) output = path.resolve(args[++index]);
    else throw new Error('UNSUPPORTED_ARGUMENT');
  }
  requireCondition(inputRoot && output, 'INPUT_AND_OUTPUT_REQUIRED');
  await noSymlinkAncestors(inputRoot);
  await noSymlinkAncestors(path.dirname(output));
  requireCondition(!output.startsWith(`${inputRoot}${path.sep}`), 'OUTPUT_MUST_BE_SEPARATE');
  const publicSources = JSON.parse((await readSafeFile(repositoryRoot, publicSourceManifest)).content);
  requireCondition(publicSources.baseCommit === publicSourceBase, 'GAMING_PUBLIC_SOURCE_BASE_INVALID');
  const result = await captureGamingBaseline(inputRoot, { publicSources });
  // A sanitized inventory is still reviewed before publication; never replace prior evidence.
  await writeFile(output, `${JSON.stringify(result.inventory, null, 2)}\n`, { flag: 'wx' });
  process.stdout.write(`${JSON.stringify({ status: result.inventory.status,
    baselineFingerprint: result.baselineFingerprint, configurationSha256: result.inventory.configuration.sha256 })}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => {
    process.stderr.write('GAMING_BASELINE_INVALID: capture is incomplete or invalid; no private values are logged.\n');
    process.exitCode = 1;
  });
}
