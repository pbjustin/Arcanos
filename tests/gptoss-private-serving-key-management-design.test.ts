import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';

const keyManagementDocs = [
  join(process.cwd(), 'docs', 'GPTOSS_PRODUCTION_KEY_MANAGEMENT_DESIGN.md'),
  join(process.cwd(), 'docs', 'GPTOSS_KEY_ROTATION_RUNBOOK.md'),
];
const schemaPath = join(process.cwd(), 'schemas', 'gptoss-private-serving-boundary.schema.json');
const validatorScript = join(
  process.cwd(),
  'scripts',
  'gptoss',
  'private-serving',
  'private-serving-key-management-design-validate.mjs',
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

describe('gptoss private serving key management design', () => {
  it('has the Phase 5.9 design docs', () => {
    for (const path of keyManagementDocs) {
      expect(existsSync(path)).toBe(true);
      expect(readFileSync(path, 'utf8')).toContain('Phase 5.9');
    }
  });

  it('parses key-management schema sections and validates sample shapes', () => {
    const schema = readJson(schemaPath);
    const ajv = new Ajv2020();
    const keyDescriptor = {
      keyId: 'gptoss-prod-router-202606-v1',
      subject: 'gptoss-private-serving',
      label: 'phase59-design-descriptor',
      owner: 'platform-security',
      audience: 'gptoss-effective-router-private',
      status: 'planned',
      activationTime: '2026-06-15T00:00:00.000Z',
      retirementTime: '2026-09-15T00:00:00.000Z',
      rawKeyMaterialStored: false,
      envSecretRead: false,
      kmsIntegrated: false,
    };
    const keyRotationPolicy = {
      designed: true,
      implemented: false,
      cadenceDays: 90,
      overlapWindowRequired: true,
      oldKeyReplayWindowHandling: 'keyId+nonce_window_bound',
      durableReplayRequired: true,
      realSecretsUsed: false,
      envSecretsRead: false,
      kmsIntegrated: false,
    };
    const keyRevocationPolicy = {
      designed: true,
      implemented: false,
      failureMode: 'fail_closed',
      revokedKeyAccepted: false,
      auditMetadataRetained: true,
      fallbackAllowed: false,
      privateServingImplemented: false,
      privateServingExposed: false,
    };
    const design = {
      schemaVersion: 1,
      phase: '5.9',
      productionKeyManagementDesigned: true,
      productionKeyManagementImplemented: false,
      realSecretsUsed: false,
      envSecretsRead: false,
      kmsIntegrated: false,
      keyDescriptor,
      keyRotationPolicy,
      keyRevocationPolicy,
      auditRequirements: ['redacted key metadata only'],
      futureImplementationBlockers: ['durable replay is not implemented'],
      privateServingImplemented: false,
      privateServingExposed: false,
      cloudReady: false,
      customGptReady: false,
    };
    const readinessReport = JSON.parse(runNode(validatorScript, ['--no-write']).stdout);
    const validateDesign = ajv.compile({
      ...schema.$defs.productionKeyManagementDesign,
      $defs: schema.$defs,
    });
    const validateReport = ajv.compile({
      ...schema.$defs.keyManagementReadinessReport,
      $defs: schema.$defs,
    });

    expect(schema.properties).toEqual(expect.objectContaining({
      productionKeyManagementDesign: expect.any(Object),
      keyDescriptor: expect.any(Object),
      keyRotationPolicy: expect.any(Object),
      keyRevocationPolicy: expect.any(Object),
      keyManagementReadinessReport: expect.any(Object),
    }));
    expect(schema.$defs).toEqual(expect.objectContaining({
      productionKeyManagementDesign: expect.any(Object),
      keyDescriptor: expect.any(Object),
      keyRotationPolicy: expect.any(Object),
      keyRevocationPolicy: expect.any(Object),
      keyManagementReadinessReport: expect.any(Object),
    }));
    expect(validateDesign(design)).toBe(true);
    expect(validateReport(readinessReport)).toBe(true);
  });

  it('runs the key-management validator without implementing serving', async () => {
    const result = runNode(validatorScript, ['--no-write']);
    const parsed = JSON.parse(result.stdout);

    expect(result.status).toBe(0);
    expect(parsed).toMatchObject({
      ok: true,
      productionKeyManagementDesigned: true,
      productionKeyManagementImplemented: false,
      keyRotationPolicyDesigned: true,
      keyRotationPolicyImplemented: false,
      keyRevocationPolicyDesigned: true,
      keyRevocationPolicyImplemented: false,
      realSecretsUsed: false,
      envSecretsRead: false,
      kmsIntegrated: false,
      noRealSecretLiterals: true,
      noEnvSecretReads: true,
      noKmsImports: true,
      noCloudSdkImports: true,
      noServerListener: true,
      noOpenAiPath: true,
      noRailwayPath: true,
      noDbPath: true,
      noVllmPath: true,
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
      runPrivateServingKeyManagementDesignValidation: (
        options?: Record<string, unknown>,
      ) => Record<string, unknown>;
    };
    expect(module.runPrivateServingKeyManagementDesignValidation({ write: false }).ok).toBe(true);
  });

  it('keeps key-management artifacts free of secrets, env reads, cloud SDKs, servers, and external paths', () => {
    const packageJson = readJson(join(process.cwd(), 'package.json'));
    const packageCommand = packageJson.scripts[
      'gptoss:private-serving:key-management:design:validate'
    ];
    const source = [
      ...keyManagementDocs,
      schemaPath,
      validatorScript,
    ].map((path) => readFileSync(path, 'utf8')).join('\n');
    const operationSource = [
      readFileSync(schemaPath, 'utf8'),
      readFileSync(validatorScript, 'utf8'),
      packageCommand,
    ].join('\n');
    const imports = importSpecifiers(readFileSync(validatorScript, 'utf8'));

    expect(source).not.toMatch(/sk-[A-Za-z0-9_-]{16,}|Bearer\s+[A-Za-z0-9._-]{12,}|postgres:\/\/|redis:\/\//i);
    expect(source).not.toMatch(/\b(api[_-]?key|token|password|secret|cookie)\b\s*[:=]\s*["']?[A-Za-z0-9_./+=-]{12,}/i);
    expect(source).not.toMatch(/process\.env[^\n;]*(KEY|TOKEN|SECRET|PASSWORD|DATABASE|REDIS|OPENAI|RAILWAY)/i);
    expect(imports).not.toEqual(expect.arrayContaining([
      expect.stringMatching(/kms|keyvault|cloudkms/i),
      expect.stringMatching(/@aws-sdk|aws-sdk|@google-cloud|googleapis|@azure\/|boto3/i),
    ]));
    expect(operationSource).not.toMatch(/node:http|node:https|node:net|createServer|\.listen\s*\(/i);
    expect(operationSource).not.toMatch(/api\.openai\.com|responses\.create|from\s+['"]openai['"]|new\s+OpenAI/i);
    expect(operationSource).not.toMatch(/\brailway\s+(up|status|logs|link|whoami|run|deploy|variables)\b/i);
    expect(operationSource).not.toMatch(/from\s+['"](@prisma\/client|pg|knex|redis)['"]|new\s+PrismaClient|new\s+Pool|createClient\s*\(/i);
    expect(operationSource).not.toMatch(/postgres:\/\/|redis:\/\//i);
    expect(packageCommand).not.toMatch(/DATABASE_URL/i);
    expect(operationSource).not.toMatch(/vllm\s+serve|vllm\./i);
    expect(operationSource).not.toMatch(/--execute|--allow-db-write|db:schema:apply|custom-gpt\s+(action|expose|deploy)/i);
  });

  it('wires the package script and keeps cloud and private serving blocked', () => {
    const packageJson = readJson(join(process.cwd(), 'package.json'));
    const readiness = JSON.parse(runNode(readinessScript, ['--no-write']).stdout);
    const cloudGate = JSON.parse(runNode(cloudGateScript, ['--no-write', '--report-only']).stdout);

    expect(packageJson.scripts['gptoss:private-serving:key-management:design:validate']).toBe(
      'node scripts/gptoss/private-serving/private-serving-key-management-design-validate.mjs',
    );
    expect(readiness).toMatchObject({
      productionKeyManagementDesigned: true,
      productionKeyManagementImplemented: false,
      realSecretsUsed: false,
      envSecretsRead: false,
      kmsIntegrated: false,
      privateServingImplemented: false,
      privateServingExposed: false,
      cloudReady: false,
      customGptReady: false,
    });
    expect(cloudGate).toMatchObject({
      cloudReady: false,
      customGptReady: false,
      customGptDirectLocalExposureAllowed: false,
      productionKeyManagementDesigned: true,
      productionKeyManagementImplemented: false,
      realSecretsUsed: false,
      envSecretsRead: false,
      kmsIntegrated: false,
      privateServingImplemented: false,
      privateServingExposed: false,
    });
    expect(cloudGate.blockers).toEqual(expect.arrayContaining([
      'production_key_management_not_implemented',
      'kms_not_integrated',
      'private_serving_not_implemented',
    ]));
  });
});
