import { afterEach, describe, expect, it } from '@jest/globals';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { installedTeachingBinding } from '../scripts/tutor-installed-teaching.mjs';
import { installedTeachingFixture } from './helpers/tutor-installed-teaching-fixture.js';
type Json = ReturnType<typeof JSON.parse>;
const roots: string[] = [];
const helper = pathToFileURL(path.join(process.cwd(), 'scripts/tutor-installed-teaching.mjs')).href;
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
function fixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'arcanos-installed-teaching-'));
  roots.push(root);
  expect(spawnSync('git', ['init', '--quiet', root], { windowsHide: true }).status).toBe(0);
  writeFileSync(path.join(root, '.gitignore'), '.local-migration/\n');
  const inputRoot = path.join(root, '.local-migration/arcanos-tutor');
  mkdirSync(inputRoot, { recursive: true });
  writeFileSync(path.join(inputRoot, 'published-gpt.json'), JSON.stringify({ instructions: 'Mock private baseline.',
    representativeBehavior: ['Mock baseline behavior.'] }));
  const release = { status: 'VERIFIED', pluginId: 'plugin_d292d1e45ae08191b3911299e30e1a25', releaseId: 'pluginrel_mock_current',
    version: '0.8.5', approvedSkillSha256: hash('mock skill'), capture: { packageFingerprint: hash('mock package') }, visibility: 'PRIVATE' };
  return { root, inputRoot, release, ...installedTeachingFixture(inputRoot, release) };
}
type Fixture = ReturnType<typeof fixture>;
function run(f: Fixture, inspect = true) {
  const options = { inputRoot: f.inputRoot, record: f.record, release: f.release, evidence: [f.evidence], state: f.state };
  const code = `import {inspectInstalledTutorTeaching,validateInstalledTutorTeaching} from ${JSON.stringify(helper)};
    const o=JSON.parse(process.argv[1]);o.evidence=new Map(o.evidence.map(e=>[e.id,e]));
    try{console.log(JSON.stringify(${inspect ? 'await inspectInstalledTutorTeaching(o)' : 'validateInstalledTutorTeaching(o.record,o)'}));}
    catch(e){console.error(e.message);process.exitCode=1;}`;
  return spawnSync(process.execPath, ['--input-type=module', '-e', code, JSON.stringify(options)], { encoding: 'utf8' });
}
function refreshEvidence(f: Fixture) { f.evidence.installedTeachingBinding = installedTeachingBinding(f.record); }
afterEach(() => {
  for (const root of roots.splice(0)) {
    if (path.dirname(root) !== path.resolve(os.tmpdir()) || !path.basename(root).startsWith('arcanos-installed-teaching-')) throw new Error('Unexpected fixture path');
    rmSync(root, { recursive: true, force: true });
  }
});
describe('Current-release installed teaching evidence with visible UI assurance', () => {
  it('verifies eighteen actual cases and sixty artifacts without claiming server zero or planned parity', () => {
    const result = run(fixture());
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ teachingVerified: true, caseCount: 18, contentPasses: 18,
      plannedPromptDeviations: 7, visibleArcanosBackendCalls: 0, authoritativeBackendCalls: null,
      authoritativeZeroBackendCallsVerified: false, loadedSkillBytesPerTurnVerified: false,
      exactPlannedParityBindingEligible: false, inspectedArtifactCount: 60 });
  });
  it.each(['stale-release', 'stale-skill', 'missing-case', 'duplicate-case', 'failed-content', 'unexpected-call',
    'incomplete-ui', 'missing-source', 'unrelated-selected', 'hidden-memory', 'hidden-deviation', 'server-zero-claim',
    'runtime-byte-claim', 'parity-claim', 'reused-history', 'extra-submission', 'lost-variant', 'gate-evidence-mismatch'])(
    'rejects invalid or overstated current teaching evidence: %s', failure => {
      const f = fixture();
      const row = f.record.cases[0];
      if (failure === 'stale-release') f.release.releaseId = 'pluginrel_mock_newer';
      if (failure === 'stale-skill') f.release.approvedSkillSha256 = hash('mock newer skill');
      if (failure === 'missing-case') f.record.cases.pop();
      if (failure === 'duplicate-case') f.record.cases[1].id = row.id;
      if (failure === 'failed-content') row.contentResult = 'FAIL';
      if (failure === 'unexpected-call') row.visibleArcanosBackendCalls = 1;
      if (failure === 'incomplete-ui') row.completedVisibleTurn = false;
      if (failure === 'missing-source') row.sourceAttribution = 'UNKNOWN';
      if (failure === 'unrelated-selected') f.record.cases.find((r: Json) => r.id === 'UNRELATED_WRITING').selection = 'PLUGIN';
      if (failure === 'hidden-memory') f.record.cases.find((r: Json) => r.id === 'MEMORY_REQUEST').otherVisibleHostActivity = [];
      if (failure === 'hidden-deviation') row.planDeviation = false;
      if (failure === 'server-zero-claim') f.record.limits.authoritativeBackendCalls = 0;
      if (failure === 'runtime-byte-claim') f.record.limits.loadedSkillBytesPerTurnVerified = true;
      if (failure === 'parity-claim') f.record.limits.exactPlannedParityBindingEligible = true;
      if (failure === 'reused-history') f.evidence.installedTeachingBinding.releaseId = 'pluginrel_mock_historical';
      if (failure === 'extra-submission') row.submissionCount = 2;
      if (failure === 'lost-variant') f.record.cases.find((r: Json) => r.id === 'PRACTICE_GENERATION').responses.pop();
      if (failure === 'gate-evidence-mismatch') f.state.gates.TUTOR_SKILL_BEHAVIOR_VERIFIED.evidenceIds = ['mock-other'];
      expect(run(f, false).status).toBe(1);
    });
  it('rejects raw response drift even when no summary field changes', () => {
    const f = fixture();
    writeFileSync(path.join(f.inputRoot, f.record.cases[0].responses[0].path), 'mock changed response');
    expect(run(f).stderr).toContain('INSTALLED_TEACHING_ARTIFACT_CHANGED');
  });
  it.each(['content-failure', 'diagnostic-alternatives', 'routing-call', 'routing-incomplete', 'actual-prompt-drift'])(
    'rejects mismatched private review evidence even after rebinding its file hash: %s', failure => {
      const f = fixture();
      const inputKey = failure.startsWith('routing') ? 'routingReview' : failure === 'actual-prompt-drift' ? 'attempts' : 'contentReview';
      const reference = f.record.inputs[inputKey];
      const value = JSON.parse(readFileSync(path.join(f.inputRoot, reference.path), 'utf8'));
      if (failure === 'content-failure') value.cases[0].contentResult = 'FAIL';
      if (failure === 'diagnostic-alternatives') value.cases.find((r: Json) => r.id === 'DIAGNOSTIC_ASSESSMENT').noStackedAlternatives = false;
      if (failure === 'routing-call') value.cases[0].visibleArcanosBackendCalls = 1;
      if (failure === 'routing-incomplete') value.cases[0].completedVisibleTurn = false;
      if (failure === 'actual-prompt-drift') value[0].prompt = 'Mock unrelated replacement prompt';
      f.record.inputs[inputKey] = f.json(path.posix.basename(reference.path), value);
      refreshEvidence(f);
      expect(run(f).status).toBe(1);
    });
});
