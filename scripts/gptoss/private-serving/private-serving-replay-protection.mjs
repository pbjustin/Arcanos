import {
  DEFAULT_MAX_TIMESTAMP_SKEW_SECONDS,
  validateTimestampSkew,
} from './private-serving-signing.mjs';

export function createInMemoryReplayStore() {
  return {
    records: new Map(),
  };
}

function nonceKey(keyId, nonce) {
  return `${String(keyId || '')}:${String(nonce || '')}`;
}

function replayDecision({
  ok,
  nonceAccepted = false,
  replayDetected = false,
  denialReason = null,
}) {
  return {
    ok,
    implemented: false,
    scaffoldReady: true,
    nonceAccepted,
    replayDetected,
    denialReason,
    reason: denialReason,
  };
}

export function checkAndRecordNonce(
  { keyId, nonce, timestamp } = {},
  store = createInMemoryReplayStore(),
  options = {},
) {
  const skew = validateTimestampSkew(
    timestamp,
    options.maxSkewSeconds ?? DEFAULT_MAX_TIMESTAMP_SKEW_SECONDS,
  );
  if (!skew.ok) {
    return replayDecision({
      ok: false,
      denialReason: 'stale_timestamp',
    });
  }

  if (!store?.records || typeof store.records.has !== 'function') {
    return replayDecision({
      ok: false,
      denialReason: 'replay_check_unavailable',
    });
  }

  const key = nonceKey(keyId, nonce);
  if (store.records.has(key)) {
    return replayDecision({
      ok: false,
      replayDetected: true,
      denialReason: 'replay_detected',
    });
  }

  store.records.set(key, {
    keyId: String(keyId || ''),
    nonce: String(nonce || ''),
    timestamp: String(timestamp || ''),
    recordedAt: new Date().toISOString(),
  });
  return replayDecision({
    ok: true,
    nonceAccepted: true,
  });
}
