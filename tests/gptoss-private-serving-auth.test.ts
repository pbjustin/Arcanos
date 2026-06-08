import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const scaffoldDir = join(process.cwd(), 'scripts', 'gptoss', 'private-serving');
const signingScript = join(scaffoldDir, 'private-serving-signing.mjs');
const authScript = join(scaffoldDir, 'private-serving-auth.mjs');
const replayScript = join(scaffoldDir, 'private-serving-replay-protection.mjs');
const denyScript = join(scaffoldDir, 'private-serving-deny.mjs');
const authValidateScript = join(scaffoldDir, 'private-serving-auth-validate.mjs');
const readinessScript = join(process.cwd(), 'scripts', 'gptoss', 'model-readiness-report.mjs');
const cloudGateScript = join(process.cwd(), 'scripts', 'gptoss', 'cloud-readiness-gate.mjs');

const LOCAL_KEY_ID = 'phase5-auth-test-key';
const LOCAL_SIGNING_KEY = 'phase-5-3-auth-fixture';
const LOCAL_SUBJECT = 'phase5-auth-test-subject';

function runNode(script: string, args: string[] = []) {
  return spawnSync(process.execPath, [script, ...args], {
    cwd: process.cwd(),
    encoding: 'utf8',
  });
}

function unsignedEnvelope(overrides: Record<string, unknown> = {}) {
  return {
    requestId: 'phase5-3-auth-test',
    timestamp: new Date().toISOString(),
    nonce: 'nonceAuthPhase5301',
    audience: 'gptoss-effective-router-private',
    signatureAlgorithm: 'hmac-sha256',
    keyId: LOCAL_KEY_ID,
    input: {
      userInput: 'Classify this local auth request.',
      mode: 'router_classifier',
    },
    ...overrides,
  };
}

async function modules() {
  const signing = await import(pathToFileURL(signingScript).href) as {
    signRequestEnvelope: (
      envelope: Record<string, unknown>,
      signingKey: string,
      options?: Record<string, unknown>,
    ) => Record<string, unknown>;
  };
  const auth = await import(pathToFileURL(authScript).href) as {
    authenticateSignedRequest: (
      envelope: Record<string, unknown>,
      options?: Record<string, unknown>,
    ) => Record<string, unknown>;
    validateRequestIdentity: (
      envelope: Record<string, unknown>,
      options?: Record<string, unknown>,
    ) => Record<string, unknown>;
  };
  const replay = await import(pathToFileURL(replayScript).href) as {
    createInMemoryReplayStore: () => Record<string, unknown>;
    checkAndRecordNonce: (
      record: Record<string, unknown>,
      store: Record<string, unknown>,
      options?: Record<string, unknown>,
    ) => Record<string, unknown>;
  };
  return { signing, auth, replay };
}

describe('gptoss private serving auth boundary', () => {
  it('authenticates a valid signed request with local identity and replay checker', async () => {
    const { signing, auth, replay } = await modules();
    const store = replay.createInMemoryReplayStore();
    const signed = signing.signRequestEnvelope(unsignedEnvelope(), LOCAL_SIGNING_KEY, {
      keyId: LOCAL_KEY_ID,
    });

    expect(auth.authenticateSignedRequest(signed, {
      localKeyMap: {
        [LOCAL_KEY_ID]: {
          subject: LOCAL_SUBJECT,
          signingKey: LOCAL_SIGNING_KEY,
        },
      },
      replayStore: store,
    })).toMatchObject({
      ok: true,
      authenticated: true,
      implemented: true,
      requestId: 'phase5-3-auth-test',
      subject: LOCAL_SUBJECT,
      keyId: LOCAL_KEY_ID,
      audience: 'gptoss-effective-router-private',
      replayProtectionRequired: true,
      timestampAccepted: true,
      nonceAccepted: true,
      signatureAccepted: true,
      denialReason: null,
    });
  });

  it('fails closed for missing identity fields and unknown key id', async () => {
    const { signing, auth, replay } = await modules();
    const store = replay.createInMemoryReplayStore();
    const signed = signing.signRequestEnvelope(unsignedEnvelope(), LOCAL_SIGNING_KEY, {
      keyId: LOCAL_KEY_ID,
    });

    expect(auth.authenticateSignedRequest({ ...signed, keyId: '' }, {
      replayChecker: (record: Record<string, unknown>) => replay.checkAndRecordNonce(record, store),
    })).toMatchObject({
      ok: false,
      authenticated: false,
      implemented: true,
      denialReason: 'missing_key_id',
      safeToExpose: true,
    });
    expect(auth.authenticateSignedRequest(signed, {
      localKeyMap: {},
      replayChecker: (record: Record<string, unknown>) => replay.checkAndRecordNonce(record, store),
    })).toMatchObject({
      ok: false,
      authenticated: false,
      implemented: true,
      denialReason: 'unknown_key_id',
      safeToExpose: true,
    });
  });

  it('fails closed for invalid audience, stale timestamp, invalid nonce, and missing signature', async () => {
    const { signing, auth, replay } = await modules();
    const store = replay.createInMemoryReplayStore();
    const options = {
      localKeyMap: {
        [LOCAL_KEY_ID]: {
          subject: LOCAL_SUBJECT,
          signingKey: LOCAL_SIGNING_KEY,
        },
      },
      replayChecker: (record: Record<string, unknown>) => replay.checkAndRecordNonce(record, store),
    };

    const invalidAudience = signing.signRequestEnvelope(unsignedEnvelope({
      audience: 'wrong-audience',
    }), LOCAL_SIGNING_KEY, { keyId: LOCAL_KEY_ID });
    const stale = signing.signRequestEnvelope(unsignedEnvelope({
      timestamp: '2020-01-01T00:00:00.000Z',
      nonce: 'nonceAuthPhase5302',
    }), LOCAL_SIGNING_KEY, { keyId: LOCAL_KEY_ID });
    const invalidNonce = signing.signRequestEnvelope(unsignedEnvelope({
      nonce: 'short',
    }), LOCAL_SIGNING_KEY, { keyId: LOCAL_KEY_ID });
    const missingSignature = signing.signRequestEnvelope(unsignedEnvelope({
      nonce: 'nonceAuthPhase5303',
    }), LOCAL_SIGNING_KEY, { keyId: LOCAL_KEY_ID });

    expect(auth.authenticateSignedRequest(invalidAudience, options)).toMatchObject({
      ok: false,
      authenticated: false,
      denialReason: 'invalid_audience',
    });
    expect(auth.authenticateSignedRequest(stale, {
      ...options,
      maxSkewSeconds: 1,
    })).toMatchObject({
      ok: false,
      authenticated: false,
      denialReason: 'stale_timestamp',
    });
    expect(auth.authenticateSignedRequest(invalidNonce, options)).toMatchObject({
      ok: false,
      authenticated: false,
      denialReason: 'invalid_nonce',
    });
    expect(auth.authenticateSignedRequest({ ...missingSignature, signature: '' }, options))
      .toMatchObject({
        ok: false,
        authenticated: false,
        denialReason: 'missing_signature',
      });
  });

  it('rejects wrong signatures, duplicate nonces, and missing replay checker', async () => {
    const { signing, auth, replay } = await modules();
    const store = replay.createInMemoryReplayStore();
    const signed = signing.signRequestEnvelope(unsignedEnvelope(), LOCAL_SIGNING_KEY, {
      keyId: LOCAL_KEY_ID,
    });
    const keyMap = {
        [LOCAL_KEY_ID]: {
          subject: LOCAL_SUBJECT,
          signingKey: LOCAL_SIGNING_KEY,
        },
    };

    expect(auth.authenticateSignedRequest(signed, {
      localKeyMap: {
        [LOCAL_KEY_ID]: {
          subject: LOCAL_SUBJECT,
          signingKey: 'phase-5-3-wrong-fixture',
        },
      },
      replayChecker: (record: Record<string, unknown>) => replay.checkAndRecordNonce(record, store),
    })).toMatchObject({
      ok: false,
      authenticated: false,
      denialReason: 'invalid_signature',
    });
    expect(auth.authenticateSignedRequest(signed, { localKeyMap: keyMap })).toMatchObject({
      ok: false,
      authenticated: false,
      denialReason: 'replay_store_unavailable',
    });
    expect(auth.authenticateSignedRequest(signed, {
      localKeyMap: keyMap,
      replayStore: store,
    })).toMatchObject({
      ok: true,
      authenticated: true,
    });
    expect(auth.authenticateSignedRequest(signed, {
      localKeyMap: keyMap,
      replayStore: store,
    })).toMatchObject({
      ok: false,
      authenticated: false,
      denialReason: 'replay_detected',
    });
  });

  it('derives subjects only in local test mode', async () => {
    const { signing, auth } = await modules();
    const signed = signing.signRequestEnvelope(unsignedEnvelope(), LOCAL_SIGNING_KEY, {
      keyId: LOCAL_KEY_ID,
    });

    expect(auth.validateRequestIdentity(signed, {
      localKeyMap: {
        [LOCAL_KEY_ID]: LOCAL_SIGNING_KEY,
      },
    })).toMatchObject({
      ok: false,
      reason: 'subject_unavailable',
      keyId: LOCAL_KEY_ID,
    });
    expect(auth.validateRequestIdentity(signed, {
      localTestMode: true,
      localKeyMap: {
        [LOCAL_KEY_ID]: LOCAL_SIGNING_KEY,
      },
    })).toMatchObject({
      ok: true,
      keyId: LOCAL_KEY_ID,
      subject: `local:${LOCAL_KEY_ID}`,
    });
  });

  it('keeps denial responses audit-safe', async () => {
    const deny = await import(pathToFileURL(denyScript).href) as {
      buildAuthFailureResponse: (
        reason?: string,
        options?: Record<string, unknown>,
      ) => Record<string, unknown>;
    };
    const response = deny.buildAuthFailureResponse('replay_detected', {
      requestId: 'phase5-3-denial-test',
      signature: 'hmac-sha256:abcdef',
      detail: LOCAL_SIGNING_KEY,
    });
    const serialized = JSON.stringify(response);

    expect(response).toMatchObject({
      ok: false,
      denied: true,
      reason: 'replay_detected',
      requestId: 'phase5-3-denial-test',
    });
    expect(serialized).not.toContain(LOCAL_SIGNING_KEY);
    expect(serialized).not.toMatch(/hmac-sha256|signature|stack|:\/\//i);
  });

  it('keeps auth modules local-only with no env key reads or server paths', () => {
    const source = [
      signingScript,
      authScript,
      replayScript,
      denyScript,
      authValidateScript,
    ].map((path) => readFileSync(path, 'utf8')).join('\n');

    expect(source).not.toMatch(/process\.env/);
    expect(source).not.toMatch(/node:http|node:https|node:net|createServer|\.listen\s*\(/i);
    expect(source).not.toMatch(/api\.openai\.com|responses\.create|vllm\s+serve|\brailway\s+/i);
    expect(source).not.toMatch(/child_process|spawnSync|execSync|\btrain\b|fine-tune|finetune/i);
  });

  it('reports auth implemented while replay durability, serving, and exposure remain false', () => {
    const readiness = runNode(readinessScript, ['--no-write']);
    const cloudGate = runNode(cloudGateScript, ['--no-write', '--report-only']);
    const authReport = runNode(authValidateScript, ['--no-write']);
    const parsedReadiness = JSON.parse(readiness.stdout);
    const parsedCloud = JSON.parse(cloudGate.stdout);
    const parsedAuthReport = JSON.parse(authReport.stdout);

    expect(readiness.status).toBe(0);
    expect(cloudGate.status).toBe(0);
    expect(authReport.status).toBe(0);
    expect(parsedReadiness).toMatchObject({
      requestSigningImplemented: true,
      authBoundaryImplemented: true,
      replayProtectionScaffoldReady: true,
      replayProtectionImplemented: true,
      replayProtectionDurable: false,
      privateServingImplemented: false,
      privateServingExposed: false,
      publicServerCreated: false,
      cloudReady: false,
      customGptReady: false,
    });
    expect(parsedCloud).toMatchObject({
      cloudReady: false,
      customGptReady: false,
      customGptDirectLocalExposureAllowed: false,
      checks: {
        authBoundaryImplemented: true,
        replayProtectionScaffoldReady: true,
        replayProtectionImplemented: true,
        replayProtectionDurable: false,
        privateServingImplemented: false,
        privateServingExposed: false,
        publicServerCreated: false,
      },
    });
    expect(parsedCloud.blockers).toEqual(expect.arrayContaining([
      'private_serving_not_implemented',
      'replay_protection_not_durable',
    ]));
    expect(parsedAuthReport).toMatchObject({
      ok: true,
      requestSigningImplemented: true,
      authBoundaryImplemented: true,
      replayProtectionScaffoldReady: true,
      replayProtectionImplemented: true,
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
    });
  });
});
