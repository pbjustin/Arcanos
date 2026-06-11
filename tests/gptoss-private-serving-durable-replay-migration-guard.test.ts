import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';

const migrationDraftPath = join(
  process.cwd(),
  'migrations',
  'drafts',
  'gptoss_durable_replay_store.sql',
);
const guardScript = join(
  process.cwd(),
  'scripts',
  'gptoss',
  'private-serving',
  'private-serving-durable-replay-migration-guard.mjs',
);
const readinessScript = join(process.cwd(), 'scripts', 'gptoss', 'model-readiness-report.mjs');
const cloudGateScript = join(process.cwd(), 'scripts', 'gptoss', 'cloud-readiness-gate.mjs');
const schemaPath = join(process.cwd(), 'schemas', 'gptoss-private-serving-boundary.schema.json');
const dbUrlPattern = new RegExp(`${'DATABASE'}_${'URL'}|process\\.env\\[['"]?${'DATABASE'}_${'URL'}`, 'i');

function runNode(script: string, args: string[] = []) {
  return spawnSync(process.execPath, [script, ...args], {
    cwd: process.cwd(),
    encoding: 'utf8',
  });
}

function tempMigration(text: string) {
  const dir = mkdtempSync(join(tmpdir(), 'gptoss-durable-replay-migration-'));
  const path = join(dir, 'draft.sql');
  writeFileSync(path, text, 'utf8');
  return {
    path,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

async function runGuardForText(text: string) {
  const { path, cleanup } = tempMigration(text);
  try {
    const module = await import(pathToFileURL(guardScript).href) as {
      runPrivateServingDurableReplayMigrationGuard: (
        options?: Record<string, unknown>,
      ) => Record<string, unknown>;
    };
    return module.runPrivateServingDurableReplayMigrationGuard({
      migrationPath: path,
      write: false,
    });
  } finally {
    cleanup();
  }
}

describe('gptoss durable replay migration guard', () => {
  it('blocks migration apply by default while validating the current draft', () => {
    const result = runNode(guardScript, ['--no-write']);
    const parsed = JSON.parse(result.stdout);

    expect(result.status).toBe(0);
    expect(parsed).toMatchObject({
      ok: true,
      applyAllowed: false,
      liveDbWrite: false,
      migrationDraftReady: true,
      durableReplayMigrationApplied: false,
      replayProtectionDurableImplemented: false,
      privateServingImplemented: false,
      privateServingExposed: false,
      cloudReady: false,
      customGptReady: false,
      liveDbUsed: false,
      migrationExecutionCodePresent: false,
      failures: [],
    });
  });

  it('detects missing required draft markers', async () => {
    const base = readFileSync(migrationDraftPath, 'utf8');
    const missingDoNotApply = await runGuardForText(base.replace('-- DO NOT APPLY\n', ''));
    const missingDesignDraft = await runGuardForText(base.replace('-- DESIGN DRAFT ONLY\n', ''));

    expect(missingDoNotApply).toMatchObject({
      ok: false,
      applyAllowed: false,
      liveDbWrite: false,
      migrationDraftReady: false,
    });
    expect(missingDoNotApply.failures).toContain('migration_marker_missing:DO NOT APPLY');
    expect(missingDesignDraft.failures).toContain('migration_marker_missing:DESIGN DRAFT ONLY');
  });

  it('detects raw nonce storage, missing nonce_hash, and missing unique scope', async () => {
    const base = readFileSync(migrationDraftPath, 'utf8');
    const rawNonce = await runGuardForText(
      base.replace('  nonce_hash CHAR(64) NOT NULL,', '  nonce TEXT NOT NULL,\n  nonce_hash CHAR(64) NOT NULL,'),
    );
    const missingNonceHash = await runGuardForText(
      base.replace('  nonce_hash CHAR(64) NOT NULL,', '  nonce_digest CHAR(64) NOT NULL,'),
    );
    const missingUnique = await runGuardForText(
      base.replace('UNIQUE (key_id, nonce_hash)', 'UNIQUE (key_id, request_id)'),
    );

    expect(rawNonce.failures).toContain('migration_raw_nonce_column_present');
    expect(missingNonceHash.failures).toContain('migration_nonce_hash_column_missing');
    expect(missingUnique.failures).toContain('migration_unique_key_nonce_hash_missing');
    for (const report of [rawNonce, missingNonceHash, missingUnique]) {
      expect(report).toMatchObject({
        ok: false,
        applyAllowed: false,
        liveDbWrite: false,
        durableReplayMigrationApplied: false,
      });
    }
  });

  it('detects destructive SQL and live DB connection paths in executable SQL', async () => {
    const base = readFileSync(migrationDraftPath, 'utf8');
    const destructive = await runGuardForText(
      `${base}\nDROP TABLE gptoss_private_serving_replay_nonces;\n`,
    );
    const liveDbPath = await runGuardForText(
      `${base}\nSELECT dblink_connect('postgresql://example.invalid/db');\n`,
    );

    expect(destructive.failures).toContain('migration_destructive_sql_present');
    expect(liveDbPath.failures).toContain('migration_live_db_connection_path_present');
    expect(liveDbPath).toMatchObject({
      ok: false,
      applyAllowed: false,
      liveDbWrite: false,
    });
  });

  it('keeps the guard source free of DB imports, env DB lookup, execution, and server paths', () => {
    const source = readFileSync(guardScript, 'utf8');

    expect(source).not.toMatch(/from\s+['"](@prisma\/client|pg|knex|redis)['"]|new\s+PrismaClient|new\s+Pool|createClient\s*\(/i);
    expect(source).not.toMatch(dbUrlPattern);
    expect(source).not.toMatch(/api\.openai\.com|responses\.create/i);
    expect(source).not.toMatch(/npm\s+run\s+[^\r\n]*train|fine-tune|finetune/i);
    expect(source).not.toMatch(/vllm\s+serve|vllm\./i);
    expect(source).not.toMatch(/\brailway\s+(up|status|logs|link|whoami|run|deploy|variables)\b/i);
    expect(source).not.toMatch(/node:http|node:https|node:net|createServer|\.listen\s*\(/i);
    expect(source).not.toMatch(/--execute|--allow-db-write|db:schema:apply/i);
  });

  it('keeps readiness, cloud, and custom GPT blocked', () => {
    const readiness = JSON.parse(runNode(readinessScript, ['--no-write']).stdout);
    const cloudGate = JSON.parse(runNode(cloudGateScript, ['--no-write', '--report-only']).stdout);

    expect(readiness).toMatchObject({
      durableReplayMigrationDraftReady: true,
      durableReplayMigrationApplyAllowed: false,
      durableReplayMigrationApplied: false,
      liveDbUsed: false,
      replayProtectionDurableImplemented: false,
      privateServingImplemented: false,
      privateServingExposed: false,
      cloudReady: false,
      customGptReady: false,
    });
    expect(cloudGate).toMatchObject({
      durableReplayMigrationDraftReady: true,
      durableReplayMigrationApplyAllowed: false,
      durableReplayMigrationApplied: false,
      liveDbUsed: false,
      cloudReady: false,
      customGptReady: false,
      checks: {
        durableReplayMigrationDraftReady: true,
        durableReplayMigrationApplyBlocked: true,
        durableReplayMigrationNotApplied: true,
      },
    });
  });

  it('adds schema definitions for migration guard reports and readiness', () => {
    const schema = JSON.parse(readFileSync(schemaPath, 'utf8'));
    const ajv = new Ajv2020();
    const report = {
      schemaVersion: 1,
      kind: 'gptoss_private_serving_durable_replay_migration_guard',
      ok: true,
      migrationDraftReady: true,
      applyAllowed: false,
      liveDbWrite: false,
      durableReplayMigrationApplied: false,
      failures: [],
    };
    const validateReport = ajv.compile({
      ...schema.$defs.durableReplayMigrationGuardReport,
      $defs: schema.$defs,
    });

    expect(schema.properties).toEqual(expect.objectContaining({
      durableReplayMigrationGuardReport: expect.any(Object),
      durableReplayMigrationGuardDecision: expect.any(Object),
      durableReplayMigrationReadiness: expect.any(Object),
    }));
    expect(schema.$defs).toEqual(expect.objectContaining({
      durableReplayMigrationGuardReport: expect.any(Object),
      durableReplayMigrationGuardDecision: expect.any(Object),
      durableReplayMigrationReadiness: expect.any(Object),
    }));
    expect(validateReport(report)).toBe(true);
  });

  it('wires only a local migration guard package script', () => {
    const packageJson = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8'));
    const scripts = packageJson.scripts as Record<string, string>;
    const durableReplayScripts = Object.fromEntries(
      Object.entries(scripts).filter(([name]) =>
        name.startsWith('gptoss:private-serving:durable-replay:'),
      ),
    );
    const serialized = JSON.stringify(durableReplayScripts);

    expect(scripts['gptoss:private-serving:durable-replay:migration-guard']).toBe(
      'node scripts/gptoss/private-serving/private-serving-durable-replay-migration-guard.mjs',
    );
    expect(serialized).not.toMatch(new RegExp(`--execute|--allow-db-write|db:schema:apply|${'DATABASE'}_${'URL'}`, 'i'));
    expect(serialized).not.toMatch(/\brailway\s+(up|status|logs|link|whoami|run|deploy|variables)\b/i);
    expect(serialized).not.toMatch(/node:http|node:https|node:net|createServer|\.listen\s*\(/i);
    expect(serialized).not.toMatch(/api\.openai\.com|responses\.create/i);
  });
});
