import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const implementationPlanPath = join(
  process.cwd(),
  'docs',
  'GPTOSS_DURABLE_REPLAY_STORE_IMPLEMENTATION_PLAN.md',
);
const migrationDraftPath = join(
  process.cwd(),
  'migrations',
  'drafts',
  'gptoss_durable_replay_store.sql',
);
const contractScript = join(
  process.cwd(),
  'scripts',
  'gptoss',
  'private-serving',
  'private-serving-durable-replay-store.mjs',
);
const validatorScript = join(
  process.cwd(),
  'scripts',
  'gptoss',
  'private-serving',
  'private-serving-durable-replay-implementation-plan-validate.mjs',
);
const readinessScript = join(process.cwd(), 'scripts', 'gptoss', 'model-readiness-report.mjs');

function runNode(script: string, args: string[] = []) {
  return spawnSync(process.execPath, [script, ...args], {
    cwd: process.cwd(),
    encoding: 'utf8',
  });
}

function stripSqlComments(text: string) {
  return text
    .split(/\r?\n/)
    .filter((line) => !line.trim().startsWith('--'))
    .join('\n');
}

describe('gptoss durable replay implementation plan', () => {
  it('documents the implementation plan while keeping serving blocked', () => {
    const text = readFileSync(implementationPlanPath, 'utf8');

    expect(text).toContain('migrations/drafts/gptoss_durable_replay_store.sql');
    expect(text).toContain('scripts/gptoss/private-serving/private-serving-durable-replay-store.mjs');
    expect(text).toContain('unique(key_id, nonce_hash)');
    expect(text).toContain('"replayProtectionDurableImplemented": false');
    expect(text).toContain('"cloudReady": false');
    expect(text).toContain('"customGptReady": false');
  });

  it('keeps the migration draft marked design-only and not applicable', () => {
    const text = readFileSync(migrationDraftPath, 'utf8');

    expect(text).toContain('-- DESIGN DRAFT ONLY');
    expect(text).toContain('-- DO NOT APPLY');
    expect(text).toContain('-- NO LIVE DB EXECUTION');
  });

  it('stores nonce_hash rather than a raw nonce column', () => {
    const text = readFileSync(migrationDraftPath, 'utf8');
    const sql = stripSqlComments(text);

    expect(sql).toMatch(/\bnonce_hash\s+CHAR\(64\)\s+NOT NULL/i);
    expect(sql).toMatch(/UNIQUE\s*\(\s*key_id\s*,\s*nonce_hash\s*\)/i);
    expect(sql).not.toMatch(/^\s*(nonce|raw_nonce)\s+/im);
    expect(sql).not.toMatch(/raw_request_body|request_body|secret|password|bearer_token/i);
  });

  it('keeps the contract module export-only and free of DB imports', async () => {
    const source = readFileSync(contractScript, 'utf8');
    const module = await import(pathToFileURL(contractScript).href) as Record<string, unknown>;

    expect(Object.keys(module).sort()).toEqual([
      'buildReplayStoreInsertPlan',
      'createDurableReplayStoreContract',
      'normalizeReplayStoreRecord',
      'validateDurableReplayRecordShape',
    ]);
    expect(source).not.toMatch(/from\s+['"](@prisma\/client|pg|knex|redis)['"]|new\s+PrismaClient|new\s+Pool|createClient\s*\(/i);
    expect(source).not.toMatch(/DATABASE_URL|process\.env\[['"]?DATABASE_URL|process\.env\.DATABASE_URL/);
    expect(source).not.toMatch(/node:http|node:https|node:net|createServer|\.listen\s*\(/i);
  });

  it('builds an insert plan without returning a raw nonce', async () => {
    const module = await import(pathToFileURL(contractScript).href) as {
      buildReplayStoreInsertPlan: (decision: Record<string, unknown>) => Record<string, unknown>;
    };
    const plan = module.buildReplayStoreInsertPlan({
      keyId: 'phase56-key',
      nonce: 'noncePhase56Replay',
      requestId: 'phase56-request',
      bodyHash: 'a'.repeat(64),
      timestamp: '2026-06-11T12:00:00.000Z',
      audience: 'gptoss-effective-router-private',
    });
    const serialized = JSON.stringify(plan);

    expect(plan).toMatchObject({
      ok: true,
      implemented: false,
      executesSql: false,
      liveDbUsed: false,
      conflictTarget: ['key_id', 'nonce_hash'],
      rawNonceStored: false,
      rawRequestBodyStored: false,
      secretsStored: false,
    });
    expect((plan.record as Record<string, unknown>).nonce_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(serialized).not.toContain('noncePhase56Replay');
    expect(serialized).not.toMatch(/"nonce"\s*:/);
  });

  it('runs the implementation-plan validator and keeps exposure blocked', () => {
    const result = runNode(validatorScript, ['--no-write']);
    const parsed = JSON.parse(result.stdout);

    expect(result.status).toBe(0);
    expect(parsed).toMatchObject({
      ok: true,
      implementationPlanExists: true,
      migrationDraftExists: true,
      migrationDraftDesignOnly: true,
      durableReplayStoreContractExists: true,
      replayProtectionDurableDesigned: true,
      replayProtectionDurableImplemented: false,
      replayProtectionDurable: false,
      privateServingImplemented: false,
      privateServingExposed: false,
      publicServerCreated: false,
      cloudReady: false,
      customGptReady: false,
      openAiCalled: false,
      trainingExecuted: false,
      vllmUsed: false,
      railwayCliUsed: false,
      liveDbUsed: false,
      serverCreated: false,
      noDbClientImports: true,
      noDatabaseUrlUsage: true,
      noRailwayCliUsage: true,
      noServerListener: true,
      noRawNonceStorage: true,
      uniqueKeyIdNonceHashPresent: true,
      failures: [],
    });
  });

  it('keeps readiness non-exposed', () => {
    const result = runNode(readinessScript, ['--no-write']);
    const readiness = JSON.parse(result.stdout);

    expect(result.status).toBe(0);
    expect(readiness).toMatchObject({
      replayProtectionDurableDesigned: true,
      replayProtectionDurableImplemented: false,
      replayProtectionDurable: false,
      privateServingImplemented: false,
      privateServingExposed: false,
      publicServerCreated: false,
      cloudReady: false,
      customGptReady: false,
    });
  });

  it('keeps implementation-plan artifacts free of external operation paths', () => {
    const source = [
      migrationDraftPath,
      contractScript,
      validatorScript,
    ].map((path) => readFileSync(path, 'utf8')).join('\n');

    expect(source).not.toMatch(/api\.openai\.com|responses\.create/i);
    expect(source).not.toMatch(/npm\s+run\s+[^\r\n]*train|fine-tune|finetune/i);
    expect(source).not.toMatch(/vllm\s+serve|vllm\./i);
    expect(source).not.toMatch(/\brailway\s+(up|status|logs|link|whoami|run|deploy|variables)\b/i);
    expect(source).not.toMatch(/from\s+['"](@prisma\/client|pg|knex|redis)['"]|new\s+PrismaClient|new\s+Pool|createClient\s*\(/i);
    expect(source).not.toMatch(/DATABASE_URL|process\.env\[['"]?DATABASE_URL|process\.env\.DATABASE_URL/);
    expect(source).not.toMatch(/node:http|node:https|node:net|createServer|\.listen\s*\(/i);
  });
});

