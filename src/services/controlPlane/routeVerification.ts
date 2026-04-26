import { evaluateControlPlaneGptPolicy } from './gptPolicy.js';
import type {
  ControlPlaneGptPolicy,
  ControlPlaneRequestPayload,
  ControlPlaneRouteEvidence,
  ControlPlaneRouteMetadata,
  ControlPlaneServiceRouteStatus,
} from './types.js';

const CONFIRMED_TRINITY_STAGES = [
  'ARCANOS-INTAKE',
  'GPT5-REASONING',
  'ARCANOS-FINAL'
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter((item): item is string => typeof item === 'string');
}

function readRouteEvidence(response: unknown): ControlPlaneRouteEvidence {
  if (!isRecord(response)) {
    return {};
  }

  const routingStages = readStringArray(response.routingStages);
  const outputControls = isRecord(response.outputControls) ? response.outputControls : null;
  const pipelineDebugPresent = isRecord(response.pipelineDebug);

  return {
    ...(typeof outputControls?.sourceEndpoint === 'string'
      ? { sourceEndpoint: outputControls.sourceEndpoint }
      : {}),
    ...(routingStages.length > 0 ? { routingStages } : {}),
    ...(pipelineDebugPresent ? { pipelineDebugPresent: true } : {}),
    ...(typeof response.gpt5Used === 'boolean' ? { gpt5Used: response.gpt5Used } : {}),
    ...(typeof response.activeModel === 'string' ? { activeModel: response.activeModel } : {}),
    responseKeys: Object.keys(response).sort()
  };
}

function hasConfirmedTrinityStages(evidence: ControlPlaneRouteEvidence): boolean {
  const stages = evidence.routingStages ?? [];
  return CONFIRMED_TRINITY_STAGES.every((expectedStage) => (
    stages.some((stage) => stage.startsWith(expectedStage))
  ));
}

export function isControlPlaneTrinityEligible(request: Pick<ControlPlaneRequestPayload, 'phase'>): boolean {
  return request.phase === 'plan';
}

export function verifyControlPlaneRoute(params: {
  request: Pick<ControlPlaneRequestPayload, 'phase' | 'routePreference'>;
  trinityResponse?: unknown;
  trinityUnavailable?: boolean;
  trinityError?: string;
  now?: () => Date;
}): ControlPlaneRouteMetadata {
  const now = params.now ?? (() => new Date());
  const timestamp = now().toISOString();
  const requested =
    params.request.routePreference === 'direct' ? 'direct' : 'trinity';
  const eligibleForTrinity =
    requested === 'trinity' && isControlPlaneTrinityEligible(params.request);

  if (requested === 'direct') {
    return {
      requested,
      status: 'DIRECT_FAST_PATH',
      eligibleForTrinity: false,
      reason: 'Direct routing was requested by the caller.',
      evidence: {},
      requestedAt: timestamp,
      verifiedAt: timestamp
    };
  }

  if (!eligibleForTrinity) {
    return {
      requested,
      status: 'DIRECT_FAST_PATH',
      eligibleForTrinity: false,
      reason: 'Control-plane execution and mutation are system operations and are not eligible for Trinity writing-plane routing.',
      evidence: {},
      requestedAt: timestamp,
      verifiedAt: timestamp
    };
  }

  if (params.trinityUnavailable) {
    return {
      requested,
      status: 'TRINITY_UNAVAILABLE',
      eligibleForTrinity,
      reason: params.trinityError ?? 'Trinity routing was requested, but the backend could not run the Trinity pipeline.',
      evidence: {},
      requestedAt: timestamp,
      verifiedAt: timestamp
    };
  }

  if (params.trinityResponse === undefined) {
    return {
      requested,
      status: 'UNKNOWN_ROUTE',
      eligibleForTrinity,
      reason: 'No route response metadata was available for verification.',
      evidence: {},
      requestedAt: timestamp,
      verifiedAt: timestamp
    };
  }

  const evidence = readRouteEvidence(params.trinityResponse);
  const status: ControlPlaneServiceRouteStatus = hasConfirmedTrinityStages(evidence)
    ? 'TRINITY_CONFIRMED'
    : 'TRINITY_REQUESTED_BUT_NOT_CONFIRMED';

  return {
    requested,
    status,
    eligibleForTrinity,
    reason: status === 'TRINITY_CONFIRMED'
      ? 'Response metadata includes the Trinity intake, reasoning, and final pipeline stages.'
      : 'Trinity was requested, but response metadata did not prove Trinity pipeline involvement.',
    evidence,
    requestedAt: timestamp,
    verifiedAt: timestamp
  };
}

export type ControlPlaneRouteStatus =
  | 'TRINITY_CONFIRMED'
  | 'DIRECT_FAST_PATH'
  | 'ORCHESTRATED_PATH_UNCONFIRMED'
  | 'UNKNOWN';

export interface ControlPlaneRouteVerificationResult {
  gptId: string | null;
  gptWhitelisted: boolean;
  trinityConfirmed: boolean;
  routeStatus: ControlPlaneRouteStatus;
  route: string | null;
  path: string | null;
  module: string | null;
  queueBypassed: boolean | null;
  orchestrationBypassed: boolean | null;
  reason: string;
}

function readRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function readString(source: Record<string, unknown> | null, key: string): string | null {
  const value = source?.[key];
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function readBoolean(source: Record<string, unknown> | null, key: string): boolean | null {
  const value = source?.[key];
  return typeof value === 'boolean' ? value : null;
}

function includesTrinityStage(metadata: Record<string, unknown> | null): boolean {
  const stages = metadata?.routingStages;
  return Array.isArray(stages) && stages.some((stage) =>
    typeof stage === 'string' && stage.toLowerCase().includes('trinity')
  );
}

export function verifyControlPlaneRouteMetadata(params: {
  gptId?: string;
  metadata: unknown;
  policies?: readonly ControlPlaneGptPolicy[];
}): ControlPlaneRouteVerificationResult {
  const policyDecision = evaluateControlPlaneGptPolicy({
    gptId: params.gptId,
    workflow: 'control_plane.route.verify',
    policies: params.policies,
  });
  const metadata = readRecord(params.metadata);
  const routeMeta = readRecord(metadata?._route) ?? metadata;
  const routeDecision = readRecord(metadata?.routeDecision);
  const directAction = readRecord(metadata?.directAction);
  const route = readString(routeMeta, 'route');
  const path = readString(routeDecision, 'path') ?? readString(metadata, 'path');
  const module = readString(routeMeta, 'module') ?? readString(metadata, 'module');
  const queueBypassed =
    readBoolean(routeDecision, 'queueBypassed') ??
    readBoolean(directAction, 'queueBypassed') ??
    readBoolean(metadata, 'queueBypassed');
  const orchestrationBypassed =
    readBoolean(directAction, 'orchestrationBypassed') ??
    readBoolean(metadata, 'orchestrationBypassed');
  const directFastPath =
    route === 'direct_action' ||
    module === 'GPT:DIRECT_ACTION' ||
    path === 'fast_path' ||
    queueBypassed === true ||
    orchestrationBypassed === true;
  const trinityConfirmed =
    policyDecision.ok &&
    policyDecision.whitelisted &&
    !directFastPath &&
    (
      module === 'ARCANOS:CORE' ||
      module === 'trinity' ||
      readString(metadata, 'pipeline') === 'trinity' ||
      includesTrinityStage(metadata)
    );

  return {
    gptId: policyDecision.gptId,
    gptWhitelisted: policyDecision.ok && policyDecision.whitelisted,
    trinityConfirmed,
    routeStatus: trinityConfirmed
      ? 'TRINITY_CONFIRMED'
      : directFastPath
        ? 'DIRECT_FAST_PATH'
        : path === 'orchestrated_path'
          ? 'ORCHESTRATED_PATH_UNCONFIRMED'
          : 'UNKNOWN',
    route,
    path,
    module,
    queueBypassed,
    orchestrationBypassed,
    reason: trinityConfirmed
      ? 'trinity_metadata_confirmed'
      : directFastPath
        ? 'direct_fast_path_metadata'
        : policyDecision.reason,
  };
}
