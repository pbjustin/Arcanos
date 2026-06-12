import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';

const readinessDocPath = join(
  process.cwd(),
  'docs',
  'GPTOSS_DURABLE_REPLAY_IMPLEMENTATION_READINESS.md',
);
const securityReviewPath = join(
  process.cwd(),
  'docs',
  'GPTOSS_DURABLE_REPLAY_SECURITY_REVIEW.md',
);
const rollbackPlanPath = join(
  process.cwd(),
  'docs',
  'GPTOSS_DURABLE_REPLAY_ROLLBACK_PLAN.md',
);
const readinessValidatorScript = join(
  process.cwd(),
  'scripts',
  'gptoss',
  'private-serving',
  'private-serving-durable-replay-readiness-validate.mjs',
);
const migrationGuardScript = join(
  process.cwd(),
  'scripts',
  'gptoss',
  'private-serving',
  'private-serving-durable-replay-migration-guard.mjs',
);
const durableReplayStoreScript = join(
  process.cwd(),
  'scripts',
  'gptoss',
  'private-serving',
  'private-serving-durable-replay-store.mjs',
);
const readinessScript = join(process.cwd(), 'scripts', 'gptoss', 'model-readiness-report.mjs');
const cloudGateScript = join(process.cwd(), 'scripts', 'gptoss', 'cloud-readiness-gate.mjs');
const schemaPath = join(process.cwd(), 'schemas', 'gptoss-private-serving-boundary.schema.json');

function runNode(script: string, args: string[] = []) {
  return spawnSync(process.execPath, [script, ...args], {
    cwd: process.cwd(),
    encoding: 'utf8',
  });
}

function readJson(path: string) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

describe('gptoss durable replay implementation readiness', () => {
  it('documents implementation readiness, security review, rollback plan, and key rotation', () => {
    const readinessDoc = readFileSync(readinessDocPath, 'utf8');
    const securityReview = readFileSync(securityReviewPath, 'utf8');
    const rollbackPlan = readFileSync(rollbackPlanPath, 'utf8');

    for (const term of [
      'PostgreSQL durable nonce ledger',
      'Alternatives Considered',
      'Durability Requirements',
      'Retention Requirements',
      'Replay Window Requirements',
      'Audit Requirements',
      'Implementation Blockers',
      'Key Rotation Review',
      'Architecture Review Gap Summary',
      '"replayProtectionDurableImplemented": false',
    ]) {
      expect(readinessDoc).toContain(term);
    }

    for (const term of [
      'No raw nonce storage',
      'No raw body storage',
      'No secret storage',
      'No signature storage',
      'No OpenAI contamination',
      'No training data ingestion',
      'No DB access in current phase',
      'No endpoint exposure',
      'No Custom GPT access',
    ]) {
      expect(securityReview).toContain(term);
    }

    for (const term of [
      'Migration Rollback Strategy',
      'Feature Disable Strategy',
      'Replay Fallback Behavior',
      'Audit Preservation',
      'Incident Recovery Checklist',
      'Fail-Closed Requirements',
      'contains no executable rollback code',
    ]) {
      expect(rollbackPlan).toContain(term);
    }
  });

  it('runs the readiness validator without writing and keeps implementation blocked', async () => {
    const result = runNode(readinessValidatorScript, ['--no-write']);
    const parsed = JSON.parse(result.stdout);

    expect(result.status).toBe(0);
    expect(parsed).toMatchObject({
      ok: true,
      durableReplayImplementationReady: true,
      replayProtectionDurableDesigned: true,
      replayProtectionDurableImplemented: false,
      replayProtectionDurable: false,
      privateServingImplemented: false,
      privateServingExposed: false,
      cloudReady: false,
      customGptReady: false,
      migrationGuardExists: true,
      migrationApplyBlocked: true,
      durableReplayMigrationApplied: false,
      liveDbUsed: false,
      liveDbWrite: false,
      serverCreated: false,
      openAiCalled: false,
      trainingExecuted: false,
      vllmUsed: false,
      railwayCliUsed: false,
      noDbImplementation: true,
      noServerImplementation: true,
      noExposurePath: true,
      failures: [],
    });

    const module = await import(pathToFileURL(readinessValidatorScript).href) as {
      runPrivateServingDurableReplayReadinessValidation: (
        options?: Record<string, unknown>,
      ) => Record<string, unknown>;
    };
    expect(
      module.runPrivateServingDurableReplayReadinessValidation({ write: false }).ok,
    ).toBe(true);
  });

  it('keeps the migration guard blocking apply and live DB writes', () => {
    const result = runNode(migrationGuardScript, ['--no-write']);
    const parsed = JSON.parse(result.stdout);

    expect(result.status).toBe(0);
    expect(parsed).toMatchObject({
      ok: true,
      applyAllowed: false,
      liveDbWrite: false,
      durableReplayMigrationApplied: false,
      durableReplayMigrationApplyAllowed: false,
      replayProtectionDurableImplemented: false,
      privateServingImplemented: false,
      privateServingExposed: false,
      cloudReady: false,
      customGptReady: false,
    });
  });

  it('keeps durable replay artifacts free of DB, server, and exposure implementation paths', () => {
    const source = [
      durableReplayStoreScript,
      readinessValidatorScript,
      migrationGuardScript,
    ].map((path) => readFileSync(path, 'utf8')).join('\n');

    expect(source).not.toMatch(/from\s+['"](@prisma\/client|pg|knex|redis)['"]|new\s+PrismaClient|new\s+Pool|createClient\s*\(/i);
    expect(source).not.toMatch(/DATABASE_URL|process\.env\[['"]?DATABASE_URL|process\.env\.DATABASE_URL/);
    expect(source).not.toMatch(/node:http|node:https|node:net|createServer|\.listen\s*\(/i);
    expect(source).not.toMatch(/\brailway\s+(up|status|logs|link|whoami|run|deploy|variables)\b/i);
    expect(source).not.toMatch(/api\.openai\.com|responses\.create/i);
    expect(source).not.toMatch(/npm\s+run\s+[^\r\n]*train|fine-tune|finetune/i);
    expect(source).not.toMatch(/vllm\s+serve|vllm\./i);
    expect(source).not.toMatch(/--execute|--allow-db-write|db:schema:apply/i);
  });

  it('adds schema definitions for readiness, security, and rollback reviews', () => {
    const schema = readJson(schemaPath);
    const ajv = new Ajv2020();
    const readinessReport = JSON.parse(runNode(readinessValidatorScript, ['--no-write']).stdout);
    const securityReview = {
      schemaVersion: 1,
      kind: 'gptoss_private_serving_durable_replay_security_review',
      ok: true,
      noRawNonceStorage: true,
      noRawBodyStorage: true,
      noSecretStorage: true,
      noSignatureStorage: true,
      noOpenAiContamination: true,
      noTrainingDataIngestion: true,
      noDbAccessInCurrentPhase: true,
      noEndpointExposure: true,
      noCustomGptAccess: true,
      durableReplayImplementationAllowed: false,
      failures: [],
    };
    const rollbackReview = {
      schemaVersion: 1,
      kind: 'gptoss_private_serving_durable_replay_rollback_review',
      ok: true,
      migrationRollbackStrategyDocumented: true,
      featureDisableStrategyDocumented: true,
      replayFallbackBehaviorDocumented: true,
      auditPreservationDocumented: true,
      incidentRecoveryChecklistDocumented: true,
      failClosedRequirementsDocumented: true,
      executableRollbackCode: false,
      cloudReady: false,
      customGptReady: false,
      failures: [],
    };

    const validateReadiness = ajv.compile({
      ...schema.$defs.durableReplayImplementationReadinessReport,
      $defs: schema.$defs,
    });
    const validateSecurity = ajv.compile({
      ...schema.$defs.durableReplaySecurityReview,
      $defs: schema.$defs,
    });
    const validateRollback = ajv.compile({
      ...schema.$defs.durableReplayRollbackReview,
      $defs: schema.$defs,
    });

    expect(schema.properties).toEqual(expect.objectContaining({
      durableReplayImplementationReadinessReport: expect.any(Object),
      durableReplaySecurityReview: expect.any(Object),
      durableReplayRollbackReview: expect.any(Object),
    }));
    expect(validateReadiness(readinessReport)).toBe(true);
    expect(validateSecurity(securityReview)).toBe(true);
    expect(validateRollback(rollbackReview)).toBe(true);
  });

  it('wires the package script and keeps cloud and Custom GPT readiness false', () => {
    const packageJson = readJson(join(process.cwd(), 'package.json'));
    const readiness = JSON.parse(runNode(readinessScript, ['--no-write']).stdout);
    const cloudGate = JSON.parse(runNode(cloudGateScript, ['--no-write', '--report-only']).stdout);

    expect(packageJson.scripts['gptoss:private-serving:durable-replay:readiness:validate']).toBe(
      'node scripts/gptoss/private-serving/private-serving-durable-replay-readiness-validate.mjs',
    );
    expect(readiness).toMatchObject({
      durableReplayImplementationReady: true,
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
      replayProtectionDurableImplemented: false,
      replayProtectionDurable: false,
      privateServingImplemented: false,
      privateServingExposed: false,
    });
  });
});
