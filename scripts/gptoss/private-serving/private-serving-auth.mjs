import {
  DEFAULT_MAX_TIMESTAMP_SKEW_SECONDS,
  PRIVATE_SERVING_AUDIENCE,
  validateAudience,
  validateNonceShape,
  validateTimestampSkew,
  verifyRequestSignature,
} from './private-serving-signing.mjs';

const REQUIRED_FIELDS = [
  ['requestId', 'missing_request_id'],
  ['timestamp', 'missing_timestamp'],
  ['nonce', 'missing_nonce'],
  ['audience', 'missing_audience'],
  ['keyId', 'missing_key_id'],
  ['bodyHash', 'missing_body_hash'],
  ['signature', 'missing_signature'],
];

function safeText(value, fallback = null) {
  if (value === undefined || value === null) {
    return fallback;
  }
  const normalized = String(value).trim();
  return normalized ? normalized.slice(0, 160) : fallback;
}

export function buildAuthDecision(fields = {}) {
  const ok = fields.ok === true;
  return {
    ok,
    authenticated: ok,
    implemented: true,
    requestId: safeText(fields.requestId, null),
    ...(ok ? {
      subject: safeText(fields.subject, null),
      keyId: safeText(fields.keyId, null),
      audience: PRIVATE_SERVING_AUDIENCE,
      replayProtectionRequired: true,
      timestampAccepted: true,
      nonceAccepted: true,
      signatureAccepted: true,
      denialReason: null,
    } : {
      denialReason: safeText(fields.denialReason, 'authentication_failure'),
      safeToExpose: true,
    }),
  };
}

function fail(denialReason, envelope, fields = {}) {
  return buildAuthDecision({
    ok: false,
    requestId: envelope?.requestId || null,
    denialReason,
    ...fields,
  });
}

function resolveKeyDescriptor(envelope, options = {}) {
  if (typeof options.keyResolver === 'function') {
    const resolved = options.keyResolver({ keyId: envelope.keyId, audience: envelope.audience });
    if (typeof resolved === 'string') {
      return {
        keyId: envelope.keyId,
        subject: options.localTestMode === true ? `local:${envelope.keyId}` : options.subject,
        signingKey: resolved,
      };
    }
    return resolved;
  }

  const keyMap = options.localKeyMap || options.testKeyMap;
  if (keyMap && Object.prototype.hasOwnProperty.call(keyMap, envelope.keyId)) {
    const value = keyMap[envelope.keyId];
    if (typeof value === 'string') {
      return {
        keyId: envelope.keyId,
        subject: options.localTestMode === true ? `local:${envelope.keyId}` : null,
        signingKey: value,
      };
    }
    if (value && typeof value === 'object') {
      return {
        keyId: envelope.keyId,
        subject: value.subject,
        signingKey: value.signingKey || value.secret,
      };
    }
  }

  const signingKey = options.signingSecret || options.localSigningSecret || options.secret;
  if (signingKey && envelope.keyId === (options.keyId || envelope.keyId)) {
    return {
      keyId: envelope.keyId,
      subject: options.subject,
      signingKey,
    };
  }

  return null;
}

export function validateRequestIdentity(envelope, options = {}) {
  if (!String(envelope?.keyId || '').trim()) {
    return {
      ok: false,
      reason: 'missing_key_id',
    };
  }

  const descriptor = resolveKeyDescriptor(envelope, options);
  if (!descriptor?.signingKey) {
    return {
      ok: false,
      reason: 'unknown_key_id',
      keyId: envelope.keyId,
    };
  }

  const subject = safeText(
    descriptor.subject ||
      (options.localTestMode === true ? `local:${envelope.keyId}` : null),
    null,
  );
  if (!subject) {
    return {
      ok: false,
      reason: 'subject_unavailable',
      keyId: envelope.keyId,
    };
  }

  return {
    ok: true,
    keyId: envelope.keyId,
    subject,
    signingKey: descriptor.signingKey,
  };
}

export function authenticateSignedRequest(envelope, options = {}) {
  if (!envelope || typeof envelope !== 'object') {
    return fail('missing_request_id', envelope);
  }

  for (const [field, reason] of REQUIRED_FIELDS) {
    if (!String(envelope[field] || '').trim()) {
      return fail(reason, envelope);
    }
  }

  const audience = validateAudience(envelope.audience);
  if (!audience.ok) {
    return fail('invalid_audience', envelope);
  }

  const timestamp = validateTimestampSkew(
    envelope.timestamp,
    options.maxSkewSeconds ?? DEFAULT_MAX_TIMESTAMP_SKEW_SECONDS,
  );
  if (!timestamp.ok) {
    return fail('stale_timestamp', envelope);
  }

  const nonce = validateNonceShape(envelope.nonce);
  if (!nonce.ok) {
    return fail('invalid_nonce', envelope);
  }

  const identity = validateRequestIdentity(envelope, options);
  if (!identity.ok) {
    return fail(identity.reason, envelope);
  }

  const signature = verifyRequestSignature(envelope, identity.signingKey, {
    keyId: identity.keyId,
  });
  if (!signature.ok) {
    return fail(signature.reason || 'invalid_signature', envelope);
  }

  if (typeof options.replayChecker !== 'function') {
    return fail('replay_check_unavailable', envelope);
  }

  const replay = options.replayChecker({
    keyId: identity.keyId,
    nonce: envelope.nonce,
    timestamp: envelope.timestamp,
    subject: identity.subject,
  });
  if (!replay?.ok) {
    return fail(replay?.denialReason || replay?.reason || 'replay_check_unavailable', envelope);
  }

  return buildAuthDecision({
    ok: true,
    requestId: envelope.requestId,
    subject: identity.subject,
    keyId: identity.keyId,
  });
}

export function validatePrivateServingAuth(envelope, options = {}) {
  return authenticateSignedRequest(envelope, options);
}
