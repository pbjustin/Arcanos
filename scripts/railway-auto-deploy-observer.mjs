#!/usr/bin/env node

import { execFile } from 'node:child_process';
import { resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const DEPLOY_REF_PATTERN = /^[0-9a-f]{40}$/u;
const CONTROL_CHARACTER_PATTERN = /\p{Cc}/u;
// The just-enqueued exact ID must be recent; bounding history prevents old
// deployment metadata from exhausting the observer's fixed output budget.
export const DEPLOYMENT_OBSERVATION_LIST_LIMIT = 20;

export const DEPLOYMENT_OBSERVATION_TIMEOUT_MS = 45 * 60_000;
export const DEPLOYMENT_POLL_INTERVAL_MS = 10_000;

export const RAILWAY_COMMAND_LIMITS = Object.freeze({
  enqueue: Object.freeze({
    timeoutMs: 10 * 60_000,
    maxBufferBytes: 64 * 1024,
  }),
  deploymentList: Object.freeze({
    timeoutMs: 30_000,
    maxBufferBytes: 256 * 1024,
  }),
  serviceStatus: Object.freeze({
    timeoutMs: 30_000,
    maxBufferBytes: 64 * 1024,
  }),
  variableList: Object.freeze({
    timeoutMs: 30_000,
    maxBufferBytes: 1024 * 1024,
  }),
});

const PENDING_DEPLOYMENT_STATUSES = new Set([
  'INITIALIZING',
  'QUEUED',
  'BUILDING',
  'DEPLOYING',
  'WAITING',
  'NEEDS_APPROVAL',
]);
const TERMINAL_FAILURE_DEPLOYMENT_STATUSES = new Set([
  'FAILED',
  'CRASHED',
  'REMOVED',
  'REMOVING',
  'SKIPPED',
  'SLEEPING',
]);

function safeError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function requireUuid(value, errorCode) {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
    throw safeError(errorCode);
  }
  return value;
}

function requireEnvironmentName(value) {
  if (
    typeof value !== 'string'
    || value.length === 0
    || CONTROL_CHARACTER_PATTERN.test(value)
  ) {
    throw safeError('RAILWAY_ENVIRONMENT_NAME_INVALID');
  }
  return value;
}

function requireDeployRef(value) {
  if (typeof value !== 'string' || !DEPLOY_REF_PATTERN.test(value)) {
    throw safeError('RAILWAY_DEPLOY_REF_INVALID');
  }
  return value;
}

function validateTarget({ serviceId, environmentName }) {
  return {
    serviceId: requireUuid(serviceId, 'RAILWAY_SERVICE_ID_INVALID'),
    environmentName: requireEnvironmentName(environmentName),
  };
}

/**
 * Run one fixed Railway CLI invocation with a wall timeout and byte cap.
 * Railway stdout and stderr are deliberately omitted from error messages.
 */
export function runBoundedRailwayCommand(
  args,
  limits,
  { execFileImplementation = execFile } = {},
) {
  if (
    !Array.isArray(args)
    || args.some(argument => typeof argument !== 'string')
    || !Number.isSafeInteger(limits?.timeoutMs)
    || limits.timeoutMs <= 0
    || !Number.isSafeInteger(limits?.maxBufferBytes)
    || limits.maxBufferBytes <= 0
  ) {
    return Promise.reject(safeError('RAILWAY_COMMAND_CONFIGURATION_INVALID'));
  }

  return new Promise((resolvePromise, rejectPromise) => {
    const callback = (error, stdout) => {
      if (error) {
        if (error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
          rejectPromise(safeError('RAILWAY_COMMAND_OUTPUT_LIMIT'));
          return;
        }
        if (error.killed === true || error.signal === 'SIGKILL') {
          rejectPromise(safeError('RAILWAY_COMMAND_TIMEOUT'));
          return;
        }
        rejectPromise(safeError('RAILWAY_COMMAND_FAILED'));
        return;
      }

      if (typeof stdout !== 'string') {
        rejectPromise(safeError('RAILWAY_COMMAND_OUTPUT_INVALID'));
        return;
      }
      resolvePromise(stdout);
    };

    try {
      execFileImplementation(
        'railway',
        args,
        {
          encoding: 'utf8',
          killSignal: 'SIGKILL',
          maxBuffer: limits.maxBufferBytes,
          shell: false,
          timeout: limits.timeoutMs,
          windowsHide: true,
        },
        callback,
      );
    } catch {
      rejectPromise(safeError('RAILWAY_COMMAND_START_FAILED'));
    }
  });
}

function parseJsonObject(rawOutput, errorCode) {
  try {
    const parsed = JSON.parse(rawOutput);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw safeError(errorCode);
    }
    return parsed;
  } catch {
    throw safeError(errorCode);
  }
}

/**
 * Classify the exact status vocabulary emitted by Railway CLI 4.30.2.
 */
export function classifyDeploymentStatus(status) {
  if (status === 'SUCCESS') {
    return 'success';
  }
  if (PENDING_DEPLOYMENT_STATUSES.has(status)) {
    return 'pending';
  }
  if (TERMINAL_FAILURE_DEPLOYMENT_STATUSES.has(status)) {
    return 'failure';
  }
  throw safeError('RAILWAY_DEPLOYMENT_STATUS_UNKNOWN');
}

function parseExactDeploymentStatus(rawOutput, deploymentId) {
  let deployments;
  try {
    deployments = JSON.parse(rawOutput);
  } catch {
    throw safeError('RAILWAY_DEPLOYMENT_LIST_INVALID');
  }
  if (!Array.isArray(deployments)) {
    throw safeError('RAILWAY_DEPLOYMENT_LIST_INVALID');
  }

  const matches = deployments.filter(candidate =>
    candidate
    && typeof candidate === 'object'
    && !Array.isArray(candidate)
    && candidate.id === deploymentId,
  );
  if (matches.length === 0) {
    return 'NOT_FOUND';
  }
  if (matches.length !== 1 || typeof matches[0].status !== 'string') {
    throw safeError('RAILWAY_DEPLOYMENT_LIST_INVALID');
  }

  classifyDeploymentStatus(matches[0].status);
  return matches[0].status;
}

/**
 * Queue a detached deployment and return only its validated exact ID.
 */
export async function enqueueDeployment(
  { projectId, serviceId, environmentName, deployRef },
  { runCommand = runBoundedRailwayCommand } = {},
) {
  const validatedProjectId = requireUuid(
    projectId,
    'RAILWAY_PROJECT_ID_INVALID',
  );
  const target = validateTarget({ serviceId, environmentName });
  const validatedDeployRef = requireDeployRef(deployRef);

  const output = await runCommand(
    [
      'up',
      '--ci',
      '--detach',
      '--json',
      '--project',
      validatedProjectId,
      '--environment',
      target.environmentName,
      '--service',
      target.serviceId,
      '--message',
      `GitHub auto deploy ${validatedDeployRef}`,
    ],
    RAILWAY_COMMAND_LIMITS.enqueue,
  );

  const response = parseJsonObject(
    output,
    'RAILWAY_DEPLOYMENT_RESPONSE_INVALID',
  );
  try {
    return requireUuid(
      response.deploymentId,
      'RAILWAY_DEPLOYMENT_RESPONSE_INVALID',
    );
  } catch {
    throw safeError('RAILWAY_DEPLOYMENT_RESPONSE_INVALID');
  }
}

function defaultSleep(delayMs) {
  return new Promise(resolvePromise => {
    setTimeout(resolvePromise, delayMs);
  });
}

function defaultStatusReporter({ attempt, deploymentId, status }) {
  process.stderr.write(
    `attempt=${attempt} deployment_id=${deploymentId} status=${status}\n`,
  );
}

/**
 * Observe one exact deployment against a single elapsed-time budget.
 */
export async function waitForDeploymentSuccess(
  { deploymentId, serviceId, environmentName },
  {
    runCommand = runBoundedRailwayCommand,
    now = () => performance.now(),
    sleep = defaultSleep,
    onStatus = defaultStatusReporter,
  } = {},
) {
  const validatedDeploymentId = requireUuid(
    deploymentId,
    'RAILWAY_DEPLOYMENT_ID_INVALID',
  );
  const target = validateTarget({ serviceId, environmentName });
  let lastObservedTime = null;
  const readTime = () => {
    let currentTime;
    try {
      currentTime = now();
    } catch {
      throw safeError('RAILWAY_OBSERVATION_CLOCK_INVALID');
    }
    if (
      typeof currentTime !== 'number'
      || !Number.isFinite(currentTime)
      || (
        lastObservedTime !== null
        && currentTime < lastObservedTime
      )
    ) {
      throw safeError('RAILWAY_OBSERVATION_CLOCK_INVALID');
    }
    lastObservedTime = currentTime;
    return currentTime;
  };
  const startedAt = readTime();
  const deadline = startedAt + DEPLOYMENT_OBSERVATION_TIMEOUT_MS;
  let attempt = 0;

  for (;;) {
    const remainingBeforePoll = deadline - readTime();
    if (remainingBeforePoll <= 0) {
      throw safeError('RAILWAY_DEPLOYMENT_OBSERVATION_TIMEOUT');
    }

    let output;
    try {
      output = await runCommand(
        [
          'deployment',
          'list',
          '--service',
          target.serviceId,
          '--environment',
          target.environmentName,
          '--limit',
          String(DEPLOYMENT_OBSERVATION_LIST_LIMIT),
          '--json',
        ],
        {
          ...RAILWAY_COMMAND_LIMITS.deploymentList,
          timeoutMs: Math.max(
            1,
            Math.min(
              RAILWAY_COMMAND_LIMITS.deploymentList.timeoutMs,
              Math.floor(remainingBeforePoll),
            ),
          ),
        },
      );
    } catch (error) {
      if (readTime() >= deadline) {
        throw safeError('RAILWAY_DEPLOYMENT_OBSERVATION_TIMEOUT');
      }
      throw error;
    }

    if (readTime() >= deadline) {
      throw safeError('RAILWAY_DEPLOYMENT_OBSERVATION_TIMEOUT');
    }

    attempt += 1;
    const status = parseExactDeploymentStatus(output, validatedDeploymentId);
    onStatus({
      attempt,
      deploymentId: validatedDeploymentId,
      status,
    });

    if (status === 'SUCCESS') {
      return status;
    }
    if (status !== 'NOT_FOUND') {
      const classification = classifyDeploymentStatus(status);
      if (classification === 'failure') {
        throw safeError(`RAILWAY_DEPLOYMENT_TERMINAL_FAILURE:${status}`);
      }
    }

    const remainingBeforeSleep = deadline - readTime();
    if (remainingBeforeSleep <= 0) {
      throw safeError('RAILWAY_DEPLOYMENT_OBSERVATION_TIMEOUT');
    }
    await sleep(
      Math.min(DEPLOYMENT_POLL_INTERVAL_MS, remainingBeforeSleep),
    );
  }
}

/**
 * Require the exact deployment to remain the active successful deployment.
 */
export async function verifyActiveDeployment(
  { deploymentId, serviceId, environmentName },
  { runCommand = runBoundedRailwayCommand } = {},
) {
  const validatedDeploymentId = requireUuid(
    deploymentId,
    'RAILWAY_DEPLOYMENT_ID_INVALID',
  );
  const target = validateTarget({ serviceId, environmentName });
  const output = await runCommand(
    [
      'service',
      'status',
      '--service',
      target.serviceId,
      '--environment',
      target.environmentName,
      '--json',
    ],
    RAILWAY_COMMAND_LIMITS.serviceStatus,
  );
  const response = parseJsonObject(
    output,
    'RAILWAY_READINESS_ACTIVATION_EVIDENCE_MISMATCH',
  );

  if (
    response.deploymentId !== validatedDeploymentId
    || response.status !== 'SUCCESS'
    || response.stopped !== false
  ) {
    throw safeError('RAILWAY_READINESS_ACTIVATION_EVIDENCE_MISMATCH');
  }
}

/**
 * Return the exact active successful deployment ID for pre-deploy evidence.
 */
export async function readActiveDeploymentId(
  { serviceId, environmentName },
  { runCommand = runBoundedRailwayCommand } = {},
) {
  const target = validateTarget({ serviceId, environmentName });
  const output = await runCommand(
    [
      'service',
      'status',
      '--service',
      target.serviceId,
      '--environment',
      target.environmentName,
      '--json',
    ],
    RAILWAY_COMMAND_LIMITS.serviceStatus,
  );
  const response = parseJsonObject(
    output,
    'RAILWAY_BASELINE_ACTIVATION_EVIDENCE_MISMATCH',
  );

  if (response.status !== 'SUCCESS' || response.stopped !== false) {
    throw safeError('RAILWAY_BASELINE_ACTIVATION_EVIDENCE_MISMATCH');
  }

  try {
    return requireUuid(
      response.deploymentId,
      'RAILWAY_BASELINE_ACTIVATION_EVIDENCE_MISMATCH',
    );
  } catch {
    throw safeError('RAILWAY_BASELINE_ACTIVATION_EVIDENCE_MISMATCH');
  }
}

/**
 * Read bounded variable JSON for the exact service and environment.
 */
export async function readRailwayVariables(
  { serviceId, environmentName },
  { runCommand = runBoundedRailwayCommand } = {},
) {
  const target = validateTarget({ serviceId, environmentName });
  const output = await runCommand(
    [
      'variable',
      'list',
      '--service',
      target.serviceId,
      '--environment',
      target.environmentName,
      '--json',
    ],
    RAILWAY_COMMAND_LIMITS.variableList,
  );
  parseJsonObject(output, 'RAILWAY_VARIABLE_LIST_INVALID');
  return output;
}

const CLI_FLAGS = Object.freeze({
  '--project': 'projectId',
  '--service': 'serviceId',
  '--environment': 'environmentName',
  '--deploy-ref': 'deployRef',
  '--deployment-id': 'deploymentId',
});

function parseCliOptions(args, requiredFlags) {
  if (args.length % 2 !== 0) {
    throw safeError('RAILWAY_OBSERVER_ARGUMENTS_INVALID');
  }

  const options = {};
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    const property = CLI_FLAGS[flag];
    if (
      !requiredFlags.includes(flag)
      || property === undefined
      || Object.hasOwn(options, property)
      || typeof value !== 'string'
      || value.length === 0
    ) {
      throw safeError('RAILWAY_OBSERVER_ARGUMENTS_INVALID');
    }
    options[property] = value;
  }

  if (
    requiredFlags.some(flag => !Object.hasOwn(options, CLI_FLAGS[flag]))
    || Object.keys(options).length !== requiredFlags.length
  ) {
    throw safeError('RAILWAY_OBSERVER_ARGUMENTS_INVALID');
  }
  return options;
}

export async function main(argv = process.argv.slice(2)) {
  const [mode, ...args] = argv;

  if (mode === 'enqueue') {
    const options = parseCliOptions(args, [
      '--project',
      '--service',
      '--environment',
      '--deploy-ref',
    ]);
    const deploymentId = await enqueueDeployment(options);
    process.stdout.write(`${deploymentId}\n`);
    return;
  }

  if (mode === 'wait') {
    const options = parseCliOptions(args, [
      '--deployment-id',
      '--service',
      '--environment',
    ]);
    await waitForDeploymentSuccess(options);
    return;
  }

  if (mode === 'verify-active') {
    const options = parseCliOptions(args, [
      '--deployment-id',
      '--service',
      '--environment',
    ]);
    await verifyActiveDeployment(options);
    return;
  }

  if (mode === 'active-id') {
    const options = parseCliOptions(args, [
      '--service',
      '--environment',
    ]);
    const deploymentId = await readActiveDeploymentId(options);
    process.stdout.write(`${deploymentId}\n`);
    return;
  }

  if (mode === 'variables') {
    const options = parseCliOptions(args, [
      '--service',
      '--environment',
    ]);
    const output = await readRailwayVariables(options);
    process.stdout.write(output);
    return;
  }

  throw safeError('RAILWAY_OBSERVER_MODE_INVALID');
}

function isDirectExecution() {
  return (
    typeof process.argv[1] === 'string'
    && import.meta.url === pathToFileURL(resolve(process.argv[1])).href
  );
}

if (isDirectExecution()) {
  try {
    await main();
  } catch (error) {
    const code =
      error
      && typeof error === 'object'
      && typeof error.code === 'string'
      && /^[A-Z0-9_:-]+$/u.test(error.code)
        ? error.code
        : 'RAILWAY_OBSERVER_FAILED';
    process.stderr.write(`${code}\n`);
    process.exitCode = 1;
  }
}
