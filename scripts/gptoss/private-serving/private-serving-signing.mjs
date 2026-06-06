import { createHash } from 'node:crypto';

export const PRIVATE_SERVING_AUDIENCE = 'gptoss-effective-router-private';
export const DEFAULT_MAX_TIMESTAMP_SKEW_SECONDS = 300;

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

export function verifySignatureScaffold(envelope, options = {}) {
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
