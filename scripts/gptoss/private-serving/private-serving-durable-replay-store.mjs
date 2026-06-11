import { createHash } from 'node:crypto';

const SHA256_HEX_PATTERN = /^[a-f0-9]{64}$/;
const DEFAULT_AUDIENCE = 'gptoss-effective-router-private';
const DEFAULT_SOURCE = 'gptoss_private_serving';
const DEFAULT_REPLAY_WINDOW_SECONDS = 300;

function safeText(value, fallback = null) {
  if (value === undefined || value === null) {
    return fallback;
  }
  const normalized = String(value).trim();
  return normalized ? normalized.slice(0, 240) : fallback;
}

function safeIso(value, fallback = null) {
  const text = safeText(value, null);
  if (!text) {
    return fallback;
  }
  const parsed = Date.parse(text);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : fallback;
}

function safePositiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function hashText(value) {
  const text = safeText(value, null);
  if (!text) {
    return null;
  }
  return createHash('sha256').update(text).digest('hex');
}

function normalizeHash(value, fallback = null) {
  const text = safeText(value, null);
  if (!text) {
    return fallback;
  }
  const lower = text.toLowerCase();
  return SHA256_HEX_PATTERN.test(lower) ? lower : fallback;
}

function omitRawNonce(record) {
  const { nonce, rawNonce, raw_nonce, ...safeRecord } = record;
  return safeRecord;
}

export function createDurableReplayStoreContract() {
  return {
    schemaVersion: 1,
    kind: 'gptoss_private_serving_durable_replay_store_contract',
    implemented: false,
    durable: false,
    executesSql: false,
    liveDbUsed: false,
    table: 'gptoss_private_serving_replay_nonces',
    requiredColumns: [
      'id',
      'key_id',
      'nonce_hash',
      'request_id',
      'body_hash',
      'first_seen_at',
      'expires_at',
      'replay_window_seconds',
      'audience',
      'subject',
      'source',
      'created_at',
    ],
    insertColumns: [
      'key_id',
      'nonce_hash',
      'request_id',
      'body_hash',
      'first_seen_at',
      'expires_at',
      'replay_window_seconds',
      'audience',
      'subject',
      'source',
      'created_at',
    ],
    uniqueConstraint: ['key_id', 'nonce_hash'],
    rawNonceStored: false,
    rawRequestBodyStored: false,
    secretsStored: false,
  };
}

export function validateDurableReplayRecordShape(record = {}) {
  const failures = [];
  const required = [
    'key_id',
    'nonce_hash',
    'request_id',
    'body_hash',
    'first_seen_at',
    'expires_at',
    'replay_window_seconds',
    'audience',
    'source',
    'created_at',
  ];

  for (const field of required) {
    if (record[field] === undefined || record[field] === null || record[field] === '') {
      failures.push(`missing_${field}`);
    }
  }
  if (!SHA256_HEX_PATTERN.test(String(record.nonce_hash || ''))) {
    failures.push('invalid_nonce_hash');
  }
  if (!SHA256_HEX_PATTERN.test(String(record.body_hash || ''))) {
    failures.push('invalid_body_hash');
  }
  if (Object.prototype.hasOwnProperty.call(record, 'nonce')) {
    failures.push('raw_nonce_present');
  }
  if (Object.prototype.hasOwnProperty.call(record, 'rawNonce')) {
    failures.push('raw_nonce_present');
  }
  if (Object.prototype.hasOwnProperty.call(record, 'raw_nonce')) {
    failures.push('raw_nonce_present');
  }

  return {
    ok: failures.length === 0,
    implemented: false,
    failures,
  };
}

export function normalizeReplayStoreRecord(input = {}) {
  const replayWindowSeconds = safePositiveInteger(
    input.replay_window_seconds ?? input.replayWindowSeconds,
    DEFAULT_REPLAY_WINDOW_SECONDS,
  );
  const firstSeenAt = safeIso(
    input.first_seen_at ?? input.firstSeenAt ?? input.timestamp,
    new Date(0).toISOString(),
  );
  const expiresAt = safeIso(
    input.expires_at ?? input.expiresAt,
    new Date(Date.parse(firstSeenAt) + (replayWindowSeconds * 1000)).toISOString(),
  );
  const nonceHash = normalizeHash(
    input.nonce_hash ?? input.nonceHash,
    hashText(input.nonce ?? input.rawNonce ?? input.raw_nonce),
  );
  const record = {
    key_id: safeText(input.key_id ?? input.keyId, ''),
    nonce_hash: nonceHash,
    request_id: safeText(input.request_id ?? input.requestId, ''),
    body_hash: normalizeHash(input.body_hash ?? input.bodyHash, ''),
    first_seen_at: firstSeenAt,
    expires_at: expiresAt,
    replay_window_seconds: replayWindowSeconds,
    audience: safeText(input.audience, DEFAULT_AUDIENCE),
    subject: safeText(input.subject, null),
    source: safeText(input.source, DEFAULT_SOURCE),
    created_at: safeIso(input.created_at ?? input.createdAt, firstSeenAt),
  };
  return omitRawNonce(record);
}

export function buildReplayStoreInsertPlan(decision = {}) {
  const contract = createDurableReplayStoreContract();
  const record = normalizeReplayStoreRecord(decision);
  const validation = validateDurableReplayRecordShape(record);

  return {
    ok: validation.ok,
    kind: 'gptoss_private_serving_durable_replay_store_insert_plan',
    implemented: false,
    executesSql: false,
    liveDbUsed: false,
    table: contract.table,
    insertColumns: contract.insertColumns,
    conflictTarget: contract.uniqueConstraint,
    conflictBehavior: 'reject_replay',
    record,
    rawNonceStored: false,
    rawRequestBodyStored: false,
    secretsStored: false,
    validation,
  };
}

