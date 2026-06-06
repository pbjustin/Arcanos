#!/usr/bin/env node
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

import { assertRuntimeReportPath } from '../effective-router-runtime.mjs';
import { buildReadinessReport } from '../model-readiness-report.mjs';
import { authenticateSignedRequest } from './private-serving-auth.mjs';
import { createInMemoryReplayStore, checkAndRecordNonce } from './private-serving-replay-protection.mjs';
import { signRequestEnvelope } from './private-serving-signing.mjs';

export const PRIVATE_SERVING_AUTH_PR_REPORT =
  'local_artifacts/gptoss-runtime/private-serving-auth-pr-report.json';

const LOCAL_TEST_KEY_ID = 'phase5-auth-local-key';
const LOCAL_TEST_SECRET = 'phase-5-3-local-auth-fixture';

function writeReport(path, report) {
  assertRuntimeReportPath(path);
  const resolved = resolve(process.cwd(), path);
  mkdirSync(dirname(resolved), { recursive: true });
  writeFileSync(resolved, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
}

export function buildLocalAuthValidationReport() {
  const store = createInMemoryReplayStore();
  const envelope = signRequestEnvelope({
    requestId: 'phase5-3-auth-validation',
    timestamp: new Date().toISOString(),
    nonce: 'nonceAuthValidate01',
    audience: 'gptoss-effective-router-private',
    signatureAlgorithm: 'hmac-sha256',
    keyId: LOCAL_TEST_KEY_ID,
    input: {
      userInput: 'Classify this local auth validation request.',
      mode: 'router_classifier',
    },
  }, LOCAL_TEST_SECRET, {
    keyId: LOCAL_TEST_KEY_ID,
  });
  const auth = authenticateSignedRequest(envelope, {
    localTestMode: true,
    localKeyMap: {
      [LOCAL_TEST_KEY_ID]: {
        subject: 'phase5-auth-local-subject',
        signingKey: LOCAL_TEST_SECRET,
      },
    },
    replayChecker: (record) => checkAndRecordNonce(record, store),
  });
  const readiness = buildReadinessReport();
  const failures = [];
  if (!auth.ok) failures.push(`auth_failed:${auth.denialReason}`);
  if (readiness.requestSigningImplemented !== true) failures.push('request_signing_not_implemented');
  if (readiness.authBoundaryImplemented !== true) failures.push('auth_boundary_not_implemented');
  if (readiness.replayProtectionScaffoldReady !== true) {
    failures.push('replay_protection_scaffold_missing');
  }
  if (readiness.replayProtectionImplemented !== false) {
    failures.push('replay_protection_implemented_not_false');
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
    replayProtectionImplemented: false,
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
    failures,
    authDecision: auth,
  };
}

function parseArgs(argv = []) {
  const options = {
    output: PRIVATE_SERVING_AUTH_PR_REPORT,
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
