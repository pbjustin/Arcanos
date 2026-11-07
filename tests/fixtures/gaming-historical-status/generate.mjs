// Offline only: replay committed pure producers with synthetic content, never stored customer records.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';
import { z } from 'zod/v3';

const repo = resolve(fileURLToPath(new URL('../../../', import.meta.url)));
const commits = ['ca45f623', '8186e253', 'e5c88eae', '741b00a8', 'cd8da153'];
const paths = {
  policy: 'src/shared/gaming/gamingClearPolicy.ts',
  ingestion: 'src/services/gamingSourceIngestion.ts',
  freshness: 'src/shared/gaming/gamingFreshnessCore.ts',
  resources: 'src/services/gamingBuildResourceSchema.ts',
  identity: 'src/shared/gaming/gamingGameIdentity.ts'
};
const hash = value => createHash('sha256').update(value).digest('hex');
const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trimEnd();
const sourceAt = (commit, path) => git('show', `${commit}:${path}`);

/** Keep original named declarations; no historical application entry points or imports execute. */
function declarations(source, names) {
  const ast = ts.createSourceFile('historical.ts', source, ts.ScriptTarget.Latest, true);
  const found = new Set();
  const selected = ast.statements.filter(statement => {
    const declared = ts.isVariableStatement(statement)
      ? statement.declarationList.declarations.map(declaration => declaration.name.getText(ast))
      : statement.name ? [statement.name.getText(ast)] : [];
    if (!declared.some(name => names.includes(name))) return false;
    declared.forEach(name => found.add(name));
    return true;
  }).map(statement => statement.getText(ast)).join('\n');
  for (const name of names) if (!found.has(name)) throw new Error(`Missing historical declaration: ${name}`);
  return selected;
}

function evaluate(source, bindings = {}) {
  const result = { exports: {} };
  const compiled = ts.transpileModule(source, { compilerOptions: {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS
  } }).outputText;
  const context = vm.createContext({ z, createHash, ...bindings, exports: result.exports, module: result });
  new vm.Script(compiled).runInContext(context, { timeout: 2_000 });
  return result.exports;
}

const fixtures = [];
for (const abbreviation of commits) {
  const commit = git('rev-parse', abbreviation);
  const sources = Object.fromEntries(Object.entries(paths).map(([key, path]) => [key, sourceAt(commit, path)]));
  // The assessed content/context are synthetic. Registry context creation/classification is not invoked.
  const policyAst = ts.createSourceFile('policy.ts', sources.policy, ts.ScriptTarget.Latest, true);
  const policySlice = policyAst.statements.filter(statement => !ts.isImportDeclaration(statement)
    && !(['identityRegistry', 'gamingClearContextFingerprint', 'classifyGamingClearQuestion'].includes(
      ts.isVariableStatement(statement) ? statement.declarationList.declarations[0].name.getText(policyAst)
        : statement.name?.getText(policyAst)))).map(statement => statement.getText(policyAst)).join('\n');
  const policy = evaluate(policySlice);
  const dimension = { status: 'evaluated', score: 4.5, reasonCodes: ['SYNTHETIC_SUPPORTED_SOURCE'],
    evidenceRefs: ['history-fixture-source'], unresolvedFacts: [] };
  const assessment = policy.createGamingClearAssessment({
    profile: 'source', questionProfile: 'walkthrough', sourceRole: 'gameplay_guide',
    subjectId: 'history-fixture-source', subjectHash: hash('synthetic historical content'),
    contextFingerprint: hash('synthetic historical context'), evidenceRefs: ['history-fixture-source'],
    gates: { identity: 'verified', compatibility: 'verified', claimSupport: 'verified', freshness: 'not_applicable',
      provenance: 'verified', security: 'verified' },
    dimensions: Object.fromEntries(['clarity', 'leverage', 'efficiency', 'alignment', 'resilience'].map(name => [name, dimension])),
    evaluatedAt: '2026-09-09T12:00:00.000Z'
  });
  if (!policy.parseGamingClearAssessment(assessment) || !assessment.qualityEligible) {
    throw new Error(`Historical assessment did not pass its own policy: ${commit}`);
  }
  const freshness = declarations(sources.freshness, ['GAMING_FRESHNESS_POLICY_VERSION', 'GAMING_SOURCE_POLICY_VERSION']);
  const resources = declarations(sources.resources, ['GAMING_RESOURCE_TYPES']);
  let identity = declarations(sources.identity, ['normalizeGamingGameIdentity']);
  const fixturePaths = { ...paths };
  if (identity.includes('normalizeGamingRegistryIdentity')) {
    fixturePaths.registry = 'src/shared/gaming/gamingGameRegistry.ts';
    identity = `${declarations(sourceAt(commit, fixturePaths.registry), ['normalizeGamingRegistryIdentity'])}\n${identity}`;
  }
  const names = ['MAX_SOURCE_URLS', 'IDEMPOTENCY_KEY_MAX_CHARS', 'SOURCE_ID_PATTERN', 'allowedSourceTypeHints',
    'sourceTypeHintSchema', 'queuedSourceSchema', 'admissionErrorSchema', 'rejectedSourceSchema',
    'queuedGamingIngestionBodySchema', 'sha256', 'stableJson', 'canonicalGameKey',
    'resolveExplicitIdempotencyKey', 'createApprovedGamingSourceIngestion'];
  const producer = evaluate([freshness, resources, identity, declarations(sources.ingestion, names),
    'export { queuedGamingIngestionBodySchema };'].join('\n'), {
    parseGamingClearAssessment: policy.parseGamingClearAssessment,
    // URL admission and job enqueue are capture boundaries, not replayed network/storage operations.
    admitUrl: url => ({ source: url }),
    buildGatewayValidationError: message => { throw new Error(message); },
    enqueueGamingIngestion: body => body
  });
  const actorKey = 'history-fixture-owner';
  const supportsApplicability = sources.ingestion.includes('applicabilityContext?:');
  const source = {
    url: 'https://example.com/copper-vale-guide', game: 'Copper Vale',
    contentHash: assessment.subjectHash, policyVersion: 'gaming-hybrid-candidates/v1', actorScopeHash: hash(actorKey),
    sourceTrustType: 'supplied', recordType: 'guide', freshness: {}, sourceAssessment: assessment,
    ...(supportsApplicability ? { applicabilityContext: { game: 'Copper Vale', mode: 'guide', classification: 'stable',
      seasonalPatchRequired: false, historical: false, contextFingerprint: assessment.contextFingerprint } } : {})
  };
  const body = await producer.createApprovedGamingSourceIngestion([source], 'historical-fixture-idempotency',
    { actorKey, canStore: true });
  producer.queuedGamingIngestionBodySchema.parse(body);
  fixtures.push({
    provenance: { commit, blobs: Object.fromEntries(Object.entries(fixturePaths).map(([key, path]) => [key,
      { path, blob: git('rev-parse', `${commit}:${path}`) }])),
      generation: 'Committed CLEAR factory and original approved-ingestion producer, validated by their original schemas; synthetic inputs and capture-only admission/enqueue.' },
    actorKey, body
  });
}
writeFileSync(new URL('./records.json', import.meta.url), `${JSON.stringify(fixtures, null, 2)}\n`);
console.log(`Generated ${fixtures.length} history-derived producer fixtures.`);
