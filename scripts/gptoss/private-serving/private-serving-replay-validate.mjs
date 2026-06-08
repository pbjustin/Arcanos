#!/usr/bin/env node
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

import { assertRuntimeReportPath } from '../effective-router-runtime.mjs';
import { buildReadinessReport } from '../model-readiness-report.mjs';
import {
  checkReplayProtection,
  createInMemoryReplayStore,
  createReplayProtectionPolicy,
  getReplayStoreStats,
  pruneExpiredReplayEntries,
} from './private-serving-replay-protection.mjs';

export const PRIVATE_SERVING_REPLAY_PR_REPORT =
  'local_artifacts/gptoss-runtime/private-serving-replay-pr-report.json';

const BASE_NOW = Date.parse('2026-06-06T12:00:00.000Z');
const BASE_TIMESTAMP = new Date(BASE_NOW).toISOString();
const BODY_HASH = 'a'.repeat(64);

function writeReport(path, report) {
  assertRuntimeReportPath(path);
  const resolved = resolve(process.cwd(), path);
  mkdirSync(dirname(resolved), { recursive: true });
  writeFileSync(resolved, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
}

function buildRecord(overrides = {}) {
  return {
    keyId: 'phase5-replay-key',
    nonce: 'nonceReplayValid01',
    timestamp: BASE_TIMESTAMP,
    requestId: 'phase5-4-replay-validation',
    bodyHash: BODY_HASH,
    ...overrides,
  };
}

export function buildReplayValidation() {
  const store = createInMemoryReplayStore();
  const policy = createReplayProtectionPolicy({
    now: BASE_NOW,
    replayWindowSeconds: 300,
    maxFutureSkewSeconds: 60,
  });
  const first = checkReplayProtection(buildRecord(), store, policy);
  const duplicate = checkReplayProtection(buildRecord(), store, policy);
  const differentKey = checkReplayProtection(buildRecord({
    keyId: 'phase5-replay-second-key',
    requestId: 'phase5-4-replay-second-key',
  }), store, policy);
  const stale = checkReplayProtection(buildRecord({
    nonce: 'nonceReplayStale01',
    timestamp: new Date(BASE_NOW - 301000).toISOString(),
    requestId: 'phase5-4-replay-stale',
  }), store, policy);
  const future = checkReplayProtection(buildRecord({
    nonce: 'nonceReplayFuture01',
    timestamp: new Date(BASE_NOW + 61000).toISOString(),
    requestId: 'phase5-4-replay-future',
  }), store, policy);
  const invalidNonce = checkReplayProtection(buildRecord({
    nonce: 'short',
    requestId: 'phase5-4-replay-invalid-nonce',
  }), store, policy);
  const missingKeyId = checkReplayProtection(buildRecord({
    keyId: '',
    nonce: 'nonceReplayMissingKey',
    requestId: 'phase5-4-replay-missing-key',
  }), store, policy);
  const unavailableStore = checkReplayProtection(buildRecord({
    nonce: 'nonceReplayNoStore01',
    requestId: 'phase5-4-replay-no-store',
  }), undefined, policy);
  const pruneStore = createInMemoryReplayStore();
  const expired = checkReplayProtection(buildRecord({
    nonce: 'nonceReplayExpired1',
    timestamp: new Date(BASE_NOW - 290000).toISOString(),
    requestId: 'phase5-4-replay-expired',
  }), pruneStore, policy);
  const pruned = pruneExpiredReplayEntries(
    pruneStore,
    BASE_NOW + 12000,
    policy,
  );

  return {
    policy,
    decisions: {
      first,
      duplicate,
      differentKey,
      stale,
      future,
      invalidNonce,
      missingKeyId,
      unavailableStore,
      expired,
    },
    prune: pruned,
    storeStats: getReplayStoreStats(store),
    pruneStoreStats: getReplayStoreStats(pruneStore),
  };
}

export function buildPrivateServingReplayPrReport() {
  const validation = buildReplayValidation();
  const readiness = buildReadinessReport();
  const failures = [];

  if (validation.decisions.first.ok !== true) failures.push('first_nonce_not_accepted');
  if (validation.decisions.duplicate.denialReason !== 'replay_detected') {
    failures.push('duplicate_nonce_not_replay_detected');
  }
  if (validation.decisions.differentKey.ok !== true) {
    failures.push('same_nonce_different_key_not_accepted');
  }
  if (validation.decisions.stale.denialReason !== 'stale_timestamp') {
    failures.push('stale_timestamp_not_rejected');
  }
  if (validation.decisions.future.denialReason !== 'future_timestamp') {
    failures.push('future_timestamp_not_rejected');
  }
  if (validation.decisions.invalidNonce.denialReason !== 'invalid_nonce') {
    failures.push('invalid_nonce_not_rejected');
  }
  if (validation.decisions.missingKeyId.denialReason !== 'missing_key_id') {
    failures.push('missing_key_id_not_rejected');
  }
  if (validation.decisions.unavailableStore.denialReason !== 'replay_store_unavailable') {
    failures.push('unavailable_store_not_rejected');
  }
  if (validation.prune.pruned !== 1 || validation.pruneStoreStats.entries !== 0) {
    failures.push('expired_entry_not_pruned');
  }
  if (readiness.replayProtectionImplemented !== true) {
    failures.push('readiness_replay_protection_not_implemented');
  }
  if (readiness.replayProtectionDurable !== false) {
    failures.push('readiness_replay_protection_durable_not_false');
  }
  if (readiness.privateServingImplemented !== false) {
    failures.push('private_serving_implemented_not_false');
  }
  if (readiness.privateServingExposed !== false) {
    failures.push('private_serving_exposed_not_false');
  }
  if (readiness.cloudReady !== false) failures.push('cloud_ready_not_false');
  if (readiness.customGptReady !== false) failures.push('custom_gpt_ready_not_false');

  return {
    schemaVersion: 1,
    kind: 'gptoss_private_serving_replay_pr_report',
    ok: failures.length === 0,
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
    noOpenAiOutputUsed: true,
    replayProtectionPolicy: validation.policy,
    replayProtectionDecision: validation.decisions.first,
    replayProtectionStoreStats: validation.storeStats,
    replayProtectionValidationReport: validation,
    failures,
  };
}

function parseArgs(argv = []) {
  const options = {
    output: PRIVATE_SERVING_REPLAY_PR_REPORT,
    write: true,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const next = argv[index + 1];
    if (flag === '--output' && next) {
      options.output = next;
      index += 1;
    } else if (flag === '--no-write') {
      options.write = false;
    } else {
      throw new Error(`Unknown or incomplete argument: ${flag}`);
    }
  }
  return options;
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const report = buildPrivateServingReplayPrReport();
  if (options.write) {
    writeReport(options.output, report);
  }
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (!report.ok) {
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
