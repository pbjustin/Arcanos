export const CLEAN_PRIVATE_SERVING_SAFETY = {
  openAiCalled: false,
  trainingExecuted: false,
  vllmUsed: false,
  railwayCliUsed: false,
  liveDbUsed: false,
  noOpenAiOutputUsed: true,
};

const ALLOWED_REASONS = new Set([
  'authentication_failure',
  'missing_signature',
  'missing_request_id',
  'missing_timestamp',
  'missing_nonce',
  'missing_audience',
  'missing_body_hash',
  'invalid_audience',
  'stale_timestamp',
  'invalid_nonce',
  'missing_key_id',
  'unknown_key_id',
  'replay_check_unavailable',
  'replay_detected',
  'subject_unavailable',
  'invalid_signature',
  'signature_verification_unavailable',
  'signature_verification_not_implemented',
  'rate_limited',
  'unsupported_endpoint',
  'forbidden_endpoint',
  'cloud_custom_blocked',
  'unsafe_safety_flags',
  'dirty_safety_flags',
]);

function safeReason(reason) {
  const normalized = String(reason || 'authentication_failure')
    .trim()
    .replace(/[^a-z0-9_-]/gi, '_')
    .slice(0, 96);
  return ALLOWED_REASONS.has(normalized) ? normalized : 'authentication_failure';
}

function safeRequestId(requestId) {
  const value = String(requestId || 'private-serving-denied').trim();
  return value.replace(/[^a-zA-Z0-9._:-]/g, '_').slice(0, 128) || 'private-serving-denied';
}

function baseDenial(reason, options = {}) {
  return {
    ok: false,
    denied: true,
    reason: safeReason(reason),
    requestId: safeRequestId(options.requestId),
    safety: CLEAN_PRIVATE_SERVING_SAFETY,
  };
}

export function buildDenialResponse(reason, options = {}) {
  return baseDenial(reason, options);
}

export function buildAuthFailureResponse(reason = 'authentication_failure', options = {}) {
  return buildDenialResponse(reason, options);
}

export function buildRateLimitResponse(options = {}) {
  return {
    ...buildDenialResponse('rate_limited', options),
    retryAfterSeconds: Math.max(1, Number(options.retryAfterSeconds || 60)),
  };
}

export function buildForbiddenEndpointResponse(options = {}) {
  return buildDenialResponse(options.reason || 'forbidden_endpoint', options);
}

export function buildUnsafeSafetyResponse(options = {}) {
  return buildDenialResponse(options.reason || 'dirty_safety_flags', options);
}
