import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';

const operationsDocs = [
  join(process.cwd(), 'docs', 'GPTOSS_PRIVATE_SERVING_INCIDENT_RESPONSE.md'),
  join(process.cwd(), 'docs', 'GPTOSS_PRIVATE_SERVING_OPERATIONS_READINESS.md'),
  join(process.cwd(), 'docs', 'GPTOSS_PRIVATE_SERVING_GO_NO_GO_CHECKLIST.md'),
];
const schemaPath = join(process.cwd(), 'schemas', 'gptoss-private-serving-boundary.schema.json');
const validatorScript = join(
  process.cwd(),
  'scripts',
  'gptoss',
  'private-serving',
  'private-serving-operations-readiness-validate.mjs',
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

describe('gptoss private serving operations readiness', () => {
  it('has the Phase 5.11 operations docs', () => {
    const expectedMarkers = [
      /incident classes|Incident Classes/i,
      /operations preflight|Operations Preflight/i,
      /go\/no-go|NO-GO/i,
    ];

    for (const [index, path] of operationsDocs.entries()) {
      expect(existsSync(path)).toBe(true);
      const text = readFileSync(path, 'utf8');
      expect(text).toContain('Phase 5.11');
      expect(text).toMatch(expectedMarkers[index]);
      expect(text).toMatch(/NO-GO|blocked/i);
    }
  });

  it('parses operations schema sections and validates sample reports', () => {
    const schema = readJson(schemaPath);
    const ajv = new Ajv2020();
    const incidentResponse = {
      schemaVersion: 1,
      kind: 'gptoss_private_serving_incident_response_readiness',
      ok: true,
      incidentResponseReady: true,
      incidentClassesDocumented: true,
      severityLevelsDocumented: true,
      detectionSignalsDocumented: true,
      containmentActionsDocumented: true,
      emergencyDisableDocumented: true,
      rollbackCriteriaDocumented: true,
      auditPreservationDocumented: true,
      postIncidentReviewDocumented: true,
      doNotRunDocumented: true,
      privateServingImplemented: false,
      privateServingExposed: false,
      cloudReady: false,
      customGptReady: false,
      failures: [],
    };
    const goNoGoChecklist = {
      schemaVersion: 1,
      kind: 'gptoss_private_serving_go_no_go_checklist',
      ok: true,
      productionGoNoGoChecklistReady: true,
      productionGoAllowed: false,
      serverImplementationGate: 'NO-GO',
      privateNetworkBoundaryGate: 'NO-GO',
      durableReplayGate: 'NO-GO',
      durableRateLimitGate: 'NO-GO',
      keyManagementGate: 'NO-GO',
      auditRetentionGate: 'NO-GO',
      rollbackGate: 'NO-GO',
      incidentResponseGate: 'NO-GO',
      securityReviewGate: 'NO-GO',
      cloudExposureGate: 'NO-GO',
      customGptExposureGate: 'NO-GO',
      privateServingImplemented: false,
      privateServingExposed: false,
      cloudReady: false,
      customGptReady: false,
      failures: [],
    };
    const rollbackDecision = {
      decision: 'no_go',
      reason: 'production exposure remains blocked',
      severity: 'sev2',
      auditPreservationRequired: true,
      privateServingImplemented: false,
      privateServingExposed: false,
      cloudReady: false,
      customGptReady: false,
    };
    const operationsReport = JSON.parse(runNode(validatorScript, ['--no-write']).stdout);
    const validateIncident = ajv.compile({
      ...schema.$defs.incidentResponseReadinessReport,
      $defs: schema.$defs,
    });
    const validateGoNoGo = ajv.compile({
      ...schema.$defs.goNoGoChecklistReport,
      $defs: schema.$defs,
    });
    const validateRollback = ajv.compile({
      ...schema.$defs.rollbackDecision,
      $defs: schema.$defs,
    });
    const validateOperations = ajv.compile({
      ...schema.$defs.operationsReadinessReport,
      $defs: schema.$defs,
    });

    expect(schema.properties).toEqual(expect.objectContaining({
      operationsReadinessReport: expect.any(Object),
      incidentResponseReadinessReport: expect.any(Object),
      goNoGoChecklistReport: expect.any(Object),
      incidentSeverity: expect.any(Object),
      rollbackDecision: expect.any(Object),
    }));
    expect(validateIncident(incidentResponse)).toBe(true);
    expect(validateGoNoGo(goNoGoChecklist)).toBe(true);
    expect(validateRollback(rollbackDecision)).toBe(true);
    expect(validateOperations(operationsReport)).toBe(true);
  });

  it('runs the operations validator while keeping production go blocked', async () => {
    const result = runNode(validatorScript, ['--no-write']);
    const parsed = JSON.parse(result.stdout);

    expect(result.status).toBe(0);
    expect(parsed).toMatchObject({
      ok: true,
      operationsReadinessDesigned: true,
      incidentResponseReady: true,
      productionGoNoGoChecklistReady: true,
      productionGoAllowed: false,
      noServerListener: true,
      noOpenAiPath: true,
      noRailwayPath: true,
      noDbPath: true,
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
      runPrivateServingOperationsReadinessValidation: (
        options?: Record<string, unknown>,
      ) => Record<string, unknown>;
    };
    expect(module.runPrivateServingOperationsReadinessValidation({ write: false }).ok).toBe(true);
  });

  it('wires readiness, cloud gate, and package script state', () => {
    const packageJson = readJson(join(process.cwd(), 'package.json'));
    const readiness = JSON.parse(runNode(readinessScript, ['--no-write']).stdout);
    const cloudGate = JSON.parse(runNode(cloudGateScript, ['--no-write', '--report-only']).stdout);

    expect(packageJson.scripts['gptoss:private-serving:operations:validate']).toBe(
      'node scripts/gptoss/private-serving/private-serving-operations-readiness-validate.mjs',
    );
    expect(readiness).toMatchObject({
      operationsReadinessDesigned: true,
      incidentResponseReady: true,
      productionGoNoGoChecklistReady: true,
      productionGoAllowed: false,
      privateServingImplemented: false,
      privateServingExposed: false,
      cloudReady: false,
      customGptReady: false,
    });
    expect(cloudGate).toMatchObject({
      cloudReady: false,
      customGptReady: false,
      customGptDirectLocalExposureAllowed: false,
      operationsReadinessDesigned: true,
      incidentResponseReady: true,
      productionGoNoGoChecklistReady: true,
      productionGoAllowed: false,
      privateServingImplemented: false,
      privateServingExposed: false,
    });
    expect(cloudGate.blockers).toEqual(expect.arrayContaining([
      'private_serving_not_implemented',
      'production_go_not_allowed',
    ]));
  });

  it('keeps operations artifacts free of external operation paths', () => {
    const packageJson = readJson(join(process.cwd(), 'package.json'));
    const packageCommand = packageJson.scripts['gptoss:private-serving:operations:validate'];
    const report = JSON.parse(runNode(validatorScript, ['--no-write']).stdout);
    const source = [
      ...operationsDocs,
      schemaPath,
      validatorScript,
    ].map((path) => readFileSync(path, 'utf8')).join('\n');
    const operationSource = [
      readFileSync(schemaPath, 'utf8'),
      readFileSync(validatorScript, 'utf8'),
      packageCommand,
    ].join('\n');
    const imports = importSpecifiers(readFileSync(validatorScript, 'utf8'));

    expect(report).toMatchObject({
      productionGoAllowed: false,
      noServerListener: true,
      noOpenAiPath: true,
      noRailwayPath: true,
      noDbPath: true,
      noVllmPath: true,
      noTrainingPath: true,
      noRealSecretLiterals: true,
      noEnvSecretReads: true,
      noKmsImports: true,
      noCloudSdkImports: true,
    });
    expect(source).not.toMatch(/sk-[A-Za-z0-9_-]{16,}|Bearer\s+[A-Za-z0-9._-]{12,}|postgres:\/\/|redis:\/\//i);
    expect(source).not.toMatch(/\b(api[_-]?key|token|password|secret|cookie)\b\s*[:=]\s*["']?[A-Za-z0-9_./+=-]{12,}/i);
    expect(operationSource).not.toMatch(/node:http|node:https|node:net|createServer|\.listen\s*\(/i);
    expect(operationSource).not.toMatch(/api\.openai\.com|responses\.create|from\s+['"]openai['"]|new\s+OpenAI/i);
    expect(operationSource).not.toMatch(/\brailway\s+(up|status|logs|link|whoami|run|deploy|variables)\b/i);
    expect(operationSource).not.toMatch(new RegExp(`${'DATABASE'}_${'URL'}`));
    expect(operationSource).not.toMatch(/from\s+['"](@prisma\/client|pg|knex|redis)['"]|new\s+PrismaClient|new\s+Pool|createClient\s*\(/i);
    expect(operationSource).not.toMatch(/vllm\s+serve|vllm\./i);
    expect(operationSource).not.toMatch(/--execute|--allow-db-write|db:schema:apply|custom-gpt\s+(action|expose|deploy)/i);
    expect(imports).not.toEqual(expect.arrayContaining([
      expect.stringMatching(/kms|keyvault|cloudkms/i),
      expect.stringMatching(/@aws-sdk|aws-sdk|@google-cloud|googleapis|@azure\/|boto3/i),
    ]));
  });
});
