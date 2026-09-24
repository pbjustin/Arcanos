import { afterEach, describe, expect, it } from '@jest/globals';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

type Json = ReturnType<typeof JSON.parse>;
const script = path.join(process.cwd(), 'scripts/validate-arcanos-tutor-package.mjs');
const captureScript = path.join(process.cwd(), 'scripts/capture-tutor-baseline.mjs');
const source = path.join(process.cwd(), 'integrations/arcanos-tutor');
const skillPath = 'skills/arcanos-tutor/SKILL.md';
const temporaryRoots: string[] = [];
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const review = { reviewedBy: 'mock fixture reviewer', reviewedAt: '2026-09-24T00:00:00Z' };
function json(root: string, file: string): Json { return JSON.parse(readFileSync(path.join(root, file), 'utf8')); }
function write(root: string, file: string, value: Json) { writeFileSync(path.join(root, file), `${JSON.stringify(value, null, 2)}\n`); }
function edit(root: string, file: string, mutate: (value: Json) => void) { const value = json(root, file); mutate(value); write(root, file, value); }
function copyPackage(): string {
  const root = mkdtempSync(path.join(os.tmpdir(), 'arcanos-tutor-package-'));
  temporaryRoots.push(root);
  cpSync(source, root, { recursive: true });
  return root;
}
function validate(root = source, args: string[] = []) {
  return spawnSync(process.execPath, [script, '--root', root, ...args], { encoding: 'utf8' });
}
function artifact(root: string, file: string) {
  const bytes = readFileSync(path.join(root, file));
  return { path: file, sha256: hash(bytes), sizeBytes: bytes.length };
}
function fingerprints(root: string, baseline: Json) {
  const report = JSON.parse(validate(root).stdout);
  const oldFingerprint = hash(JSON.stringify({ configuration: baseline.configuration.sha256,
    knowledge: baseline.knowledge.map(({ name, sha256, sizeBytes }: Json) => ({ name, sha256, sizeBytes }))
      .sort((left: Json, right: Json) => left.name.localeCompare(right.name, 'en')) }));
  return { oldFingerprint, pluginFingerprint: report.packageFingerprint };
}
function completeFixture() {
  const root = copyPackage();
  const inputs = path.join(root, 'mock-private-inputs');
  mkdirSync(inputs);
  const instruction = 'Mock teaching personality: explain one small step, then invite one practice attempt.';
  write(inputs, 'published-gpt.json', { schemaVersion: 1,
    publication: { status: 'published', version: 'mock-v1', publishedAt: '2026-09-23T00:00:00Z' },
    displayName: 'ARCANOS TUTOR', description: 'Mock Tutor description', instructions: instruction,
    conversationStarters: ['Explain a fraction.'], enabledCapabilities: [], actions: [{ name: 'mock tutor', schema: { type: 'object' } }],
    sharingStatus: 'private', representativeBehavior: ['Clear short explanations.'], knowledge: [{ name: 'mock-notes.txt', path: 'mock-notes.txt' }] });
  writeFileSync(path.join(inputs, 'mock-notes.txt'), 'Mock reviewed reference: one half equals two quarters.\n');
  const captured = spawnSync(process.execPath, [captureScript, '--inputs', inputs, '--output', path.join(root, 'mock-baseline.json')], { encoding: 'utf8' });
  expect(captured.status).toBe(0);
  const baseline = json(root, 'mock-baseline.json');
  baseline.status = 'VERIFIED';
  baseline.publicationReview = { ...review, latestPublishedConfirmed: true, evidenceIds: ['mock-account-observation'] };
  write(root, 'baseline.inventory.json', baseline);
  const migrated = `---\nname: arcanos-tutor\ndescription: Mock migrated Tutor instructions.\n---\n${instruction}\n`;
  writeFileSync(path.join(inputs, 'migrated-skill.md'), migrated);
  writeFileSync(path.join(root, 'package', skillPath), `${readFileSync(path.join(root, 'package', skillPath), 'utf8')}\n${instruction}\n`);
  cpSync(path.join(root, 'package/plugin.json'), path.join(inputs, 'migrated-plugin.json'));
  cpSync(path.join(root, 'package/.app.json'), path.join(inputs, '.app.json'));
  const appId = json(root, 'connection.requirements.json').registeredAppId;
  const migration = { schemaVersion: 1, status: 'VERIFIED', registeredAppId: appId,
    skill: { ...artifact(inputs, 'migrated-skill.md'), ...review, approvedForRepository: true },
    metadata: artifact(inputs, 'migrated-plugin.json'), appMapping: artifact(inputs, '.app.json'), references: baseline.knowledge, warnings: [],
    accountReview: { ...review, confirmedMigrated: true, confirmedWarningsReviewed: true },
    instructionComparison: { status: 'VERIFIED', ...review, disposition: 'PASS', summary: 'Mock exact instruction preservation.',
      baselineInstructionsSha256: baseline.configuration.fields.instructions.sha256,
      migratedSkillSha256: hash(migrated), packagedSkillSha256: artifact(path.join(root, 'package'), skillPath).sha256 } };
  write(root, 'migration.inventory.json', migration);
  const referencePath = 'skills/arcanos-tutor/references/mock-notes.txt';
  mkdirSync(path.dirname(path.join(root, 'package', referencePath)), { recursive: true });
  cpSync(path.join(inputs, 'mock-notes.txt'), path.join(root, 'package', referencePath));
  write(root, 'reference-review.json', { schemaVersion: 1, references: [{ sourcePath: 'mock-notes.txt', packagePath: referencePath,
    sha256: baseline.knowledge[0].sha256, sizeBytes: baseline.knowledge[0].sizeBytes, approvedForRepository: true, ...review }] });
  edit(root, 'connection.requirements.json', connection => {
    connection.evidence.push({ id: 'mock-account-observation', kind: 'chatgpt', status: 'VERIFIED', observedAt: review.reviewedAt, summary: 'Synthetic account evidence; no actual migration.' });
    connection.evidence.push({ id: 'mock-repo-observation', kind: 'repository', status: 'VERIFIED', observedAt: review.reviewedAt, summary: 'Synthetic reviewed local fixture.' });
    connection.builderReconciliation = 'VERIFIED';
    connection.referenceReconciliation = 'VERIFIED';
  });
  const bindings = fingerprints(root, baseline);
  edit(root, 'parity-matrix.json', parity => {
    parity.status = 'VERIFIED';
    for (const item of parity.cases) {
      const summary = `Mock comparison for ${item.id}.`;
      item.oldGpt = { status: 'VERIFIED', summary, sha256: hash(summary), hashBasis: 'sanitized_summary', artifactSha256: baseline.configuration.sha256,
        configurationFingerprint: bindings.oldFingerprint, evidenceIds: ['mock-account-observation'] };
      item.plugin = { ...item.oldGpt, artifactSha256: migration.skill.sha256, configurationFingerprint: bindings.pluginFingerprint };
      for (const side of ['oldGpt', 'plugin']) {
        const id = `mock-parity-${item.id}-${side}`;
        item[side].evidenceIds = [id];
        edit(root, 'connection.requirements.json', connection => {
          connection.evidence.push({ id, kind: 'chatgpt', status: 'VERIFIED', observedAt: review.reviewedAt,
            summary: `Mock observed ${item.id} ${side} fixture only.`, parityBinding: { caseId: item.id, side,
              promptSha256: hash(item.prompt), configurationFingerprint: item[side].configurationFingerprint,
              summarySha256: item[side].sha256 } });
        });
      }
      item.toolInvoked = ['non_activation', 'clarification', 'memory', 'admin'].includes(item.category) ? null : 'arcanos_tutor';
      item.materialDifference = 'No material difference in this synthetic fixture.';
      item.disposition = 'PASS';
      Object.assign(item, review);
    }
  });
  edit(root, 'migration-state.json', state => {
    for (const [name, gate] of Object.entries<Json>(state.gates)) {
      if (['PACKAGE_READY', 'RELEASE_READY'].includes(name)) { gate.status = 'BLOCKED'; continue; }
      gate.status = 'VERIFIED';
      if (['CODE_READY', 'GPT_BASELINE_CAPTURED', 'SKILL_RECONCILED', 'REFERENCES_RECONCILED'].includes(name)) gate.evidenceIds = ['mock-repo-observation'];
      if (['GPT_MIGRATED', 'PARITY_VERIFIED'].includes(name)) gate.evidenceIds = ['mock-account-observation'];
    }
  });
  return { root, inputs, baseline, migration };
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    if (path.dirname(root) !== path.resolve(os.tmpdir()) || !path.basename(root).startsWith('arcanos-tutor-package-')) throw new Error('Unexpected temporary test path');
    rmSync(root, { recursive: true, force: true });
  }
});

describe('Standalone Tutor package and migration release boundary', () => {
  it('validates the final identity and only the three reviewed distribution files', () => {
    const result = validate();
    expect(result.status).toBe(0);
    const report = JSON.parse(result.stdout);
    expect(report).toMatchObject({ sourceValidation: 'PASS', releaseStatus: 'BLOCKED', archiveWritten: false, validatedFileCount: 3 });
    expect(report.distributionCandidates.map((item: Json) => item.path).sort()).toEqual(['.app.json', 'plugin.json', skillPath]);
    expect(report.distributionCandidates.every((item: Json) => /^[a-f0-9]{64}$/u.test(item.sha256))).toBe(true);
  });
  it('blocks actual release without the published and migrated artifacts', () => {
    const result = validate(source, ['--release']);
    expect(result.status).toBe(2);
    expect(JSON.parse(result.stdout).releaseBlockers).toContain('ACTUAL_INPUT_ARTIFACTS_NOT_INSPECTED');
  });
  it('accepts a complete reviewed safe synthetic migration without claiming a real one', () => {
    const fixture = completeFixture();
    const result = validate(fixture.root, ['--release', '--inputs', fixture.inputs]);
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ releaseStatus: 'VERIFIED', archiveWritten: false,
      gates: { PACKAGE_READY: 'VERIFIED', RELEASE_READY: 'VERIFIED' } });
  });
  it.each(['.env', 'private-builder-export.json', 'mcp.json', 'README.md', '.local-migration.json'])('rejects unreviewed packaged file %s', filename => {
    const root = copyPackage();
    writeFileSync(path.join(root, 'package', filename), '{}');
    expect(validate(root).status).toBe(1);
  });
  it('rejects a private-input directory inside the distribution', () => {
    const root = copyPackage();
    mkdirSync(path.join(root, 'package/.local-migration'));
    expect(validate(root).status).toBe(1);
  });
  it.each(['memory.search', 'jobs.get', 'dag.dispatch', 'gaming_query', 'backstage_generate', 'modules.invoke', 'ARCANOS Core', 'arcanos_gaming'])('rejects cross-capability dependency %s', tool => {
    const root = copyPackage();
    writeFileSync(path.join(root, 'package', skillPath), `${readFileSync(path.join(root, 'package', skillPath), 'utf8')}\nCall ${tool}, then arcanos_tutor.\n`);
    expect(validate(root).status).toBe(1);
  });
  it.each(['plugin_asdk_app_6ab4747769088191856fd8eb02507240', 'REPLACE_ME'])('rejects an invalid registered-app mapping %s', id => {
    const root = copyPackage();
    edit(root, 'package/.app.json', mapping => { mapping.apps['arcanos-tutor'].id = id; });
    expect(validate(root).status).toBe(1);
  });
  it('rejects an extra registered app and tool', () => {
    const root = copyPackage();
    edit(root, 'package/.app.json', mapping => { mapping.apps.extra = { id: mapping.apps['arcanos-tutor'].id, required: true }; });
    expect(validate(root).status).toBe(1);
    cpSync(path.join(source, 'package/.app.json'), path.join(root, 'package/.app.json'));
    edit(root, 'connection.requirements.json', connection => { connection.toolNames.push('extra_tool'); });
    expect(validate(root).status).toBe(1);
  });
  it('accepts equivalent property order in the final and migrated app mappings', () => {
    const root = copyPackage();
    edit(root, 'package/.app.json', mapping => {
      const id = mapping.apps['arcanos-tutor'].id;
      mapping.apps['arcanos-tutor'] = { required: true, id };
    });
    expect(validate(root).status).toBe(0);
    const fixture = completeFixture();
    edit(fixture.inputs, '.app.json', mapping => {
      const id = mapping.apps['arcanos-tutor'].id;
      mapping.apps['arcanos-tutor'] = { required: true, id };
    });
    edit(fixture.root, 'migration.inventory.json', migration => { migration.appMapping = artifact(fixture.inputs, '.app.json'); });
    expect(validate(fixture.root, ['--release', '--inputs', fixture.inputs]).status).toBe(0);
  });
  it.each(['registeredAppId', 'appMapping'])('rejects verified migration without its %s binding', field => {
    const fixture = completeFixture();
    edit(fixture.root, 'migration.inventory.json', migration => { delete migration[field]; });
    expect(validate(fixture.root, ['--release', '--inputs', fixture.inputs]).status).toBe(1);
  });
  it('rejects a migrated manifest pointing to an unreviewed app mapping', () => {
    const fixture = completeFixture();
    cpSync(path.join(fixture.inputs, '.app.json'), path.join(fixture.inputs, 'other-app.json'));
    edit(fixture.inputs, 'migrated-plugin.json', metadata => { metadata.extensions['com.openai'].apps = './other-app.json'; });
    edit(fixture.root, 'migration.inventory.json', migration => { migration.metadata = artifact(fixture.inputs, 'migrated-plugin.json'); });
    expect(validate(fixture.root, ['--release', '--inputs', fixture.inputs]).status).toBe(1);
  });
  it('rejects migrated metadata without its app mapping pointer', () => {
    const fixture = completeFixture();
    edit(fixture.inputs, 'migrated-plugin.json', metadata => { delete metadata.extensions['com.openai'].apps; });
    edit(fixture.root, 'migration.inventory.json', migration => { migration.metadata = artifact(fixture.inputs, 'migrated-plugin.json'); });
    expect(validate(fixture.root, ['--release', '--inputs', fixture.inputs]).status).toBe(1);
  });
  it('rejects an actual migrated app mapping for another registered connection', () => {
    const fixture = completeFixture();
    edit(fixture.inputs, '.app.json', mapping => { mapping.apps['arcanos-tutor'].id = `asdk_app_${'0'.repeat(32)}`; });
    edit(fixture.root, 'migration.inventory.json', migration => { migration.appMapping = artifact(fixture.inputs, '.app.json'); });
    expect(validate(fixture.root, ['--release', '--inputs', fixture.inputs]).status).toBe(1);
  });
  it.each(['optional', 'string-required', 'extra-app', 'optional-field', 'array-apps', 'empty-alias'])('rejects a migrated mapping with %s semantics', kind => {
    const fixture = completeFixture();
    edit(fixture.inputs, '.app.json', mapping => {
      const tutor = mapping.apps['arcanos-tutor'];
      if (kind === 'optional') tutor.required = false;
      else if (kind === 'string-required') tutor.required = 'true';
      else if (kind === 'extra-app') mapping.apps.extra = { ...tutor };
      else if (kind === 'array-apps') mapping.apps = [tutor];
      else if (kind === 'empty-alias') mapping.apps = { '': tutor };
      else tutor.optional = true;
    });
    edit(fixture.root, 'migration.inventory.json', migration => { migration.appMapping = artifact(fixture.inputs, '.app.json'); });
    expect(validate(fixture.root, ['--release', '--inputs', fixture.inputs]).status).toBe(1);
  });
  it('accepts one migrated alias bound to the same required Tutor connection', () => {
    const fixture = completeFixture();
    edit(fixture.inputs, '.app.json', mapping => { mapping.apps = { 'migrated-tutor-alias': mapping.apps['arcanos-tutor'] }; });
    edit(fixture.root, 'migration.inventory.json', migration => { migration.appMapping = artifact(fixture.inputs, '.app.json'); });
    expect(validate(fixture.root, ['--release', '--inputs', fixture.inputs]).status).toBe(0);
  });
  it.each(['../.app.json', '/.app.json', 'C:/mock/.app.json'])('rejects unsafe migrated app mapping pointer %s', pointer => {
    const fixture = completeFixture();
    edit(fixture.inputs, 'migrated-plugin.json', metadata => { metadata.extensions['com.openai'].apps = pointer; });
    edit(fixture.root, 'migration.inventory.json', migration => { migration.metadata = artifact(fixture.inputs, 'migrated-plugin.json'); });
    expect(validate(fixture.root, ['--release', '--inputs', fixture.inputs]).status).toBe(1);
  });
  it('resolves the migrated app mapping relative to a nested manifest', () => {
    const fixture = completeFixture();
    mkdirSync(path.join(fixture.inputs, 'generated'));
    renameSync(path.join(fixture.inputs, 'migrated-plugin.json'), path.join(fixture.inputs, 'generated/plugin.json'));
    renameSync(path.join(fixture.inputs, '.app.json'), path.join(fixture.inputs, 'generated/.app.json'));
    edit(fixture.root, 'migration.inventory.json', migration => {
      migration.metadata = artifact(fixture.inputs, 'generated/plugin.json');
      migration.appMapping = artifact(fixture.inputs, 'generated/.app.json');
    });
    expect(validate(fixture.root, ['--release', '--inputs', fixture.inputs]).status).toBe(0);
  });
  it('rejects replacing both mapping records with a plausible but unobserved app ID', () => {
    const root = copyPackage();
    const invented = `asdk_app_${'0'.repeat(32)}`;
    edit(root, 'package/.app.json', mapping => { mapping.apps['arcanos-tutor'].id = invented; });
    edit(root, 'connection.requirements.json', connection => { connection.registeredAppId = invented; connection.technicalId = `plugin_${invented}`; });
    expect(validate(root).status).toBe(1);
  });
  it('rejects unknown manifest fields, replaced schema, and missing skill frontmatter', () => {
    const root = copyPackage();
    edit(root, 'package/plugin.json', manifest => { manifest.arbitraryUnsupportedProperty = true; });
    expect(validate(root).status).toBe(1);
    cpSync(path.join(source, 'package/plugin.json'), path.join(root, 'package/plugin.json'));
    writeFileSync(path.join(root, 'schemas/agent-plugins-1.0.0.schema.json'), '{}');
    expect(validate(root).status).toBe(1);
    cpSync(path.join(source, 'schemas/agent-plugins-1.0.0.schema.json'), path.join(root, 'schemas/agent-plugins-1.0.0.schema.json'));
    writeFileSync(path.join(root, 'package', skillPath), 'Missing frontmatter.');
    expect(validate(root).status).toBe(1);
  });
  it('accepts schema CRLF without weakening its digest', () => {
    const root = copyPackage();
    const file = path.join(root, 'schemas/agent-plugins-1.0.0.schema.json');
    writeFileSync(file, readFileSync(file, 'utf8').replace(/\r?\n/gu, '\r\n'));
    expect(validate(root).status).toBe(0);
  });
  it('rejects oversized packaged inputs', () => {
    const root = copyPackage();
    writeFileSync(path.join(root, 'package', skillPath), 'x'.repeat(1024 * 1024 + 1));
    expect(validate(root).status).toBe(1);
  });
  it('rejects credential-like content without printing it', () => {
    const root = copyPackage();
    const mockMaterial = ['sk', 'proj', 'mock'.repeat(15)].join('-');
    writeFileSync(path.join(root, 'package', skillPath), mockMaterial);
    const result = validate(root);
    expect(result.status).toBe(1);
    expect(`${result.stdout}${result.stderr}`).not.toContain(mockMaterial);
  });
  it.each(['clientSecret', 'accessToken', 'refreshToken', 'apiKey', 'privateSigningKey', 'OPENAI_API_KEY',
    'client-secret', 'access-token', 'refresh-token', 'api-key', 'private-key', 'private_signing_key']
    .flatMap(key => ['skill', 'approved-reference'].map(target => [key, target])))('rejects named %s material in %s without logging it', (key, target) => {
    const root = copyPackage();
    const mockMaterial = 'mock_opaque_material_for_validator_fixture';
    const content = `${JSON.stringify({ [key]: mockMaterial })}\n`;
    if (target === 'skill') {
      const file = path.join(root, 'package', skillPath);
      writeFileSync(file, `${readFileSync(file, 'utf8')}\n${content}`);
    } else {
      const referencePath = 'skills/arcanos-tutor/references/mock-credentials.json';
      mkdirSync(path.dirname(path.join(root, 'package', referencePath)), { recursive: true });
      writeFileSync(path.join(root, 'package', referencePath), content);
      write(root, 'reference-review.json', { schemaVersion: 1, references: [{ sourcePath: 'mock-credentials.json',
        packagePath: referencePath, sha256: hash(content), sizeBytes: Buffer.byteLength(content),
        approvedForRepository: true, ...review }] });
    }
    const result = validate(root);
    expect(result.status).toBe(1);
    expect(`${result.stdout}${result.stderr}`).not.toContain(mockMaterial);
    expect(`${result.stdout}${result.stderr}`).not.toContain(content.trim());
  });
  it.each(['ENCRYPTED', 'DSA'])('rejects a %s private-key label without printing its mock contents', label => {
    const root = copyPackage();
    const mockMaterial = ['-----BEGIN', label, 'PRIVATE KEY-----', '\nmock_encoded_fixture_material\n'].join(' ');
    const file = path.join(root, 'package', skillPath);
    writeFileSync(file, `${readFileSync(file, 'utf8')}\n${mockMaterial}`);
    const result = validate(root);
    expect(result.status).toBe(1);
    expect(`${result.stdout}${result.stderr}`).not.toContain('mock_encoded_fixture_material');
  });
  it('rejects a junction in an ancestor and inside the package', () => {
    const root = copyPackage();
    const linked = path.join(root, 'linked');
    mkdirSync(path.join(root, 'container'));
    cpSync(source, path.join(root, 'container/candidate'), { recursive: true });
    symlinkSync(path.join(root, 'container'), linked, 'junction');
    const viaAncestor = validate(path.join(linked, 'candidate'));
    expect(viaAncestor.status).toBe(1);
    rmSync(linked, { recursive: true });
    renameSync(path.join(root, 'package/skills'), path.join(root, 'outside-skills'));
    symlinkSync(path.join(root, 'outside-skills'), path.join(root, 'package/skills'), 'junction');
    expect(validate(root).status).toBe(1);
  });
  it('cannot promote user-reported connection evidence using unrelated verified evidence', () => {
    const root = copyPackage();
    edit(root, 'connection.requirements.json', connection => {
      connection.evidence.find((item: Json) => item.id === 'chatgpt-registration').status = 'USER_REPORTED';
      connection.checks.registeredConnection.evidenceIds = ['chatgpt-registration', 'repository-foundation'];
    });
    expect(validate(root).status).toBe(1);
  });
  it('rejects inconsistent connection states and missing parity categories', () => {
    const root = copyPackage();
    edit(root, 'migration-state.json', state => { state.gates.LIVE_TUTOR_CALL_VERIFIED.status = 'USER_REPORTED'; });
    expect(validate(root).status).toBe(1);
    cpSync(path.join(source, 'migration-state.json'), path.join(root, 'migration-state.json'));
    edit(root, 'parity-matrix.json', parity => { parity.cases = parity.cases.filter((item: Json) => item.category !== 'cancellation'); });
    expect(validate(root).status).toBe(1);
  });
  it('rejects baseline verification claims without captured configuration', () => {
    const root = copyPackage();
    edit(root, 'migration-state.json', state => { state.gates.GPT_BASELINE_CAPTURED.status = 'VERIFIED'; state.gates.GPT_BASELINE_CAPTURED.evidenceIds = ['repository-foundation']; });
    expect(validate(root).status).toBe(1);
  });
  it.each(['configuration', 'reference', 'metadata', 'appMapping'])('rejects changed private %s bytes after review', target => {
    const fixture = completeFixture();
    const file = target === 'configuration' ? 'published-gpt.json' : target === 'reference' ? 'mock-notes.txt' : target === 'appMapping' ? '.app.json' : 'migrated-plugin.json';
    writeFileSync(path.join(fixture.inputs, file), 'Changed mock artifact.');
    expect(validate(fixture.root, ['--release', '--inputs', fixture.inputs]).status).toBe(1);
  });
  it('invalidates parity when final packaged safeguards change even if their review hash is updated', () => {
    const fixture = completeFixture();
    const file = path.join(fixture.root, 'package', skillPath);
    writeFileSync(file, `${readFileSync(file, 'utf8')}\nA changed mock safeguard.\n`);
    edit(fixture.root, 'migration.inventory.json', migration => { migration.instructionComparison.packagedSkillSha256 = hash(readFileSync(file)); });
    expect(validate(fixture.root, ['--release', '--inputs', fixture.inputs]).status).toBe(1);
  });
  it('rejects unapproved references and renamed knowledge files', () => {
    const fixture = completeFixture();
    edit(fixture.root, 'reference-review.json', refs => { refs.references[0].approvedForRepository = false; });
    expect(validate(fixture.root).status).toBe(1);
    edit(fixture.root, 'reference-review.json', refs => { refs.references[0].approvedForRepository = true; });
    edit(fixture.root, 'migration.inventory.json', migration => { migration.references[0].name = 'renamed.txt'; });
    expect(validate(fixture.root, ['--release', '--inputs', fixture.inputs]).status).toBe(1);
  });
  it('requires explicit owner acceptance for an accepted parity difference', () => {
    const fixture = completeFixture();
    edit(fixture.root, 'parity-matrix.json', parity => { parity.cases[0].disposition = 'ACCEPTED_DIFFERENCE'; });
    expect(validate(fixture.root, ['--release', '--inputs', fixture.inputs]).status).toBe(1);
  });
  it('accepts an explicit owner-approved difference bound to both configurations and the exact prompt', () => {
    const fixture = completeFixture();
    edit(fixture.root, 'parity-matrix.json', parity => {
      const item = parity.cases[0];
      item.disposition = 'ACCEPTED_DIFFERENCE';
      item.ownerAcceptance = { accepted: true, acceptedBy: 'mock fixture owner', acceptedAt: review.reviewedAt,
        reason: 'Mock accepted teaching style difference.', promptSha256: hash(item.prompt),
        oldFingerprint: item.oldGpt.configurationFingerprint, pluginFingerprint: item.plugin.configurationFingerprint };
    });
    expect(validate(fixture.root, ['--release', '--inputs', fixture.inputs]).status).toBe(0);
  });
  it('invalidates parity when final manifest metadata changes', () => {
    const fixture = completeFixture();
    edit(fixture.root, 'package/plugin.json', manifest => { manifest.version = '0.1.1'; });
    expect(validate(fixture.root, ['--release', '--inputs', fixture.inputs]).status).toBe(1);
  });
  it('invalidates parity after a fully rehashed reference replacement', () => {
    const fixture = completeFixture();
    const replacement = 'A newly reviewed mock reference.\n';
    writeFileSync(path.join(fixture.inputs, 'mock-notes.txt'), replacement);
    writeFileSync(path.join(fixture.root, 'package/skills/arcanos-tutor/references/mock-notes.txt'), replacement);
    for (const file of ['baseline.inventory.json', 'migration.inventory.json']) edit(fixture.root, file, inventory => {
      const entry = (inventory.knowledge ?? inventory.references)[0];
      entry.sha256 = hash(replacement); entry.sizeBytes = Buffer.byteLength(replacement);
    });
    edit(fixture.root, 'reference-review.json', refs => { refs.references[0].sha256 = hash(replacement); refs.references[0].sizeBytes = Buffer.byteLength(replacement); });
    expect(validate(fixture.root, ['--release', '--inputs', fixture.inputs]).status).toBe(1);
  });
  it('rejects raw private Builder instructions in the sanitized inventory', () => {
    const fixture = completeFixture();
    edit(fixture.root, 'baseline.inventory.json', baseline => { baseline.configuration.instructions = 'Mock private instruction leak.'; });
    const result = validate(fixture.root);
    expect(result.status).toBe(1);
    expect(`${result.stdout}${result.stderr}`).not.toContain('Mock private instruction leak');
  });
  it('cannot use the earlier standalone tool call to certify installed-skill parity', () => {
    const fixture = completeFixture();
    edit(fixture.root, 'parity-matrix.json', parity => { parity.cases[0].plugin.evidenceIds = ['chatgpt-live-call']; });
    expect(validate(fixture.root, ['--release', '--inputs', fixture.inputs]).status).toBe(1);
  });
  it.each([['direct', null], ['non_activation', 'arcanos_tutor']])('rejects a passed %s case with the wrong tool activation', (category, tool) => {
    const fixture = completeFixture();
    edit(fixture.root, 'parity-matrix.json', parity => { parity.cases.find((item: Json) => item.category === category).toolInvoked = tool; });
    expect(validate(fixture.root, ['--release', '--inputs', fixture.inputs]).status).toBe(1);
  });
  it('cannot promote user-reported pairs using a verified aggregate gate', () => {
    const fixture = completeFixture();
    edit(fixture.root, 'parity-matrix.json', parity => { parity.cases[0].plugin.status = 'USER_REPORTED'; });
    expect(validate(fixture.root, ['--release', '--inputs', fixture.inputs]).status).toBe(1);
  });
  it('rejects duplicate source approvals that could hide an omitted migrated reference', () => {
    const fixture = completeFixture();
    edit(fixture.root, 'reference-review.json', refs => { refs.references.push({ ...refs.references[0], packagePath: 'skills/arcanos-tutor/references/copy.txt' }); });
    expect(validate(fixture.root).status).toBe(1);
  });
  it('captures only metadata and leaves latest publication unverified', () => {
    const fixture = completeFixture();
    const captured = json(fixture.root, 'mock-baseline.json');
    expect(captured.status).toBe('IMPLEMENTED_NOT_VERIFIED');
    expect(captured.publicationAssurance).toBe('USER_REPORTED');
    expect(JSON.stringify(captured)).not.toContain('Mock teaching personality');
    expect(captured.configuration.fields.instructions.sha256).toMatch(/^[a-f0-9]{64}$/u);
  });
  it('rejects unpublished drafts and path traversal during baseline capture without exposing inputs', () => {
    const fixture = completeFixture();
    edit(fixture.inputs, 'published-gpt.json', configuration => { configuration.publication.status = 'draft'; });
    const result = spawnSync(process.execPath, [captureScript, '--inputs', fixture.inputs, '--output', path.join(fixture.root, 'draft.json')], { encoding: 'utf8' });
    expect(result.status).toBe(1);
    expect(result.stderr).not.toContain('Mock teaching personality');
    edit(fixture.inputs, 'published-gpt.json', configuration => { configuration.publication.status = 'published'; configuration.knowledge[0].path = '../escape.txt'; });
    expect(spawnSync(process.execPath, [captureScript, '--inputs', fixture.inputs, '--output', path.join(fixture.root, 'unsafe.json')]).status).toBe(1);
  });
});
