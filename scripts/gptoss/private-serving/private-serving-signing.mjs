import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

export const PRIVATE_SERVING_AUDIENCE = 'gptoss-effective-router-private';
export const DEFAULT_MAX_TIMESTAMP_SKEW_SECONDS = 300;
export const SIGNATURE_ALGORITHM = 'hmac-sha256';

function stableValue(value) {
  if (Array.isArray(value)) {
    return value.map((item) => stableValue(item));
  }
  if (value && typeof value === 'object') {
    return Object.keys(value)
      .sort()
      .reduce((acc, key) => {
        if (value[key] !== undefined) {
          acc[key] = stableValue(value[key]);
        }
        return acc;
      }, {});
  }
  return value;
}

export function canonicalizeRequestEnvelope(envelope) {
  const canonical = {
    requestId: envelope?.requestId,
    timestamp: envelope?.timestamp,
    nonce: envelope?.nonce,
    audience: envelope?.audience,
    signatureAlgorithm: envelope?.signatureAlgorithm || SIGNATURE_ALGORITHM,
    keyId: envelope?.keyId,
    bodyHash: envelope?.bodyHash,
    input: envelope?.input,
  };
  return JSON.stringify(stableValue(canonical));
}

export function computeBodyHash(body) {
  const payload = typeof body === 'string' ? body : JSON.stringify(stableValue(body));
  return createHash('sha256').update(payload || '', 'utf8').digest('hex');
}

export function validateTimestampSkew(
  timestamp,
  maxSkewSeconds = DEFAULT_MAX_TIMESTAMP_SKEW_SECONDS,
) {
  const parsed = Date.parse(timestamp);
  const maxSkew = Number(maxSkewSeconds);
  if (!Number.isFinite(parsed) || !Number.isFinite(maxSkew) || maxSkew < 0) {
    return { ok: false, reason: 'stale_timestamp', skewSeconds: null };
  }

  const skewSeconds = Math.abs(Date.now() - parsed) / 1000;
  if (skewSeconds > maxSkew) {
    return { ok: false, reason: 'stale_timestamp', skewSeconds };
  }

  return { ok: true, reason: null, skewSeconds };
}

export function validateNonceShape(nonce) {
  const value = String(nonce || '');
  if (!/^[A-Za-z0-9._:-]{8,128}$/.test(value)) {
    return { ok: false, reason: 'invalid_nonce' };
  }
  return { ok: true, reason: null };
}

export function validateAudience(audience) {
  if (audience !== PRIVATE_SERVING_AUDIENCE) {
    return { ok: false, reason: 'invalid_audience' };
  }
  return { ok: true, reason: null };
}

function hasSigningMaterial(secret) {
  return typeof secret === 'string' && secret.length > 0;
}

function normalizeSignature(signature) {
  const value = String(signature || '').trim();
  return value.startsWith(`${SIGNATURE_ALGORITHM}:`)
    ? value.slice(`${SIGNATURE_ALGORITHM}:`.length)
    : value;
}

function safeEqualSignature(actual, expected) {
  const actualValue = normalizeSignature(actual);
  const expectedValue = normalizeSignature(expected);
  if (!/^[a-f0-9]{64}$/i.test(actualValue) || !/^[a-f0-9]{64}$/i.test(expectedValue)) {
    return false;
  }
  const actualBuffer = Buffer.from(actualValue, 'hex');
  const expectedBuffer = Buffer.from(expectedValue, 'hex');
  return (
    actualBuffer.length === expectedBuffer.length &&
    timingSafeEqual(actualBuffer, expectedBuffer)
  );
}

function resolveExplicitSigningSecret(options = {}) {
  return options.signingSecret || options.localSigningSecret || options.secret;
}

function computeExpectedSignature(envelope, secret) {
  const canonical = canonicalizeRequestEnvelope(envelope);
  const digest = createHmac('sha256', secret).update(canonical, 'utf8').digest('hex');
  return `${SIGNATURE_ALGORITHM}:${digest}`;
}

export function signRequestEnvelope(envelope, secret, options = {}) {
  if (!hasSigningMaterial(secret)) {
    return {
      ok: false,
      implemented: true,
      reason: 'signature_verification_unavailable',
    };
  }

  const signedEnvelope = {
    ...envelope,
    signatureAlgorithm: SIGNATURE_ALGORITHM,
    keyId: String(options.keyId || envelope?.keyId || 'phase5-local-signer'),
    bodyHash: computeBodyHash(envelope?.input ?? {}),
  };
  return {
    ...signedEnvelope,
    signature: computeExpectedSignature(signedEnvelope, secret),
  };
}

export function verifyRequestSignature(envelope, secret, options = {}) {
  if (!hasSigningMaterial(secret)) {
    return {
      ok: false,
      implemented: true,
      reason: 'signature_verification_unavailable',
    };
  }
  if (!String(envelope?.signature || '').trim()) {
    return {
      ok: false,
      implemented: true,
      reason: 'missing_signature',
    };
  }
  if ((envelope?.signatureAlgorithm || SIGNATURE_ALGORITHM) !== SIGNATURE_ALGORITHM) {
    return {
      ok: false,
      implemented: true,
      reason: 'invalid_signature',
    };
  }

  const expectedBodyHash = computeBodyHash(envelope?.input ?? {});
  if (envelope?.bodyHash !== expectedBodyHash) {
    return {
      ok: false,
      implemented: true,
      reason: 'invalid_signature',
    };
  }

  const canonicalEnvelope = {
    ...envelope,
    signatureAlgorithm: SIGNATURE_ALGORITHM,
    keyId: String(envelope?.keyId || options.keyId || 'phase5-local-signer'),
    bodyHash: expectedBodyHash,
  };
  const expectedSignature = computeExpectedSignature(canonicalEnvelope, secret);
  const ok = safeEqualSignature(envelope.signature, expectedSignature);
  return {
    ok,
    implemented: true,
    reason: ok ? null : 'invalid_signature',
  };
}

export function verifySignatureScaffold(envelope, options = {}) {
  const explicitSecret = resolveExplicitSigningSecret(options);
  if (hasSigningMaterial(explicitSecret)) {
    return verifyRequestSignature(envelope, explicitSecret, options);
  }

  if (options.allowDeterministicTestSignature === true) {
    const expected = `test-signature:${computeBodyHash(canonicalizeRequestEnvelope(envelope))}`;
    return {
      ok: envelope?.signature === expected,
      implemented: false,
      testOnly: true,
      reason: envelope?.signature === expected ? null : 'signature_verification_not_implemented',
    };
  }

  return {
    ok: false,
    implemented: false,
    reason: 'signature_verification_not_implemented',
  };
}
