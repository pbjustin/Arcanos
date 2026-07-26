import { resolveErrorMessage } from '@core/lib/errors/index.js';
import { getEnv } from '@platform/runtime/env.js';
import { getRailwayApiConfig } from '@platform/runtime/railway.js';
import {
  getConfig,
  getStableWorkerRuntimeMode,
  isWorkerRuntimeSuppressedForServiceRole,
} from '@platform/runtime/unifiedConfig.js';
import {
  deployService,
  isRailwayApiConfigured,
  listProjects,
  type RailwayProjectSummary
} from '@services/railwayClient.js';
import {
  healWorkerRuntime,
  type HealWorkerRuntimeResponse
} from '@services/workerControlService.js';
import {
  resolveConfiguredWorkerHelperToken,
  WORKER_HELPER_TOKEN_ENV_NAME,
  WORKER_HELPER_TOKEN_HEADER_NAME,
} from '@shared/security/workerHelperCredential.js';
import {
  evaluateSelfHealOperatorApproval,
  type SelfHealOperatorApproval
} from './operatorApproval.js';

export type WorkerRepairActuatorMode =
  | 'local_in_process'
  | 'railway_service_deploy'
  | 'remote_worker_helper'
  | 'unavailable';

export interface WorkerRepairActuatorStatus {
  mode: WorkerRepairActuatorMode;
  available: boolean;
  reason: string;
  serviceName: string | null;
  targetServiceName: string | null;
  baseUrl: string | null;
  path: string | null;
  timeoutMs: number;
}

export interface WorkerRepairActuatorResult {
  mode: Exclude<WorkerRepairActuatorMode, 'unavailable'>;
  baseUrl: string | null;
  path: string | null;
  statusCode: number | null;
  message: string;
  payload: Record<string, unknown>;
}

export interface WorkerRepairActuatorDependencies {
  fetchFn?: typeof fetch;
  resolveWorkerHelperToken?: () => string | null;
}

const REMOTE_WORKER_HELPER_MAX_RESPONSE_BYTES = 65_536;
const REMOTE_WORKER_HELPER_MAX_MESSAGE_LENGTH = 512;
const REMOTE_WORKER_HELPER_URL_ENV_NAMES = Object.freeze([
  'SELF_HEAL_WORKER_SERVICE_URL',
  'WORKER_HELPER_BASE_URL',
  'RAILWAY_SERVICE_ARCANOS_WORKER_URL',
  'ARCANOS_WORKER_PUBLIC_URL',
] as const);

function normalizeBaseUrl(raw: string | undefined): string | null {
  const normalized = raw?.trim();
  if (!normalized || !/^https?:\/\//iu.test(normalized)) {
    return null;
  }

  try {
    const url = new URL(normalized);
    const loopbackHost = new Set(['127.0.0.1', '[::1]', '::1', 'localhost'])
      .has(url.hostname.toLowerCase());
    if (
      (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopbackHost))
      || url.username.length > 0
      || url.password.length > 0
      || (url.pathname !== '/' && url.pathname !== '')
      || url.search.length > 0
      || url.hash.length > 0
    ) {
      return null;
    }

    return url.origin;
  } catch {
    return null;
  }
}

function resolveRemoteWorkerHelperCredential(): string | null {
  return resolveConfiguredWorkerHelperToken((environmentName) => getEnv(environmentName));
}

function getWorkerHelperTokenResolver(
  dependencies: WorkerRepairActuatorDependencies
): () => string | null {
  return dependencies.resolveWorkerHelperToken ?? resolveRemoteWorkerHelperCredential;
}

function safelyResolveWorkerHelperToken(
  dependencies: WorkerRepairActuatorDependencies
): string | null {
  try {
    const candidate = getWorkerHelperTokenResolver(dependencies)();
    if (typeof candidate !== 'string') {
      return null;
    }

    return resolveConfiguredWorkerHelperToken((environmentName) => (
      environmentName === WORKER_HELPER_TOKEN_ENV_NAME
        ? candidate
        : getEnv(environmentName)
    ));
  } catch {
    return null;
  }
}

function extractWorkerServiceBaseUrl(): {
  configured: boolean;
  baseUrl: string | null;
} {
  const configuredValues = REMOTE_WORKER_HELPER_URL_ENV_NAMES
    .map((environmentName) => getEnv(environmentName))
    .filter((value): value is string => typeof value === 'string' && value.trim().length > 0);
  if (configuredValues.length === 0) {
    return {
      configured: false,
      baseUrl: null,
    };
  }

  const normalizedValues = configuredValues.map(normalizeBaseUrl);
  if (
    normalizedValues.some((value) => value === null)
    || new Set(normalizedValues).size !== 1
  ) {
    return {
      configured: true,
      baseUrl: null,
    };
  }

  return {
    configured: true,
    baseUrl: normalizedValues[0] ?? null,
  };
}

function getWorkerRepairTargetServiceName(): string {
  return (
    getEnv('SELF_HEAL_WORKER_SERVICE_NAME')?.trim() ||
    getEnv('ARCANOS_WORKER_SERVICE_NAME')?.trim() ||
    'ARCANOS Worker'
  );
}

function getWorkerRepairTargetServiceId(): string | null {
  return (
    getEnv('SELF_HEAL_WORKER_SERVICE_ID')?.trim() ||
    getEnv('ARCANOS_WORKER_SERVICE_ID')?.trim() ||
    null
  );
}

function getCurrentProjectId(): string | null {
  return getEnv('RAILWAY_PROJECT_ID')?.trim() || null;
}

function getCurrentEnvironmentName(): string | null {
  return (
    getEnv('SELF_HEAL_TARGET_ENVIRONMENT')?.trim() ||
    getEnv('RAILWAY_ENVIRONMENT_NAME')?.trim() ||
    getEnv('RAILWAY_ENVIRONMENT')?.trim() ||
    null
  );
}

async function cancelRemoteResponseBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // Best-effort cancellation only.
  }
}

function getRemoteResponseHeader(response: Response, name: string): string | null {
  const headers = response.headers as Headers | undefined;
  return typeof headers?.get === 'function' ? headers.get(name) : null;
}

async function readBoundedRemoteJsonResponse(
  response: Response
): Promise<Record<string, unknown>> {
  const declaredLength = getRemoteResponseHeader(response, 'content-length');
  if (declaredLength !== null) {
    if (
      !/^\d+$/u.test(declaredLength)
      || Number(declaredLength) > REMOTE_WORKER_HELPER_MAX_RESPONSE_BYTES
    ) {
      await cancelRemoteResponseBody(response);
      throw new Error('Remote worker-helper response was invalid.');
    }
  }

  const contentType = getRemoteResponseHeader(response, 'content-type');
  if (contentType !== null && !/\bjson\b/iu.test(contentType)) {
    await cancelRemoteResponseBody(response);
    throw new Error('Remote worker-helper response was invalid.');
  }

  let responseText: string;
  if (typeof response.body?.getReader === 'function') {
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let totalBytes = 0;

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }
        totalBytes += value.byteLength;
        if (totalBytes > REMOTE_WORKER_HELPER_MAX_RESPONSE_BYTES) {
          await reader.cancel();
          throw new Error('Remote worker-helper response was invalid.');
        }
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }

    const combined = new Uint8Array(totalBytes);
    let offset = 0;
    for (const chunk of chunks) {
      combined.set(chunk, offset);
      offset += chunk.byteLength;
    }
    responseText = new TextDecoder('utf-8', { fatal: true }).decode(combined);
  } else {
    throw new Error('Remote worker-helper response was invalid.');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(responseText);
  } catch {
    throw new Error('Remote worker-helper response was invalid.');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Remote worker-helper response was invalid.');
  }

  return parsed as Record<string, unknown>;
}

function buildSafeRemoteRepairPayload(
  remotePayload: Record<string, unknown>,
  requestedForce: boolean,
  statusCode: number
): {
  message: string;
  payload: Record<string, unknown>;
} {
  const restart = remotePayload.restart;
  if (
    remotePayload.requestedForce !== requestedForce
    || !restart
    || typeof restart !== 'object'
    || Array.isArray(restart)
  ) {
    throw new Error('Remote worker-helper response was invalid.');
  }

  const restartRecord = restart as Record<string, unknown>;
  const message = restartRecord.message;
  if (
    typeof restartRecord.started !== 'boolean'
    || typeof restartRecord.alreadyRunning !== 'boolean'
    || typeof restartRecord.runWorkers !== 'boolean'
    || typeof message !== 'string'
    || message.trim().length === 0
    || message.length > REMOTE_WORKER_HELPER_MAX_MESSAGE_LENGTH
    || (restartRecord.started && restartRecord.alreadyRunning)
    || (
      !restartRecord.runWorkers
      && (restartRecord.started || restartRecord.alreadyRunning)
    )
  ) {
    throw new Error('Remote worker-helper response was invalid.');
  }

  const safeMessage = restartRecord.started
    ? 'Remote worker runtime restart started.'
    : restartRecord.alreadyRunning
      ? 'Remote worker runtime was already running.'
      : !restartRecord.runWorkers
        ? 'Remote worker runtime reported workers disabled.'
        : `Remote worker repair completed with HTTP ${statusCode}.`;
  const safeRestart = {
    started: restartRecord.started,
    alreadyRunning: restartRecord.alreadyRunning,
    runWorkers: restartRecord.runWorkers,
    message: safeMessage,
  };

  return {
    message: safeMessage,
    payload: {
      requestedForce,
      restart: safeRestart,
    },
  };
}

function matchEnvironmentCandidates(
  environments: RailwayProjectSummary['environments'],
  environmentName: string | null
): RailwayProjectSummary['environments'] {
  if (!environmentName) {
    return environments;
  }

  const normalizedEnvironment = environmentName.trim().toLowerCase();
  const exactMatches = environments.filter(
    (environment) => environment.name.trim().toLowerCase() === normalizedEnvironment
  );

  return exactMatches.length > 0 ? exactMatches : environments;
}

async function resolveRailwayRepairTarget(): Promise<{
  projectId: string;
  projectName: string;
  environmentId: string;
  environmentName: string;
  serviceId: string;
  serviceName: string;
}> {
  const configuredServiceId = getWorkerRepairTargetServiceId();
  const targetServiceName = getWorkerRepairTargetServiceName();
  const currentProjectId = getCurrentProjectId();
  const currentEnvironmentName = getCurrentEnvironmentName();
  const projects = await listProjects();
  const candidateProjects =
    currentProjectId !== null
      ? projects.filter((project) => project.id === currentProjectId)
      : projects;

  if (currentProjectId !== null && candidateProjects.length === 0) {
    throw new Error(`Unable to resolve Railway project ${currentProjectId} for worker repair.`);
  }

  const normalizedTargetServiceName = targetServiceName.trim().toLowerCase();
  const projectsToSearch = candidateProjects.length > 0 ? candidateProjects : projects;

  for (const project of projectsToSearch) {
    const environments = matchEnvironmentCandidates(project.environments, currentEnvironmentName);

    for (const environment of environments) {
      const service = configuredServiceId
        ? environment.services.find((candidate) => candidate.id === configuredServiceId)
        : environment.services.find(
            (candidate) => candidate.name.trim().toLowerCase() === normalizedTargetServiceName
          );

      if (!service) {
        continue;
      }

      return {
        projectId: project.id,
        projectName: project.name,
        environmentId: environment.id,
        environmentName: environment.name,
        serviceId: service.id,
        serviceName: service.name
      };
    }
  }

  const targetDescriptor = configuredServiceId ?? targetServiceName;
  throw new Error(`Unable to resolve Railway worker repair target "${targetDescriptor}".`);
}

async function executeRailwayServiceRepair(
  actuator: WorkerRepairActuatorStatus,
  requestedForce: boolean
): Promise<WorkerRepairActuatorResult> {
  const target = await resolveRailwayRepairTarget();
  const deployment = await deployService({
    environmentId: target.environmentId,
    serviceId: target.serviceId
  });

  return {
    mode: 'railway_service_deploy',
    baseUrl: actuator.baseUrl,
    path: actuator.path,
    statusCode: null,
    message: deployment.accepted
      ? `Triggered Railway redeploy for ${target.serviceName}.`
      : `Railway did not accept the redeploy request for ${target.serviceName}.`,
    payload: {
      requestedForce,
      accepted: deployment.accepted,
      deploymentStatus: deployment.status,
      projectId: target.projectId,
      projectName: target.projectName,
      environmentId: target.environmentId,
      environmentName: target.environmentName,
      serviceId: target.serviceId,
      serviceName: target.serviceName
    }
  };
}

async function executeRemoteWorkerHelperRepair(
  actuator: WorkerRepairActuatorStatus,
  requestedForce: boolean,
  dependencies: WorkerRepairActuatorDependencies
): Promise<WorkerRepairActuatorResult> {
  const credential = safelyResolveWorkerHelperToken(dependencies);
  if (!credential || !actuator.baseUrl || !actuator.path) {
    throw new Error('Remote worker-helper actuator configuration is incomplete.');
  }

  const requestUrl = new URL(actuator.path, `${actuator.baseUrl}/`);
  if (
    actuator.path !== '/worker-helper/heal'
    || requestUrl.origin !== actuator.baseUrl
  ) {
    throw new Error('Remote worker-helper actuator configuration is incomplete.');
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), actuator.timeoutMs);

  try {
    let response: Response;
    try {
      response = await (dependencies.fetchFn ?? fetch)(
        requestUrl,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            [WORKER_HELPER_TOKEN_HEADER_NAME]: credential
          },
          body: JSON.stringify({
            mode: 'execute',
            execute: true,
            force: requestedForce
          }),
          redirect: 'error',
          signal: controller.signal
        }
      );
    } catch {
      throw new Error('Remote worker repair request could not be completed.');
    }

    if (response.status >= 300 && response.status < 400) {
      await cancelRemoteResponseBody(response);
      throw new Error('Remote worker repair redirect response was rejected.');
    }
    if (!response.ok) {
      await cancelRemoteResponseBody(response);
      throw new Error(`Remote worker repair failed with HTTP ${response.status}.`);
    }

    let safeResult: ReturnType<typeof buildSafeRemoteRepairPayload>;
    try {
      const remotePayload = await readBoundedRemoteJsonResponse(response);
      safeResult = buildSafeRemoteRepairPayload(
        remotePayload,
        requestedForce,
        response.status
      );
    } catch {
      throw new Error('Remote worker-helper response was invalid.');
    }

    return {
      mode: 'remote_worker_helper',
      baseUrl: actuator.baseUrl,
      path: actuator.path,
      statusCode: response.status,
      message: safeResult.message,
      payload: safeResult.payload
    };
  } finally {
    clearTimeout(timeout);
  }
}

export function buildWorkerRepairActuatorStatus(
  dependencies: WorkerRepairActuatorDependencies = {}
): WorkerRepairActuatorStatus {
  const config = getConfig();
  const workerRuntimeMode = getStableWorkerRuntimeMode();
  const currentServiceName = getEnv('RAILWAY_SERVICE_NAME')?.trim() || null;
  const timeoutMs = Math.max(5_000, config.workerApiTimeoutMs);

  if (config.runWorkers) {
    return {
      mode: 'local_in_process',
      available: true,
      reason: 'Local worker runtime is enabled for this service.',
      serviceName: currentServiceName,
      targetServiceName: currentServiceName,
      baseUrl: null,
      path: null,
      timeoutMs
    };
  }

  if (isWorkerRuntimeSuppressedForServiceRole(workerRuntimeMode)) {
    return {
      mode: 'unavailable',
      available: false,
      reason: 'Worker repair actuator is disabled in the web service role; use the dedicated worker service or Railway CLI for recovery.',
      serviceName: currentServiceName,
      targetServiceName: getWorkerRepairTargetServiceName(),
      baseUrl: null,
      path: null,
      timeoutMs
    };
  }

  if (isRailwayApiConfigured()) {
    return {
      mode: 'railway_service_deploy',
      available: true,
      reason: 'Local worker runtime is disabled; Railway serviceInstanceRedeploy will repair the dedicated worker service.',
      serviceName: currentServiceName,
      targetServiceName: getWorkerRepairTargetServiceName(),
      baseUrl: getRailwayApiConfig().endpoint,
      path: 'serviceInstanceRedeploy',
      timeoutMs
    };
  }

  const remoteConfiguration = extractWorkerServiceBaseUrl();
  if (
    remoteConfiguration.baseUrl
    && safelyResolveWorkerHelperToken(dependencies)
  ) {
    return {
      mode: 'remote_worker_helper',
      available: true,
      reason: 'Local worker runtime is disabled; dedicated worker helper endpoint is configured.',
      serviceName: currentServiceName,
      targetServiceName: getWorkerRepairTargetServiceName(),
      baseUrl: remoteConfiguration.baseUrl,
      path: '/worker-helper/heal',
      timeoutMs
    };
  }

  if (remoteConfiguration.configured) {
    return {
      mode: 'unavailable',
      available: false,
      reason: 'Remote worker-helper actuator configuration is incomplete.',
      serviceName: currentServiceName,
      targetServiceName: getWorkerRepairTargetServiceName(),
      baseUrl: null,
      path: null,
      timeoutMs
    };
  }

  return {
    mode: 'unavailable',
    available: false,
    reason: 'Local worker runtime is disabled and no production repair actuator is configured.',
    serviceName: currentServiceName,
    targetServiceName: getWorkerRepairTargetServiceName(),
    baseUrl: null,
    path: null,
    timeoutMs
  };
}

export async function executeWorkerRepairActuator(params: {
  force?: boolean;
  source: string;
  approval?: SelfHealOperatorApproval;
}, dependencies: WorkerRepairActuatorDependencies = {}): Promise<WorkerRepairActuatorResult> {
  const actuator = buildWorkerRepairActuatorStatus(dependencies);
  const requestedForce = params.force ?? true;

  if (!actuator.available || actuator.mode === 'unavailable') {
    throw new Error(actuator.reason);
  }

  const privilegedRemoteRepair =
    actuator.mode === 'railway_service_deploy' || actuator.mode === 'remote_worker_helper';
  const approval = evaluateSelfHealOperatorApproval({
    action: `worker repair actuator ${actuator.mode}`,
    required: privilegedRemoteRepair,
    approval: params.approval
  });
  if (!approval.satisfied) {
    throw new Error(approval.reason ?? 'Worker repair actuator requires explicit operator approval.');
  }

  try {
    if (actuator.mode === 'local_in_process') {
      const localResult: HealWorkerRuntimeResponse = await healWorkerRuntime(requestedForce, params.source);
      return {
        mode: 'local_in_process',
        baseUrl: null,
        path: null,
        statusCode: null,
        message: localResult.restart.message ?? 'Local worker runtime repair executed.',
        payload: {
          timestamp: localResult.timestamp,
          requestedForce: localResult.requestedForce,
          restart: localResult.restart,
          runtime: localResult.runtime
        }
      };
    }

    if (actuator.mode === 'railway_service_deploy') {
      return await executeRailwayServiceRepair(actuator, requestedForce);
    }

    return await executeRemoteWorkerHelperRepair(actuator, requestedForce, dependencies);
  } catch (error) {
    throw new Error(`Worker repair actuator failed: ${resolveErrorMessage(error)}`);
  }
}
