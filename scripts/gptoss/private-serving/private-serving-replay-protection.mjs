import {
  DEFAULT_MAX_TIMESTAMP_SKEW_SECONDS,
  validateNonceShape,
} from './private-serving-signing.mjs';

export const DEFAULT_REPLAY_WINDOW_SECONDS = 300;

const NONCE_PATTERN_SOURCE = '^[A-Za-z0-9_-]{16,128}$';

function safeText(value, fallback = null) {
  if (value === undefined || value === null) {
    return fallback;
  }
  const normalized = String(value).trim();
  return normalized ? normalized.slice(0, 160) : fallback;
}

function safePositiveNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function nowMs(policy = {}) {
  const parsed = Number(policy.now);
  return Number.isFinite(parsed) ? parsed : Date.now();
}

function replayEntryKey(keyId, nonce) {
  return JSON.stringify([String(keyId), String(nonce)]);
}

function replayDecision({
  ok,
  keyId = null,
  nonce = null,
  requestId = null,
  bodyHash = null,
  recorded = false,
  denialReason = null,
}) {
  return {
    ok,
    replayAccepted: ok,
    implemented: true,
    keyId: safeText(keyId, null),
    nonce: safeText(nonce, null),
    requestId: safeText(requestId, null),
    bodyHash: safeText(bodyHash, null),
    recorded,
    denialReason,
  };
}

function validateReplayTimestamp(timestamp, now, policy) {
  const parsed = Date.parse(timestamp);
  if (!Number.isFinite(parsed)) {
    return { ok: false, denialReason: 'stale_timestamp', timestampMs: null };
  }

  const pastWindowMs = policy.replayWindowSeconds * 1000;
  const futureWindowMs = policy.maxFutureSkewSeconds * 1000;
  if (now - parsed > pastWindowMs) {
    return { ok: false, denialReason: 'stale_timestamp', timestampMs: parsed };
  }
  if (parsed - now > futureWindowMs) {
    return { ok: false, denialReason: 'future_timestamp', timestampMs: parsed };
  }

  return { ok: true, denialReason: null, timestampMs: parsed };
}

export function createInMemoryReplayStore(options = {}) {
  return {
    kind: 'in_memory_replay_store',
    durable: false,
    records: options.records instanceof Map ? options.records : new Map(),
  };
}

export function createReplayProtectionPolicy(options = {}) {
  const maxFutureSkewSeconds = safePositiveNumber(
    options.maxFutureSkewSeconds ?? options.maxSkewSeconds,
    DEFAULT_MAX_TIMESTAMP_SKEW_SECONDS,
  );
  return {
    implemented: true,
    durable: false,
    replayWindowSeconds: safePositiveNumber(
      options.replayWindowSeconds ?? options.windowSeconds,
      DEFAULT_REPLAY_WINDOW_SECONDS,
    ),
    maxFutureSkewSeconds,
    noncePattern: NONCE_PATTERN_SOURCE,
    ...(Number.isFinite(Number(options.now)) ? { now: Number(options.now) } : {}),
  };
}

export function pruneExpiredReplayEntries(
  store,
  now = Date.now(),
  policy = createReplayProtectionPolicy(),
) {
  if (!store?.records || typeof store.records.entries !== 'function') {
    return {
      ok: false,
      implemented: true,
      pruned: 0,
      denialReason: 'replay_store_unavailable',
    };
  }

  const normalizedPolicy = createReplayProtectionPolicy(policy);
  const threshold = Number(now) - (normalizedPolicy.replayWindowSeconds * 1000);
  let pruned = 0;
  for (const [key, entry] of store.records.entries()) {
    const timestampMs = Number(entry?.timestampMs ?? entry?.recordedAtMs);
    if (!Number.isFinite(timestampMs) || timestampMs < threshold) {
      store.records.delete(key);
      pruned += 1;
    }
  }

  return {
    ok: true,
    implemented: true,
    pruned,
    denialReason: null,
  };
}

export function getReplayStoreStats(store) {
  if (!store?.records || typeof store.records.entries !== 'function') {
    return {
      implemented: true,
      durable: false,
      available: false,
      entries: 0,
      keyIds: [],
      nonces: [],
      oldestTimestamp: null,
      newestTimestamp: null,
    };
  }

  const entries = Array.from(store.records.values());
  const timestamps = entries
    .map((entry) => Number(entry?.timestampMs))
    .filter((value) => Number.isFinite(value))
    .sort((a, b) => a - b);
  return {
    implemented: true,
    durable: false,
    available: true,
    entries: entries.length,
    keyIds: Array.from(new Set(entries.map((entry) => safeText(entry?.keyId, '')).filter(Boolean)))
      .sort(),
    nonces: Array.from(new Set(entries.map((entry) => safeText(entry?.nonce, '')).filter(Boolean)))
      .sort(),
    oldestTimestamp: timestamps.length > 0 ? new Date(timestamps[0]).toISOString() : null,
    newestTimestamp: timestamps.length > 0
      ? new Date(timestamps[timestamps.length - 1]).toISOString()
      : null,
  };
}

export function checkReplayProtection(
  { keyId, nonce, timestamp, requestId, bodyHash } = {},
  store,
  policy = createReplayProtectionPolicy(),
) {
  const normalizedPolicy = createReplayProtectionPolicy(policy);
  const normalizedKeyId = safeText(keyId, null);
  const normalizedNonce = safeText(nonce, null);
  const metadata = {
    keyId: normalizedKeyId,
    nonce: normalizedNonce,
    requestId,
    bodyHash,
  };

  if (!normalizedKeyId) {
    return replayDecision({
      ...metadata,
      ok: false,
      denialReason: 'missing_key_id',
    });
  }

  if (!validateNonceShape(normalizedNonce).ok) {
    return replayDecision({
      ...metadata,
      ok: false,
      denialReason: 'invalid_nonce',
    });
  }

  if (!store?.records || typeof store.records.has !== 'function') {
    return replayDecision({
      ...metadata,
      ok: false,
      denialReason: 'replay_store_unavailable',
    });
  }

  const currentNow = nowMs(normalizedPolicy);
  const timestampDecision = validateReplayTimestamp(timestamp, currentNow, normalizedPolicy);
  if (!timestampDecision.ok) {
    return replayDecision({
      ...metadata,
      ok: false,
      denialReason: timestampDecision.denialReason,
    });
  }

  pruneExpiredReplayEntries(store, currentNow, normalizedPolicy);

  const key = replayEntryKey(normalizedKeyId, normalizedNonce);
  if (store.records.has(key)) {
    return replayDecision({
      ...metadata,
      ok: false,
      denialReason: 'replay_detected',
    });
  }

  store.records.set(key, {
    keyId: normalizedKeyId,
    nonce: normalizedNonce,
    timestamp: String(timestamp),
    timestampMs: timestampDecision.timestampMs,
    recordedAtMs: currentNow,
    requestId: safeText(requestId, null),
    bodyHash: safeText(bodyHash, null),
  });

  return replayDecision({
    ...metadata,
    ok: true,
    recorded: true,
  });
}

export function checkAndRecordNonce(record = {}, store, options = {}) {
  return checkReplayProtection(record, store, createReplayProtectionPolicy(options));
}
