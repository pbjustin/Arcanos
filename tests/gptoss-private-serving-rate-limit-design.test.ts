import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';

const rateLimitDocs = [
  join(process.cwd(), 'docs', 'GPTOSS_DURABLE_RATE_LIMIT_DESIGN.md'),
  join(process.cwd(), 'docs', 'GPTOSS_RATE_LIMIT_RUNBOOK.md'),
];
const schemaPath = join(process.cwd(), 'schemas', 'gptoss-private-serving-boundary.schema.json');
const validatorScript = join(
  process.cwd(),
  'scripts',
  'gptoss',
  'private-serving',
  'private-serving-rate-limit-design-validate.mjs',
);
const rateLimitScript = join(
  process.cwd(),
  'scripts',
  'gptoss',
  'private-serving',
  'private-serving-rate-limit.mjs',
);
const readinessScript = join(process.cwd(), 'scripts', 'gptoss', 'model-readiness-report.mjs');
const cloudGateScript = join(process.cwd(), 'scripts', 'gptoss', 'cloud-readiness-gate.mjs');

function runNode(script: string, args: string[] = []) {
  return spawnSync(process.execPath, [script, ...args], {
    cwd: process.cwd(),
    encoding: 'utf8',
  });
}

function readJson(path: string) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function importSpecifiers(text: string) {
  const specifiers: string[] = [];
  for (const match of text.matchAll(/^\s*import(?:[\s\S]*?)from\s+['"]([^'"]+)['"]/gm)) {
    specifiers.push(match[1]);
  }
  for (const match of text.matchAll(/\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/gm)) {
    specifiers.push(match[1]);
  }
  return specifiers;
}

describe('gptoss private serving durable rate-limit design', () => {
  it('has the Phase 5.10 design docs and runbook', () => {
    for (const path of rateLimitDocs) {
      expect(existsSync(path)).toBe(true);
      const text = readFileSync(path, 'utf8');
      expect(text).toContain('Phase 5.10');
      expect(text).toMatch(/durable rate-limit/i);
      expect(text).toMatch(/local scaffold/i);
      expect(text).toMatch(/implementation remains blocked|private serving remains blocked/i);
    }
  });

  it('parses durable rate-limit schema sections and validates sample shapes', () => {
    const schema = readJson(schemaPath);
    const ajv = new Ajv2020();
    const hash = 'a'.repeat(64);
    const policy = {
      designed: true,
      implemented: false,
      durable: false,
      quotaScopes: ['keyId', 'subject', 'action', 'global'],
      burstPolicyDesigned: true,
      abuseMitigationDesigned: true,
      replayInteractionDesigned: true,
      authInteractionDesigned: true,
      failureMode: 'fail_closed',
      liveDbAccessInPhase: false,
      migrationApplyPathCreated: false,
    };
    const auditRecord = {
      schemaVersion: 1,
      requestId: 'phase510-rate-limit-audit',
      keyId: 'gptoss-rate-limit-design-key',
      subjectHash: hash,
      action: 'classify',
      quotaScope: 'keyId',
      windowStart: '2026-06-16T00:00:00.000Z',
      windowEnd: '2026-06-16T00:01:00.000Z',
      retryAfterSeconds: 30,
      denialReason: 'durable_rate_limit_not_implemented',
      rawRequestBodyStored: false,
      secretsStored: false,
      liveDbRecordCreated: false,
    };
    const design = {
      schemaVersion: 1,
      phase: '5.10',
      durableRateLimitDesigned: true,
      durableRateLimitImplemented: false,
      rateLimitDurable: false,
      policy,
      auditRecord,
      futureImplementationBlockers: ['durable backend is not selected'],
      privateServingImplemented: false,
      privateServingExposed: false,
      cloudReady: false,
      customGptReady: false,
    };
    const decision = {
      ok: false,
      allowed: false,
      implemented: false,
      durable: false,
      keyId: 'gptoss-rate-limit-design-key',
      subject: 'subject-redacted',
      action: 'classify',
      quotaScope: 'keyId',
      retryAfterSeconds: 30,
      denialReason: 'rate_limited',
    };
    const readinessReport = JSON.parse(runNode(validatorScript, ['--no-write']).stdout);
    const validateDesign = ajv.compile({
      ...schema.$defs.durableRateLimitDesign,
      $defs: schema.$defs,
    });
    const validateDecision = ajv.compile({
      ...schema.$defs.durableRateLimitDecision,
      $defs: schema.$defs,
    });
    const validateReport = ajv.compile({
      ...schema.$defs.durableRateLimitReadinessReport,
      $defs: schema.$defs,
    });

    expect(schema.properties).toEqual(expect.objectContaining({
      durableRateLimitDesign: expect.any(Object),
      durableRateLimitPolicy: expect.any(Object),
      durableRateLimitDecision: expect.any(Object),
      durableRateLimitReadinessReport: expect.any(Object),
      durableRateLimitAuditRecord: expect.any(Object),
    }));
    expect(schema.$defs).toEqual(expect.objectContaining({
      durableRateLimitDesign: expect.any(Object),
      durableRateLimitPolicy: expect.any(Object),
      durableRateLimitDecision: expect.any(Object),
      durableRateLimitReadinessReport: expect.any(Object),
      durableRateLimitAuditRecord: expect.any(Object),
    }));
    expect(validateDesign(design)).toBe(true);
    expect(validateDecision(decision)).toBe(true);
    expect(validateReport(readinessReport)).toBe(true);
  });

  it('runs the rate-limit design validator while keeping serving unimplemented', async () => {
    const result = runNode(validatorScript, ['--no-write']);
    const parsed = JSON.parse(result.stdout);

    expect(result.status).toBe(0);
    expect(parsed).toMatchObject({
      ok: true,
      durableRateLimitDesigned: true,
      durableRateLimitImplemented: false,
      rateLimitDurable: false,
      noDbClientImports: true,
      noDatabaseUrlUsage: true,
      noRailwayUsage: true,
      noServerListener: true,
      noOpenAiPath: true,
      noVllmPath: true,
      noTrainingPath: true,
      noRealSecretLiterals: true,
      noEnvSecretReads: true,
      noKmsImports: true,
      noCloudSdkImports: true,
      readinessBlocked: true,
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
    });

    const module = await import(pathToFileURL(validatorScript).href) as {
      runPrivateServingRateLimitDesignValidation: (
        options?: Record<string, unknown>,
      ) => Record<string, unknown>;
    };
    expect(module.runPrivateServingRateLimitDesignValidation({ write: false }).ok).toBe(true);
  });

  it('wires the package script and keeps readiness blocked', () => {
    const packageJson = readJson(join(process.cwd(), 'package.json'));
    const readiness = JSON.parse(runNode(readinessScript, ['--no-write']).stdout);
    const cloudGate = JSON.parse(runNode(cloudGateScript, ['--no-write', '--report-only']).stdout);

    expect(packageJson.scripts['gptoss:private-serving:rate-limit:design:validate']).toBe(
      'node scripts/gptoss/private-serving/private-serving-rate-limit-design-validate.mjs',
    );
    expect(readiness).toMatchObject({
      durableRateLimitDesigned: true,
      durableRateLimitImplemented: false,
      rateLimitDurable: false,
      privateServingImplemented: false,
      privateServingExposed: false,
      cloudReady: false,
      customGptReady: false,
    });
    expect(cloudGate).toMatchObject({
      cloudReady: false,
      customGptReady: false,
      customGptDirectLocalExposureAllowed: false,
      durableRateLimitDesigned: true,
      durableRateLimitImplemented: false,
      rateLimitDurable: false,
      privateServingImplemented: false,
      privateServingExposed: false,
    });
    expect(cloudGate.blockers).toEqual(expect.arrayContaining([
      'private_serving_not_implemented',
      'durable_rate_limit_not_implemented',
      'rate_limit_not_durable',
    ]));
  });

  it('keeps rate-limit artifacts free of durable implementation and external paths', () => {
    const packageJson = readJson(join(process.cwd(), 'package.json'));
    const packageCommand = packageJson.scripts[
      'gptoss:private-serving:rate-limit:design:validate'
    ];
    const report = JSON.parse(runNode(validatorScript, ['--no-write']).stdout);
    const source = [
      ...rateLimitDocs,
      schemaPath,
      rateLimitScript,
      validatorScript,
    ].map((path) => readFileSync(path, 'utf8')).join('\n');
    const operationSource = [
      readFileSync(schemaPath, 'utf8'),
      readFileSync(rateLimitScript, 'utf8'),
      readFileSync(validatorScript, 'utf8'),
      packageCommand,
    ].join('\n');
    const imports = importSpecifiers(readFileSync(validatorScript, 'utf8'));

    expect(report).toMatchObject({
      durableRateLimitImplemented: false,
      rateLimitDurable: false,
      noDbClientImports: true,
      noDatabaseUrlUsage: true,
      noRailwayUsage: true,
      noServerListener: true,
      noOpenAiPath: true,
      noVllmPath: true,
      noTrainingPath: true,
      noRealSecretLiterals: true,
      noEnvSecretReads: true,
      noKmsImports: true,
      noCloudSdkImports: true,
    });
    expect(readFileSync(rateLimitScript, 'utf8')).toContain('new Map');
    expect(source).not.toMatch(/sk-[A-Za-z0-9_-]{16,}|Bearer\s+[A-Za-z0-9._-]{12,}|postgres:\/\/|redis:\/\//i);
    expect(source).not.toMatch(/\b(api[_-]?key|token|password|secret|cookie)\b\s*[:=]\s*["']?[A-Za-z0-9_./+=-]{12,}/i);
    expect(operationSource).not.toMatch(new RegExp(`${'DATABASE'}_${'URL'}`));
    expect(imports).not.toEqual(expect.arrayContaining([
      expect.stringMatching(/^(@prisma\/client|pg|knex|redis|ioredis|mysql2?)$/i),
      expect.stringMatching(/kms|keyvault|cloudkms/i),
      expect.stringMatching(/@aws-sdk|aws-sdk|@google-cloud|googleapis|@azure\/|boto3/i),
    ]));
    expect(operationSource).not.toMatch(/node:http|node:https|node:net|createServer|\.listen\s*\(/i);
    expect(operationSource).not.toMatch(/api\.openai\.com|responses\.create|from\s+['"]openai['"]|new\s+OpenAI/i);
    expect(operationSource).not.toMatch(/\brailway\s+(up|status|logs|link|whoami|run|deploy|variables)\b/i);
    expect(operationSource).not.toMatch(/from\s+['"](@prisma\/client|pg|knex|redis)['"]|new\s+PrismaClient|new\s+Pool|createClient\s*\(/i);
    expect(operationSource).not.toMatch(/vllm\s+serve|vllm\./i);
    expect(operationSource).not.toMatch(/--execute|--allow-db-write|db:schema:apply|custom-gpt\s+(action|expose|deploy)/i);
  });
});
