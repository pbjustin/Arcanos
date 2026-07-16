import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';

const finalReadinessDocs = [
  join(process.cwd(), 'docs', 'GPTOSS_PRIVATE_SERVING_FINAL_READINESS_REVIEW.md'),
  join(process.cwd(), 'docs', 'GPTOSS_PHASE6_IMPLEMENTATION_ENTRY_CRITERIA.md'),
  join(process.cwd(), 'docs', 'GPTOSS_PRODUCTION_NO_GO_CHECKLIST.md'),
];
const schemaPath = join(process.cwd(), 'schemas', 'gptoss-private-serving-boundary.schema.json');
const validatorScript = join(
  process.cwd(),
  'scripts',
  'gptoss',
  'private-serving',
  'private-serving-final-readiness-validate.mjs',
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

let cachedValidatorResult: ReturnType<typeof runNode> | undefined;

function runValidatorNoWrite() {
  cachedValidatorResult ??= runNode(validatorScript, ['--no-write']);
  return cachedValidatorResult;
}

describe('gptoss private serving final architecture readiness', () => {
  it('has the Phase 5.12 final readiness and production no-go docs', () => {
    for (const path of finalReadinessDocs) {
      expect(existsSync(path)).toBe(true);
      const text = readFileSync(path, 'utf8');
      expect(text).toContain('Phase 5.12');
      expect(text).toMatch(/NO-GO/i);
      expect(text).toMatch(/phase6ImplementationReady/i);
    }
  });

  it('parses and validates all final readiness schema report definitions', () => {
    const schema = readJson(schemaPath);
    const result = runValidatorNoWrite();
    const report = JSON.parse(result.stdout);
    const ajv = new Ajv2020();
    const validateFinalReport = ajv.compile({
      ...schema.$defs.finalArchitectureReadinessReport,
      $defs: schema.$defs,
    });
    const validatePhase6Entry = ajv.compile({
      ...schema.$defs.phase6EntryCriteriaReport,
      $defs: schema.$defs,
    });
    const validateProductionNoGo = ajv.compile({
      ...schema.$defs.productionNoGoChecklistReport,
      $defs: schema.$defs,
    });

    expect(result.status).toBe(0);
    expect(schema.properties).toEqual(expect.objectContaining({
      finalArchitectureReadinessReport: {
        $ref: '#/$defs/finalArchitectureReadinessReport',
      },
      phase6EntryCriteriaReport: {
        $ref: '#/$defs/phase6EntryCriteriaReport',
      },
      productionNoGoChecklistReport: {
        $ref: '#/$defs/productionNoGoChecklistReport',
      },
    }));
    expect(schema.$defs).toEqual(expect.objectContaining({
      finalArchitectureReadinessReport: expect.any(Object),
      phase6EntryCriteriaReport: expect.any(Object),
      productionNoGoChecklistReport: expect.any(Object),
    }));
    expect(validateFinalReport(report)).toBe(true);
    expect(validatePhase6Entry(report.phase6EntryCriteria)).toBe(true);
    expect(validateProductionNoGo(report.productionNoGoChecklist)).toBe(true);
  });

  it('runs the final readiness validator through CLI and exported function modes', async () => {
    const result = runValidatorNoWrite();
    const report = JSON.parse(result.stdout);

    expect(result.status).toBe(0);
    expect(report).toMatchObject({
      schemaVersion: 1,
      kind: 'gptoss_private_serving_final_architecture_readiness',
      ok: true,
      effectiveScore: '24/24',
      phase6ImplementationReady: true,
      finalArchitectureReadinessReviewed: true,
      localControlledRuntimeReady: true,
      requestSigningImplemented: true,
      authBoundaryImplemented: true,
      replayProtectionImplemented: true,
      replayProtectionDurableDesigned: true,
      replayProtectionDurableImplemented: false,
      durableReplayMigrationApplyAllowed: false,
      durableRateLimitDesigned: true,
      durableRateLimitImplemented: false,
      productionKeyManagementDesigned: true,
      productionKeyManagementImplemented: false,
      operationsReadinessDesigned: true,
      incidentResponseReady: true,
      productionGoNoGoChecklistReady: true,
      productionGoAllowed: false,
      privateServingImplemented: false,
      privateServingExposed: false,
      cloudReady: false,
      customGptReady: false,
      allRequiredPhase5DocsExist: true,
      allKeyValidatorsExist: true,
      ciReleaseGatePassed: true,
      trackedBaselineValid: true,
      noServerListener: true,
      noDbPath: true,
      noMigrationApplyPath: true,
      noRailwayPath: true,
      noOpenAiPath: true,
      noTrainingPath: true,
      noVllmPath: true,
      noDeploymentPath: true,
      noCustomGptExposurePath: true,
      noRealSecretLiterals: true,
      noEnvSecretReads: true,
      noKmsImports: true,
      noCloudSdkImports: true,
      noExternalOperationPath: true,
      serverCreated: false,
      publicServerCreated: false,
      liveDbUsed: false,
      migrationApplied: false,
      railwayCliUsed: false,
      openAiCalled: false,
      trainingExecuted: false,
      vllmUsed: false,
      deploymentExecuted: false,
      customGptExposureCreated: false,
      realSecretsUsed: false,
      envSecretsRead: false,
      kmsIntegrated: false,
      failures: [],
    });
    expect(report.phase6EntryCriteria).toMatchObject({
      phase6ImplementationReady: true,
      finalArchitectureReadinessReviewed: true,
      internalPrivateServingRequestHandlerAllowed: true,
      publicServerAllowed: false,
      publicExposureAllowed: false,
      customGptBridgeAllowed: false,
      rawModelEndpointAllowed: false,
      liveDbAllowed: false,
      deploymentAllowed: false,
      productionGoAllowed: false,
      privateServingImplemented: false,
      privateServingExposed: false,
      cloudReady: false,
      customGptReady: false,
    });
    expect(report.productionNoGoChecklist).toMatchObject({
      replayProtectionDurableImplemented: false,
      durableReplayMigrationApplyAllowed: false,
      durableRateLimitImplemented: false,
      productionKeyManagementImplemented: false,
      productionGoAllowed: false,
      privateServingImplemented: false,
      privateServingExposed: false,
      cloudReady: false,
      customGptReady: false,
    });

    const module = await import(pathToFileURL(validatorScript).href) as {
      runPrivateServingFinalReadinessValidation: (
        options?: Record<string, unknown>,
      ) => Record<string, unknown>;
    };
    expect(module.runPrivateServingFinalReadinessValidation({ write: false })).toMatchObject({
      ok: true,
      phase6ImplementationReady: true,
      productionGoAllowed: false,
      privateServingImplemented: false,
      privateServingExposed: false,
      cloudReady: false,
      customGptReady: false,
      failures: [],
    });
  });

  it('wires the exact package command and preserves readiness and cloud blockers', () => {
    const packageJson = readJson(join(process.cwd(), 'package.json'));
    const readinessResult = runNode(readinessScript, ['--no-write']);
    const cloudGateResult = runNode(cloudGateScript, ['--no-write', '--report-only']);
    const readiness = JSON.parse(readinessResult.stdout);
    const cloudGate = JSON.parse(cloudGateResult.stdout);
    const expectedState = {
      phase6ImplementationReady: true,
      finalArchitectureReadinessReviewed: true,
      replayProtectionDurableImplemented: false,
      durableReplayMigrationApplyAllowed: false,
      durableRateLimitImplemented: false,
      productionKeyManagementImplemented: false,
      productionGoAllowed: false,
      privateServingImplemented: false,
      privateServingExposed: false,
      cloudReady: false,
      customGptReady: false,
    };

    expect(readinessResult.status).toBe(0);
    expect(cloudGateResult.status).toBe(0);
    expect(packageJson.scripts['gptoss:private-serving:final-readiness:validate']).toBe(
      'node scripts/gptoss/private-serving/private-serving-final-readiness-validate.mjs',
    );
    expect(readiness).toMatchObject(expectedState);
    expect(cloudGate).toMatchObject(expectedState);
    expect(cloudGate.blockers).toEqual(expect.arrayContaining([
      'private_serving_not_implemented',
      'production_key_management_not_implemented',
      'replay_protection_durable_not_implemented',
      'durable_rate_limit_not_implemented',
      'production_go_not_allowed',
    ]));
  });

  it('keeps executable Phase 5.12 sources free of prohibited operation paths', () => {
    const packageJson = readJson(join(process.cwd(), 'package.json'));
    const packageCommand = packageJson.scripts[
      'gptoss:private-serving:final-readiness:validate'
    ];
    const report = JSON.parse(runValidatorNoWrite().stdout);
    const executableSourcePaths = [validatorScript, readinessScript, cloudGateScript];
    const executableSource = [
      ...executableSourcePaths.map((path) => readFileSync(path, 'utf8')),
      packageCommand,
    ].join('\n');
    const imports = executableSourcePaths.flatMap((path) => (
      importSpecifiers(readFileSync(path, 'utf8'))
    ));

    expect(report).toMatchObject({
      noServerListener: true,
      noDbPath: true,
      noMigrationApplyPath: true,
      noRailwayPath: true,
      noOpenAiPath: true,
      noTrainingPath: true,
      noVllmPath: true,
      noDeploymentPath: true,
      noCustomGptExposurePath: true,
      noRealSecretLiterals: true,
      noEnvSecretReads: true,
      noKmsImports: true,
      noCloudSdkImports: true,
      serverCreated: false,
      liveDbUsed: false,
      migrationApplied: false,
      railwayCliUsed: false,
      openAiCalled: false,
      trainingExecuted: false,
      vllmUsed: false,
      deploymentExecuted: false,
      customGptExposureCreated: false,
      realSecretsUsed: false,
      envSecretsRead: false,
      kmsIntegrated: false,
    });
    expect(executableSource).not.toMatch(
      /from\s+['"](?:node:http|node:https|node:net|express|fastify|hono)['"]/i,
    );
    expect(executableSource).not.toMatch(/\bcreateServer\s*\(|\.listen\s*\(|(?:Bun|Deno)\.serve\s*\(/i);
    expect(executableSource).not.toMatch(
      /from\s+['"](?:@prisma\/client|pg|knex|redis|ioredis|mysql2?|mongoose)['"]/i,
    );
    expect(executableSource).not.toMatch(/new\s+(?:PrismaClient|Pool)\s*\(|createClient\s*\(/i);
    expect(executableSource).not.toMatch(
      /--execute\b|--allow-db-write\b|db:schema:apply\b|prisma\s+migrate\s+deploy|knex\s+migrate:latest/i,
    );
    expect(executableSource).not.toMatch(
      /\brailway\s+(?:up|status|logs|link|whoami|run|deploy|variables)\b/i,
    );
    expect(executableSource).not.toMatch(
      /api\.openai\.com|responses\.create|from\s+['"]openai['"]|new\s+OpenAI\s*\(/i,
    );
    expect(executableSource).not.toMatch(/\.train\s*\(|fine_tuning\.jobs\.create|fine-tune\s+(?:run|create)/i);
    expect(executableSource).not.toMatch(/\bvllm\s+serve|from\s+['"]vllm|\bvllm\./i);
    expect(executableSource).not.toMatch(
      /kubectl\s+apply|terraform\s+apply|\.deploy\s*\(|npm\s+run\s+deploy\b/i,
    );
    expect(executableSource).not.toMatch(
      /custom-gpt\s+(?:action|expose|deploy)|customGptExposureCreated\s*:\s*true/i,
    );
    expect(executableSource).not.toMatch(/sk-[A-Za-z0-9_-]{16,}|Bearer\s+[A-Za-z0-9._-]{12,}/i);
    expect(executableSource).not.toMatch(/postgres:\/\/|redis:\/\//i);
    expect(executableSource).not.toMatch(
      /\b(api[_-]?key|token|password|secret|cookie)\b\s*[:=]\s*["']?[A-Za-z0-9_./+=-]{12,}/i,
    );
    expect(executableSource).not.toMatch(
      new RegExp(
        `${'process'}\\s*\\.\\s*${'env'}[^\\n;]*(?:KEY|TOKEN|SECRET|PASSWORD|DATABASE|REDIS|OPENAI|RAILWAY)`,
        'i',
      ),
    );
    expect(imports).not.toEqual(expect.arrayContaining([
      expect.stringMatching(/kms|keyvault|cloudkms/i),
      expect.stringMatching(/@aws-sdk|aws-sdk|@google-cloud|googleapis|@azure\/|boto3/i),
    ]));
  });
});
