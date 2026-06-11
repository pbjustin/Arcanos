import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';

const scaffoldDir = join(process.cwd(), 'scripts', 'gptoss', 'private-serving');
const signingScript = join(scaffoldDir, 'private-serving-signing.mjs');
const authScript = join(scaffoldDir, 'private-serving-auth.mjs');
const replayScript = join(scaffoldDir, 'private-serving-replay-protection.mjs');
const rateLimitScript = join(scaffoldDir, 'private-serving-rate-limit.mjs');
const responseScript = join(scaffoldDir, 'private-serving-response.mjs');
const denyScript = join(scaffoldDir, 'private-serving-deny.mjs');
const authValidateScript = join(scaffoldDir, 'private-serving-auth-validate.mjs');
const scaffoldValidateScript = join(scaffoldDir, 'private-serving-scaffold-validate.mjs');
const readinessScript = join(process.cwd(), 'scripts', 'gptoss', 'model-readiness-report.mjs');
const cloudGateScript = join(process.cwd(), 'scripts', 'gptoss', 'cloud-readiness-gate.mjs');
const schemaPath = join(process.cwd(), 'schemas', 'gptoss-private-serving-boundary.schema.json');
const localSigningKey = 'phase-5-2-local-hmac-fixture';

function runNode(script: string, args: string[] = []) {
  return spawnSync(process.execPath, [script, ...args], {
    cwd: process.cwd(),
    encoding: 'utf8',
  });
}

function cleanRuntimeOutput(overrides: Record<string, unknown> = {}) {
  return {
    ok: true,
    requestId: 'phase5-1-scaffold-test',
    model: {
      rawFinalText: 'raw model text must not be exposed',
      debugPath: 'local_artifacts/redacted',
    },
    effective: {
      plane: 'writing-plane',
      action: 'write_typescript_dataset_validation_helper',
      risk: 'low',
      requiresConfirmation: false,
      allowedForTraining: false,
      effectivePassed: true,
      sources: ['model', 'postprocessor'],
    },
    safety: {
      allowedForTraining: false,
      openAiCalled: false,
      trainingExecuted: false,
      vllmUsed: false,
      railwayCliUsed: false,
      liveDbUsed: false,
      noOpenAiOutputUsed: true,
    },
    debug: {
      internal: true,
    },
    ...overrides,
  };
}

describe('gptoss private serving scaffold', () => {
  it('parses the schema with scaffold definitions', () => {
    const schema = JSON.parse(readFileSync(schemaPath, 'utf8'));
    const ajv = new Ajv2020();

    expect(schema.$defs).toEqual(expect.objectContaining({
      scaffoldSignedRequestEnvelope: expect.any(Object),
      scaffoldAuthDecision: expect.any(Object),
      scaffoldRateLimitDecision: expect.any(Object),
      scaffoldSafeResponseEnvelope: expect.any(Object),
      scaffoldDenialResponse: expect.any(Object),
      scaffoldValidationReport: expect.any(Object),
      authDecision: expect.any(Object),
      authFailure: expect.any(Object),
      replayProtectionDecision: expect.any(Object),
      replayProtectionPolicy: expect.any(Object),
      replayProtectionStoreStats: expect.any(Object),
      replayProtectionValidationReport: expect.any(Object),
      durableReplayStoreDesign: expect.any(Object),
      durableReplayStoreRecord: expect.any(Object),
      durableReplayStorePolicy: expect.any(Object),
      durableReplayStoreValidationReport: expect.any(Object),
      requestIdentity: expect.any(Object),
      keyDescriptor: expect.any(Object),
    }));

    const validateSafeResponse = ajv.compile({
      ...schema.$defs.scaffoldSafeResponseEnvelope,
      $defs: schema.$defs,
    });
    expect(validateSafeResponse({
      requestId: 'phase5-1-schema-test',
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
    })).toBe(true);
  });

  it('canonicalizes requests deterministically and keeps body hashes stable', async () => {
    const signing = await import(pathToFileURL(signingScript).href) as {
      canonicalizeRequestEnvelope: (envelope: Record<string, unknown>) => string;
      computeBodyHash: (body: unknown) => string;
    };
    const input = {
      mode: 'router_classifier',
      userInput: 'Classify this local request.',
    };
    const first = {
      requestId: 'phase5-2-canonical-test',
      timestamp: '2026-06-06T00:00:00.000Z',
      nonce: 'nonceCanon1234567',
      audience: 'gptoss-effective-router-private',
      signatureAlgorithm: 'hmac-sha256',
      keyId: 'phase5-local-signer',
      bodyHash: signing.computeBodyHash(input),
      input,
    };
    const second = {
      input,
      bodyHash: signing.computeBodyHash({
        userInput: 'Classify this local request.',
        mode: 'router_classifier',
      }),
      keyId: 'phase5-local-signer',
      signatureAlgorithm: 'hmac-sha256',
      audience: 'gptoss-effective-router-private',
      nonce: 'nonceCanon1234567',
      timestamp: '2026-06-06T00:00:00.000Z',
      requestId: 'phase5-2-canonical-test',
    };

    expect(signing.computeBodyHash(input)).toBe(signing.computeBodyHash({
      userInput: 'Classify this local request.',
      mode: 'router_classifier',
    }));
    expect(signing.canonicalizeRequestEnvelope(first)).toBe(
      signing.canonicalizeRequestEnvelope(second),
    );
  });

  it('keeps signature verification scaffold fail-closed by default', async () => {
    const signing = await import(pathToFileURL(signingScript).href) as {
      computeBodyHash: (body: unknown) => string;
      verifySignatureScaffold: (envelope: Record<string, unknown>) => Record<string, unknown>;
    };
    const envelope = {
      requestId: 'phase5-1-signing-test',
      timestamp: new Date().toISOString(),
      nonce: 'nonceDefault12345',
      audience: 'gptoss-effective-router-private',
      signatureAlgorithm: 'hmac-sha256',
      keyId: 'phase5-local-signer',
      bodyHash: signing.computeBodyHash({ userInput: 'Classify this.', mode: 'router_classifier' }),
      signature: 'test-signature-placeholder',
      input: {
        userInput: 'Classify this.',
        mode: 'router_classifier',
      },
    };

    expect(signing.verifySignatureScaffold(envelope)).toEqual({
      ok: false,
      implemented: false,
      reason: 'signature_verification_not_implemented',
    });
  });

  it('signs and verifies synthetic local HMAC envelopes', async () => {
    const signing = await import(pathToFileURL(signingScript).href) as {
      computeBodyHash: (body: unknown) => string;
      signRequestEnvelope: (
        envelope: Record<string, unknown>,
        signingKey: string,
        options?: Record<string, unknown>,
      ) => Record<string, unknown>;
      verifyRequestSignature: (
        envelope: Record<string, unknown>,
        signingKey?: string,
        options?: Record<string, unknown>,
      ) => Record<string, unknown>;
      verifySignatureScaffold: (
        envelope: Record<string, unknown>,
        options?: Record<string, unknown>,
      ) => Record<string, unknown>;
    };
    const envelope = {
      requestId: 'phase5-2-hmac-test',
      timestamp: new Date().toISOString(),
      nonce: 'nonceHmac1234567',
      audience: 'gptoss-effective-router-private',
      signatureAlgorithm: 'hmac-sha256',
      keyId: 'phase5-local-signer',
      bodyHash: signing.computeBodyHash({ userInput: 'Classify this.', mode: 'router_classifier' }),
      input: {
        userInput: 'Classify this.',
        mode: 'router_classifier',
      },
    };
    const signed = signing.signRequestEnvelope(envelope, localSigningKey, {
      keyId: 'phase5-local-signer',
    });

    expect(signed.signature).toMatch(/^hmac-sha256:[a-f0-9]{64}$/);
    expect(JSON.stringify(signed)).not.toContain(localSigningKey);
    expect(JSON.stringify(signed)).not.toMatch(/Bearer\s|:\/\//i);
    expect(signing.verifyRequestSignature(signed, localSigningKey)).toMatchObject({
      ok: true,
      implemented: true,
      reason: null,
    });
    expect(signing.verifySignatureScaffold(signed, { localSigningSecret: localSigningKey }))
      .toMatchObject({
        ok: true,
        implemented: true,
        reason: null,
      });
    expect(signing.verifyRequestSignature({
      ...signed,
      input: {
        userInput: 'Tampered local request.',
        mode: 'router_classifier',
      },
    }, localSigningKey)).toMatchObject({
      ok: false,
      implemented: true,
      reason: 'invalid_signature',
    });
    expect(signing.verifyRequestSignature(signed, 'phase-5-2-wrong-fixture')).toMatchObject({
      ok: false,
      implemented: true,
      reason: 'invalid_signature',
    });
    expect(signing.verifyRequestSignature(signed)).toMatchObject({
      ok: false,
      implemented: true,
      reason: 'signature_verification_unavailable',
    });
    expect(signing.verifyRequestSignature({ ...signed, signature: '' }, localSigningKey))
      .toMatchObject({
        ok: false,
        implemented: true,
        reason: 'missing_signature',
      });
  });

  it('rejects missing signature, invalid audience, stale timestamp, and invalid nonce', async () => {
    const auth = await import(pathToFileURL(authScript).href) as {
      validatePrivateServingAuth: (
        envelope: Record<string, unknown>,
        options?: Record<string, unknown>,
      ) => Record<string, unknown>;
    };
    const base = {
      requestId: 'phase5-1-auth-test',
      timestamp: new Date().toISOString(),
      nonce: 'nonceAuth1234567',
      audience: 'gptoss-effective-router-private',
      signatureAlgorithm: 'hmac-sha256',
      keyId: 'phase5-local-signer',
      bodyHash: 'a'.repeat(64),
      signature: 'test-signature-placeholder',
      input: {
        userInput: 'Classify this.',
        mode: 'router_classifier',
      },
    };

    expect(auth.validatePrivateServingAuth({ ...base, signature: '' })).toMatchObject({
      ok: false,
      authenticated: false,
      implemented: true,
      denialReason: 'missing_signature',
    });
    expect(auth.validatePrivateServingAuth({ ...base, audience: 'wrong-audience' })).toMatchObject({
      ok: false,
      authenticated: false,
      implemented: true,
      denialReason: 'invalid_audience',
    });
    expect(auth.validatePrivateServingAuth({
      ...base,
      timestamp: '2020-01-01T00:00:00.000Z',
    }, { maxSkewSeconds: 1 })).toMatchObject({
      ok: false,
      authenticated: false,
      implemented: true,
      denialReason: 'stale_timestamp',
    });
    expect(auth.validatePrivateServingAuth({ ...base, nonce: 'bad' })).toMatchObject({
      ok: false,
      authenticated: false,
      implemented: true,
      denialReason: 'invalid_nonce',
    });
    expect(auth.validatePrivateServingAuth(base)).toMatchObject({
      ok: false,
      authenticated: false,
      implemented: true,
      denialReason: 'unknown_key_id',
      safeToExpose: true,
    });
  });

  it('auth accepts valid synthetic HMAC and rejects invalid HMAC', async () => {
    const signing = await import(pathToFileURL(signingScript).href) as {
      signRequestEnvelope: (
        envelope: Record<string, unknown>,
        signingKey: string,
        options?: Record<string, unknown>,
      ) => Record<string, unknown>;
    };
    const auth = await import(pathToFileURL(authScript).href) as {
      validatePrivateServingAuth: (
        envelope: Record<string, unknown>,
        options?: Record<string, unknown>,
      ) => Record<string, unknown>;
    };
    const replay = await import(pathToFileURL(replayScript).href) as {
      createInMemoryReplayStore: () => Record<string, unknown>;
      checkAndRecordNonce: (
        record: Record<string, unknown>,
        store: Record<string, unknown>,
      ) => Record<string, unknown>;
    };
    const store = replay.createInMemoryReplayStore();
    const signed = signing.signRequestEnvelope({
      requestId: 'phase5-2-auth-hmac-test',
      timestamp: new Date().toISOString(),
      nonce: 'nonceAuthHmac123',
      audience: 'gptoss-effective-router-private',
      signatureAlgorithm: 'hmac-sha256',
      keyId: 'phase5-local-signer',
      input: {
        userInput: 'Classify this.',
        mode: 'router_classifier',
      },
    }, localSigningKey, {
      keyId: 'phase5-local-signer',
    });

    expect(auth.validatePrivateServingAuth(signed, { localSigningSecret: localSigningKey }))
      .toMatchObject({
        ok: false,
        authenticated: false,
        implemented: true,
        denialReason: 'subject_unavailable',
      });
    expect(auth.validatePrivateServingAuth(signed, {
      localKeyMap: {
        'phase5-local-signer': {
          subject: 'phase5-local-subject',
          signingKey: localSigningKey,
        },
      },
      replayChecker: (record: Record<string, unknown>) => replay.checkAndRecordNonce(record, store),
    })).toMatchObject({
      ok: true,
      authenticated: true,
      implemented: true,
      subject: 'phase5-local-subject',
      replayProtectionRequired: true,
      denialReason: null,
    });
    expect(auth.validatePrivateServingAuth(signed, {
      localKeyMap: {
        'phase5-local-signer': {
          subject: 'phase5-local-subject',
          signingKey: 'phase-5-2-wrong-fixture',
        },
      },
      replayChecker: (record: Record<string, unknown>) => replay.checkAndRecordNonce(record, store),
    })).toMatchObject({
      ok: false,
      authenticated: false,
      implemented: true,
      denialReason: 'invalid_signature',
    });
  });


  it('rate limits above the scaffold burst threshold', async () => {
    const rateLimit = await import(pathToFileURL(rateLimitScript).href) as {
      createRateLimitState: () => Record<string, unknown>;
      evaluateRateLimit: (
        subject: string,
        now: number,
        policy: Record<string, unknown>,
        state: Record<string, unknown>,
      ) => Record<string, unknown>;
      DEFAULT_RATE_LIMIT_POLICY: Record<string, unknown>;
    };
    const state = rateLimit.createRateLimitState();
    const now = Date.now();

    for (let index = 0; index < 5; index += 1) {
      expect(rateLimit.evaluateRateLimit(
        'local-subject',
        now,
        rateLimit.DEFAULT_RATE_LIMIT_POLICY,
        state,
      )).toMatchObject({ ok: true, allowed: true });
    }

    expect(rateLimit.evaluateRateLimit(
      'local-subject',
      now,
      rateLimit.DEFAULT_RATE_LIMIT_POLICY,
      state,
    )).toMatchObject({
      ok: false,
      allowed: false,
      reason: 'rate_limited',
    });
  });

  it('shapes only the safe response envelope and excludes raw model text', async () => {
    const response = await import(pathToFileURL(responseScript).href) as {
      shapePrivateServingResponse: (runtimeOutput: Record<string, unknown>) => Record<string, unknown>;
    };
    const shaped = response.shapePrivateServingResponse(cleanRuntimeOutput());
    const serialized = JSON.stringify(shaped);

    expect(Object.keys(shaped).sort()).toEqual(['effective', 'requestId', 'safety']);
    expect(shaped).toMatchObject({
      requestId: 'phase5-1-scaffold-test',
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
    });
    expect(serialized).not.toContain('rawFinalText');
    expect(serialized).not.toContain('raw model text must not be exposed');
    expect(serialized).not.toContain('debug');
    expect(serialized).not.toContain('local_artifacts');
  });

  it('fails closed when safety flags are dirty', async () => {
    const response = await import(pathToFileURL(responseScript).href) as {
      shapePrivateServingResponse: (runtimeOutput: Record<string, unknown>) => Record<string, unknown>;
    };
    const shaped = response.shapePrivateServingResponse(cleanRuntimeOutput({
      safety: {
        allowedForTraining: false,
        openAiCalled: true,
        trainingExecuted: false,
        vllmUsed: false,
        railwayCliUsed: false,
        liveDbUsed: false,
        noOpenAiOutputUsed: true,
      },
    }));

    expect(shaped).toMatchObject({
      ok: false,
      denied: true,
      reason: 'dirty_safety_flags',
      safety: {
        openAiCalled: false,
        trainingExecuted: false,
        vllmUsed: false,
        railwayCliUsed: false,
        liveDbUsed: false,
        noOpenAiOutputUsed: true,
      },
    });
  });

  it('builds denial responses without stack traces or secret-like details', async () => {
    const deny = await import(pathToFileURL(denyScript).href) as {
      buildDenialResponse: (reason: string, options?: Record<string, unknown>) => Record<string, unknown>;
      buildRateLimitResponse: (options?: Record<string, unknown>) => Record<string, unknown>;
    };
    const denied = deny.buildDenialResponse('authentication_failure', {
      requestId: 'phase5-1-deny-test',
      details: 'Error stack should not be copied',
    });
    const limited = deny.buildRateLimitResponse({
      requestId: 'phase5-1-rate-limit-test',
      retryAfterSeconds: 12,
    });
    const serialized = `${JSON.stringify(denied)}\n${JSON.stringify(limited)}`;

    expect(denied).toMatchObject({
      ok: false,
      denied: true,
      reason: 'authentication_failure',
      requestId: 'phase5-1-deny-test',
    });
    expect(limited).toMatchObject({
      ok: false,
      denied: true,
      reason: 'rate_limited',
      retryAfterSeconds: 12,
    });
    expect(serialized).not.toMatch(/stack|password|secret|cookie|:\/\/|bearer/i);
  });

  it('validator detects forbidden server and listener patterns in a temp scaffold', async () => {
    const tempDir = join(tmpdir(), `arcanos-gptoss-private-serving-${Date.now()}`);
    mkdirSync(tempDir, { recursive: true });
    const forbiddenFile = join(tempDir, 'forbidden.mjs');
    writeFileSync(forbiddenFile, [
      "import http from 'node:http';",
      'const app = {};',
      'app.listen(3000);',
      'http.createServer(() => {});',
    ].join('\n'), 'utf8');

    try {
      const validator = await import(pathToFileURL(scaffoldValidateScript).href) as {
        runPrivateServingScaffoldValidation: (
          options: Record<string, unknown>,
        ) => Promise<Record<string, unknown>>;
      };
      const report = await validator.runPrivateServingScaffoldValidation({
        scaffoldDir: tempDir,
        write: false,
      });

      expect(report.ok).toBe(false);
      expect(report.failures).toEqual(expect.arrayContaining([
        expect.stringContaining('forbidden_scaffold_pattern'),
      ]));
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('reports scaffold readiness while keeping implementation and exposure false', () => {
    const readiness = runNode(readinessScript, ['--no-write']);
    const cloudGate = runNode(cloudGateScript, ['--no-write', '--report-only']);
    const parsedReadiness = JSON.parse(readiness.stdout);
    const parsedCloud = JSON.parse(cloudGate.stdout);

    expect(readiness.status).toBe(0);
    expect(cloudGate.status).toBe(0);
    expect(parsedReadiness).toMatchObject({
      privateServingDesignReady: true,
      privateServingScaffoldReady: true,
      privateServingImplemented: false,
      privateServingExposed: false,
      requestSigningScaffoldReady: true,
      requestSigningImplemented: true,
      authBoundaryScaffoldReady: true,
      authBoundaryImplemented: true,
      replayProtectionScaffoldReady: true,
      replayProtectionImplemented: true,
      replayProtectionDurableDesigned: true,
      replayProtectionDurableImplemented: false,
      replayProtectionDurable: false,
      rateLimitScaffoldReady: true,
      rateLimitImplemented: false,
      responseShapingScaffoldReady: true,
      publicServerCreated: false,
      cloudReady: false,
      customGptReady: false,
    });
    expect(parsedCloud).toMatchObject({
      cloudReady: false,
      customGptReady: false,
      customGptDirectLocalExposureAllowed: false,
      checks: {
        privateServingScaffoldReady: true,
        privateServingImplemented: false,
        privateServingExposed: false,
        requestSigningScaffoldReady: true,
        requestSigningImplemented: true,
        authBoundaryScaffoldReady: true,
        authBoundaryImplemented: true,
        replayProtectionScaffoldReady: true,
        replayProtectionImplemented: true,
        replayProtectionDurableDesigned: true,
        replayProtectionDurableImplemented: false,
        replayProtectionDurable: false,
        rateLimitScaffoldReady: true,
        rateLimitImplemented: false,
        responseShapingScaffoldReady: true,
        publicServerCreated: false,
      },
    });
  });

  it('keeps package scripts and scaffold source free of serving and external-operation paths', async () => {
    const packageJson = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8'));
    const scripts = packageJson.scripts as Record<string, string>;
    const privateScripts = Object.entries(scripts)
      .filter(([name]) => name.startsWith('gptoss:private-serving:'));
    const source = [
      signingScript,
      authScript,
      replayScript,
      rateLimitScript,
      responseScript,
      denyScript,
      authValidateScript,
    ].map((path) => readFileSync(path, 'utf8')).join('\n');
    const validator = await import(pathToFileURL(scaffoldValidateScript).href) as {
      runPrivateServingScaffoldValidation: (
        options?: Record<string, unknown>,
      ) => Promise<Record<string, unknown>>;
    };
    const report = await validator.runPrivateServingScaffoldValidation({ write: false });

    expect(scripts['gptoss:private-serving:scaffold:validate']).toBe(
      'node scripts/gptoss/private-serving/private-serving-scaffold-validate.mjs',
    );
    expect(scripts['gptoss:private-serving:replay:validate']).toBe(
      'node scripts/gptoss/private-serving/private-serving-replay-validate.mjs',
    );
    expect(scripts['gptoss:private-serving:scaffold:report']).toBe(
      'node scripts/gptoss/private-serving/private-serving-scaffold-validate.mjs --pr-report',
    );
    for (const [name, command] of privateScripts) {
      expect(name).not.toMatch(/(^|:)start(:|$)|(^|:)serve(:|$)|(^|:)listen(:|$)|deploy|tunnel|expose|custom-gpt|action/i);
      expect(command).not.toMatch(/start-server|\.listen\s*\(|createServer|deploy|tunnel|expose|custom-gpt|api\.openai\.com|\btrain\b|vllm\s+serve|\brailway\s+/i);
    }
    expect(source).not.toMatch(/from\s+['"]express['"]|from\s+['"]fastify['"]|node:http|node:https|node:net|createServer|\.listen\s*\(|api\.openai\.com|responses\.create|vllm\s+serve|\brailway\s+|child_process|spawnSync|execSync|\btrain\b|fine-tune|finetune/i);
    expect(report).toMatchObject({
      ok: true,
      privateServingScaffoldReady: true,
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
    });
  });
});
