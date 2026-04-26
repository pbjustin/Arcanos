import { evaluateControlPlaneGptPolicy } from './gptPolicy.js';
import type { ControlPlaneGptPolicy } from './types.js';

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
