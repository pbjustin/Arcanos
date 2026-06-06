import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';

const privateSchemaPath = join(process.cwd(), 'schemas', 'gptoss-private-serving-boundary.schema.json');
const endpointContractPath = join(process.cwd(), 'docs', 'GPTOSS_PRIVATE_ENDPOINT_CONTRACT.md');
const boundaryDocPath = join(process.cwd(), 'docs', 'GPTOSS_PRIVATE_SERVING_BOUNDARY.md');
const threatModelPath = join(process.cwd(), 'docs', 'GPTOSS_PRIVATE_SERVING_THREAT_MODEL.md');
const runbookPath = join(process.cwd(), 'docs', 'GPTOSS_PRIVATE_SERVING_RUNBOOK.md');
const readinessScript = join(process.cwd(), 'scripts', 'gptoss', 'model-readiness-report.mjs');
const cloudGateScript = join(process.cwd(), 'scripts', 'gptoss', 'cloud-readiness-gate.mjs');
const designValidateScript = join(process.cwd(), 'scripts', 'gptoss', 'private-serving-design-validate.mjs');
const threatValidateScript = join(process.cwd(), 'scripts', 'gptoss', 'private-serving-threat-model-validate.mjs');

function runNode(script: string, args: string[] = []) {
  return spawnSync(process.execPath, [script, ...args], {
    cwd: process.cwd(),
    encoding: 'utf8',
  });
}

function parseJsonFile(path: string) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

describe('gptoss private serving design boundary', () => {
  it('parses and validates the private serving schema sections', () => {
    const schema = parseJsonFile(privateSchemaPath);
    const ajv = new Ajv2020();
    const validate = ajv.compile(schema);
    const hash = 'a'.repeat(64);
    const sample = {
      kind: 'gptoss_private_serving_boundary',
      schemaVersion: 1,
      request: {
        requestId: 'phase5-private-design-test',
        timestamp: '2026-05-28T00:00:00.000Z',
        nonce: 'noncePhase5Design01',
        audience: 'gptoss-effective-router-private',
        signatureAlgorithm: 'hmac-sha256',
        keyId: 'phase5-local-signer',
        bodyHash: hash,
        signature: `hmac-sha256:${'b'.repeat(64)}`,
        input: {
          userInput: 'Write a TypeScript helper for dataset validation.',
          mode: 'router_classifier',
        },
      },
      response: {
        requestId: 'phase5-private-design-test',
        effective: {
          plane: 'writing-plane',
          action: 'write_typescript_dataset_validation_helper',
          risk: 'low',
          requiresConfirmation: false,
          allowedForTraining: false,
          sources: ['model', 'postprocessor'],
        },
        safety: {
          openAiCalled: false,
          trainingExecuted: false,
          vllmUsed: false,
          railwayCliUsed: false,
          liveDbUsed: false,
          noOpenAiOutputUsed: true,
        },
        audit: {
          auditVersion: 1,
          requestId: 'phase5-private-design-test',
          timestamp: '2026-05-28T00:00:00.000Z',
          bodyHash: hash,
          decision: 'allowed',
        },
        replay: {
          replayable: true,
          requestHash: hash,
          nonce: 'noncePhase5Design01',
        },
        readiness: {
          privateServingDesignReady: true,
          privateServingScaffoldReady: true,
          privateServingImplemented: false,
          privateServingExposed: false,
          requestSigningDesigned: true,
          requestSigningScaffoldReady: true,
          requestSigningImplemented: true,
          authBoundaryDesigned: true,
          authBoundaryScaffoldReady: true,
          authBoundaryImplemented: true,
          replayProtectionScaffoldReady: true,
          replayProtectionImplemented: false,
          rateLimitScaffoldReady: true,
          rateLimitImplemented: false,
          responseShapingScaffoldReady: true,
          publicServerCreated: false,
          cloudReady: false,
          customGptReady: false,
        },
      },
    };

    expect(schema.$defs).toEqual(expect.objectContaining({
      signedRequestEnvelope: expect.any(Object),
      responseEnvelope: expect.any(Object),
      safetyFlags: expect.any(Object),
      auditMetadata: expect.any(Object),
      replayMetadata: expect.any(Object),
      denialResponse: expect.any(Object),
      rateLimitResponse: expect.any(Object),
      authFailureResponse: expect.any(Object),
      authDecision: expect.any(Object),
      authFailure: expect.any(Object),
      replayProtectionDecision: expect.any(Object),
      requestIdentity: expect.any(Object),
      keyDescriptor: expect.any(Object),
    }));
    expect(validate(sample)).toBe(true);
  });

  it('keeps allowed endpoints private-only and forbidden endpoints explicit', () => {
    const contract = readFileSync(endpointContractPath, 'utf8');
    const allowedEndpoints = [
      'POST /private/gptoss/effective-router/classify',
      'POST /private/gptoss/effective-router/replay',
      'GET /private/gptoss/effective-router/readiness',
      'GET /private/gptoss/effective-router/release-gate',
    ];
    const forbiddenMarkers = [
      '/v1/chat/completions public clone',
      'raw completion endpoint',
      'arbitrary shell endpoint',
      'Railway command endpoint',
      'DB query endpoint',
      'training endpoint',
      'Custom GPT direct action endpoint',
      'public unauthenticated endpoint',
    ];

    for (const endpoint of allowedEndpoints) {
      expect(contract).toContain(endpoint);
      expect(endpoint).toContain('/private/');
    }
    for (const marker of forbiddenMarkers) {
      expect(contract).toContain(marker);
    }
    expect(contract).toMatch(/private/i);
    expect(contract).toMatch(/authenticated/i);
    expect(contract).not.toMatch(/POST \/v1\/chat\/completions|POST \/shell|POST \/train/);
  });

  it('documents the required private serving exposure shape and raw preview rule', () => {
    const boundary = readFileSync(boundaryDocPath, 'utf8');

    expect(boundary).toContain('Only effective-router contract output may be exposed');
    expect(boundary).toContain('"plane": "..."');
    expect(boundary).toContain('"allowedForTraining": false');
    expect(boundary).toContain('"openAiCalled": false');
    expect(boundary).toContain('"noOpenAiOutputUsed": true');
    expect(boundary).toContain('Raw model text may be logged only as capped/redacted preview in local audit artifacts');
    expect(boundary).toContain('No route may bypass these controls by falling back to `/gpt/:gptId`');
  });

  it('reports private serving design ready but implementation and exposure false', () => {
    const result = runNode(readinessScript, ['--no-write']);
    const parsed = JSON.parse(result.stdout);

    expect(result.status).toBe(0);
    expect(parsed).toMatchObject({
      privateServingDesignReady: true,
      privateServingScaffoldReady: true,
      privateServingImplemented: false,
      privateServingExposed: false,
      requestSigningDesigned: true,
      requestSigningScaffoldReady: true,
      requestSigningImplemented: true,
      authBoundaryDesigned: true,
      authBoundaryScaffoldReady: true,
      authBoundaryImplemented: true,
      replayProtectionScaffoldReady: true,
      replayProtectionImplemented: false,
      rateLimitScaffoldReady: true,
      rateLimitImplemented: false,
      responseShapingScaffoldReady: true,
      publicServerCreated: false,
      customGptExposureCreated: false,
      cloudReady: false,
      customGptReady: false,
    });
  });

  it('keeps cloud and Custom GPT gates blocked with private serving criteria unmet', () => {
    const result = runNode(cloudGateScript, ['--no-write', '--report-only']);
    const parsed = JSON.parse(result.stdout);

    expect(result.status).toBe(0);
    expect(parsed).toMatchObject({
      cloudReady: false,
      customGptReady: false,
      customGptDirectLocalExposureAllowed: false,
      checks: {
        privateServingDesignReady: true,
        privateServingScaffoldReady: true,
        privateServingImplemented: false,
        privateServingExposed: false,
        requestSigningDesigned: true,
        requestSigningScaffoldReady: true,
        requestSigningImplemented: true,
        authBoundaryDesigned: true,
        authBoundaryScaffoldReady: true,
        authBoundaryImplemented: true,
        replayProtectionScaffoldReady: true,
        replayProtectionImplemented: false,
        rateLimitScaffoldReady: true,
        rateLimitImplemented: false,
        responseShapingScaffoldReady: true,
        publicServerCreated: false,
        customGptExposureCreated: false,
      },
    });
    expect(parsed.blockers).toEqual(expect.arrayContaining([
      'private_serving_not_implemented',
      'replay_protection_not_implemented',
    ]));
  });

  it('adds validation scripts without adding serving scripts or external execution paths', () => {
    const packageJson = parseJsonFile(join(process.cwd(), 'package.json'));
    const scripts = packageJson.scripts as Record<string, string>;

    expect(scripts['gptoss:private-serving:design:validate']).toBe(
      'node scripts/gptoss/private-serving-design-validate.mjs',
    );
    expect(scripts['gptoss:private-serving:threat-model:validate']).toBe(
      'node scripts/gptoss/private-serving-threat-model-validate.mjs',
    );

    for (const [name, command] of Object.entries(scripts)) {
      if (!name.startsWith('gptoss:private-serving:')) {
        continue;
      }
      expect(name).not.toMatch(/start|serve|listen|deploy|custom-gpt/i);
      expect(command).not.toMatch(/npm run dev|npm start|start-server|listen|serve|vllm serve|railway\s|api\.openai\.com|train|--execute/i);
    }
  });

  it('validates private serving design and threat model without external operations', async () => {
    const design = runNode(designValidateScript);
    const threat = runNode(threatValidateScript);
    const designSource = readFileSync(designValidateScript, 'utf8');
    const threatSource = readFileSync(threatValidateScript, 'utf8');

    expect(design.status).toBe(0);
    expect(threat.status).toBe(0);
    expect(JSON.parse(design.stdout)).toMatchObject({
      ok: true,
      privateServingDesignReady: true,
      privateServingImplemented: false,
      privateServingExposed: false,
      cloudReady: false,
      customGptReady: false,
      publicServerCreated: false,
      openAiCalled: false,
      trainingExecuted: false,
      vllmUsed: false,
      railwayCliUsed: false,
      liveDbUsed: false,
    });
    expect(`${designSource}\n${threatSource}`).not.toMatch(/node:child_process|spawnSync|execSync/);

    const module = await import(pathToFileURL(designValidateScript).href) as {
      runPrivateServingDesignValidation: (options: { write: boolean }) => Record<string, unknown>;
    };
    expect(module.runPrivateServingDesignValidation({ write: false }).ok).toBe(true);
  });

  it('covers the required threat model and runbook safety constraints', () => {
    const threatModel = readFileSync(threatModelPath, 'utf8');
    const runbook = readFileSync(runbookPath, 'utf8');

    for (const threat of [
      'Direct public exposure risk',
      'Prompt injection',
      'Tool escalation',
      'Raw model output leakage',
      'Audit log secret leakage',
      'Replay abuse',
      'Request forgery',
      'Missing rate limits',
      'Accidental training from requests',
      'OpenAI output contamination',
      'Railway command escalation',
      'DB data leakage',
      'Custom GPT direct-to-local exposure',
      'Rollback failure',
    ]) {
      expect(threatModel).toContain(threat);
    }

    for (const command of [
      'npm run gptoss:runtime:release-gate',
      'npm run gptoss:runtime:release-gate:ci',
      'npm run gptoss:runtime:request:regress',
      'npm run gptoss:runtime:request:local-model:smoke',
      'npm run gptoss:runtime:readiness',
      'npm run gptoss:runtime:cloud-gate',
    ]) {
      expect(runbook).toContain(command);
    }
    expect(runbook).toContain('Do Not Run');
    expect(runbook).toContain('OpenAI API calls');
    expect(runbook).toContain('vLLM serve commands');
    expect(runbook).toContain('Railway CLI commands');
    expect(runbook).toContain('Live database commands');
    expect(runbook).toContain('Server startup commands');
  });
});
