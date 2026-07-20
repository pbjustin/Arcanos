#!/usr/bin/env node
/**
 * Purpose: Bind the Gate R2 coordinator to one already-running local projector session.
 * Safety: Never starts a token session, accepts only a secure session path and exact PID,
 * rejects ambient tokens, suppresses process diagnostics, and emits fixed results only.
 */

import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  createGateR2CoordinatorFileAdapter,
  createGateR2CoordinatorProcessAdapter,
  runGateR2RetirementCoordinator
} from './gate-r2-retirement-coordinator.js';

export const GATE_R2_RUNNER_EXIT_TIMEOUT_MS = 30_000;
export const GATE_R2_RUNNER_POLL_INTERVAL_MS = 100;
export const GATE_R2_RUNNER_PROCESS_OUTPUT_LIMIT_BYTES = 512;
export const GATE_R2_RUNNER_SESSION_SCRIPT_LIMIT_BYTES = 128 * 1024;
export const GATE_R2_RUNNER_SESSION_SCRIPT_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  'gate-r2-projector-session-20260720.ps1'
);

const FORBIDDEN_TOKEN_NAMES = Object.freeze([
  'ARCANOS_GATE_R1_RAILWAY_PROJECT_TOKEN',
  'ARCANOS_GATE_R2_RAILWAY_PROJECT_TOKEN',
  'RAILWAY_API_TOKEN',
  'RAILWAY_PROJECT_TOKEN',
  'RAILWAY_TOKEN'
]);
const FORBIDDEN_TOKEN_NAME_SET = new Set(FORBIDDEN_TOKEN_NAMES);
const RUNNER_CODES = Object.freeze({
  AMBIENT_TOKEN_FORBIDDEN: 'GATE_R2_RETIREMENT_RUNNER_AMBIENT_TOKEN_FORBIDDEN',
  ARGUMENT_INVALID: 'GATE_R2_RETIREMENT_RUNNER_ARGUMENT_INVALID',
  COORDINATOR_FAILED: 'GATE_R2_RETIREMENT_RUNNER_COORDINATOR_FAILED',
  OUTPUT_INVALID: 'GATE_R2_RETIREMENT_RUNNER_OUTPUT_INVALID',
  PID_REUSED: 'GATE_R2_RETIREMENT_RUNNER_PID_REUSED',
  PLATFORM_UNSUPPORTED: 'GATE_R2_RETIREMENT_RUNNER_PLATFORM_UNSUPPORTED',
  SESSION_CLEANUP_REQUIRED: 'GATE_R2_RETIREMENT_RUNNER_SESSION_CLEANUP_REQUIRED',
  SESSION_EXIT_TIMEOUT: 'GATE_R2_RETIREMENT_RUNNER_SESSION_EXIT_TIMEOUT',
  SESSION_PROCESS_INVALID: 'GATE_R2_RETIREMENT_RUNNER_SESSION_PROCESS_INVALID'
});
const SAFE_RUNNER_CODES = new Set(Object.values(RUNNER_CODES));

function fail(code) {
  throw new Error(code);
}

function ownDataValue(value, property) {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, property);
    return descriptor && Object.hasOwn(descriptor, 'value') ? descriptor.value : undefined;
  } catch {
    return undefined;
  }
}

function safeCode(error) {
  const message = error && typeof error === 'object' ? ownDataValue(error, 'message') : undefined;
  return typeof message === 'string' && SAFE_RUNNER_CODES.has(message)
    ? message
    : RUNNER_CODES.COORDINATOR_FAILED;
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function exactKeys(value, expectedKeys) {
  if (!isPlainObject(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...expectedKeys].sort();
  return actual.length === expected.length
    && actual.every((key, index) => key === expected[index]);
}

function clearBuffer(value) {
  if (Buffer.isBuffer(value)) value.fill(0);
}

function clearChildDiagnostics(value, seen = new Set()) {
  if (!value || typeof value !== 'object' || seen.has(value)) return;
  seen.add(value);
  clearBuffer(ownDataValue(value, 'stdout'));
  clearBuffer(ownDataValue(value, 'stderr'));
  const output = ownDataValue(value, 'output');
  if (Array.isArray(output)) {
    try {
      for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(output))) {
        if (Object.hasOwn(descriptor, 'value')) clearBuffer(descriptor.value);
      }
    } catch {
      // Child diagnostics are never rendered and cleanup is best effort.
    }
  }
  const nestedError = ownDataValue(value, 'error');
  if (nestedError && nestedError !== value) clearChildDiagnostics(nestedError, seen);
  const nestedCause = ownDataValue(value, 'cause');
  if (nestedCause && nestedCause !== value) clearChildDiagnostics(nestedCause, seen);
}

function decodeBounded(value) {
  if (!Buffer.isBuffer(value) || value.length > GATE_R2_RUNNER_PROCESS_OUTPUT_LIMIT_BYTES) {
    fail(RUNNER_CODES.SESSION_PROCESS_INVALID);
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(value);
  } catch {
    fail(RUNNER_CODES.SESSION_PROCESS_INVALID);
  }
}

function resolvePowerShellPath(environment) {
  let systemRoot;
  try {
    systemRoot = environment.SystemRoot ?? environment.SYSTEMROOT;
  } catch {
    fail(RUNNER_CODES.SESSION_PROCESS_INVALID);
  }
  if (typeof systemRoot !== 'string'
      || !/^[A-Za-z]:\\Windows$/u.test(systemRoot)
      || resolve(systemRoot) !== systemRoot) {
    fail(RUNNER_CODES.SESSION_PROCESS_INVALID);
  }
  const executable = join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  if (!existsSync(executable)) fail(RUNNER_CODES.SESSION_PROCESS_INVALID);
  return executable;
}

function processInspectionCommand(pid) {
  return [
    `$p = Get-Process -Id ${pid} -ErrorAction SilentlyContinue`,
    "if ($null -eq $p) { [Console]::Out.Write('{\"alive\":false,\"pid\":${pid}}'); exit 0 }",
    "$name = [string]$p.ProcessName",
    "if ($name -cne 'pwsh' -and $name -cne 'powershell') { exit 3 }",
    'try { $ticks = $p.StartTime.ToUniversalTime().Ticks.ToString() } catch { exit 4 }',
    `[Console]::Out.Write('{\"alive\":true,\"pid\":${pid},\"identity\":\"' + $ticks + '\"}')`
  ].join('; ');
}

export function inspectGateR2WindowsSessionProcess({
  pid,
  environment = process.env,
  spawn = spawnSync,
  powerShellPath
} = {}) {
  if (!Number.isInteger(pid) || pid < 1 || pid > 0xffff_ffff
      || !isPlainObject(environment) || typeof spawn !== 'function') {
    fail(RUNNER_CODES.ARGUMENT_INVALID);
  }
  const executable = powerShellPath ?? resolvePowerShellPath(environment);
  if (typeof executable !== 'string' || executable.length === 0) {
    fail(RUNNER_CODES.SESSION_PROCESS_INVALID);
  }
  const childEnvironment = Object.freeze({
    SystemRoot: environment.SystemRoot ?? environment.SYSTEMROOT,
    WINDIR: environment.WINDIR ?? environment.SystemRoot ?? environment.SYSTEMROOT
  });
  let child;
  let stdout;
  let stderr;
  try {
    child = spawn(executable, [
      '-NoLogo', '-NoProfile', '-NonInteractive', '-Command', processInspectionCommand(pid)
    ], {
      env: childEnvironment,
      maxBuffer: GATE_R2_RUNNER_PROCESS_OUTPUT_LIMIT_BYTES,
      shell: false,
      timeout: 5_000,
      windowsHide: true
    });
    if (child?.error || child?.status !== 0) fail(RUNNER_CODES.SESSION_PROCESS_INVALID);
    stdout = decodeBounded(child.stdout);
    stderr = decodeBounded(child.stderr);
    if (stderr.length !== 0) fail(RUNNER_CODES.SESSION_PROCESS_INVALID);
    let parsed;
    try { parsed = JSON.parse(stdout); } catch { fail(RUNNER_CODES.SESSION_PROCESS_INVALID); }
    if (exactKeys(parsed, ['alive', 'pid']) && parsed.alive === false && parsed.pid === pid) {
      return Object.freeze({ alive: false, pid });
    }
    if (!exactKeys(parsed, ['alive', 'pid', 'identity'])
        || parsed.alive !== true
        || parsed.pid !== pid
        || typeof parsed.identity !== 'string'
        || !/^[1-9][0-9]{0,19}$/u.test(parsed.identity)) {
      fail(RUNNER_CODES.SESSION_PROCESS_INVALID);
    }
    return Object.freeze({ alive: true, identity: parsed.identity, pid });
  } catch (error) {
    clearChildDiagnostics(error);
    if (safeCode(error) === RUNNER_CODES.SESSION_PROCESS_INVALID) throw error;
    fail(RUNNER_CODES.SESSION_PROCESS_INVALID);
  } finally {
    clearBuffer(child?.stdout);
    clearBuffer(child?.stderr);
    child = null;
    stdout = null;
    stderr = null;
  }
}

export function parseGateR2RetirementRunnerArgs(argv) {
  if (!Array.isArray(argv)
      || argv.length !== 4
      || argv[0] !== '--session-directory'
      || typeof argv[1] !== 'string'
      || argv[1].length === 0
      || argv[2] !== '--session-pid'
      || typeof argv[3] !== 'string'
      || !/^[1-9][0-9]{0,9}$/u.test(argv[3])) {
    fail(RUNNER_CODES.ARGUMENT_INVALID);
  }
  const pid = Number(argv[3]);
  if (!Number.isSafeInteger(pid) || pid > 0xffff_ffff) fail(RUNNER_CODES.ARGUMENT_INVALID);
  return Object.freeze({ pid, sessionDirectory: argv[1] });
}

function assertInspection(value, pid, requireAlive) {
  if (requireAlive) {
    if (!exactKeys(value, ['alive', 'identity', 'pid'])
        || value.alive !== true
        || value.pid !== pid
        || typeof value.identity !== 'string'
        || !/^[1-9][0-9]{0,19}$/u.test(value.identity)) {
      fail(RUNNER_CODES.SESSION_PROCESS_INVALID);
    }
  } else if (!exactKeys(value, ['alive', 'pid']) || value.alive !== false || value.pid !== pid) {
    fail(RUNNER_CODES.SESSION_PROCESS_INVALID);
  }
}

function assertCoordinatorResult(value) {
  if (!exactKeys(value, [
    'code', 'environmentId', 'finalOldVolumeState', 'projectId',
    'requestsConsumed', 'serviceRetirementCount', 'sessionExitVerified',
    'status', 'validatorCutoverCount', 'volumeDispositionCount'
  ])
      || value.code !== 'GATE_R2_COORDINATOR_COMPLETE'
      || value.environmentId !== 'fb99f47d-5ef5-44c1-96c2-acf7b90fab13'
      || value.finalOldVolumeState !== 'ABSENT'
      || value.projectId !== '7faf44e5-519c-4e73-8d7a-da9f389e6187'
      || value.requestsConsumed !== 14
      || value.serviceRetirementCount !== 3
      || value.sessionExitVerified !== true
      || value.status !== 'PASS'
      || value.validatorCutoverCount !== 2
      || !Number.isInteger(value.volumeDispositionCount)
      || value.volumeDispositionCount < 0
      || value.volumeDispositionCount > 3) {
    fail(RUNNER_CODES.OUTPUT_INVALID);
  }
  return Object.freeze({
    code: 'GATE_R2_RETIREMENT_RUNNER_COMPLETE',
    environmentId: value.environmentId,
    finalOldVolumeState: 'ABSENT',
    projectId: value.projectId,
    requestsConsumed: 14,
    serviceRetirementCount: 3,
    sessionExitVerified: true,
    status: 'PASS',
    validatorCutoverCount: 2,
    volumeDispositionCount: value.volumeDispositionCount
  });
}

function assertNoAmbientTokens(environment) {
  if (!isPlainObject(environment)) fail(RUNNER_CODES.ARGUMENT_INVALID);
  let names;
  try { names = Object.keys(environment); } catch { fail(RUNNER_CODES.ARGUMENT_INVALID); }
  for (const name of names) {
    if (FORBIDDEN_TOKEN_NAME_SET.has(name.toUpperCase())) {
      fail(RUNNER_CODES.AMBIENT_TOKEN_FORBIDDEN);
    }
  }
}

function resolveSessionScriptSha256({
  path = GATE_R2_RUNNER_SESSION_SCRIPT_PATH,
  readFile = readFileSync
} = {}) {
  let bytes;
  try {
    bytes = readFile(path);
    if (!Buffer.isBuffer(bytes)
        || bytes.length === 0
        || bytes.length > GATE_R2_RUNNER_SESSION_SCRIPT_LIMIT_BYTES) {
      fail(RUNNER_CODES.SESSION_PROCESS_INVALID);
    }
    return createHash('sha256').update(bytes).digest('hex').toUpperCase();
  } catch (error) {
    clearChildDiagnostics(error);
    if (safeCode(error) === RUNNER_CODES.SESSION_PROCESS_INVALID) throw error;
    fail(RUNNER_CODES.SESSION_PROCESS_INVALID);
  } finally {
    if (Buffer.isBuffer(bytes)) bytes.fill(0);
  }
}

function assertReadyBinding(value, pid, expectedScriptSha256, expectedProcessIdentity) {
  if (!exactKeys(value, [
    'protocolVersion', 'status', 'projectId', 'environmentId',
    'maximumRequests', 'createdAt', 'sessionProcessId',
    'sessionProcessIdentity', 'sessionScriptSha256'
  ])
      || value.protocolVersion !== 1
      || value.status !== 'ready'
      || value.projectId !== '7faf44e5-519c-4e73-8d7a-da9f389e6187'
      || value.environmentId !== 'fb99f47d-5ef5-44c1-96c2-acf7b90fab13'
      || value.maximumRequests !== 14
      || value.sessionProcessId !== pid
      || typeof value.sessionProcessIdentity !== 'string'
      || !/^[1-9][0-9]{0,19}$/u.test(value.sessionProcessIdentity)
      || (expectedProcessIdentity !== undefined
        && value.sessionProcessIdentity !== expectedProcessIdentity)
      || value.sessionScriptSha256 !== expectedScriptSha256
      || typeof value.createdAt !== 'string') {
    fail(RUNNER_CODES.SESSION_PROCESS_INVALID);
  }
}

function bindFileAdapterToSession(fileAdapter, pid, expectedScriptSha256, expectedProcessIdentity) {
  if (!isPlainObject(fileAdapter)
      || !['readReady', 'writeRequest', 'waitForResponse', 'writeAcknowledgement']
        .every(name => typeof fileAdapter[name] === 'function')) {
    fail(RUNNER_CODES.ARGUMENT_INVALID);
  }
  const readReady = () => {
    let value;
    try { value = fileAdapter.readReady(); } catch { fail(RUNNER_CODES.SESSION_PROCESS_INVALID); }
    assertReadyBinding(value, pid, expectedScriptSha256, expectedProcessIdentity);
    return value;
  };
  return Object.freeze({
    readReady,
    writeRequest: (sequence, value) => fileAdapter.writeRequest(sequence, value),
    waitForResponse: sequence => fileAdapter.waitForResponse(sequence),
    writeAcknowledgement: value => fileAdapter.writeAcknowledgement(value)
  });
}

function directoryIsAbsent(path) {
  try {
    lstatSync(path);
    return false;
  } catch (error) {
    if (ownDataValue(error, 'code') === 'ENOENT') return true;
    throw error;
  }
}

export async function runGateR2RetirementRunner({
  argv,
  environment = process.env,
  platform = process.platform,
  inspectProcess = options => inspectGateR2WindowsSessionProcess({ ...options, environment }),
  isDirectoryAbsent = directoryIsAbsent,
  sleep = milliseconds => new Promise(resolveSleep => setTimeout(resolveSleep, milliseconds)),
  now = Date.now,
  exitTimeoutMs = GATE_R2_RUNNER_EXIT_TIMEOUT_MS,
  pollIntervalMs = GATE_R2_RUNNER_POLL_INTERVAL_MS,
  createFileAdapter = createGateR2CoordinatorFileAdapter,
  createProcessAdapter = createGateR2CoordinatorProcessAdapter,
  coordinator = runGateR2RetirementCoordinator,
  sessionScriptSha256 = resolveSessionScriptSha256
} = {}) {
  const { pid, sessionDirectory } = parseGateR2RetirementRunnerArgs(argv);
  assertNoAmbientTokens(environment);
  if (platform !== 'win32') fail(RUNNER_CODES.PLATFORM_UNSUPPORTED);
  if (typeof inspectProcess !== 'function'
      || typeof isDirectoryAbsent !== 'function'
      || typeof sleep !== 'function'
      || typeof now !== 'function'
      || typeof createFileAdapter !== 'function'
      || typeof createProcessAdapter !== 'function'
      || typeof coordinator !== 'function'
      || typeof sessionScriptSha256 !== 'function'
      || !Number.isInteger(exitTimeoutMs) || exitTimeoutMs < 1 || exitTimeoutMs > 120_000
      || !Number.isInteger(pollIntervalMs) || pollIntervalMs < 1 || pollIntervalMs > 1_000) {
    fail(RUNNER_CODES.ARGUMENT_INVALID);
  }

  let rawFileAdapter;
  let ready;
  let expectedSessionScriptSha256;
  try {
    expectedSessionScriptSha256 = sessionScriptSha256();
    if (typeof expectedSessionScriptSha256 !== 'string'
        || !/^[0-9A-F]{64}$/u.test(expectedSessionScriptSha256)) {
      fail(RUNNER_CODES.SESSION_PROCESS_INVALID);
    }
    rawFileAdapter = createFileAdapter({ sessionDirectory });
    ready = rawFileAdapter.readReady();
    assertReadyBinding(ready, pid, expectedSessionScriptSha256, undefined);
  } catch (error) {
    if (safeCode(error) === RUNNER_CODES.SESSION_PROCESS_INVALID) throw error;
    fail(RUNNER_CODES.ARGUMENT_INVALID);
  }
  let initial;
  try { initial = await inspectProcess({ pid }); } catch { fail(RUNNER_CODES.SESSION_PROCESS_INVALID); }
  assertInspection(initial, pid, true);
  if (initial.identity !== ready.sessionProcessIdentity) {
    fail(RUNNER_CODES.SESSION_PROCESS_INVALID);
  }
  const initialIdentity = initial.identity;
  const fileAdapter = bindFileAdapterToSession(
    rawFileAdapter,
    pid,
    expectedSessionScriptSha256,
    initialIdentity
  );

  let sessionExitFailureCode = null;
  const failSessionExit = code => {
    sessionExitFailureCode = code;
    fail(code);
  };
  const waitForSessionExit = async () => {
    let startedAt;
    try { startedAt = now(); } catch { failSessionExit(RUNNER_CODES.SESSION_PROCESS_INVALID); }
    if (!Number.isFinite(startedAt)) failSessionExit(RUNNER_CODES.SESSION_PROCESS_INVALID);
    while (true) {
      let current;
      try { current = await inspectProcess({ pid }); } catch {
        failSessionExit(RUNNER_CODES.SESSION_PROCESS_INVALID);
      }
      if (isPlainObject(current) && current.alive === false) {
        try { assertInspection(current, pid, false); } catch {
          failSessionExit(RUNNER_CODES.SESSION_PROCESS_INVALID);
        }
        let absent;
        try { absent = isDirectoryAbsent(sessionDirectory); } catch {
          failSessionExit(RUNNER_CODES.SESSION_CLEANUP_REQUIRED);
        }
        if (absent !== true) failSessionExit(RUNNER_CODES.SESSION_CLEANUP_REQUIRED);
        return 0;
      }
      try { assertInspection(current, pid, true); } catch {
        failSessionExit(RUNNER_CODES.SESSION_PROCESS_INVALID);
      }
      if (current.identity !== initialIdentity) failSessionExit(RUNNER_CODES.PID_REUSED);
      let observedAt;
      try { observedAt = now(); } catch { failSessionExit(RUNNER_CODES.SESSION_PROCESS_INVALID); }
      if (!Number.isFinite(observedAt) || observedAt < startedAt) {
        failSessionExit(RUNNER_CODES.SESSION_PROCESS_INVALID);
      }
      if (observedAt - startedAt >= exitTimeoutMs) {
        failSessionExit(RUNNER_CODES.SESSION_EXIT_TIMEOUT);
      }
      try { await sleep(pollIntervalMs); } catch {
        failSessionExit(RUNNER_CODES.SESSION_PROCESS_INVALID);
      }
    }
  };

  let processAdapter;
  try { processAdapter = createProcessAdapter({ waitForSessionExit }); } catch {
    fail(RUNNER_CODES.COORDINATOR_FAILED);
  }
  let result;
  try {
    result = await coordinator({ environment: {}, fileAdapter, processAdapter });
  } catch {
    if (sessionExitFailureCode !== null) fail(sessionExitFailureCode);
    fail(RUNNER_CODES.COORDINATOR_FAILED);
  }
  return assertCoordinatorResult(result);
}

export async function runGateR2RetirementRunnerCli({
  argv = process.argv.slice(2),
  stdout = process.stdout,
  stderr = process.stderr,
  ...dependencies
} = {}) {
  try {
    const result = await runGateR2RetirementRunner({ argv, ...dependencies });
    stdout.write(`${JSON.stringify(result)}\n`);
    return 0;
  } catch (error) {
    stderr.write(`${safeCode(error)}\n`);
    return 1;
  }
}

const isMain = process.argv[1]
  && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  process.exitCode = await runGateR2RetirementRunnerCli();
}
