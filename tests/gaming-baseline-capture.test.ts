import { afterEach, describe, expect, it } from '@jest/globals';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

type Json = ReturnType<typeof JSON.parse>;
const roots: string[] = [];
const captureScript = path.join(process.cwd(), 'scripts/capture-gaming-baseline.mjs');
const sharedScript = path.join(process.cwd(), 'scripts/tutor-migration.mjs');
const canonicalSchema = readFileSync(path.join(process.cwd(), 'contracts/arcanos_gaming.openapi.v1.json'), 'utf8');
const mockInstructions = 'Synthetic private Gaming instructions preserve progress and spoiler preferences, and use the bounded workflow.';
const code = `import {captureGamingBaseline} from ${JSON.stringify(pathToFileURL(captureScript).href)};`
  + 'try { console.log(JSON.stringify(await captureGamingBaseline(process.argv[1]))); } '
  + 'catch(error) { console.error(error.message); process.exitCode=1; }';

function fixture(change: (configuration: Json) => void = () => {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'arcanos-gaming-baseline-'));
  roots.push(root);
  expect(spawnSync('git', ['init', '--quiet', root], { windowsHide: true }).status).toBe(0);
  writeFileSync(path.join(root, '.gitignore'), '/.local-migration/\n');
  const inputRoot = path.join(root, '.local-migration/arcanos-gaming');
  mkdirSync(inputRoot, { recursive: true });
  const configuration = { schemaVersion: 1,
    publication: { status: 'published', version: 'synthetic-v1', publishedAt: '2026-09-28T12:00:00Z' },
    displayName: 'Arcanos Gaming', description: 'Synthetic Gaming capture fixture.', instructions: mockInstructions,
    conversationStarters: [], enabledCapabilities: ['Web Search'], sharingStatus: 'Only me', knowledge: [],
    representativeBehavior: ['Synthetic expected behavior preserves the explicit progress and spoiler constraints.'],
    actions: [{ name: 'Synthetic Gaming Action', schema: JSON.parse(canonicalSchema), authType: 'api_key_bearer' }] };
  change(configuration);
  writeFileSync(path.join(inputRoot, 'published-gpt.json'), JSON.stringify(configuration));
  return { root, inputRoot, configuration };
}

function capture(inputRoot: string) {
  return spawnSync(process.execPath, ['--input-type=module', '-e', code, inputRoot], { encoding: 'utf8' });
}

function scan(content: string) {
  const source = `import {safeContent} from ${JSON.stringify(pathToFileURL(sharedScript).href)};`
    + 'import {readFileSync} from "node:fs";'
    + 'try { safeContent(readFileSync(0,"utf8")); console.log("SAFE"); } catch(error) { console.error(error.message); process.exitCode=1; }';
  return spawnSync(process.execPath, ['--input-type=module', '-e', source], { encoding: 'utf8', input: content });
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    if (path.dirname(root) !== path.resolve(os.tmpdir()) || !path.basename(root).startsWith('arcanos-gaming-baseline-')) {
      throw new Error('Unexpected fixture path');
    }
    rmSync(root, { recursive: true, force: true });
  }
});

describe('Gaming published baseline capture reuses the shared foundation', () => {
  it('captures a deterministic hash-only inventory without asserting owner approval or published-state proof', () => {
    const f = fixture();
    const first = capture(f.inputRoot);
    const second = capture(f.inputRoot);
    expect(first.status).toBe(0);
    expect(second.stdout).toBe(first.stdout);
    const result = JSON.parse(first.stdout);
    expect(result.baselineFingerprint).toMatch(/^[a-f0-9]{64}$/u);
    expect(result.inventory).toMatchObject({ status: 'IMPLEMENTED_NOT_VERIFIED', publicationAssurance: 'USER_REPORTED', knowledge: [] });
    expect(result.inventory.publicationReview).toBeUndefined();
    expect(result.inventory.configuration.actions).toHaveLength(1);
    expect(result.inventory.configuration.fields.actions.sha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(first.stdout).not.toContain(mockInstructions);
    expect(first.stdout).not.toContain('Synthetic expected behavior');
    expect(first.stdout).not.toContain('api_key_bearer');
  });

  it.each(['none', 'api_key', 'api_key_basic', 'api_key_bearer', 'oauth'])('captures the stored auth type %s without inferring backend compatibility', authType => {
    const f = fixture(configuration => { configuration.actions[0].authType = authType; });
    expect(capture(f.inputRoot).status).toBe(0);
  });

  it.each(['name', 'sharing', 'schema version', 'hybrid marker', 'missing root marker', 'missing action', 'missing schema', 'missing auth',
    'extra auth field', 'wrong operation', 'extra operation', 'extra method', 'missing timestamp'])('rejects %s drift or missing evidence', mode => {
    const f = fixture(configuration => {
      const action = configuration.actions[0];
      if (mode === 'name') configuration.displayName = 'Arcanos Tutor';
      if (mode === 'sharing') configuration.sharingStatus = 'Anyone with a link';
      if (mode === 'schema version') action.schema.info.version = '1.4.0';
      if (mode === 'hybrid marker') action.schema = JSON.parse(JSON.stringify(action.schema).replaceAll('gaming-hybrid-v1', 'unrecognized-contract'));
      if (mode === 'missing root marker') delete action.schema['x-arcanos-gaming-hybrid-contract-version'];
      if (mode === 'missing action') configuration.actions = [];
      if (mode === 'missing schema') action.schema = null;
      if (mode === 'missing auth') action.authType = null;
      if (mode === 'extra auth field') action.authValue = 'fixture-value-not-permitted';
      if (mode === 'wrong operation') action.schema.paths['/gpt/arcanos-gaming'].post.operationId = 'modules.invoke';
      if (mode === 'extra operation') action.schema.paths['/gpt/arcanos-tutor'] = { post: { operationId: 'queryTutor' } };
      if (mode === 'extra method') action.schema.paths['/gpt/arcanos-gaming'].get = { operationId: 'queryArcanosGaming' };
      if (mode === 'missing timestamp') configuration.publication.publishedAt = null;
    });
    const result = capture(f.inputRoot);
    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).not.toContain(mockInstructions);
  });

  it('refuses an escaped private instruction before producing an inventory', () => {
    const f = fixture();
    writeFileSync(path.join(f.root, 'escaped.txt'), mockInstructions);
    const result = capture(f.inputRoot);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('PRIVATE_CONTENT_OUTSIDE_IGNORED_INPUTS');
  });

  it('keeps the incomplete CLI output generic and preserves an existing output file', () => {
    const f = fixture(configuration => { configuration.actions[0].schema = null; });
    const output = path.join(f.root, 'baseline.inventory.json');
    writeFileSync(output, 'Existing reviewed inventory fixture.');
    const result = spawnSync(process.execPath, [captureScript, '--inputs', f.inputRoot, '--output', output], { encoding: 'utf8' });
    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('GAMING_BASELINE_INVALID');
    expect(result.stderr).not.toContain(mockInstructions);
    expect(readFileSync(output, 'utf8')).toBe('Existing reviewed inventory fixture.');
  });
});

describe('Migration credential scan handles public Gaming authentication prose narrowly', () => {
  it('accepts the complete canonical public Gaming Action schema', () => {
    expect(scan(canonicalSchema).status).toBe(0);
  });

  it.each(['authentication123', 'authentication.other', 'authentication-credential', 'authentication/credential', 'authentication=', 'authentication=='])('rejects bearer token suffix %s', suffix => {
    const result = scan(['Bearer', suffix].join(' '));
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('POSSIBLE_CREDENTIAL');
  });

  it('still rejects a credential assignment containing the standalone prose word', () => {
    expect(scan(JSON.stringify({ authorization: ['Bearer', 'authentication'].join(' ') })).status).toBe(1);
  });
});
