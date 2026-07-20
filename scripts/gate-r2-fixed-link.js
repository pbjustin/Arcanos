/**
 * Purpose: Verify the exact Gate R2 Railway project and environment before mutation.
 * Safety: Links only a disposable scratch directory with fixed immutable IDs,
 * schema-checks bounded output, wipes child output, and exposes no caller-selected target.
 */

import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { lstatSync, mkdirSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';

export const GATE_R2_FIXED_LINK_PROJECT_ID = '7faf44e5-519c-4e73-8d7a-da9f389e6187';
export const GATE_R2_FIXED_LINK_PROJECT_NAME = 'Arcanos';
export const GATE_R2_FIXED_LINK_ENVIRONMENT_ID = 'fb99f47d-5ef5-44c1-96c2-acf7b90fab13';
export const GATE_R2_FIXED_LINK_ENVIRONMENT_NAME = 'phase2e-validation-20260717';
export const GATE_R2_FIXED_LINK_JSON_MAX_BYTES = 2 * 1024;

function fail(code) {
  throw new Error(code);
}

function readOwnDataValue(value, property) {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, property);
    return descriptor && Object.hasOwn(descriptor, 'value') ? descriptor.value : undefined;
  } catch {
    return undefined;
  }
}

function clearBuffer(value) {
  if (Buffer.isBuffer(value)) value.fill(0);
}

function clearChildDiagnostics(value, seen = new Set()) {
  if (!value || typeof value !== 'object' || seen.has(value)) return;
  seen.add(value);
  clearBuffer(readOwnDataValue(value, 'stdout'));
  clearBuffer(readOwnDataValue(value, 'stderr'));
  const output = readOwnDataValue(value, 'output');
  if (Array.isArray(output)) {
    try {
      for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(output))) {
        if (Object.hasOwn(descriptor, 'value')) clearBuffer(descriptor.value);
      }
    } catch {
      // Diagnostics are best-effort wiped and are never rendered.
    }
  }
  const nestedError = readOwnDataValue(value, 'error');
  if (nestedError && nestedError !== value) clearChildDiagnostics(nestedError, seen);
  const nestedCause = readOwnDataValue(value, 'cause');
  if (nestedCause && nestedCause !== value) clearChildDiagnostics(nestedCause, seen);
}

function decodeBounded(value, maximumBytes, failureCode) {
  if (!Buffer.isBuffer(value) || value.length > maximumBytes) fail(failureCode);
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(value);
  } catch {
    fail(failureCode);
  }
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function assertHumanStatus(child, failureCode) {
  if (child?.error || child?.status !== 0) fail(failureCode);
  const stderr = decodeBounded(child.stderr, 256, failureCode);
  const stdout = decodeBounded(child.stdout, 512, failureCode);
  if (stderr.length !== 0) fail(failureCode);
  const expected = [
    `Project: ${GATE_R2_FIXED_LINK_PROJECT_NAME}`,
    `Environment: ${GATE_R2_FIXED_LINK_ENVIRONMENT_NAME}`,
    'Service: None'
  ];
  const lines = stdout.split(/\r?\n/u).filter(Boolean);
  if (lines.length !== expected.length || lines.some((line, index) => line !== expected[index])) {
    fail(failureCode);
  }
}

function assertJsonLink(child, failureCode) {
  if (child?.error || child?.status !== 0) fail(failureCode);
  const stderr = decodeBounded(child.stderr, 256, failureCode);
  const stdout = decodeBounded(child.stdout, GATE_R2_FIXED_LINK_JSON_MAX_BYTES, failureCode);
  if (stderr.length !== 0) fail(failureCode);

  let parsed;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    fail(failureCode);
  }
  const expectedKeys = ['environmentId', 'environmentName', 'projectId', 'projectName'];
  if (!isPlainObject(parsed)
      || Object.keys(parsed).sort().join('\u0000') !== expectedKeys.sort().join('\u0000')
      || parsed.projectId !== GATE_R2_FIXED_LINK_PROJECT_ID
      || parsed.projectName !== GATE_R2_FIXED_LINK_PROJECT_NAME
      || parsed.environmentId !== GATE_R2_FIXED_LINK_ENVIRONMENT_ID
      || parsed.environmentName !== GATE_R2_FIXED_LINK_ENVIRONMENT_NAME) {
    fail(failureCode);
  }
}

function createScratchDirectory(temporaryRoot) {
  const path = join(temporaryRoot, `arcanos-gate-r-${randomBytes(16).toString('hex')}`);
  mkdirSync(path, { mode: 0o700 });
  return path;
}

function isApprovedScratchDirectory(path, temporaryRoot) {
  if (typeof path !== 'string' || path.length === 0
      || typeof temporaryRoot !== 'string' || temporaryRoot.length === 0) return false;
  const resolvedPath = resolve(path);
  const resolvedRoot = resolve(temporaryRoot);
  return dirname(resolvedPath) === resolvedRoot
    && /^arcanos-gate-r-[0-9a-f]{32}$/u.test(basename(resolvedPath));
}

export function removeGateR2ScratchDirectory({
  path,
  temporaryRoot,
  lstat = lstatSync,
  realpath = realpathSync,
  remove = rmSync
}) {
  if (!isApprovedScratchDirectory(path, temporaryRoot)
      || typeof lstat !== 'function'
      || typeof realpath !== 'function'
      || typeof remove !== 'function') fail('GATE_R2_FIXED_LINK_CLEANUP_INVALID');
  let stat;
  let canonicalRoot;
  let canonicalPath;
  try {
    stat = lstat(path);
    canonicalRoot = realpath(temporaryRoot);
    canonicalPath = realpath(path);
  } catch {
    fail('GATE_R2_FIXED_LINK_CLEANUP_INVALID');
  }
  if (!stat?.isDirectory?.() || stat?.isSymbolicLink?.()
      || canonicalPath !== join(canonicalRoot, basename(path))) {
    fail('GATE_R2_FIXED_LINK_CLEANUP_INVALID');
  }
  try {
    remove(path, { force: true, recursive: true });
  } catch {
    fail('GATE_R2_FIXED_LINK_CLEANUP_INVALID');
  }
}

function removeScratchDirectory(path, temporaryRoot) {
  removeGateR2ScratchDirectory({ path, temporaryRoot });
}

export function assertGateR2FixedLink({
  railwayExecutable,
  childEnvironment,
  failureCode,
  timeoutCode,
  spawn = spawnSync,
  createScratch = createScratchDirectory,
  removeScratch = removeScratchDirectory,
  temporaryRoot = tmpdir(),
  operation = () => undefined
}) {
  if (typeof railwayExecutable !== 'string' || railwayExecutable.length === 0
      || !isPlainObject(childEnvironment)
      || typeof failureCode !== 'string' || !/^GATE_R2_[A-Z0-9_]+$/u.test(failureCode)
      || typeof timeoutCode !== 'string' || !/^GATE_R2_[A-Z0-9_]+$/u.test(timeoutCode)
      || typeof spawn !== 'function'
      || typeof createScratch !== 'function'
      || typeof removeScratch !== 'function'
      || typeof temporaryRoot !== 'string' || temporaryRoot.length === 0
      || typeof operation !== 'function') {
    fail('GATE_R2_FIXED_LINK_ARGUMENT_INVALID');
  }

  let scratchDirectory;
  let humanChild;
  let linkChild;
  let operationInvoked = false;
  let operationResult;
  try {
    scratchDirectory = createScratch(temporaryRoot);
    if (!isApprovedScratchDirectory(scratchDirectory, temporaryRoot)) fail(failureCode);

    linkChild = spawn(railwayExecutable, [
      'link',
      '-p', GATE_R2_FIXED_LINK_PROJECT_ID,
      '-e', GATE_R2_FIXED_LINK_ENVIRONMENT_ID,
      '--json'
    ], {
      cwd: scratchDirectory,
      env: childEnvironment,
      maxBuffer: GATE_R2_FIXED_LINK_JSON_MAX_BYTES,
      shell: false,
      timeout: 30_000,
      windowsHide: true
    });
    if (linkChild?.error?.code === 'ETIMEDOUT') fail(timeoutCode);
    assertJsonLink(linkChild, failureCode);

    humanChild = spawn(railwayExecutable, ['status'], {
      cwd: scratchDirectory,
      env: childEnvironment,
      maxBuffer: 512,
      shell: false,
      timeout: 30_000,
      windowsHide: true
    });
    if (humanChild?.error?.code === 'ETIMEDOUT') fail(timeoutCode);
    assertHumanStatus(humanChild, failureCode);

    operationInvoked = true;
    operationResult = operation(scratchDirectory);
  } catch (error) {
    if (operationInvoked) throw error;
    const message = error && typeof error === 'object'
      ? readOwnDataValue(error, 'message')
      : undefined;
    const errorCode = error && typeof error === 'object'
      ? readOwnDataValue(error, 'code')
      : undefined;
    clearChildDiagnostics(error);
    if (message === timeoutCode || errorCode === 'ETIMEDOUT') fail(timeoutCode);
    fail(failureCode);
  } finally {
    clearChildDiagnostics(linkChild);
    clearChildDiagnostics(humanChild);
    if (typeof scratchDirectory === 'string' && scratchDirectory.length > 0) {
      try { removeScratch(scratchDirectory, temporaryRoot); } catch { fail(failureCode); }
    }
    linkChild = null;
    humanChild = null;
    scratchDirectory = null;
  }
  return operationResult;
}
