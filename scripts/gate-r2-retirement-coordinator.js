#!/usr/bin/env node
/**
 * Purpose: Coordinate the fixed fourteen-request Gate R2 retirement protocol.
 * Safety: This module is token-blind, accepts no Railway target, performs no
 * network access itself, and requires injected session-exit ownership.
 */

import { randomBytes } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import {
  GATE_R2_REFERENCE_CATEGORIES,
  GATE_R2_VALIDATOR_PROFILES
} from './gate-r2-validator-reference-projector.js';
import {
  GATE_R2_ACTIVE_REPLACEMENTS,
  GATE_R2_ENVIRONMENT_ID,
  GATE_R2_INACTIVE_CONSUMERS,
  GATE_R2_PRIVATE_NETWORK_ID,
  GATE_R2_PROJECT_ID,
  GATE_R2_RETIREMENT_ORDER,
  GATE_R2_RETIREMENT_TARGETS
} from './gate-r2-retirement-state-projector.js';
import {
  GATE_R2_VALIDATOR_TARGETS,
  runGateR2ValidatorCutover
} from './gate-r2-validator-cutover.js';
import {
  runGateR2ServiceInstanceRetirement
} from './gate-r2-service-instance-retirement.js';
import {
  GATE_R2_VOLUME_DISPOSITION_TARGETS,
  runGateR2VolumeDisposition
} from './gate-r2-volume-disposition.js';

export const GATE_R2_COORDINATOR_PROTOCOL_VERSION = 1;
export const GATE_R2_COORDINATOR_MAXIMUM_REQUESTS = 14;
export const GATE_R2_COORDINATOR_TOKEN_ENV = 'ARCANOS_GATE_R2_RAILWAY_PROJECT_TOKEN';
export const GATE_R2_COORDINATOR_RESPONSE_LIMIT_BYTES = 128 * 1024;
export const GATE_R2_COORDINATOR_RESPONSE_TIMEOUT_MS = 30_000;

const COORDINATOR_CODES = Object.freeze({
  ABORT_FAILED: 'GATE_R2_COORDINATOR_ABORT_FAILED',
  AMBIENT_TOKEN_FORBIDDEN: 'GATE_R2_COORDINATOR_AMBIENT_TOKEN_FORBIDDEN',
  ARGUMENT_INVALID: 'GATE_R2_COORDINATOR_ARGUMENT_INVALID',
  FILE_IO_FAILED: 'GATE_R2_COORDINATOR_FILE_IO_FAILED',
  MUTATION_FAILED: 'GATE_R2_COORDINATOR_MUTATION_FAILED',
  MUTATION_RESULT_INVALID: 'GATE_R2_COORDINATOR_MUTATION_RESULT_INVALID',
  POSTCONDITION_FAILED: 'GATE_R2_COORDINATOR_POSTCONDITION_FAILED',
  READY_INVALID: 'GATE_R2_COORDINATOR_READY_INVALID',
  RESPONSE_INVALID: 'GATE_R2_COORDINATOR_RESPONSE_INVALID',
  SESSION_DIRECTORY_INVALID: 'GATE_R2_COORDINATOR_SESSION_DIRECTORY_INVALID',
  SESSION_EXIT_INVALID: 'GATE_R2_COORDINATOR_SESSION_EXIT_INVALID',
  SESSION_EXIT_WAITER_REQUIRED: 'GATE_R2_COORDINATOR_SESSION_EXIT_WAITER_REQUIRED',
  STOP_FAILED: 'GATE_R2_COORDINATOR_STOP_FAILED'
});
const SAFE_COORDINATOR_CODES = new Set(Object.values(COORDINATOR_CODES));

const BASELINE_REFERENCE_CATEGORIES = new Set([
  GATE_R2_REFERENCE_CATEGORIES.ORIGINAL_POSTGRES,
  GATE_R2_REFERENCE_CATEGORIES.FAILED_POSTGRES_R2,
  GATE_R2_REFERENCE_CATEGORIES.POSTGRES_R3
]);
const RETIRED_SERVICE_STATES = new Set(['ABSENT', 'TOMBSTONED']);
const RETIRED_VOLUME_STATES = new Set(['RETAINED_ATTACHED', 'RETAINED_DETACHED', 'ABSENT']);
const VALIDATOR_REQUEST_PROFILE = Object.freeze({
  'migration-validator': 'migration',
  'compatibility-validator': 'compatibility'
});
const VALIDATOR_AMBIGUOUS_CODE = 'GATE_R2_VALIDATOR_CUTOVER_MUTATION_AMBIGUOUS';
const RETIREMENT_AMBIGUOUS_CODE = 'GATE_R2_RETIREMENT_MUTATION_AMBIGUOUS';
const VOLUME_AMBIGUOUS_CODE = 'GATE_R2_VOLUME_DISPOSITION_MUTATION_AMBIGUOUS';

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

function safeErrorCode(error) {
  const message = error && typeof error === 'object' ? ownDataValue(error, 'message') : undefined;
  return typeof message === 'string' && SAFE_COORDINATOR_CODES.has(message)
    ? message
    : COORDINATOR_CODES.POSTCONDITION_FAILED;
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

function isoTimestamp(value) {
  return typeof value === 'string'
    && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value)
    && !Number.isNaN(Date.parse(value))
    && new Date(value).toISOString() === value;
}

function assertSessionDirectoryPath(sessionDirectory, temporaryRoot = tmpdir()) {
  if (typeof sessionDirectory !== 'string' || typeof temporaryRoot !== 'string') {
    fail(COORDINATOR_CODES.SESSION_DIRECTORY_INVALID);
  }
  const resolvedDirectory = resolve(sessionDirectory);
  const resolvedRoot = resolve(temporaryRoot);
  if (dirname(resolvedDirectory) !== resolvedRoot
      || !/^arcanos-gate-r2-projector-[0-9a-f]{32}$/u.test(basename(resolvedDirectory))) {
    fail(COORDINATOR_CODES.SESSION_DIRECTORY_INVALID);
  }
  let stat;
  try {
    stat = lstatSync(resolvedDirectory);
    if (!stat.isDirectory() || stat.isSymbolicLink()
        || realpathSync(resolvedDirectory) !== join(realpathSync(resolvedRoot), basename(resolvedDirectory))) {
      fail(COORDINATOR_CODES.SESSION_DIRECTORY_INVALID);
    }
  } catch (error) {
    if (safeErrorCode(error) === COORDINATOR_CODES.SESSION_DIRECTORY_INVALID) throw error;
    fail(COORDINATOR_CODES.SESSION_DIRECTORY_INVALID);
  }
  return resolvedDirectory;
}

function parseBoundedJson(path, limitBytes) {
  let bytes;
  try {
    bytes = readFileSync(path);
  } catch {
    fail(COORDINATOR_CODES.FILE_IO_FAILED);
  }
  if (!Buffer.isBuffer(bytes) || bytes.length === 0 || bytes.length > limitBytes) {
    fail(COORDINATOR_CODES.RESPONSE_INVALID);
  }
  let text;
  let parsed;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    parsed = JSON.parse(text);
  } catch {
    fail(COORDINATOR_CODES.RESPONSE_INVALID);
  } finally {
    bytes.fill(0);
  }
  if (!isPlainObject(parsed)) fail(COORDINATOR_CODES.RESPONSE_INVALID);
  return parsed;
}

function atomicWriteJson(path, value) {
  const temporaryPath = `${path}.tmp-${randomBytes(16).toString('hex')}`;
  let serialized;
  try {
    if (existsSync(path)) fail(COORDINATOR_CODES.FILE_IO_FAILED);
    serialized = `${JSON.stringify(value)}\n`;
    writeFileSync(temporaryPath, serialized, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    renameSync(temporaryPath, path);
  } catch (error) {
    try { rmSync(temporaryPath, { force: true }); } catch { /* best-effort local cleanup */ }
    if (safeErrorCode(error) === COORDINATOR_CODES.FILE_IO_FAILED) throw error;
    fail(COORDINATOR_CODES.FILE_IO_FAILED);
  } finally {
    serialized = null;
  }
}

async function waitForJson(path, {
  timeoutMs = GATE_R2_COORDINATOR_RESPONSE_TIMEOUT_MS,
  intervalMs = 25,
  sleep = (milliseconds) => new Promise(resolveSleep => setTimeout(resolveSleep, milliseconds))
} = {}) {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000
      || !Number.isInteger(intervalMs) || intervalMs < 1 || intervalMs > 1_000
      || typeof sleep !== 'function') fail(COORDINATOR_CODES.ARGUMENT_INVALID);
  const deadline = Date.now() + timeoutMs;
  while (!existsSync(path)) {
    if (Date.now() >= deadline) fail(COORDINATOR_CODES.FILE_IO_FAILED);
    try { await sleep(intervalMs); } catch { fail(COORDINATOR_CODES.FILE_IO_FAILED); }
  }
  return parseBoundedJson(path, GATE_R2_COORDINATOR_RESPONSE_LIMIT_BYTES);
}

export function createGateR2CoordinatorFileAdapter({
  sessionDirectory,
  temporaryRoot = tmpdir(),
  timeoutMs = GATE_R2_COORDINATOR_RESPONSE_TIMEOUT_MS,
  sleep
} = {}) {
  const directory = assertSessionDirectoryPath(sessionDirectory, temporaryRoot);
  return Object.freeze({
    readReady() {
      return parseBoundedJson(join(directory, 'ready.json'), 16 * 1024);
    },
    writeRequest(sequence, value) {
      atomicWriteJson(join(directory, `request-${String(sequence).padStart(4, '0')}.json`), value);
    },
    waitForResponse(sequence) {
      return waitForJson(
        join(directory, `response-${String(sequence).padStart(4, '0')}.json`),
        { timeoutMs, ...(sleep ? { sleep } : {}) }
      );
    },
    writeAcknowledgement(value) {
      atomicWriteJson(join(directory, 'acknowledge.json'), value);
    }
  });
}

export function createGateR2CoordinatorProcessAdapter({ waitForSessionExit } = {}) {
  if (typeof waitForSessionExit !== 'function') {
    fail(COORDINATOR_CODES.SESSION_EXIT_WAITER_REQUIRED);
  }
  return Object.freeze({
    disposeVolume: profile => runGateR2VolumeDisposition({ profile }),
    retireService: profile => runGateR2ServiceInstanceRetirement({ profile }),
    validatorCutover: profile => runGateR2ValidatorCutover({ profile }),
    waitForSessionExit
  });
}

function assertAdapter(fileAdapter, processAdapter) {
  if (!isPlainObject(fileAdapter)
      || !['readReady', 'writeRequest', 'waitForResponse', 'writeAcknowledgement']
        .every(name => typeof fileAdapter[name] === 'function')) {
    fail(COORDINATOR_CODES.ARGUMENT_INVALID);
  }
  if (!isPlainObject(processAdapter)
      || !['disposeVolume', 'retireService', 'validatorCutover']
        .every(name => typeof processAdapter[name] === 'function')) {
    fail(COORDINATOR_CODES.ARGUMENT_INVALID);
  }
  if (typeof processAdapter.waitForSessionExit !== 'function') {
    fail(COORDINATOR_CODES.SESSION_EXIT_WAITER_REQUIRED);
  }
}

function assertReady(value) {
  if (!exactKeys(value, [
    'protocolVersion', 'status', 'projectId', 'environmentId',
    'maximumRequests', 'createdAt', 'sessionProcessId',
    'sessionProcessIdentity', 'sessionScriptSha256'
  ])
      || value.protocolVersion !== GATE_R2_COORDINATOR_PROTOCOL_VERSION
      || value.status !== 'ready'
      || value.projectId !== GATE_R2_PROJECT_ID
      || value.environmentId !== GATE_R2_ENVIRONMENT_ID
      || value.maximumRequests !== GATE_R2_COORDINATOR_MAXIMUM_REQUESTS
      || !Number.isInteger(value.sessionProcessId)
      || value.sessionProcessId < 1
      || value.sessionProcessId > 0xffff_ffff
      || typeof value.sessionProcessIdentity !== 'string'
      || !/^[1-9][0-9]{0,19}$/u.test(value.sessionProcessIdentity)
      || typeof value.sessionScriptSha256 !== 'string'
      || !/^[0-9A-F]{64}$/u.test(value.sessionScriptSha256)
      || !isoTimestamp(value.createdAt)) {
    fail(COORDINATOR_CODES.READY_INVALID);
  }
}

function assertOkEnvelope(value, sequence) {
  if (!exactKeys(value, ['protocolVersion', 'sequence', 'status', 'result'])
      || value.protocolVersion !== GATE_R2_COORDINATOR_PROTOCOL_VERSION
      || value.sequence !== sequence
      || value.status !== 'ok'
      || !isPlainObject(value.result)) {
    fail(COORDINATOR_CODES.RESPONSE_INVALID);
  }
  return value.result;
}

function assertValidatorProjection(value, profile, expectedCategory) {
  const target = GATE_R2_VALIDATOR_PROFILES[profile];
  if (!target
      || !exactKeys(value, [
        'projectId', 'environmentId', 'validatorProfile', 'serviceId',
        'serviceName', 'serviceInstanceId', 'observedAt',
        'activeDeploymentCount', 'variableCount', 'referenceCategory'
      ])
      || value.projectId !== GATE_R2_PROJECT_ID
      || value.environmentId !== GATE_R2_ENVIRONMENT_ID
      || value.validatorProfile !== profile
      || value.serviceId !== target.serviceId
      || value.serviceName !== target.serviceName
      || value.serviceInstanceId !== target.serviceInstanceId
      || !isoTimestamp(value.observedAt)
      || value.activeDeploymentCount !== 0
      || !Number.isInteger(value.variableCount)
      || value.variableCount < 0
      || value.variableCount > 1) {
    fail(COORDINATOR_CODES.POSTCONDITION_FAILED);
  }
  if (expectedCategory === 'BASELINE') {
    if (!BASELINE_REFERENCE_CATEGORIES.has(value.referenceCategory) || value.variableCount !== 1) {
      fail(COORDINATOR_CODES.POSTCONDITION_FAILED);
    }
  } else if (expectedCategory === GATE_R2_REFERENCE_CATEGORIES.POSTGRES_R3) {
    if (value.referenceCategory !== GATE_R2_REFERENCE_CATEGORIES.POSTGRES_R3
        || value.variableCount !== 1) fail(COORDINATOR_CODES.POSTCONDITION_FAILED);
  } else {
    fail(COORDINATOR_CODES.ARGUMENT_INVALID);
  }
}

function assertVolume(value, expected, profile, permittedStates) {
  if (!exactKeys(value, ['profile', 'volumeId', 'volumeInstanceId', 'volumeState'])
      || value.profile !== profile
      || value.volumeId !== expected.volumeId
      || value.volumeInstanceId !== expected.volumeInstanceId
      || !permittedStates.has(value.volumeState)) {
    fail(COORDINATOR_CODES.POSTCONDITION_FAILED);
  }
}

function assertTargetEntry(entry, profile, retired, permittedVolumeStates) {
  const expected = GATE_R2_RETIREMENT_TARGETS[profile];
  if (!exactKeys(entry, [
    'profile', 'serviceId', 'serviceInstanceId', 'serviceState',
    'restartPolicyType', 'restartPolicyMaxRetries', 'sourceImage',
    'latestDeployment', 'activeDeployments',
    'activeDeploymentCount', 'railwayDomainCount', 'customDomainCount',
    'latestDeploymentPresent', 'variableNameCount', 'publicUrlVariableCount',
    'variableNameState', 'tcpProxyCount', 'volume'
  ])
      || entry.profile !== profile
      || entry.serviceId !== expected.serviceId
      || entry.serviceInstanceId !== expected.serviceInstanceId
      || entry.latestDeployment !== null
      || !Array.isArray(entry.activeDeployments)
      || entry.activeDeployments.length !== 0
      || entry.activeDeploymentCount !== 0
      || entry.latestDeploymentPresent !== false
      || entry.railwayDomainCount !== 0
      || entry.customDomainCount !== 0
      || entry.tcpProxyCount !== 0
      || !Number.isInteger(entry.variableNameCount)
      || entry.variableNameCount < 0
      || !Number.isInteger(entry.publicUrlVariableCount)
      || entry.publicUrlVariableCount < 0
      || entry.publicUrlVariableCount > entry.variableNameCount
      || entry.variableNameState !== 'OBSERVED'
      || (retired && (entry.variableNameCount !== 0 || entry.publicUrlVariableCount !== 0))
      || (retired ? !RETIRED_SERVICE_STATES.has(entry.serviceState) : entry.serviceState !== 'PRESENT')) {
    fail(COORDINATOR_CODES.POSTCONDITION_FAILED);
  }
  assertVolume(entry.volume, expected, profile, permittedVolumeStates);
}

function assertDeployment(value, expectedId) {
  return exactKeys(value, ['id', 'status'])
    && value.id === expectedId
    && value.status === 'SUCCESS';
}

function assertReplacementEntry(entry, profile) {
  const expected = GATE_R2_ACTIVE_REPLACEMENTS[profile];
  if (!exactKeys(entry, [
    'profile', 'serviceId', 'serviceInstanceId', 'serviceState',
    'restartPolicyType', 'restartPolicyMaxRetries', 'sourceImage',
    'latestDeployment', 'activeDeployments',
    'activeDeploymentCount', 'railwayDomainCount', 'customDomainCount',
    'sourceState', 'deploymentState', 'restartPolicyState',
    'variableNameCount', 'publicUrlVariableCount', 'variableNameState',
    'privateEndpointState', 'tcpProxyCount', 'volume'
  ])
      || entry.profile !== profile
      || entry.serviceId !== expected.serviceId
      || entry.serviceInstanceId !== expected.serviceInstanceId
      || entry.serviceState !== 'PRESENT'
      || entry.restartPolicyType !== 'ON_FAILURE'
      || entry.restartPolicyMaxRetries !== 3
      || entry.sourceImage !== expected.image
      || !assertDeployment(entry.latestDeployment, expected.deploymentId)
      || !Array.isArray(entry.activeDeployments)
      || entry.activeDeployments.length !== 1
      || !assertDeployment(entry.activeDeployments[0], expected.deploymentId)
      || entry.activeDeploymentCount !== 1
      || entry.railwayDomainCount !== 0
      || entry.customDomainCount !== 0
      || entry.sourceState !== 'MATCH'
      || entry.deploymentState !== 'HEALTHY'
      || entry.restartPolicyState !== 'MATCH'
      || entry.variableNameCount !== expected.variableNames.length
      || entry.publicUrlVariableCount !== 0
      || entry.variableNameState !== 'MATCH'
      || entry.privateEndpointState !== 'ACTIVE'
      || entry.tcpProxyCount !== 0) {
    fail(COORDINATOR_CODES.POSTCONDITION_FAILED);
  }
  assertVolume(entry.volume, expected, profile, new Set(['RETAINED_ATTACHED']));
}

function assertConsumerEntry(entry, profile) {
  const expected = GATE_R2_INACTIVE_CONSUMERS[profile];
  const isValidator = expected.requiredPresent === true;
  if (!exactKeys(entry, [
    'profile', 'serviceId', 'serviceInstanceId', 'serviceState',
    'activeDeploymentCount', 'latestDeploymentPresent',
    'railwayDomainCount', 'customDomainCount', 'tcpProxyCount', 'variableNameCount',
    'publicUrlVariableCount', 'variableNameState', 'referenceCategory'
  ])
      || entry.profile !== profile
      || entry.serviceId !== expected.serviceId
      || entry.serviceInstanceId !== expected.serviceInstanceId
      || entry.serviceState !== (isValidator ? 'PRESENT' : 'ABSENT')
      || entry.activeDeploymentCount !== 0
      || entry.latestDeploymentPresent !== false
      || entry.railwayDomainCount !== 0
      || entry.customDomainCount !== 0
      || entry.tcpProxyCount !== 0
      || entry.publicUrlVariableCount !== 0
      || entry.variableNameCount !== (isValidator ? 1 : 0)
      || entry.variableNameState !== (isValidator ? 'MATCH' : 'OBSERVED')
      || entry.referenceCategory !== (isValidator ? 'POSTGRES_R3' : 'NOT_APPLICABLE')) {
    fail(COORDINATOR_CODES.POSTCONDITION_FAILED);
  }
}

function assertRetirementProjection(value, { phase, profile = null, requiredAbsentVolumes = [] }) {
  if (!exactKeys(value, [
    'schemaVersion', 'observedAt', 'projectId', 'environmentId',
    'privateNetworkId', 'phase', 'retiredProfile', 'disposedProfile',
    'status', 'reasonCodes', 'sharedVariableCount', 'targets',
    'replacements', 'consumers'
  ])
      || value.schemaVersion !== 2
      || !isoTimestamp(value.observedAt)
      || value.projectId !== GATE_R2_PROJECT_ID
      || value.environmentId !== GATE_R2_ENVIRONMENT_ID
      || value.privateNetworkId !== GATE_R2_PRIVATE_NETWORK_ID
      || value.phase !== phase
      || value.retiredProfile !== (phase === 'post' ? profile : null)
      || value.disposedProfile !== (phase === 'final' ? profile : null)
      || value.status !== 'PASS'
      || !Array.isArray(value.reasonCodes)
      || value.reasonCodes.length !== 0
      || value.sharedVariableCount !== 0
      || !Array.isArray(value.targets)
      || value.targets.length !== GATE_R2_RETIREMENT_ORDER.length
      || !Array.isArray(value.replacements)
      || value.replacements.length !== Object.keys(GATE_R2_ACTIVE_REPLACEMENTS).length
      || !Array.isArray(value.consumers)
      || value.consumers.length !== Object.keys(GATE_R2_INACTIVE_CONSUMERS).length) {
    fail(COORDINATOR_CODES.POSTCONDITION_FAILED);
  }
  const retiredThrough = phase === 'post'
    ? GATE_R2_RETIREMENT_ORDER.indexOf(profile)
    : phase === 'final'
      ? GATE_R2_RETIREMENT_ORDER.length - 1
      : -1;
  const disposedThrough = phase === 'final' ? GATE_R2_RETIREMENT_ORDER.indexOf(profile) : -1;
  if ((phase === 'pre' && profile !== null)
      || (phase === 'post' && retiredThrough < 0)
      || (phase === 'final' && disposedThrough < 0)
      || !['pre', 'post', 'final'].includes(phase)
      || !requiredAbsentVolumes.every(item => GATE_R2_RETIREMENT_ORDER.includes(item))) {
    fail(COORDINATOR_CODES.ARGUMENT_INVALID);
  }
  const absent = new Set(requiredAbsentVolumes);
  for (const [index, targetProfile] of GATE_R2_RETIREMENT_ORDER.entries()) {
    const retired = index <= retiredThrough;
    let permittedVolumeStates;
    if (absent.has(targetProfile) || (phase === 'final' && index <= disposedThrough)) {
      permittedVolumeStates = new Set(['ABSENT']);
    } else if (phase === 'final') {
      permittedVolumeStates = new Set(['ABSENT', 'RETAINED_DETACHED']);
    } else {
      permittedVolumeStates = retired ? RETIRED_VOLUME_STATES : new Set(['RETAINED_ATTACHED']);
    }
    assertTargetEntry(value.targets[index], targetProfile, retired, permittedVolumeStates);
  }
  for (const [index, replacementProfile] of Object.keys(GATE_R2_ACTIVE_REPLACEMENTS).entries()) {
    assertReplacementEntry(value.replacements[index], replacementProfile);
  }
  for (const [index, consumerProfile] of Object.keys(GATE_R2_INACTIVE_CONSUMERS).entries()) {
    assertConsumerEntry(value.consumers[index], consumerProfile);
  }
  return value;
}

function assertValidatorMutationResult(value, profile) {
  const target = GATE_R2_VALIDATOR_TARGETS[profile];
  if (!target
      || !exactKeys(value, [
        'code', 'environmentId', 'profile', 'projectId', 'projectionRequired',
        'retryAuthorized', 'serviceId', 'status'
      ])
      || value.code !== 'GATE_R2_VALIDATOR_CUTOVER_ACCEPTED_PENDING_PROJECTION'
      || value.environmentId !== GATE_R2_ENVIRONMENT_ID
      || value.profile !== profile
      || value.projectId !== GATE_R2_PROJECT_ID
      || value.projectionRequired !== true
      || value.retryAuthorized !== false
      || value.serviceId !== target.serviceId
      || value.status !== 'PENDING_PROJECTION') {
    fail(COORDINATOR_CODES.MUTATION_RESULT_INVALID);
  }
}

function assertRetirementMutationResult(value, profile) {
  const target = GATE_R2_RETIREMENT_TARGETS[profile];
  if (!target
      || !exactKeys(value, [
        'code', 'environmentId', 'profile', 'projectId', 'projectionRequired',
        'retryAuthorized', 'serviceId', 'serviceInstanceId', 'status'
      ])
      || value.code !== 'GATE_R2_RETIREMENT_ACCEPTED_PENDING_PROJECTION'
      || value.environmentId !== GATE_R2_ENVIRONMENT_ID
      || value.profile !== profile
      || value.projectId !== GATE_R2_PROJECT_ID
      || value.projectionRequired !== true
      || value.retryAuthorized !== false
      || value.serviceId !== target.serviceId
      || value.serviceInstanceId !== target.serviceInstanceId
      || value.status !== 'PENDING_PROJECTION') {
    fail(COORDINATOR_CODES.MUTATION_RESULT_INVALID);
  }
}

function assertVolumeMutationResult(value, profile) {
  const target = GATE_R2_VOLUME_DISPOSITION_TARGETS[profile];
  if (!target
      || !exactKeys(value, [
        'code', 'environmentId', 'profile', 'projectId', 'projectionRequired',
        'retryAuthorized', 'status', 'volumeId', 'volumeInstanceId'
      ])
      || value.code !== 'GATE_R2_VOLUME_DISPOSITION_ACCEPTED_PENDING_PROJECTION'
      || value.environmentId !== GATE_R2_ENVIRONMENT_ID
      || value.profile !== profile
      || value.projectId !== GATE_R2_PROJECT_ID
      || value.projectionRequired !== true
      || value.retryAuthorized !== false
      || value.status !== 'PENDING_PROJECTION'
      || value.volumeId !== target.volumeId
      || value.volumeInstanceId !== target.volumeInstanceId) {
    fail(COORDINATOR_CODES.MUTATION_RESULT_INVALID);
  }
}

function targetVolumeState(retirementProjection, profile) {
  const entry = retirementProjection.targets.find(target => target.profile === profile);
  if (!entry || !isPlainObject(entry.volume)) fail(COORDINATOR_CODES.POSTCONDITION_FAILED);
  return entry.volume.volumeState;
}

function ambiguousCode(error) {
  const message = error && typeof error === 'object' ? ownDataValue(error, 'message') : undefined;
  return typeof message === 'string' ? message : null;
}

async function invokeMutationThenProject({
  invoke,
  assertMutationResult,
  expectedAmbiguousCode,
  project,
  assertProjection
}) {
  let mustProject = false;
  let resultInvalid = false;
  try {
    const mutationResult = await invoke();
    mustProject = true;
    try {
      assertMutationResult(mutationResult);
    } catch {
      resultInvalid = true;
    }
  } catch (error) {
    if (ambiguousCode(error) !== expectedAmbiguousCode) {
      fail(COORDINATOR_CODES.MUTATION_FAILED);
    }
    mustProject = true;
  }
  if (!mustProject) fail(COORDINATOR_CODES.MUTATION_FAILED);
  const projection = await project();
  assertProjection(projection);
  if (resultInvalid) fail(COORDINATOR_CODES.MUTATION_RESULT_INVALID);
  return projection;
}

function requestPayload(sequence, fields) {
  return Object.freeze({
    ...fields,
    protocolVersion: GATE_R2_COORDINATOR_PROTOCOL_VERSION,
    sequence
  });
}

function assertStoppedResponse(value, sequence) {
  if (!exactKeys(value, ['protocolVersion', 'sequence', 'status', 'completedLedger'])
      || value.protocolVersion !== GATE_R2_COORDINATOR_PROTOCOL_VERSION
      || value.sequence !== sequence
      || value.status !== 'stopped'
      || value.completedLedger !== (sequence === GATE_R2_COORDINATOR_MAXIMUM_REQUESTS)) {
    fail(COORDINATOR_CODES.STOP_FAILED);
  }
}

async function callFixedAdapter(adapterCall, failureCode) {
  try {
    return await adapterCall();
  } catch (error) {
    if (safeErrorCode(error) === failureCode) throw error;
    fail(failureCode);
  }
}

export async function runGateR2RetirementCoordinator({
  sessionDirectory,
  environment = process.env,
  fileAdapter,
  processAdapter
} = {}) {
  if (!isPlainObject(environment)) fail(COORDINATOR_CODES.ARGUMENT_INVALID);
  if (Object.hasOwn(environment, GATE_R2_COORDINATOR_TOKEN_ENV)) {
    fail(COORDINATOR_CODES.AMBIENT_TOKEN_FORBIDDEN);
  }
  let selectedFileAdapter = fileAdapter;
  if (selectedFileAdapter === undefined) {
    selectedFileAdapter = createGateR2CoordinatorFileAdapter({ sessionDirectory });
  } else if (sessionDirectory !== undefined) {
    fail(COORDINATOR_CODES.ARGUMENT_INVALID);
  }
  assertAdapter(selectedFileAdapter, processAdapter);

  let nextSequence = 1;
  let protocolActive = false;
  let stopAttempted = false;
  let stopped = false;
  let volumeDispositionCount = 0;

  const exchange = async fields => {
    if (nextSequence >= GATE_R2_COORDINATOR_MAXIMUM_REQUESTS) {
      fail(COORDINATOR_CODES.RESPONSE_INVALID);
    }
    const sequence = nextSequence;
    const request = requestPayload(sequence, fields);
    await callFixedAdapter(
      () => selectedFileAdapter.writeRequest(sequence, request),
      COORDINATOR_CODES.FILE_IO_FAILED
    );
    nextSequence += 1;
    const response = await callFixedAdapter(
      () => selectedFileAdapter.waitForResponse(sequence),
      COORDINATOR_CODES.FILE_IO_FAILED
    );
    return assertOkEnvelope(response, sequence);
  };

  const stopAndAcknowledge = async () => {
    if (stopAttempted) fail(COORDINATOR_CODES.STOP_FAILED);
    stopAttempted = true;
    const sequence = nextSequence;
    if (sequence < 1 || sequence > GATE_R2_COORDINATOR_MAXIMUM_REQUESTS) {
      fail(COORDINATOR_CODES.STOP_FAILED);
    }
    let stopFailure = false;
    let requestWritten = false;
    try {
      await selectedFileAdapter.writeRequest(sequence, requestPayload(sequence, { operation: 'stop' }));
      requestWritten = true;
      nextSequence += 1;
    } catch {
      stopFailure = true;
    }
    if (requestWritten) {
      try {
        assertStoppedResponse(await selectedFileAdapter.waitForResponse(sequence), sequence);
      } catch {
        stopFailure = true;
      }
      try {
        await selectedFileAdapter.writeAcknowledgement({
          consumedThroughSequence: sequence,
          protocolVersion: GATE_R2_COORDINATOR_PROTOCOL_VERSION,
          sequence,
          status: 'consumed'
        });
      } catch {
        stopFailure = true;
      }
    }
    let exitCode;
    try {
      exitCode = await processAdapter.waitForSessionExit();
    } catch {
      stopFailure = true;
    }
    if (exitCode !== 0) stopFailure = true;
    if (stopFailure) fail(COORDINATOR_CODES.STOP_FAILED);
    stopped = true;
  };

  try {
    const ready = await callFixedAdapter(
      () => selectedFileAdapter.readReady(),
      COORDINATOR_CODES.FILE_IO_FAILED
    );
    assertReady(ready);
    protocolActive = true;

    const migrationBaseline = await exchange({ operation: 'validatorReference', profile: 'migration' });
    assertValidatorProjection(migrationBaseline, 'migration-validator', 'BASELINE');

    const compatibilityBaseline = await exchange({ operation: 'validatorReference', profile: 'compatibility' });
    assertValidatorProjection(compatibilityBaseline, 'compatibility-validator', 'BASELINE');

    await invokeMutationThenProject({
      invoke: () => processAdapter.validatorCutover('migration-validator'),
      assertMutationResult: value => assertValidatorMutationResult(value, 'migration-validator'),
      expectedAmbiguousCode: VALIDATOR_AMBIGUOUS_CODE,
      project: () => exchange({ operation: 'validatorReference', profile: 'migration' }),
      assertProjection: value => assertValidatorProjection(
        value,
        'migration-validator',
        GATE_R2_REFERENCE_CATEGORIES.POSTGRES_R3
      )
    });

    await invokeMutationThenProject({
      invoke: () => processAdapter.validatorCutover('compatibility-validator'),
      assertMutationResult: value => assertValidatorMutationResult(value, 'compatibility-validator'),
      expectedAmbiguousCode: VALIDATOR_AMBIGUOUS_CODE,
      project: () => exchange({ operation: 'validatorReference', profile: 'compatibility' }),
      assertProjection: value => assertValidatorProjection(
        value,
        'compatibility-validator',
        GATE_R2_REFERENCE_CATEGORIES.POSTGRES_R3
      )
    });

    assertValidatorProjection(
      await exchange({ operation: 'validatorReference', profile: 'migration' }),
      'migration-validator',
      GATE_R2_REFERENCE_CATEGORIES.POSTGRES_R3
    );
    assertValidatorProjection(
      await exchange({ operation: 'validatorReference', profile: 'compatibility' }),
      'compatibility-validator',
      GATE_R2_REFERENCE_CATEGORIES.POSTGRES_R3
    );

    assertRetirementProjection(
      await exchange({ operation: 'retirementState', phase: 'pre' }),
      { phase: 'pre' }
    );

    let retirementState = await invokeMutationThenProject({
      invoke: () => processAdapter.retireService('original-postgres'),
      assertMutationResult: value => assertRetirementMutationResult(value, 'original-postgres'),
      expectedAmbiguousCode: RETIREMENT_AMBIGUOUS_CODE,
      project: () => exchange({
        operation: 'retirementState', phase: 'post', profile: 'original-postgres'
      }),
      assertProjection: value => assertRetirementProjection(value, {
        phase: 'post', profile: 'original-postgres'
      })
    });

    retirementState = await invokeMutationThenProject({
      invoke: () => processAdapter.retireService('failed-postgres-r2'),
      assertMutationResult: value => assertRetirementMutationResult(value, 'failed-postgres-r2'),
      expectedAmbiguousCode: RETIREMENT_AMBIGUOUS_CODE,
      project: () => exchange({
        operation: 'retirementState', phase: 'post', profile: 'failed-postgres-r2'
      }),
      assertProjection: value => assertRetirementProjection(value, {
        phase: 'post', profile: 'failed-postgres-r2'
      })
    });

    retirementState = await invokeMutationThenProject({
      invoke: () => processAdapter.retireService('original-redis'),
      assertMutationResult: value => assertRetirementMutationResult(value, 'original-redis'),
      expectedAmbiguousCode: RETIREMENT_AMBIGUOUS_CODE,
      project: () => exchange({
        operation: 'retirementState', phase: 'post', profile: 'original-redis'
      }),
      assertProjection: value => assertRetirementProjection(value, {
        phase: 'post', profile: 'original-redis'
      })
    });

    const absentVolumes = [];
    for (const profile of GATE_R2_RETIREMENT_ORDER) {
      const state = targetVolumeState(retirementState, profile);
      if (state === 'RETAINED_DETACHED') {
        retirementState = await invokeMutationThenProject({
          invoke: () => processAdapter.disposeVolume(profile),
          assertMutationResult: value => assertVolumeMutationResult(value, profile),
          expectedAmbiguousCode: VOLUME_AMBIGUOUS_CODE,
          project: () => exchange({
            operation: 'retirementState', phase: 'final', profile
          }),
          assertProjection: value => assertRetirementProjection(value, {
            phase: 'final',
            profile,
            requiredAbsentVolumes: [...absentVolumes, profile]
          })
        });
        volumeDispositionCount += 1;
      } else if (state === 'ABSENT') {
        retirementState = await exchange({
          operation: 'retirementState', phase: 'final', profile
        });
        assertRetirementProjection(retirementState, {
          phase: 'final',
          profile,
          requiredAbsentVolumes: [...absentVolumes, profile]
        });
      } else {
        fail(COORDINATOR_CODES.POSTCONDITION_FAILED);
      }
      absentVolumes.push(profile);
    }

    assertRetirementProjection(retirementState, {
      phase: 'final',
      profile: 'original-redis',
      requiredAbsentVolumes: [...GATE_R2_RETIREMENT_ORDER]
    });
    if (nextSequence !== GATE_R2_COORDINATOR_MAXIMUM_REQUESTS) {
      fail(COORDINATOR_CODES.POSTCONDITION_FAILED);
    }
    await stopAndAcknowledge();

    return Object.freeze({
      code: 'GATE_R2_COORDINATOR_COMPLETE',
      environmentId: GATE_R2_ENVIRONMENT_ID,
      finalOldVolumeState: 'ABSENT',
      projectId: GATE_R2_PROJECT_ID,
      requestsConsumed: GATE_R2_COORDINATOR_MAXIMUM_REQUESTS,
      serviceRetirementCount: 3,
      sessionExitVerified: true,
      status: 'PASS',
      validatorCutoverCount: 2,
      volumeDispositionCount
    });
  } catch (error) {
    const primaryCode = safeErrorCode(error);
    if (protocolActive && !stopped && !stopAttempted
        && nextSequence <= GATE_R2_COORDINATOR_MAXIMUM_REQUESTS) {
      try {
        await stopAndAcknowledge();
      } catch {
        fail(COORDINATOR_CODES.ABORT_FAILED);
      }
    } else if (protocolActive && !stopped) {
      fail(COORDINATOR_CODES.ABORT_FAILED);
    }
    throw new Error(primaryCode);
  }
}

export async function runGateR2RetirementCoordinatorCli({ stderr = process.stderr } = {}) {
  stderr.write(`${COORDINATOR_CODES.SESSION_EXIT_WAITER_REQUIRED}\n`);
  return 1;
}

const isMain = process.argv[1]
  && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  process.exitCode = await runGateR2RetirementCoordinatorCli();
}
