import type {
  ControlPlaneRequestPayload,
  ControlPlaneRouteEvidence,
  ControlPlaneRouteMetadata,
  ControlPlaneRouteStatus
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
  const status: ControlPlaneRouteStatus = hasConfirmedTrinityStages(evidence)
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
