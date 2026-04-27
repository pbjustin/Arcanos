import { classifyRuntimeInspectionPrompt } from '@services/runtimeInspectionRoutingService.js';
import { shouldTreatPromptAsDagExecution } from '@shared/dag/dagExecutionRouting.js';
import { normalizeGptRequestBody } from '@shared/gpt/gptIdempotency.js';
import {
  GPT_DIRECT_CONTROL_ACTIONS,
  type GptDirectControlAction,
  isReservedGptControlNamespace,
  normalizeGptDirectControlAction,
} from '@shared/gpt/gptControlActions.js';
import {
  GPT_GET_RESULT_ACTION,
  GPT_GET_STATUS_ACTION,
  GPT_QUERY_AND_WAIT_ACTION,
} from '@shared/gpt/gptJobResult.js';
import {
  parseNaturalLanguageJobLookup,
  type NaturalLanguageJobLookupIntent,
} from '@shared/gpt/naturalLanguageJobLookup.js';

export type WritingPlaneControlKind =
  | 'dag_control'
  | 'diagnostics'
  | 'job_lookup'
  | 'job_result'
  | 'job_status'
  | 'mcp_control'
  | 'queue_inspection_action'
  | 'runtime_inspection'
  | 'runtime_inspection_action'
  | 'self_heal_status_action'
  | 'system_state'
  | 'unsupported_control_action'
  | 'workers_status_action';

export type DirectWritingPlaneControlKind =
  | 'diagnostics'
  | 'job_result'
  | 'job_status'
  | 'queue_inspection_action'
  | 'runtime_inspection_action'
  | 'self_heal_status_action'
  | 'system_state'
  | 'workers_status_action';

type ExplicitWritingPlaneControlAction =
  | 'runtime.inspect'
  | 'workers.status'
  | 'queue.inspect'
  | 'self_heal.status';

type ExplicitWritingPlaneControlClassification = {
  kind: Extract<
    DirectWritingPlaneControlKind,
    | 'runtime_inspection_action'
    | 'workers_status_action'
    | 'queue_inspection_action'
    | 'self_heal_status_action'
  >;
  reason: string;
  message: string;
  canonical: Record<string, string>;
};

export type WritingPlaneInputClassification =
  | {
      plane: 'writing';
      kind: 'writing';
      action: string | null;
      reason: string;
    }
  | {
      plane: 'control';
      kind: WritingPlaneControlKind;
      action: string;
      reason: string;
      errorCode: string;
      message: string;
      canonical: Record<string, string | null>;
      jobLookup?: NaturalLanguageJobLookupIntent;
    };

type ControlWritingPlaneInputClassification = Extract<
  WritingPlaneInputClassification,
  { plane: 'control' }
>;

type McpControlAction = 'mcp.invoke' | 'mcp.list_tools';

const EXPLICIT_WRITING_PLANE_CONTROL_CLASSIFICATIONS: Record<
  ExplicitWritingPlaneControlAction,
  ExplicitWritingPlaneControlClassification
> = {
  'runtime.inspect': {
    kind: 'runtime_inspection_action',
    reason: 'explicit_action_runtime_inspect',
    message: 'Runtime inspection is a control-plane operation and must not execute inside Trinity.',
    canonical: {
      runtimeInspect: '/gpt/{gptId}',
    },
  },
  'workers.status': {
    kind: 'workers_status_action',
    reason: 'explicit_action_workers_status',
    message: 'Worker status inspection is a control-plane operation and must not execute inside Trinity.',
    canonical: {
      workers: '/gpt/{gptId}',
    },
  },
  'queue.inspect': {
    kind: 'queue_inspection_action',
    reason: 'explicit_action_queue_inspect',
    message: 'Queue inspection is a control-plane operation and must not execute inside Trinity.',
    canonical: {
      queueInspect: '/gpt/{gptId}',
    },
  },
  'self_heal.status': {
    kind: 'self_heal_status_action',
    reason: 'explicit_action_self_heal_status',
    message: 'Self-heal status inspection is a control-plane operation and must not execute inside Trinity.',
    canonical: {
      selfHealStatus: '/gpt/{gptId}',
    },
  },
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeAction(action: string | null | undefined): string | null {
  return typeof action === 'string' && action.trim().length > 0
    ? action.trim().toLowerCase()
    : null;
}

function isQueryLikeAction(action: string | null): boolean {
  return action === null || action === 'query' || action === GPT_QUERY_AND_WAIT_ACTION;
}

function normalizeMcpAction(action: string | null | undefined): McpControlAction | null {
  const normalizedAction = normalizeAction(action);
  if (normalizedAction === 'mcp.invoke' || normalizedAction === 'mcp.run') {
    return 'mcp.invoke';
  }

  if (
    normalizedAction === 'mcp.list_tools' ||
    normalizedAction === 'mcp.listtools' ||
    normalizedAction === 'mcp.list-tools'
  ) {
    return 'mcp.list_tools';
  }

  return null;
}

function normalizeDagControlAction(action: string | null | undefined): string | null {
  const normalizedAction = normalizeAction(action);
  return normalizedAction && normalizedAction.startsWith('dag.') ? normalizedAction : null;
}

function isExplicitWritingPlaneControlAction(
  action: GptDirectControlAction | null
): action is ExplicitWritingPlaneControlAction {
  return action === 'runtime.inspect' ||
    action === 'workers.status' ||
    action === 'queue.inspect' ||
    action === 'self_heal.status';
}

function buildUnsupportedControlActionCanonical() {
  return {
    supportedActions: GPT_DIRECT_CONTROL_ACTIONS.join(', '),
  };
}

function buildDagControlCanonical() {
  return {
    mcp: '/mcp',
    dispatch: '/dispatch',
    dagCapabilities: '/api/arcanos/capabilities',
    dagRuns: '/api/arcanos/dag/runs',
    dagRunStatus: '/api/arcanos/dag/runs/{runId}',
    dagTrace: '/api/arcanos/dag/runs/{runId}/trace',
  };
}

function buildDagControlClassification(params: {
  action: string;
  reason: string;
}): ControlWritingPlaneInputClassification {
  return {
    plane: 'control',
    kind: 'dag_control',
    action: params.action,
    reason: params.reason,
    errorCode: 'DAG_CONTROL_REQUIRES_DIRECT_ENDPOINT',
    message:
      "DAG execution must use /api/arcanos/dag/*, POST /mcp, or POST /dispatch with target='dag'.",
    canonical: buildDagControlCanonical(),
  };
}

function getString(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function readBodyMode(body: unknown): string | null {
  const normalizedBody = normalizeGptRequestBody(body);
  const mode = normalizedBody?.mode;
  return typeof mode === 'string' && mode.trim().length > 0
    ? mode.trim().toLowerCase()
    : null;
}

function readBodyStringField(body: unknown, key: string): string | null {
  const normalizedBody = normalizeGptRequestBody(body);
  if (!normalizedBody) {
    return null;
  }

  const direct = normalizedBody[key];
  if (typeof direct === 'string' && direct.trim().length > 0) {
    return direct.trim().toLowerCase();
  }

  const payload = isRecord(normalizedBody.payload) ? normalizedBody.payload : null;
  const payloadValue = payload?.[key];
  return typeof payloadValue === 'string' && payloadValue.trim().length > 0
    ? payloadValue.trim().toLowerCase()
    : null;
}

function detectEmbeddedMcpAction(body: unknown): McpControlAction | null {
  const normalizedBody = normalizeGptRequestBody(body);
  if (!normalizedBody) {
    return null;
  }

  const payloadRecord = isRecord(normalizedBody.payload) ? normalizedBody.payload : normalizedBody;
  const embeddedEnvelope = isRecord(payloadRecord.mcp) ? payloadRecord.mcp : payloadRecord;
  const envelopeAction =
    getString(embeddedEnvelope, 'action') ?? getString(embeddedEnvelope, 'operation');

  return normalizeMcpAction(envelopeAction);
}

function detectEmbeddedDagAction(body: unknown): string | null {
  const normalizedBody = normalizeGptRequestBody(body);
  if (!normalizedBody) {
    return null;
  }

  const payloadRecord = isRecord(normalizedBody.payload) ? normalizedBody.payload : normalizedBody;
  const embeddedEnvelope = isRecord(payloadRecord.dag) ? payloadRecord.dag : payloadRecord;
  const envelopeAction =
    getString(embeddedEnvelope, 'action') ?? getString(embeddedEnvelope, 'operation');

  return normalizeDagControlAction(envelopeAction);
}

export function classifyWritingPlaneInput(input: {
  body: unknown;
  promptText: string | null;
  requestedAction: string | null;
}): WritingPlaneInputClassification {
  const normalizedAction = normalizeAction(input.requestedAction);
  const normalizedMode = readBodyMode(input.body);
  const normalizedExecutionMode = readBodyStringField(input.body, 'executionMode');
  const normalizedTarget = readBodyStringField(input.body, 'target');
  const explicitDirectControlAction = normalizeGptDirectControlAction(normalizedAction);

  if (normalizedAction === GPT_GET_STATUS_ACTION) {
    return {
      plane: 'control',
      kind: 'job_status',
      action: GPT_GET_STATUS_ACTION,
      reason: 'explicit_action_get_status',
      errorCode: 'TRINITY_CONTROL_LEAK',
      message: 'Job status retrieval is control-plane only and must bypass the Trinity writing pipeline.',
      canonical: {
        poll: '/jobs/{jobId}/result',
      },
    };
  }

  if (normalizedAction === GPT_GET_RESULT_ACTION) {
    return {
      plane: 'control',
      kind: 'job_result',
      action: GPT_GET_RESULT_ACTION,
      reason: 'explicit_action_get_result',
      errorCode: 'TRINITY_CONTROL_LEAK',
      message: 'Job result retrieval is control-plane only and must bypass the Trinity writing pipeline.',
      canonical: {
        result: '/jobs/{jobId}/result',
      },
    };
  }

  if (normalizedAction === 'diagnostics') {
    return {
      plane: 'control',
      kind: 'diagnostics',
      action: 'diagnostics',
      reason: 'explicit_action_diagnostics',
      errorCode: 'TRINITY_CONTROL_LEAK',
      message: 'Diagnostics are control-plane operations and must not execute inside Trinity.',
      canonical: {
        diagnostics: '/status',
      },
    };
  }

  if (normalizedAction === 'system_state' || normalizedMode === 'system_state') {
    return {
      plane: 'control',
      kind: 'system_state',
      action: 'system_state',
      reason:
        normalizedAction === 'system_state'
          ? 'explicit_action_system_state'
          : 'explicit_mode_system_state',
      errorCode: 'TRINITY_CONTROL_LEAK',
      message: 'System state inspection is a control-plane operation and must not execute inside Trinity.',
      canonical: {
        systemState: '/gpt/arcanos-core',
      },
    };
  }

  if (isExplicitWritingPlaneControlAction(explicitDirectControlAction)) {
    const controlClassification =
      EXPLICIT_WRITING_PLANE_CONTROL_CLASSIFICATIONS[explicitDirectControlAction];

    return {
      plane: 'control',
      kind: controlClassification.kind,
      action: explicitDirectControlAction,
      reason: controlClassification.reason,
      errorCode: 'TRINITY_CONTROL_LEAK',
      message: controlClassification.message,
      canonical: controlClassification.canonical,
    };
  }

  if (normalizedAction && isReservedGptControlNamespace(normalizedAction)) {
    return {
      plane: 'control',
      kind: 'unsupported_control_action',
      action: normalizedAction,
      reason: 'unsupported_reserved_control_action',
      errorCode: 'UNSUPPORTED_GPT_ACTION',
      message: `Unsupported control action '${normalizedAction}'. Supported control actions: ${GPT_DIRECT_CONTROL_ACTIONS.join(', ')}.`,
      canonical: buildUnsupportedControlActionCanonical(),
    };
  }

  if (isQueryLikeAction(normalizedAction)) {
    const jobLookup = parseNaturalLanguageJobLookup(input.promptText);
    if (jobLookup) {
      const canonical = jobLookup.ok
        ? {
            poll: `/jobs/${jobLookup.jobId}/result`,
            result: `/jobs/${jobLookup.jobId}/result`,
          }
        : {
            poll: null,
            result: null,
          };

      if (!jobLookup.ok) {
        return {
          plane: 'control',
          kind: 'job_lookup',
          action: `${jobLookup.kind}_lookup`,
          reason: 'prompt_job_lookup_missing_job_id',
          errorCode: 'JOB_ID_REQUIRED',
          message:
            'Job retrieval prompts sent to /gpt/{gptId} must include a concrete job ID. Use the jobs API instead of prompting the GPT route.',
          canonical,
          jobLookup,
        };
      }

      return {
        plane: 'control',
        kind: 'job_lookup',
        action: `${jobLookup.kind}_lookup`,
        reason: 'prompt_job_lookup_rejected',
        errorCode: 'JOB_LOOKUP_REQUIRES_JOBS_API',
        message:
          'Job retrieval requests must use the jobs API. Do not send result or status lookups through POST /gpt/{gptId}.',
        canonical,
        jobLookup,
      };
    }
  }

  const explicitMcpAction =
    normalizeMcpAction(normalizedAction) ?? detectEmbeddedMcpAction(input.body);
  if (explicitMcpAction) {
    return {
      plane: 'control',
      kind: 'mcp_control',
      action: explicitMcpAction,
      reason: 'mcp_control_requires_mcp_transport',
      errorCode: 'MCP_CONTROL_REQUIRES_MCP_API',
      message:
        'MCP tool calls must use POST /mcp. Do not send MCP control requests through POST /gpt/{gptId}.',
      canonical: {
        mcp: '/mcp',
      },
    };
  }

  const explicitDagAction =
    normalizeDagControlAction(normalizedAction) ?? detectEmbeddedDagAction(input.body);
  if (explicitDagAction || normalizedExecutionMode === 'dag' || normalizedTarget === 'dag') {
    return buildDagControlClassification({
      action: explicitDagAction ?? normalizedAction ?? 'dag.run.create',
      reason: 'explicit_dag_control_action',
    });
  }

  if (
    isQueryLikeAction(normalizedAction) &&
    input.promptText &&
    shouldTreatPromptAsDagExecution(input.promptText, { requireDagTokenForArtifact: true })
  ) {
    return buildDagControlClassification({
      action: 'dag.run.create',
      reason: 'prompt_dag_control_requires_direct_endpoint',
    });
  }

  if (isQueryLikeAction(normalizedAction)) {
    const runtimeInspection = classifyRuntimeInspectionPrompt(input.promptText);
    if (runtimeInspection.detectedIntent === 'RUNTIME_INSPECTION_REQUIRED') {
      return {
        plane: 'control',
        kind: 'runtime_inspection',
        action: 'runtime.inspect',
        reason: 'runtime_control_requires_direct_endpoint',
        errorCode: 'CONTROL_PLANE_REQUIRES_DIRECT_ENDPOINT',
        message:
          'Runtime diagnostics, worker state, tracing, and queue inspection must use direct control-plane endpoints or POST /mcp. Do not send runtime control requests through POST /gpt/{gptId}.',
        canonical: {
          status: '/status',
          workers: '/workers/status',
          workerHealth: '/worker-helper/health',
          selfHeal: '/status/safety/self-heal',
          mcp: '/mcp',
        },
      };
    }
  }

  return {
    plane: 'writing',
    kind: 'writing',
    action: normalizedAction,
    reason: 'write_plane_request',
  };
}

export function isDirectControlPlaneKind(
  kind: WritingPlaneControlKind
): kind is DirectWritingPlaneControlKind {
  return (
    kind === 'job_status' ||
    kind === 'job_result' ||
    kind === 'diagnostics' ||
    kind === 'runtime_inspection_action' ||
    kind === 'workers_status_action' ||
    kind === 'queue_inspection_action' ||
    kind === 'self_heal_status_action' ||
    kind === 'system_state'
  );
}
