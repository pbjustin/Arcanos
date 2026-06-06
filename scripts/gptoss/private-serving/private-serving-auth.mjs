import {
  PRIVATE_SERVING_AUDIENCE,
  validateAudience,
  validateNonceShape,
  validateTimestampSkew,
  verifyRequestSignature,
  verifySignatureScaffold,
} from './private-serving-signing.mjs';

const REQUIRED_FIELDS = [
  ['requestId', 'missing_request_id'],
  ['timestamp', 'missing_timestamp'],
  ['nonce', 'missing_nonce'],
  ['audience', 'missing_audience'],
  ['bodyHash', 'missing_body_hash'],
  ['signature', 'missing_signature'],
];

function fail(reason, envelope) {
  return {
    ok: false,
    authenticated: false,
    failClosed: true,
    implemented: false,
    reason,
    requestId: envelope?.requestId || null,
    cloudReady: false,
    customGptReady: false,
    privateServingExposed: false,
    publicServerCreated: false,
  };
}

function explicitSigningSecret(options = {}) {
  return options.signingSecret || options.localSigningSecret || options.secret;
}

export function validatePrivateServingAuth(envelope, options = {}) {
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
    options.maxSkewSeconds,
  );
  if (!timestamp.ok) {
    return fail('stale_timestamp', envelope);
  }

  const nonce = validateNonceShape(envelope.nonce);
  if (!nonce.ok) {
    return fail('invalid_nonce', envelope);
  }

  const signingSecret = explicitSigningSecret(options);
  const signature = signingSecret
    ? verifyRequestSignature(envelope, signingSecret, options)
    : verifySignatureScaffold(envelope, options);
  if (!signature.ok || signature.implemented !== true) {
    if (signature.testOnly === true && signature.ok === true) {
      return {
        ok: true,
        authenticated: true,
        failClosed: false,
        implemented: false,
        testOnly: true,
        reason: null,
        requestId: envelope.requestId,
        audience: PRIVATE_SERVING_AUDIENCE,
        cloudReady: false,
        customGptReady: false,
        privateServingExposed: false,
        publicServerCreated: false,
      };
    }
    return fail(signature.reason === 'invalid_signature'
      ? 'invalid_signature'
      : 'signature_verification_unavailable', envelope);
  }

  return {
    ok: true,
    authenticated: true,
    failClosed: false,
    implemented: false,
    signatureImplemented: true,
    reason: null,
    requestId: envelope.requestId,
    audience: PRIVATE_SERVING_AUDIENCE,
    cloudReady: false,
    customGptReady: false,
    privateServingExposed: false,
    publicServerCreated: false,
  };
}
