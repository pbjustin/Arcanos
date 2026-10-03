import { afterEach, describe, expect, it } from '@jest/globals';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

type Json = ReturnType<typeof JSON.parse>;
const roots: string[] = [];
const script = path.join(process.cwd(), 'scripts/compose-gaming-skill.mjs');
const migration = path.join(process.cwd(), 'scripts/tutor-migration.mjs');
const skillPath = 'skills/arcanos-gaming/SKILL.md';
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const readJson = (file: string): Json => JSON.parse(readFileSync(file, 'utf8'));
const writeJson = (file: string, value: Json) => writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
const mockInstructions = [
  '## Mock Gaming π\r\nMock original question and player context. queryGamingHybridKnowledge first.',
  'Mock answer_ready clarification_required discovery_required verify_currentness ingestion_pending.\r\nsubmitGamingHybridCandidates with workflowId contractVersion and a new operation key.',
  'Mock canaryArcanosGaming with action "canary" and payload.scope "public_pipeline".',
  'Mock getGamingSourceIngestionStatus; ingestGamingSources; refreshGamingSources; ingestGamingHybridCandidates.',
  'Mock legacy queryArcanosGaming must retain hybrid limits. Supplied-guide failure is not grounding.\r\nMock preserve uncertainty and stop on source failure.'
].join('\r\n\r\n');

function fixture(instructions = mockInstructions) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'arcanos-gaming-composition-'));
  roots.push(root);
  expect(spawnSync('git', ['init', '--quiet', root], { windowsHide: true }).status).toBe(0);
  writeFileSync(path.join(root, '.gitignore'), '.local-migration/\n');
  const inputRoot = path.join(root, '.local-migration/arcanos-gaming');
  mkdirSync(inputRoot, { recursive: true });
  const published = { schemaVersion: 1, publication: { status: 'published', version: 'mock-v1', publishedAt: '2026-09-28T00:00:00Z' },
    displayName: 'Arcanos Gaming', description: 'Synthetic Gaming fixture', instructions,
    conversationStarters: [], enabledCapabilities: ['Web Search'], actions: [{ name: 'mock-action', authType: 'api_key',
      schema: { openapi: '3.1.0', components: { securitySchemes: { mockAuth: { type: 'http', scheme: 'bearer' } } } } }],
    sharingStatus: 'private', representativeBehavior: ['Mock hybrid-first expectation.'], knowledge: [] };
  writeJson(path.join(inputRoot, 'published-gpt.json'), published);
  const code = `import {captureBaseline} from ${JSON.stringify(pathToFileURL(migration).href)}; console.log(JSON.stringify(await captureBaseline(process.argv[1])));`;
  const captured = spawnSync(process.execPath, ['--input-type=module', '-e', code, inputRoot], { encoding: 'utf8' });
  expect(captured.status).toBe(0);
  const baseline = JSON.parse(captured.stdout);
  baseline.status = 'VERIFIED';
  baseline.publicationReview = { reviewedBy: 'mock owner', reviewedAt: '2026-09-28T00:00:00Z', latestPublishedConfirmed: true, evidenceIds: ['mock-owner-confirmation'] };
  const baselinePath = path.join(root, 'baseline.inventory.json');
  writeJson(baselinePath, baseline);
  const fingerprint = hash(JSON.stringify({ configuration: baseline.configuration.sha256, knowledge: [] }));
  writeJson(path.join(inputRoot, 'owner-baseline-review.json'), { schemaVersion: 1, status: 'VERIFIED',
    baselineFingerprint: fingerprint, configuration: baseline.configuration, approval: baseline.publicationReview,
    authType: 'api_key', schemaDeclaredScheme: 'bearer', starters: 0, knowledgeFiles: 0 });
  return { root, inputRoot, baselinePath, baseline, fingerprint };
}
type Fixture = ReturnType<typeof fixture>;
function compose(f: Fixture, output = 'mock-composed', args: string[] = []) {
  return spawnSync(process.execPath, [script, '--inputs', f.inputRoot, '--baseline', f.baselinePath, '--output', output, ...args], { encoding: 'utf8' });
}
function mutate(file: string, callback: (value: Json) => void) { const value = readJson(file); callback(value); writeJson(file, value); }

afterEach(() => {
  for (const root of roots.splice(0)) {
    if (path.dirname(root) !== path.resolve(os.tmpdir()) || !path.basename(root).startsWith('arcanos-gaming-composition-')) throw new Error('Unexpected fixture path');
    rmSync(root, { recursive: true, force: true });
  }
});

describe('Private Gaming source composition, separate from live acceptance', () => {
  it('provides an exact public v2 replacement recipe without composing or approving missing private inputs', () => {
    const code = `const {gamingRecoveryCompositionPatch,gamingRules}=await import(${JSON.stringify(pathToFileURL(script).href)}); console.log(JSON.stringify({patch:await gamingRecoveryCompositionPatch(),rules:gamingRules}));`;
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', code], { encoding: 'utf8' });
    expect(result.status).toBe(0);
    const { patch, rules } = JSON.parse(result.stdout);
    expect(patch.status).toBe('PROPOSED_NOT_OWNER_APPROVED');
    expect(patch.approvedSkillBaseline).toEqual({ sizeBytes: 15_210,
      sha256: 'a2cd3cfb2eb677eaef47c7fc148b41565b58e051486a49b29df48ee53c048081' });
    const workflow = readFileSync(path.join(process.cwd(), patch.workflow.path));
    expect(workflow.length).toBe(9_046);
    expect(hash(workflow)).toBe('2f8f4d08442674d014a0e36a2dc1e19b6628092199697720355bd6a1ed98c6be');
    expect(patch.workflow.sizeBytes).toBe(workflow.length);
    expect(patch.workflow.sha256).toBe(hash(workflow));
    expect(patch.workflow.content).toBe(workflow.toString('utf8'));
    expect(patch.replacement.operation).toBe('replace_exactly_one_complete_marked_workflow');
    for (const replacement of patch.ruleReplacements) {
      expect(rules.find((rule: Json) => rule.id === replacement.id).text).toBe(replacement.before);
      expect(replacement.after).not.toBe(replacement.before);
    }
    expect(patch.requirements).toContain('Verify actual private baseline size and hash before applying.');
    expect(patch.requirements).toContain('Preserve all unrelated baseline bytes and owner-approval records unchanged.');
    expect(patch.requirements).toContain('Do not update the installed plugin or assign release readiness from this recipe.');
    const proposed = patch.workflow.content + patch.ruleReplacements.map((rule: Json) => rule.after).join('\n');
    for (const name of proposed.match(/\barcanos_gaming_[a-z_]+\b/gu) ?? []) {
      const contract = readJson(path.join(process.cwd(), 'packages/protocol/schemas/v1/tools/arcanos-gaming/contract.schema.json'));
      expect(Object.keys(contract.tools)).toContain(name);
    }
    for (const text of ['expectedRevision', 'replacementAllowed', 'continuationRequired', 'gapAssessmentStatus',
      'selectedCandidateIds', 'selectedEvidenceIds', 'coverageSatisfied', 'requirementSupport',
      'six distinct', '24 seconds', 'same workflowId', 'Actually use available Web Search',
      'private player information', 'provider timed out', 'Keep surrounding punctuation outside hyperlink targets']) {
      expect(proposed).toContain(text);
    }
    expect(proposed.indexOf('arcanos_gaming_hybrid_query')).toBeLessThan(proposed.indexOf('Actually use available Web Search'));
    expect(proposed).not.toContain('queryGamingHybridKnowledge');
    expect(proposed).not.toContain('submitGamingHybridCandidates');
    const publicV1 = readFileSync(path.join(process.cwd(), 'docs/gpt/arcanos-gaming-hybrid.instructions.md'));
    expect(publicV1.length).toBe(7_796);
    expect(hash(publicV1)).toBe('8a30dad3b83cced79724b58fb21d3f9d538c29f89779f090cd54b1cbdc99e406');
    const f = fixture();
    expect(compose(f).status).toBe(0);
    const legacy = readFileSync(path.join(f.inputRoot, 'mock-composed', skillPath), 'utf8');
    expect(legacy).toContain('under gaming-hybrid-v1');
    expect(legacy).toContain('Respect one gameplay round');
    expect(legacy).not.toContain('gaming-hybrid-v2');
  });

  it('binds approved source, preserves every UTF-8/CRLF section and produces deterministic private files', () => {
    const f = fixture();
    const before = readFileSync(path.join(f.inputRoot, 'published-gpt.json'));
    const first = compose(f);
    expect(first.status).toBe(0);
    const a = JSON.parse(first.stdout);
    const second = compose(f, 'mock-second');
    expect(second.status).toBe(0);
    const b = JSON.parse(second.stdout);
    expect(a.baselineFingerprint).toBe(f.fingerprint);
    expect(b.skill).toEqual(a.skill);
    expect(b.files).toEqual(a.files);
    expect(b.contentFingerprint).toBe(a.contentFingerprint);
    expect(readFileSync(path.join(f.inputRoot, 'published-gpt.json'))).toEqual(before);
    expect(first.stdout).not.toContain('Mock original question');
    const report = readJson(path.join(f.inputRoot, 'mock-composed/reconciliation-map.json'));
    const skill = readFileSync(path.join(f.inputRoot, 'mock-composed', skillPath));
    expect(report.sectionMap.map((item: Json) => item.sourceText).join('')).toBe(mockInstructions);
    let sourceOffset = 0;
    for (const section of report.sectionMap) {
      expect(section.sourceStartByte).toBe(sourceOffset);
      expect(hash(section.sourceText)).toBe(section.sha256);
      expect(Buffer.from(mockInstructions).subarray(section.sourceStartByte, section.sourceEndByte)).toEqual(Buffer.from(section.sourceText));
      expect(skill.subarray(section.outputStartByte, section.outputEndByte)).toEqual(Buffer.from(section.transformedText));
      expect(hash(section.transformedText)).toBe(section.outputSha256);
      sourceOffset = section.sourceEndByte;
    }
    expect(sourceOffset).toBe(Buffer.byteLength(mockInstructions));
    expect(report.compositionReview).toEqual({ status: 'PENDING', approvedForRepository: false });
    expect(compose(f, 'mock-composed', ['--inspect', '--expected-skill-sha256', a.skill.sha256,
      '--expected-content-fingerprint', a.contentFingerprint]).status).toBe(0);
  });

  it('maps precisely the eight implemented tools with traceable transformations and no authority expansion', () => {
    const f = fixture();
    expect(compose(f).status).toBe(0);
    const report = readJson(path.join(f.inputRoot, 'mock-composed/reconciliation-map.json'));
    const contract = readJson(path.join(process.cwd(), 'packages/protocol/schemas/v1/tools/arcanos-gaming/contract.schema.json'));
    expect(report.toolMappings.map((item: Json) => item.mcpOperation).sort()).toEqual(Object.keys(contract.tools).sort());
    expect(report.toolMappings).toHaveLength(8);
    expect(report.toolMappings.every((item: Json) => item.occurrences === 1)).toBe(true);
    expect(report.toolMappings.filter((item: Json) => item.effect === 'durable_write').map((item: Json) => item.mcpOperation).sort())
      .toEqual(['arcanos_gaming_ingest_candidates', 'arcanos_gaming_ingest_sources', 'arcanos_gaming_refresh_sources']);
    const skill = readFileSync(path.join(f.inputRoot, 'mock-composed', skillPath), 'utf8');
    for (const item of report.toolMappings) expect(skill).not.toContain(item.oldAction);
    expect(skill).not.toContain('payload.scope');
    expect(skill).toContain('empty input object {}');
    expect(skill).toContain('no legacy action/payload envelope');
    expect(skill).toContain('arcanos:gaming:query');
    expect(skill).toContain('arcanos:gaming:sources:write');
    expect(skill).toContain('ask_before_store');
    expect(skill).toContain('confirmStore true');
    expect(skill).toContain('shared Gaming corpus');
    expect(skill).toContain('Server-verified identity');
    expect(report.sectionMap.flatMap((section: Json) => section.transformations).every((item: Json) => item.reason && item.intendedEffect)).toBe(true);
  });

  it('retains hybrid states and source-failure rules while mapping only the existing 18 behavior cases', () => {
    const f = fixture();
    expect(compose(f).status).toBe(0);
    const skill = readFileSync(path.join(f.inputRoot, 'mock-composed', skillPath), 'utf8');
    for (const state of ['answer_ready', 'clarification_required', 'discovery_required', 'verify_currentness', 'ingestion_pending']) expect(skill).toContain(state);
    for (const text of ['sourceKnown, evidenceSelected, freshnessStatus and successful generation',
      'HTTP 200 does not establish success', 'do not claim the guide was read', 'no guideUrls field',
      'cannot silently substitute unrelated sources', 'general model knowledge', 'untrusted evidence',
      'three source slots', 'three polls', 'operation-specific idempotency keys']) expect(skill).toContain(text);
    const report = readJson(path.join(f.inputRoot, 'mock-composed/reconciliation-map.json'));
    const matrix = readJson(path.join(process.cwd(), 'docs/chatgpt-migration/gaming/behavior-matrix.json'));
    expect(matrix.cases).toHaveLength(18);
    const ruleIds = report.rules.map((item: Json) => item.id);
    for (const item of matrix.cases) {
      expect(item.executionStatus).toBe('NOT_RUN');
      expect(item.composedRuleIds.length).toBeGreaterThan(0);
      for (const id of item.composedRuleIds) expect(ruleIds).toContain(id);
    }
    expect(report.reviewDecisions.every((item: Json) => item.status === 'PENDING')).toBe(true);
  });

  it.each(['unapproved', 'changed-source', 'wrong-fingerprint', 'wrong-configuration', 'wrong-owner', 'changed-auth', 'changed-schema-auth', 'wrong-count'])
  ('rejects %s without logging private content or creating output', failure => {
    const f = fixture();
    const ownerPath = path.join(f.inputRoot, 'owner-baseline-review.json');
    if (failure === 'unapproved') mutate(f.baselinePath, value => { value.status = 'BLOCKED'; });
    if (failure === 'changed-source') mutate(path.join(f.inputRoot, 'published-gpt.json'), value => { value.instructions += '\nPRIVATE MOCK CHANGE'; });
    if (failure === 'wrong-fingerprint') mutate(ownerPath, value => { value.baselineFingerprint = hash('wrong'); });
    if (failure === 'wrong-configuration') mutate(ownerPath, value => { value.configuration.sha256 = hash('wrong'); });
    if (failure === 'wrong-owner') mutate(ownerPath, value => { value.approval.reviewedBy = 'wrong'; });
    if (failure === 'changed-auth') mutate(ownerPath, value => { value.authType = 'oauth'; });
    if (failure === 'changed-schema-auth') mutate(ownerPath, value => { value.schemaDeclaredScheme = 'basic'; });
    if (failure === 'wrong-count') mutate(ownerPath, value => { value.knowledgeFiles = 1; });
    const result = compose(f);
    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toBe('GAMING_COMPOSITION_INVALID: no private input contents or filesystem details are logged.\n');
    expect(readdirSync(f.inputRoot)).not.toContain('mock-composed');
  });

  it.each([skillPath, 'reconciliation-map.json', 'review-summary.md', 'candidate-manifest.json'])('rejects tampered %s at inspection', file => {
    const f = fixture();
    expect(compose(f).status).toBe(0);
    const target = path.join(f.inputRoot, 'mock-composed', file);
    writeFileSync(target, `${readFileSync(target, 'utf8')}\nSynthetic alteration.\n`);
    expect(compose(f, 'mock-composed', ['--inspect']).status).toBe(1);
  });

  it('confines exclusive output to ignored private directories and rejects extra files or stale hashes', () => {
    const f = fixture();
    expect(compose(f, '../escape').status).toBe(1);
    expect(compose(f, path.join(f.root, 'escape')).status).toBe(1);
    expect(compose(f).status).toBe(0);
    expect(compose(f).status).toBe(1);
    expect(compose(f, 'mock-composed', ['--inspect', '--expected-skill-sha256', hash('wrong')]).status).toBe(1);
    writeFileSync(path.join(f.inputRoot, 'mock-composed/extra.txt'), 'Mock extra.');
    expect(compose(f, 'mock-composed', ['--inspect']).status).toBe(1);
    writeFileSync(path.join(f.root, '.gitignore'), '');
    expect(compose(f, 'unignored').status).toBe(1);
  });

  it('rejects credentials before composition, including in an otherwise reviewed instruction source', () => {
    const f = fixture();
    mutate(path.join(f.inputRoot, 'published-gpt.json'), value => { value.instructions += `\nBearer ${'X'.repeat(32)}`; });
    const result = compose(f);
    expect(result.status).toBe(1);
    expect(result.stdout + result.stderr).not.toContain('X'.repeat(32));
  });

  it('rejects linked output ancestors and unresolved legacy envelopes without writing outside the private root', () => {
    const f = fixture();
    const outside = path.join(f.root, 'outside');
    mkdirSync(outside);
    symlinkSync(outside, path.join(f.inputRoot, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
    expect(compose(f, 'linked/escaped').status).toBe(1);
    expect(readdirSync(outside)).toEqual([]);
    const unresolved = fixture(`${mockInstructions}\r\n\r\nMock Action still requires action "query" and payload.`);
    expect(compose(unresolved).status).toBe(1);
    expect(readdirSync(unresolved.inputRoot)).not.toContain('mock-composed');
  });

  it('performs preparation offline with backend acceptance blocked and cannot yield release or an app-bound package', () => {
    const f = fixture();
    // No connection or runtime configuration exists. Network use would fail this subprocess.
    const code = `globalThis.fetch=()=>{throw new Error('NETWORK_FORBIDDEN')}; const {composeGamingSkill}=await import(${JSON.stringify(pathToFileURL(script).href)}); console.log(JSON.stringify(await composeGamingSkill(JSON.parse(process.argv[1]))));`;
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', code,
      JSON.stringify({ inputRoot: f.inputRoot, baselineInventoryPath: f.baselinePath, outputDirectory: 'mock-composed' })], { encoding: 'utf8' });
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    const summary = JSON.parse(result.stdout);
    expect(summary.compositionStatus).toBe('COMPOSED_PENDING_OWNER_REVIEW');
    expect(summary.backendAcceptance).toBe('BLOCKED');
    expect(summary.ownerArtifactReview).toBe('PENDING');
    expect(summary.packageStatus).toBe('BLOCKED');
    expect(summary.releaseStatus).toBe('BLOCKED');
    const manifest = readJson(path.join(f.inputRoot, 'mock-composed/candidate-manifest.json'));
    expect(manifest.appId).toBeNull();
    expect(manifest.pluginId).toBeNull();
    expect(manifest.releaseId).toBeNull();
    expect(summary.files.map((item: Json) => item.path).sort()).toEqual([skillPath, 'reconciliation-map.json', 'review-summary.md', 'candidate-manifest.json'].sort());
    expect(compose(f, 'release', ['--release']).status).toBe(1);
    const adapterSource = readFileSync(script, 'utf8');
    expect(adapterSource).not.toMatch(/\bfetch\s*\(|https?:\/\/|node:(?:http|https|net)|from ['"](?:pg|openai|axios|redis)['"]/u);
    expect(adapterSource.match(/spawnSync\(/gu)).toHaveLength(2);
    expect(adapterSource.match(/spawnSync\('git'/gu)).toHaveLength(2);
  });
});
