#!/usr/bin/env node
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

import { assertRuntimeReportPath } from '../effective-router-runtime.mjs';
import { buildReadinessReport } from '../model-readiness-report.mjs';
import { authenticateSignedRequest } from './private-serving-auth.mjs';
import {
  createInMemoryReplayStore,
  getReplayStoreStats,
} from './private-serving-replay-protection.mjs';
import { signRequestEnvelope } from './private-serving-signing.mjs';

export const PRIVATE_SERVING_AUTH_REPORT =
  'local_artifacts/gptoss-runtime/private-serving-auth-report.json';
export const PRIVATE_SERVING_AUTH_PR_REPORT =
  'local_artifacts/gptoss-runtime/private-serving-auth-pr-report.json';

const LOCAL_TEST_KEY_ID = 'phase5-auth-local-key';
const LOCAL_TEST_SIGNING_KEY = 'phase-5-4-local-auth-fixture';

function writeReport(path, report) {
  assertRuntimeReportPath(path);
  const resolved = resolve(process.cwd(), path);
  mkdirSync(dirname(resolved), { recursive: true });
  writeFileSync(resolved, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
}

function buildSignedSyntheticEnvelope() {
  return signRequestEnvelope({
    requestId: 'phase5-4-auth-replay-validation',
    timestamp: new Date().toISOString(),
    nonce: 'nonceAuthReplay01',
    audience: 'gptoss-effective-router-private',
    signatureAlgorithm: 'hmac-sha256',
    keyId: LOCAL_TEST_KEY_ID,
    input: {
      userInput: 'Classify this local auth replay validation request.',
      mode: 'router_classifier',
    },
  }, LOCAL_TEST_SIGNING_KEY, {
    keyId: LOCAL_TEST_KEY_ID,
  });
}

function buildLocalAuthOptions(store) {
  return {
    localTestMode: true,
    localKeyMap: {
      [LOCAL_TEST_KEY_ID]: {
        subject: 'phase5-auth-local-subject',
        signingKey: LOCAL_TEST_SIGNING_KEY,
      },
    },
    replayStore: store,
  };
}

export function validateSignedSyntheticReplay() {
  const store = createInMemoryReplayStore();
  const envelope = buildSignedSyntheticEnvelope();
  const options = buildLocalAuthOptions(store);
  const first = authenticateSignedRequest(envelope, options);
  const duplicate = authenticateSignedRequest(envelope, options);

  return {
    requestId: envelope.requestId,
    keyId: envelope.keyId,
    nonce: envelope.nonce,
    firstSignedSyntheticRequestPassed: first.ok === true,
    duplicateSignedSyntheticRequestRejected:
      duplicate.ok === false && duplicate.denialReason === 'replay_detected',
    duplicateDenialReason: duplicate.denialReason || null,
    replayStoreStats: getReplayStoreStats(store),
    firstAuthDecision: first,
    duplicateAuthDecision: duplicate,
  };
}

export function buildLocalAuthValidationReport() {
  const replay = validateSignedSyntheticReplay();
  const readiness = buildReadinessReport();
  const failures = [];
  if (!replay.firstSignedSyntheticRequestPassed) {
    failures.push(`first_signed_synthetic_request_failed:${replay.firstAuthDecision.denialReason}`);
  }
  if (!replay.duplicateSignedSyntheticRequestRejected) {
    failures.push(
      `duplicate_signed_synthetic_request_not_replay_detected:${replay.duplicateDenialReason}`,
    );
  }
  if (readiness.requestSigningImplemented !== true) failures.push('request_signing_not_implemented');
  if (readiness.authBoundaryImplemented !== true) failures.push('auth_boundary_not_implemented');
  if (readiness.replayProtectionScaffoldReady !== true) {
    failures.push('replay_protection_scaffold_missing');
  }
  if (readiness.replayProtectionImplemented !== true) {
    failures.push('replay_protection_not_implemented');
  }
  if (readiness.replayProtectionDurable !== false) {
    failures.push('replay_protection_durable_not_false');
  }
  if (readiness.privateServingImplemented !== false) {
    failures.push('private_serving_implemented_not_false');
  }
  if (readiness.privateServingExposed !== false) {
    failures.push('private_serving_exposed_not_false');
  }
  if (readiness.publicServerCreated !== false) {
    failures.push('public_server_created_not_false');
  }
  if (readiness.cloudReady !== false) failures.push('cloud_ready_not_false');
  if (readiness.customGptReady !== false) failures.push('custom_gpt_ready_not_false');

  return {
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
    allowedForTraining: false,
    openAiCalled: false,
    trainingExecuted: false,
    vllmUsed: false,
    railwayCliUsed: false,
    liveDbUsed: false,
    serverCreated: false,
    externalSecretsUsed: false,
    noOpenAiOutputUsed: true,
    failures,
    firstSignedSyntheticRequestPassed: replay.firstSignedSyntheticRequestPassed,
    duplicateSignedSyntheticRequestRejected: replay.duplicateSignedSyntheticRequestRejected,
    duplicateDenialReason: replay.duplicateDenialReason,
    replayValidation: {
      requestId: replay.requestId,
      keyId: replay.keyId,
      nonce: replay.nonce,
      firstSignedSyntheticRequestPassed: replay.firstSignedSyntheticRequestPassed,
      duplicateSignedSyntheticRequestRejected: replay.duplicateSignedSyntheticRequestRejected,
      duplicateDenialReason: replay.duplicateDenialReason,
      replayStoreStats: replay.replayStoreStats,
    },
    authDecision: replay.firstAuthDecision,
    duplicateAuthDecision: replay.duplicateAuthDecision,
  };
}

function parseArgs(argv = []) {
  const options = {
    output: PRIVATE_SERVING_AUTH_REPORT,
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
    } else if (flag === '--pr-report') {
      options.output = PRIVATE_SERVING_AUTH_PR_REPORT;
    } else {
      throw new Error(`Unknown or incomplete argument: ${flag}`);
    }
  }
  return options;
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const report = buildLocalAuthValidationReport();
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
