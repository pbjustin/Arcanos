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

function normalizeBaseUrl(raw: string | undefined): string | null {
  const normalized = raw?.trim();
  if (!normalized) {
    return null;
  }

  if (/^https?:\/\//i.test(normalized)) {
    return normalized.replace(/\/+$/, '');
  }

  return `https://${normalized.replace(/^\/+/, '').replace(/\/+$/, '')}`;
}

function extractWorkerServiceBaseUrl(): string | null {
  return normalizeBaseUrl(
    getEnv('SELF_HEAL_WORKER_SERVICE_URL') ||
      getEnv('WORKER_HELPER_BASE_URL') ||
      getEnv('RAILWAY_SERVICE_ARCANOS_WORKER_URL') ||
      getEnv('ARCANOS_WORKER_PUBLIC_URL')
  );
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

function getRemoteRepairMessage(payload: Record<string, unknown>, statusCode: number): string {
  const restart = payload.restart;
  if (restart && typeof restart === 'object' && !Array.isArray(restart)) {
    const restartMessage = (restart as Record<string, unknown>).message;
    if (typeof restartMessage === 'string' && restartMessage.trim().length > 0) {
      return restartMessage.trim();
    }
  }

  const directMessage = payload.message;
  if (typeof directMessage === 'string' && directMessage.trim().length > 0) {
    return directMessage.trim();
  }

  const errorMessage = payload.error;
  if (typeof errorMessage === 'string' && errorMessage.trim().length > 0) {
    return errorMessage.trim();
  }

  return `Remote worker repair completed with HTTP ${statusCode}.`;
}

function parseRemotePayload(raw: string): Record<string, unknown> {
  if (!raw.trim()) {
    return {};
  }

  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // Fall through to raw payload capture.
  }

  return { raw };
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
  requestedForce: boolean
): Promise<WorkerRepairActuatorResult> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), actuator.timeoutMs);

  try {
    const response = await fetch(`${actuator.baseUrl}${actuator.path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        mode: 'execute',
        execute: true,
        force: requestedForce
      }),
      signal: controller.signal
    });
    const responseText = await response.text();
    const payload = parseRemotePayload(responseText);

    if (!response.ok) {
      throw new Error(
        `Remote worker repair failed (${response.status}): ${getRemoteRepairMessage(payload, response.status)}`
      );
    }

    return {
      mode: 'remote_worker_helper',
      baseUrl: actuator.baseUrl,
      path: actuator.path,
      statusCode: response.status,
      message: getRemoteRepairMessage(payload, response.status),
      payload
    };
  } finally {
    clearTimeout(timeout);
  }
}

export function buildWorkerRepairActuatorStatus(): WorkerRepairActuatorStatus {
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

  const remoteBaseUrl = extractWorkerServiceBaseUrl();
  if (remoteBaseUrl) {
    return {
      mode: 'remote_worker_helper',
      available: true,
      reason: 'Local worker runtime is disabled; dedicated worker helper endpoint is configured.',
      serviceName: currentServiceName,
      targetServiceName: getWorkerRepairTargetServiceName(),
      baseUrl: remoteBaseUrl,
      path: '/worker-helper/heal',
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
}): Promise<WorkerRepairActuatorResult> {
  const actuator = buildWorkerRepairActuatorStatus();
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

    return await executeRemoteWorkerHelperRepair(actuator, requestedForce);
  } catch (error) {
    throw new Error(`Worker repair actuator failed: ${resolveErrorMessage(error)}`);
  }
}
