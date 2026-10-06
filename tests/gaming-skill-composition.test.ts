import { afterEach, describe, expect, it } from '@jest/globals';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { gamingHybridCandidatesSchema, gamingHybridQuerySchema } from '../src/shared/gaming/gamingHybridContract.js';
import { resolveGamingRequestEdition } from '../src/shared/gaming/gamingGameIdentity.js';

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

function recoveryComposition(scenario = 'valid') {
  const code = `
    import {readFileSync} from 'node:fs';
    import {createHash} from 'node:crypto';
    import {gamingRecoveryCompositionPatch,applyGamingRecoveryCompositionPatch,legacyGamingRules as gamingRules}
      from ${JSON.stringify(pathToFileURL(script).href)};
    const hash = bytes => createHash('sha256').update(bytes).digest('hex');
    globalThis.fetch = () => { throw new Error('NETWORK_FORBIDDEN'); };
    const recipe = await gamingRecoveryCompositionPatch();
    const publicV1 = readFileSync('docs/gpt/arcanos-gaming-hybrid.instructions.md', 'utf8');
    let source = '\\uFEFFSynthetic unrelated π prefix.\\r\\n\\r\\n' + publicV1 +
      '\\r\\nSynthetic retained middle.\\r\\n' + gamingRules.map(rule =>
        '### ' + rule.id + '\\r\\n\\r\\n' + rule.text).join('\\r\\n\\r\\n') +
      '\\r\\n\\r\\nSynthetic unrelated suffix.\\r\\n';
    const scenario = process.argv[1];
    if (scenario === 'absent begin') source = source.replace(recipe.replacement.begin, 'Synthetic absent marker.');
    if (scenario === 'absent end') source = source.replace(recipe.replacement.end, 'Synthetic absent marker.');
    if (scenario === 'duplicate workflow') source += publicV1;
    if (scenario === 'reversed markers') source = source.replace(recipe.replacement.begin, 'Synthetic marker swap')
      .replace(recipe.replacement.end, recipe.replacement.begin).replace('Synthetic marker swap', recipe.replacement.end);
    if (scenario === 'inline begin') source = source.replace(recipe.replacement.begin, 'inline ' + recipe.replacement.begin);
    if (scenario === 'inline end') source = source.replace(recipe.replacement.end, 'inline ' + recipe.replacement.end);
    if (scenario === 'missing safeguard') source = source.replace(recipe.ruleReplacements[0].before, 'Synthetic missing safeguard.');
    if (scenario === 'duplicate safeguard') source += recipe.ruleReplacements[0].before;
    if (scenario === 'existing replacement safeguard') source += recipe.ruleReplacements[0].after;
    if (scenario === 'overlapping safeguard') source = source.replace(recipe.ruleReplacements[0].before, '')
      .replace(recipe.replacement.begin, recipe.replacement.begin + '\\n' + recipe.ruleReplacements[0].before);
    if (scenario === 'mixed v2 baseline') source += recipe.workflow.content;
    let bytes = Buffer.from(source, 'utf8');
    if (scenario === 'invalid UTF-8') bytes = Buffer.concat([bytes, Buffer.from([255])]);
    // This is a synthetic pinned descriptor, never the actual approved private baseline.
    recipe.approvedSkillBaseline = {sizeBytes:bytes.length,sha256:hash(bytes)};
    if (scenario === 'changed pinned bytes') bytes = Buffer.concat([bytes, Buffer.from('Synthetic changed source.')]);
    if (scenario === 'wrong baseline digest') recipe.approvedSkillBaseline.sha256 = '0'.repeat(64);
    if (scenario === 'wrong baseline size') recipe.approvedSkillBaseline.sizeBytes += 1;
    if (scenario === 'conflicting safeguard') recipe.ruleReplacements[0].after += 'Synthetic conflicting guard.';
    if (scenario === 'duplicate recipe rule') recipe.ruleReplacements[1] = recipe.ruleReplacements[0];
    if (scenario === 'wrong workflow digest') recipe.workflow.sha256 = '0'.repeat(64);
    if (scenario === 'changed workflow bytes') recipe.workflow.content += 'Synthetic changed workflow.';
    if (scenario === 'wrong contract') recipe.contractVersion = 'gaming-hybrid-v1';
    if (scenario === 'wrong marker recipe') recipe.replacement.begin = 'Synthetic alternate marker.';
    if (scenario === 'non-byte baseline') bytes = source;
    try {
      const inputBefore = Buffer.from(bytes);
      const first = applyGamingRecoveryCompositionPatch(bytes, recipe);
      const second = applyGamingRecoveryCompositionPatch(bytes, recipe);
      let sourceOffset = 0, outputOffset = 0, preserved = true;
      const restored = [];
      for (const change of first.replacements) {
        const oldGap = bytes.subarray(sourceOffset, change.sourceStartByte);
        const newGap = first.bytes.subarray(outputOffset, change.outputStartByte);
        preserved = preserved && oldGap.equals(newGap);
        restored.push(newGap, bytes.subarray(change.sourceStartByte, change.sourceEndByte));
        sourceOffset = change.sourceEndByte;
        outputOffset = change.outputEndByte;
      }
      preserved = preserved && bytes.subarray(sourceOffset).equals(first.bytes.subarray(outputOffset));
      restored.push(first.bytes.subarray(outputOffset));
      console.log(JSON.stringify({status:first.status,contractVersion:first.contractVersion,
        deterministic:first.bytes.equals(second.bytes) && first.sha256 === second.sha256 &&
          JSON.stringify(first.replacements) === JSON.stringify(second.replacements),
        preserved,reversible:Buffer.concat(restored).equals(bytes),inputUntouched:bytes.equals(inputBefore),
        replacements:first.replacements.length,sizeMatches:first.sizeBytes === first.bytes.length,
        hashMatches:first.sha256 === hash(first.bytes),v1MarkersRemoved:!first.bytes.includes(Buffer.from(recipe.replacement.begin)),
        v2WorkflowCount:first.bytes.toString('utf8').split('WORKFLOW BEGIN gaming-hybrid-v2').length - 1}));
    } catch (error) { console.error(error.message); process.exitCode = 1; }
  `;
  return spawnSync(process.execPath, ['--input-type=module', '-e', code, scenario], { encoding: 'utf8' });
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    if (path.dirname(root) !== path.resolve(os.tmpdir()) || !path.basename(root).startsWith('arcanos-gaming-composition-')) throw new Error('Unexpected fixture path');
    rmSync(root, { recursive: true, force: true });
  }
});

describe('Private Gaming source composition, separate from live acceptance', () => {
  it('applies the actual public recipe to synthetic pinned bytes with deterministic, reversible preservation', () => {
    const result = recoveryComposition();
    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    expect(JSON.parse(result.stdout)).toEqual({ status: 'PROPOSED_NOT_OWNER_APPROVED',
      contractVersion: 'gaming-hybrid-v2', deterministic: true, preserved: true, reversible: true,
      inputUntouched: true, replacements: 9, sizeMatches: true, hashMatches: true,
      v1MarkersRemoved: true, v2WorkflowCount: 1 });
  });

  it.each(['absent begin', 'absent end', 'duplicate workflow', 'reversed markers', 'inline begin', 'inline end',
    'missing safeguard', 'duplicate safeguard', 'existing replacement safeguard', 'overlapping safeguard', 'mixed v2 baseline', 'invalid UTF-8',
    'changed pinned bytes', 'wrong baseline digest', 'wrong baseline size', 'conflicting safeguard',
    'duplicate recipe rule', 'wrong workflow digest', 'changed workflow bytes', 'wrong contract',
    'wrong marker recipe', 'non-byte baseline'])('blocks v2 composition for %s without revealing source text', scenario => {
    const result = recoveryComposition(scenario);
    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toBe('GAMING_RECOVERY_COMPOSITION_INVALID\n');
  });

  it('provides an exact public v2 replacement recipe without composing or approving missing private inputs', () => {
    const code = `const {gamingRecoveryCompositionPatch,legacyGamingRules:gamingRules}=await import(${JSON.stringify(pathToFileURL(script).href)}); console.log(JSON.stringify({patch:await gamingRecoveryCompositionPatch(),rules:gamingRules}));`;
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', code], { encoding: 'utf8' });
    expect(result.status).toBe(0);
    const { patch, rules } = JSON.parse(result.stdout);
    expect(patch.status).toBe('PROPOSED_NOT_OWNER_APPROVED');
    expect(patch.approvedSkillBaseline).toEqual({ sizeBytes: 15_210,
      sha256: 'a2cd3cfb2eb677eaef47c7fc148b41565b58e051486a49b29df48ee53c048081' });
    const workflow = readFileSync(path.join(process.cwd(), patch.workflow.path));
    expect(workflow.length).toBe(11_314);
    expect(hash(workflow)).toBe('c20289819f4ac70e2fa96385a17ecdc780db44b2b3707182780dfed39f1f3edb');
    expect(workflow.toString('utf8')).toContain('revision as expectedRevision');
    expect(workflow.toString('utf8')).toContain('do not restart acquisition');
    expect(workflow.toString('utf8')).toContain('Released Gaming guide workflow: gaming-hybrid-v2.');
    expect(workflow.toString('utf8')).not.toContain('Proposed MCP instruction revision');
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
    expect(legacy).toContain('under released gaming-hybrid-v2');
    expect(legacy).toContain('expectedRevision');
    expect(legacy).not.toContain('under gaming-hybrid-v1');
  });

  it('uses the released v2 default output without approving or installing the candidate', () => {
    const f = fixture();
    const result = spawnSync(process.execPath, [script, '--inputs', f.inputRoot, '--baseline', f.baselinePath], { encoding: 'utf8' });
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ outputDirectory: 'composed-skill-v2', ownerArtifactReview: 'PENDING', releaseStatus: 'BLOCKED' });
    const skill = readFileSync(path.join(f.inputRoot, 'composed-skill-v2', skillPath), 'utf8');
    expect(skill).toContain('Set contractVersion to\n   "gaming-hybrid-v2"');
    expect(skill).toContain('expectedRevision');
  });

  it('composes released URL-only discovery without demanding harmless edition or source metadata', () => {
    const f = fixture();
    expect(compose(f).status).toBe(0);
    const skill = readFileSync(path.join(f.inputRoot, 'mock-composed', skillPath), 'utf8').replace(/\s+/gu, ' ');
    for (const text of [
      'The frontend discovers public guide URLs; ARCANOS independently acquires, validates and structures those documents',
      'Forward edition only if the user explicitly supplied it; do not ask for an edition merely because it is absent.',
      "Ordinary Elden Ring requests use the backend's safe base-game interpretation.",
      'Explicit Shadow of the Erdtree or DLC requests retain their expansion constraints',
      'URL-only candidates are sufficient input',
      'do not demand frontend proof of edition, patch, platform, region, publisher or publication date',
      'Unknown is not wrong.',
      'Missing patch, platform, region or date normally qualifies an answer',
      'never turn that uncertainty into a fabricated fact.',
      'strict independent currentness checks'
    ]) expect(skill).toContain(text);
    expect(skill).not.toContain('the precise game and edition');
    const query = gamingHybridQuerySchema.parse({ contractVersion: 'gaming-hybrid-v2',
      idempotencyKey: 'released-samurai-query', game: 'Elden Ring', mode: 'build', question: 'Build an early-game Samurai blade build.' });
    expect(query.edition).toBeUndefined();
    expect(resolveGamingRequestEdition(query)).toBe('base-game');
    expect(resolveGamingRequestEdition({ ...query, question: 'Build a Shadow of the Erdtree Samurai build.' })).toBe('shadow of the erdtree');
    expect(resolveGamingRequestEdition({ ...query, question: 'Build a DLC Samurai build.' })).toBeUndefined();
    const submission = gamingHybridCandidatesSchema.parse({ contractVersion: query.contractVersion,
      workflowId: '20000000-0000-4000-8000-000000000020', expectedRevision: 1,
      idempotencyKey: 'released-guide-submission', candidates: [{ url: 'https://guides.example.org/early-samurai' }] });
    expect(submission.candidates).toEqual([{ url: 'https://guides.example.org/early-samurai' }]);
  });

  it('composes four frontend outcomes while retaining authoritative actions, revisions, budgets and approval boundaries', () => {
    const f = fixture();
    const source = readFileSync(path.join(f.inputRoot, 'published-gpt.json'));
    expect(compose(f).status).toBe(0);
    const skill = readFileSync(path.join(f.inputRoot, 'mock-composed', skillPath), 'utf8').replace(/\s+/gu, ' ');
    expect(skill).toContain("Read the structured result's frontendOutcome together with state, nextAction, contractVersion, workflowId and revision.");
    expect(skill).toContain('Its four normal frontend concepts are answer_ready, need_new_source, clarification_required and temporarily_unavailable.');
    for (const text of [
      "use the backend's searchHint when provided",
      'discover a replacement only when nextAction and the bounded continuation grant permit it',
      'the missing user decision materially changes the answer',
      'Missing harmless metadata is not a reason to ask an extra question',
      'The compatible wire state, nextAction, revision and recovery budgets remain authoritative',
      'frontendOutcome never grants another attempt or bypasses nextAction stop',
      'latest returned revision as expectedRevision',
      'remainingCandidateUrls and remainingTotalAcquisitionMs permit it',
      'Never silently downgrade failed v2 to a new v1 workflow',
      'Keep source storage separate and transient_only by default',
      'dedicated write scope, client confirmation and server-side eligibility checks remain intact'
    ]) expect(skill).toContain(text);
    const report = readJson(path.join(f.inputRoot, 'mock-composed/reconciliation-map.json'));
    expect(report.compositionReview).toEqual({ status: 'PENDING', approvedForRepository: false });
    expect(report.acceptance.installedBehavior).toBe('NOT_STARTED');
    expect(readFileSync(path.join(f.inputRoot, 'published-gpt.json'))).toEqual(source);
  });

  it('replaces the canonical legacy workflow while preserving unrelated source sections and approval boundaries', () => {
    const publicV1 = readFileSync(path.join(process.cwd(), 'docs/gpt/arcanos-gaming-hybrid.instructions.md'), 'utf8');
    const source = `${mockInstructions}\r\n\r\n${publicV1.replaceAll('\n', '\r\n')}\r\nRetained unrelated suffix π.`;
    const f = fixture(source);
    expect(compose(f).status).toBe(0);
    const skill = readFileSync(path.join(f.inputRoot, 'mock-composed', skillPath), 'utf8');
    const report = readJson(path.join(f.inputRoot, 'mock-composed/reconciliation-map.json'));
    expect(report.contractVersion).toBe('gaming-hybrid-v2');
    expect(report.sectionMap.map((item: Json) => item.sourceText).join('')).toBe(source);
    expect(skill.split('WORKFLOW BEGIN gaming-hybrid-v2')).toHaveLength(2);
    expect(skill).not.toContain('WORKFLOW BEGIN gaming-hybrid-v1');
    expect(skill).toContain('Retained unrelated suffix π.');
    expect(skill).toContain('latest returned revision as');
    expect(skill).toContain('Never silently downgrade');
    expect(report.compositionReview.approvedForRepository).toBe(false);
    expect(report.acceptance.installedBehavior).toBe('NOT_STARTED');
    const bytes = Buffer.from(skill);
    for (const section of report.sectionMap) {
      expect(bytes.subarray(section.outputStartByte, section.outputEndByte).toString('utf8')).toBe(section.transformedText);
      expect(hash(section.sourceText)).toBe(section.sha256);
    }
  });

  it.each(['gaming-hybrid-v1', 'WORKFLOW BEGIN gaming-hybrid-v2'])('rejects unmarked or mixed source protocol %s', declaration => {
    const f = fixture(`${mockInstructions}\r\n\r\n${declaration}`);
    expect(compose(f).status).toBe(1);
    expect(readdirSync(f.inputRoot)).not.toContain('mock-composed');
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
      'HTTP 200', 'do not claim the guide was read', 'schema fields',
      'silently satisfy', 'general model knowledge', 'untrusted evidence',
      'three source slots', 'three polls', 'operation-specific idempotency']) expect(skill).toContain(text);
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
