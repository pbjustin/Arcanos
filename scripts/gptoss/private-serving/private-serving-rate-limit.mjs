export const DEFAULT_RATE_LIMIT_POLICY = {
  maxRequestsPerMinute: 30,
  burstLimit: 5,
  burstWindowMs: 1000,
  windowMs: 60_000,
  denyReason: 'rate_limited',
};

export function createRateLimitState() {
  return {
    buckets: new Map(),
  };
}

function normalizeNow(now) {
  const value = now instanceof Date ? now.getTime() : Number(now);
  return Number.isFinite(value) ? value : Date.now();
}

function validPolicy(policy) {
  return (
    policy &&
    Number.isFinite(Number(policy.maxRequestsPerMinute)) &&
    Number(policy.maxRequestsPerMinute) > 0 &&
    Number.isFinite(Number(policy.burstLimit)) &&
    Number(policy.burstLimit) > 0 &&
    Number.isFinite(Number(policy.windowMs)) &&
    Number(policy.windowMs) > 0 &&
    Number.isFinite(Number(policy.burstWindowMs)) &&
    Number(policy.burstWindowMs) > 0
  );
}

export function evaluateRateLimit(
  subject,
  now = Date.now(),
  policy = DEFAULT_RATE_LIMIT_POLICY,
  state = createRateLimitState(),
) {
  const normalizedSubject = String(subject || '').trim();
  if (!normalizedSubject) {
    return {
      ok: false,
      allowed: false,
      reason: 'missing_subject',
      retryAfterSeconds: 60,
    };
  }
  if (!validPolicy(policy) || !state?.buckets || typeof state.buckets.get !== 'function') {
    return {
      ok: false,
      allowed: false,
      reason: 'invalid_rate_limit_policy',
      retryAfterSeconds: 60,
    };
  }

  const timestamp = normalizeNow(now);
  const windowMs = Number(policy.windowMs);
  const burstWindowMs = Number(policy.burstWindowMs);
  const maxRequestsPerMinute = Number(policy.maxRequestsPerMinute);
  const burstLimit = Number(policy.burstLimit);
  const existing = state.buckets.get(normalizedSubject) || [];
  const recent = existing.filter((item) => timestamp - item < windowMs);
  const burst = recent.filter((item) => timestamp - item < burstWindowMs);

  if (recent.length >= maxRequestsPerMinute || burst.length >= burstLimit) {
    const oldest = recent[0] ?? timestamp;
    const retryAfterSeconds = Math.max(1, Math.ceil((windowMs - (timestamp - oldest)) / 1000));
    state.buckets.set(normalizedSubject, recent);
    return {
      ok: false,
      allowed: false,
      reason: policy.denyReason || 'rate_limited',
      retryAfterSeconds,
      remaining: 0,
      policy: {
        maxRequestsPerMinute,
        burstLimit,
      },
    };
  }

  recent.push(timestamp);
  state.buckets.set(normalizedSubject, recent);
  return {
    ok: true,
    allowed: true,
    reason: null,
    retryAfterSeconds: 0,
    remaining: Math.max(0, maxRequestsPerMinute - recent.length),
    policy: {
      maxRequestsPerMinute,
      burstLimit,
    },
  };
}
