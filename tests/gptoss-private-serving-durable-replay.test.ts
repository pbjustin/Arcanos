import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';

const designDocPath = join(process.cwd(), 'docs', 'GPTOSS_DURABLE_REPLAY_STORE_DESIGN.md');
const schemaPath = join(process.cwd(), 'schemas', 'gptoss-private-serving-boundary.schema.json');
const validatorScript = join(
  process.cwd(),
  'scripts',
  'gptoss',
  'private-serving',
  'private-serving-durable-replay-design-validate.mjs',
);
const readinessScript = join(process.cwd(), 'scripts', 'gptoss', 'model-readiness-report.mjs');
const cloudGateScript = join(process.cwd(), 'scripts', 'gptoss', 'cloud-readiness-gate.mjs');

function runNode(script: string, args: string[] = []) {
  return spawnSync(process.execPath, [script, ...args], {
    cwd: process.cwd(),
    encoding: 'utf8',
  });
}

function parseJsonFile(path: string) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

describe('gptoss private serving durable replay design', () => {
  it('adds the durable replay design doc with required boundaries', () => {
    expect(existsSync(designDocPath)).toBe(true);
    const doc = readFileSync(designDocPath, 'utf8');

    for (const term of [
      'Purpose',
      'Table Or Record Shape',
      'keyId + nonce',
      'Timestamp Window',
      'TTL And Pruning Policy',
      'Audit Correlation Fields',
      'Failure Modes',
      'Migration Safety',
      'Rollback Behavior',
      'raw request body',
      'secret storage',
      'live DB access',
      'design/schema/validation only',
    ]) {
      expect(doc).toContain(term);
    }
  });

  it('parses durable replay schema sections and validates sample shapes', () => {
    const schema = parseJsonFile(schemaPath);
    const ajv = new Ajv2020();
    const hash = 'a'.repeat(64);
    const design = {
      schemaVersion: 1,
      phase: '5.5',
      designed: true,
      implemented: false,
      durable: false,
      purpose: 'Persist accepted keyId plus nonce combinations in a future ledger.',
      record: {
        schemaVersion: 1,
        keyId: 'phase55-key',
        nonce: 'nonceDurableReplay01',
        uniquenessScope: 'keyId+nonce',
        requestId: 'phase55-request',
        bodyHash: hash,
        timestamp: '2026-06-08T12:00:00.000Z',
        receivedAt: '2026-06-08T12:00:01.000Z',
        expiresAt: '2026-06-08T12:06:01.000Z',
        auditCorrelation: {
          requestId: 'phase55-request',
          bodyHash: hash,
          keyId: 'phase55-key',
          subjectHash: hash,
          traceId: 'trace-phase55',
          auditRecordId: 'audit-phase55',
        },
        rawRequestBodyStored: false,
        secretsStored: false,
      },
      policy: {
        designed: true,
        implemented: false,
        durable: false,
        uniquenessRule: 'keyId+nonce',
        timestampWindowSeconds: 300,
        maxFutureSkewSeconds: 60,
        ttlSeconds: 360,
        pruningPolicy: 'delete_after_expires_at',
        failureMode: 'fail_closed',
        migrationSafety: 'design_only_no_live_migration',
        rollbackBehavior: 'disable_private_serving_keep_existing_replay_blocks',
        noRawRequestBodyStorage: true,
        noSecretStorage: true,
        liveDbAccessInPhase: false,
      },
    };
    const report = {
      schemaVersion: 1,
      kind: 'gptoss_private_serving_durable_replay_store_design_validation',
      ok: true,
      durableReplayStoreDesigned: true,
      replayProtectionDurableDesigned: true,
      replayProtectionDurableImplemented: false,
      replayProtectionDurable: false,
      privateServingImplemented: false,
      privateServingExposed: false,
      cloudReady: false,
      customGptReady: false,
      openAiCalled: false,
      trainingExecuted: false,
      vllmUsed: false,
      railwayCliUsed: false,
      liveDbUsed: false,
      serverCreated: false,
      failures: [],
    };
    const validateDesign = ajv.compile({
      ...schema.$defs.durableReplayStoreDesign,
      $defs: schema.$defs,
    });
    const validateReport = ajv.compile({
      ...schema.$defs.durableReplayStoreValidationReport,
      $defs: schema.$defs,
    });

    expect(schema.$defs).toEqual(expect.objectContaining({
      durableReplayStoreDesign: expect.any(Object),
      durableReplayStoreRecord: expect.any(Object),
      durableReplayStorePolicy: expect.any(Object),
      durableReplayStoreValidationReport: expect.any(Object),
    }));
    expect(validateDesign(design)).toBe(true);
    expect(validateReport(report)).toBe(true);
  });

  it('runs the durable replay design validator without writing external state', async () => {
    const result = runNode(validatorScript, ['--no-write']);
    const parsed = JSON.parse(result.stdout);

    expect(result.status).toBe(0);
    expect(parsed).toMatchObject({
      ok: true,
      durableReplayStoreDesigned: true,
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
      docsParsed: true,
      schemaParsed: true,
      noLiveDbCode: true,
      noSqlMigrationAdded: true,
      noDatabaseUrlUsage: true,
      noRailwayCliUsage: true,
      noServerListener: true,
      failures: [],
    });

    const module = await import(pathToFileURL(validatorScript).href) as {
      runPrivateServingDurableReplayDesignValidation: (
        options?: Record<string, unknown>,
      ) => Record<string, unknown>;
    };
    expect(module.runPrivateServingDurableReplayDesignValidation({ write: false }).ok).toBe(true);
  });

  it('keeps durable replay design artifacts free of live DB, Railway, and server paths', () => {
    const source = [
      designDocPath,
      schemaPath,
      validatorScript,
    ].map((path) => readFileSync(path, 'utf8')).join('\n');

    expect(source).not.toMatch(/from\s+['"](@prisma\/client|pg|knex|redis)['"]|new\s+PrismaClient|new\s+Pool/i);
    expect(source).not.toMatch(/DATABASE_URL|process\.env\[['"]?DATABASE_URL|process\.env\.DATABASE_URL/);
    expect(source).not.toMatch(/\brailway\s+(up|status|logs|link|whoami|run|deploy|variables)\b/i);
    expect(source).not.toMatch(/node:http|node:https|node:net|createServer|\.listen\s*\(/i);
  });

  it('keeps package wiring validation-only and exposure readiness blocked', () => {
    const packageJson = parseJsonFile(join(process.cwd(), 'package.json'));
    const scripts = packageJson.scripts as Record<string, string>;
    const readiness = JSON.parse(runNode(readinessScript, ['--no-write']).stdout);
    const cloudGate = JSON.parse(runNode(cloudGateScript, ['--no-write', '--report-only']).stdout);

    expect(scripts['gptoss:private-serving:durable-replay:design:validate']).toBe(
      'node scripts/gptoss/private-serving/private-serving-durable-replay-design-validate.mjs',
    );
    expect(readiness).toMatchObject({
      replayProtectionDurableDesigned: true,
      replayProtectionDurableImplemented: false,
      replayProtectionDurable: false,
      privateServingImplemented: false,
      privateServingExposed: false,
      cloudReady: false,
      customGptReady: false,
    });
    expect(cloudGate).toMatchObject({
      cloudReady: false,
      customGptReady: false,
      customGptDirectLocalExposureAllowed: false,
      checks: {
        replayProtectionDurableDesigned: true,
        replayProtectionDurableImplemented: false,
        replayProtectionDurable: false,
        privateServingImplemented: false,
        privateServingExposed: false,
      },
    });
    expect(cloudGate.blockers).toEqual(expect.arrayContaining([
      'private_serving_not_implemented',
      'replay_protection_durable_not_implemented',
      'replay_protection_not_durable',
    ]));
  });
});

