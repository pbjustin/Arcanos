import {
  classifyWritingPlaneInput,
  isDirectControlPlaneKind,
} from '@platform/runtime/writingPlaneContract.js';
import { type NaturalLanguageJobLookupIntent } from '@shared/gpt/naturalLanguageJobLookup.js';

export type GptDirectControlKind =
  | 'diagnostics'
  | 'job_result'
  | 'job_status'
  | 'queue_inspection_action'
  | 'runtime_inspection_action'
  | 'self_heal_status_action'
  | 'system_state'
  | 'workers_status_action';

export type GptRejectedControlKind =
  | 'dag_control'
  | 'job_lookup'
  | 'mcp_control'
  | 'runtime_inspection'
  | 'unsupported_control_action';

export type GptPlaneClassification =
  | {
      plane: 'writing';
      kind: 'writing';
      action: string | null;
      reason: string;
    }
  | {
      plane: 'control';
      kind: GptDirectControlKind;
      action: string;
      reason: string;
    }
  | {
      plane: 'reject';
      kind: GptRejectedControlKind;
      action: string;
      reason: string;
      errorCode: string;
      message: string;
      canonical: Record<string, string | null>;
      jobLookup?: NaturalLanguageJobLookupIntent;
    };

export type GptWritingPlaneClassification = Extract<
  GptPlaneClassification,
  { plane: 'writing' }
>;

const GPT_ROUTE_BLOCKED_DIRECT_CONTROL_KINDS = new Set<GptDirectControlKind>([
  'diagnostics',
  'job_result',
  'job_status',
  'queue_inspection_action',
  'runtime_inspection_action',
  'self_heal_status_action',
  'system_state',
  'workers_status_action',
]);

function isBlockedDirectControlKind(kind: GptDirectControlKind): boolean {
  return GPT_ROUTE_BLOCKED_DIRECT_CONTROL_KINDS.has(kind);
}

function buildDirectEndpointRequiredClassification(input: {
  action: string;
  reason: string;
}): GptPlaneClassification {
  return {
    plane: 'reject',
    kind: 'runtime_inspection',
    action: input.action,
    reason: input.reason,
    errorCode: 'CONTROL_PLANE_REQUIRES_DIRECT_ENDPOINT',
    message:
      'Runtime diagnostics, worker state, tracing, queue inspection, system state, MCP diagnostics, and job lookups must use direct control-plane endpoints, /gpt-access/*, /system-state, or POST /gpt-access/mcp. Do not send control requests through POST /gpt/{gptId}.',
    canonical: {
      status: '/gpt-access/status',
      workers: '/gpt-access/workers/status',
      workerHealth: '/gpt-access/worker-helper/health',
      queueInspect: '/gpt-access/queue/inspect',
      systemState: '/system-state',
      jobStatus: '/gpt-access/jobs/result',
      jobResult: '/gpt-access/jobs/result',
      gptAccessJobResult: '/gpt-access/jobs/result',
      selfHeal: '/gpt-access/self-heal/status',
      mcp: '/gpt-access/mcp',
    },
  };
}

export function classifyGptRequestPlane(input: {
  body: unknown;
  promptText: string | null;
  requestedAction: string | null;
}): GptPlaneClassification {
  const classification = classifyWritingPlaneInput(input);
  if (classification.plane === 'writing') {
    return classification;
  }

  if (isDirectControlPlaneKind(classification.kind)) {
    if (isBlockedDirectControlKind(classification.kind)) {
      return buildDirectEndpointRequiredClassification({
        action: classification.action,
        reason: 'control_plane_requires_direct_endpoint',
      });
    }

    return {
      plane: 'control',
      kind: classification.kind,
      action: classification.action,
      reason: classification.reason,
    };
  }

  return {
    plane: 'reject',
    kind: classification.kind,
    action: classification.action,
    reason: classification.reason,
    errorCode: classification.errorCode,
    message: classification.message,
    canonical: classification.canonical,
    ...(classification.jobLookup ? { jobLookup: classification.jobLookup } : {}),
  };
}

export function assertWritingPlaneClassification(
  classification: GptPlaneClassification
): asserts classification is GptWritingPlaneClassification {
  if (classification.plane !== 'writing') {
    throw new Error(
      `Expected writing-plane classification, received ${classification.plane}:${classification.kind}.`
    );
  }
}
