import type { PreparedClientJsonPayload } from '@shared/http/clientResponseCommon.js';
import {
  isRecord,
  measureJsonBytes,
  readBoolean,
  readString,
  resolveClientResponseMaxBytes,
  truncateText,
} from '@shared/http/clientResponseCommon.js';
import { prepareBoundedClientJsonPayload } from '@shared/http/clientJsonPayload.js';
import type { RequestScopedLogger } from '@shared/http/types.js';

import {
  buildGptControlResponseMeta,
  getGptExecutionPlanAvailableSections,
  type GptExecutionPlan,
  type GptExecutionPlanDetail,
} from './gptExecutionPlanner.js';

type ShapableControlAction = 'runtime.inspect' | 'self_heal.status';

type DetailPruneBudget = {
  maxDepth: number;
  maxArrayItems: number;
  maxStringBytes: number;
};

const DETAIL_PRUNE_BUDGETS: Record<GptExecutionPlanDetail, DetailPruneBudget> = {
  summary: {
    maxDepth: 2,
    maxArrayItems: 4,
    maxStringBytes: 240,
  },
  standard: {
    maxDepth: 3,
    maxArrayItems: 8,
    maxStringBytes: 1_024,
  },
  full: {
    maxDepth: 5,
    maxArrayItems: 24,
    maxStringBytes: 4_096,
  },
};

const PARTIAL_RESPONSE_MESSAGE =
  'Response exceeded public route bounds. Narrow sections or use a less verbose detail level.';

type PlannedControlPreparedResponse = PreparedClientJsonPayload<Record<string, unknown>> & {
  explicitTruncated: boolean;
};

function pruneForDetail(value: unknown, detail: GptExecutionPlanDetail, depth = 0): unknown {
  const budget = DETAIL_PRUNE_BUDGETS[detail];

  if (typeof value === 'string') {
    return truncateText(value, budget.maxStringBytes);
  }

  if (typeof value === 'number' || typeof value === 'boolean' || value === null) {
    return value;
  }

  if (Array.isArray(value)) {
    if (depth >= budget.maxDepth) {
      return { total: value.length };
    }

    return value
      .slice(0, budget.maxArrayItems)
      .map((entry) => pruneForDetail(entry, detail, depth + 1))
      .filter((entry) => entry !== undefined);
  }

  if (!isRecord(value)) {
    return undefined;
  }

  if (depth >= budget.maxDepth) {
    return undefined;
  }

  const output: Record<string, unknown> = {};
  for (const [key, entryValue] of Object.entries(value)) {
    const normalized = pruneForDetail(entryValue, detail, depth + 1);
    if (normalized !== undefined) {
      output[key] = normalized;
    }
  }

  return Object.keys(output).length > 0 ? output : undefined;
}

function mapSourceRecord(source: Record<string, unknown>): Record<string, unknown> {
  return {
    ...(readString(source.sourceType) ? { sourceType: readString(source.sourceType) } : {}),
    ...(readString(source.tool) ? { tool: readString(source.tool) } : {}),
    ...(Object.prototype.hasOwnProperty.call(source, 'data') ? { data: source.data } : {}),
  };
}

function buildRuntimeInspectionSectionCatalog(
  runtimeInspection: Record<string, unknown>,
): Record<string, unknown> {
  const sources = Array.isArray(runtimeInspection.sources)
    ? runtimeInspection.sources.filter(isRecord).map(mapSourceRecord)
    : [];

  const workerSources = sources.filter((source) => {
    const tool = readString(source.tool) ?? '';
    return tool === '/workers/status' ||
      tool === '/worker-helper/health' ||
      tool === 'cli:workers';
  });
  const memorySources = sources.filter((source) => (readString(source.tool) ?? '') === 'system.metrics');
  const eventSources = sources.filter((source) => {
    const tool = readString(source.tool) ?? '';
    return tool === '/api/self-heal/events' || tool === 'cli:logs_recent';
  });
  const traceSources = sources.filter((source) => (readString(source.tool) ?? '') === '/api/self-heal/inspection');

  return {
    workers: {
      sources: workerSources,
    },
    queues: {
      sources: workerSources,
    },
    memory: {
      metrics: memorySources,
    },
    incidents: {
      failures: Array.isArray(runtimeInspection.failures) ? runtimeInspection.failures : [],
      workerSources,
    },
    events: {
      eventSources,
    },
    trace: {
      detectedIntent: runtimeInspection.detectedIntent,
      matchedKeywords: runtimeInspection.matchedKeywords,
      toolsSelected: runtimeInspection.toolsSelected,
      runtimeEndpointsQueried: runtimeInspection.runtimeEndpointsQueried,
      repoInspectionDisabled: runtimeInspection.repoInspectionDisabled,
      onlyReturnRuntimeValues: runtimeInspection.onlyReturnRuntimeValues,
      evidence: runtimeInspection.evidence,
      traceSources,
    },
  };
}

function buildSelfHealSectionCatalog(
  selfHealStatus: Record<string, unknown>,
): Record<string, unknown> {
  const predictiveHealing = isRecord(selfHealStatus.predictiveHealing)
    ? selfHealStatus.predictiveHealing
    : null;
  const recentObservations = Array.isArray(predictiveHealing?.recentObservations)
    ? predictiveHealing.recentObservations
    : [];
  const latestObservation = recentObservations.length > 0
    ? recentObservations[recentObservations.length - 1]
    : null;
  const inspection = isRecord(selfHealStatus.inspection)
    ? selfHealStatus.inspection
    : null;

  return {
    system: {
      status: selfHealStatus.status,
      enabled: selfHealStatus.enabled,
      active: selfHealStatus.active,
      isHealing: selfHealStatus.isHealing,
      systemState: selfHealStatus.systemState,
      trinity: selfHealStatus.trinity,
    },
    workers: {
      loopRunning: selfHealStatus.loopRunning,
      inFlight: selfHealStatus.inFlight,
      lastDiagnosis: selfHealStatus.lastDiagnosis,
      lastAction: selfHealStatus.lastAction,
      lastActionAt: selfHealStatus.lastActionAt,
      inspection: inspection
        ? {
            lastDispatchAttempt: inspection.lastDispatchAttempt,
            lastDispatchTarget: inspection.lastDispatchTarget,
            lastWorkerReceipt: inspection.lastWorkerReceipt,
            lastHealResult: inspection.lastHealResult,
          }
        : null,
    },
    memory: {
      latestObservation,
      aiProvider: predictiveHealing?.aiProvider ?? null,
      trends: predictiveHealing?.trends ?? null,
    },
    incidents: {
      degradedModeReason: selfHealStatus.degradedModeReason,
      activeMitigation: selfHealStatus.activeMitigation,
      recentTimeoutCounts: selfHealStatus.recentTimeoutCounts,
      lastError: selfHealStatus.lastError,
      lastFailure: selfHealStatus.lastFailure,
      lastFallback: selfHealStatus.lastFallback,
      promptRouteMitigation: selfHealStatus.promptRouteMitigation,
    },
    events: {
      recentEvents: Array.isArray(selfHealStatus.recentEvents) ? selfHealStatus.recentEvents : [],
    },
    trace: {
      inspection,
      loop: selfHealStatus.loop,
      controlLoop: selfHealStatus.controlLoop,
      lastVerificationResult: selfHealStatus.lastVerificationResult,
    },
    predictive: predictiveHealing,
  };
}

function buildRuntimeInspectionSummary(runtimeInspection: Record<string, unknown>): string {
  const explicitSummary = readString(runtimeInspection.summary);
  if (explicitSummary) {
    return explicitSummary;
  }

  const selectedTools = Array.isArray(runtimeInspection.toolsSelected)
    ? runtimeInspection.toolsSelected.length
    : 0;
  return `Collected live runtime state from ${selectedTools} runtime sources.`;
}

function buildSelfHealSummary(selfHealStatus: Record<string, unknown>): string {
  const status = readString(selfHealStatus.status) ?? 'ok';
  const enabled = readBoolean(selfHealStatus.enabled);
  const active = readBoolean(selfHealStatus.active);
  const isHealing = readBoolean(selfHealStatus.isHealing);
  const lastAction = readString(selfHealStatus.lastHealAction) ?? readString(selfHealStatus.lastAction);
  const systemState = isRecord(selfHealStatus.systemState)
    ? readString(selfHealStatus.systemState.status)
    : null;

  return truncateText(
    `Self-heal status is ${status}; enabled=${enabled === true}; active=${active === true}; healing=${isHealing === true}; lastAction=${lastAction ?? 'unknown'}; systemState=${systemState ?? 'unknown'}.`,
    240,
  );
}

function buildShapedSections(
  catalog: Record<string, unknown>,
  sections: string[],
  detail: GptExecutionPlanDetail,
): Record<string, unknown> {
  const shapedSections: Record<string, unknown> = {};

  for (const section of sections) {
    if (!Object.prototype.hasOwnProperty.call(catalog, section)) {
      continue;
    }

    const pruned = pruneForDetail(catalog[section], detail);
    if (pruned !== undefined) {
      shapedSections[section] = pruned;
    }
  }

  return shapedSections;
}

function buildRuntimeInspectionEnvelope(params: {
  action: 'runtime.inspect';
  rawResult: Record<string, unknown>;
  plan: GptExecutionPlan<'runtime.inspect'>;
  routeMeta: Record<string, unknown>;
  generatedAt: string;
  returnedSections: string[];
  omittedSections: string[];
  truncated: boolean;
}): Record<string, unknown> {
  const runtimeInspection = isRecord(params.rawResult.runtimeInspection)
    ? params.rawResult.runtimeInspection
    : {};
  const catalog = buildRuntimeInspectionSectionCatalog(runtimeInspection);
  const shapedSections = buildShapedSections(catalog, params.returnedSections, params.plan.detail);
  const actualReturnedSections = Object.keys(shapedSections);

  return {
    ok: true,
    action: params.action,
    ...(params.truncated ? { status: 'partial' } : {}),
    result: {
      handledBy: readString(params.rawResult.handledBy) ?? 'runtime-inspection',
      runtimeInspection: {
        status: readString(runtimeInspection.status) ?? 'ok',
        summary: buildRuntimeInspectionSummary(runtimeInspection),
        ...(actualReturnedSections.length > 0 ? { sections: shapedSections } : {}),
      },
    },
    meta: buildGptControlResponseMeta({
      plan: params.plan,
      generatedAt: params.generatedAt,
      availableSections: getGptExecutionPlanAvailableSections(params.action),
      truncated: params.truncated,
      returnedSections: actualReturnedSections,
      omittedSections: params.omittedSections,
    }),
    ...(params.truncated ? { message: PARTIAL_RESPONSE_MESSAGE } : {}),
    _route: params.routeMeta,
  };
}

function buildSelfHealEnvelope(params: {
  action: 'self_heal.status';
  rawResult: Record<string, unknown>;
  plan: GptExecutionPlan<'self_heal.status'>;
  routeMeta: Record<string, unknown>;
  generatedAt: string;
  returnedSections: string[];
  omittedSections: string[];
  truncated: boolean;
}): Record<string, unknown> {
  const catalog = buildSelfHealSectionCatalog(params.rawResult);
  const shapedSections = buildShapedSections(catalog, params.returnedSections, params.plan.detail);
  const actualReturnedSections = Object.keys(shapedSections);

  return {
    ok: true,
    action: params.action,
    ...(params.truncated ? { status: 'partial' } : {}),
    result: {
      status: readString(params.rawResult.status) ?? 'ok',
      ...(readBoolean(params.rawResult.enabled) !== undefined
        ? { enabled: readBoolean(params.rawResult.enabled) }
        : {}),
      ...(readBoolean(params.rawResult.active) !== undefined
        ? { active: readBoolean(params.rawResult.active) }
        : {}),
      ...(readBoolean(params.rawResult.isHealing) !== undefined
        ? { isHealing: readBoolean(params.rawResult.isHealing) }
        : {}),
      ...(readString(params.rawResult.lastHealAction)
        ? { lastHealAction: readString(params.rawResult.lastHealAction) }
        : {}),
      ...(readString(params.rawResult.lastHealRun)
        ? { lastHealRun: readString(params.rawResult.lastHealRun) }
        : {}),
      ...(readString(params.rawResult.lastTriggerReason)
        ? { lastTriggerReason: readString(params.rawResult.lastTriggerReason) }
        : {}),
      ...(readString(params.rawResult.lastHealedComponent)
        ? { lastHealedComponent: readString(params.rawResult.lastHealedComponent) }
        : {}),
      summary: buildSelfHealSummary(params.rawResult),
      ...(actualReturnedSections.length > 0 ? { sections: shapedSections } : {}),
    },
    meta: buildGptControlResponseMeta({
      plan: params.plan,
      generatedAt: params.generatedAt,
      availableSections: getGptExecutionPlanAvailableSections(params.action),
      truncated: params.truncated,
      returnedSections: actualReturnedSections,
      omittedSections: params.omittedSections,
    }),
    ...(params.truncated ? { message: PARTIAL_RESPONSE_MESSAGE } : {}),
    _route: params.routeMeta,
  };
}

function buildMinimalPartialEnvelope(params: {
  action: ShapableControlAction;
  rawResult: Record<string, unknown>;
  plan: GptExecutionPlan<ShapableControlAction>;
  routeMeta: Record<string, unknown>;
  generatedAt: string;
  omittedSections: string[];
}): Record<string, unknown> {
  if (params.action === 'runtime.inspect') {
    const runtimeInspection = isRecord(params.rawResult.runtimeInspection)
      ? params.rawResult.runtimeInspection
      : {};

    return {
      ok: true,
      action: params.action,
      status: 'partial',
      result: {
        handledBy: readString(params.rawResult.handledBy) ?? 'runtime-inspection',
        runtimeInspection: {
          status: readString(runtimeInspection.status) ?? 'ok',
          summary: buildRuntimeInspectionSummary(runtimeInspection),
        },
      },
      meta: buildGptControlResponseMeta({
        plan: params.plan,
        generatedAt: params.generatedAt,
        availableSections: getGptExecutionPlanAvailableSections(params.action),
        truncated: true,
        omittedSections: params.omittedSections,
      }),
      message: PARTIAL_RESPONSE_MESSAGE,
      _route: params.routeMeta,
    };
  }

  return {
    ok: true,
    action: params.action,
    status: 'partial',
    result: {
      status: readString(params.rawResult.status) ?? 'ok',
      ...(readBoolean(params.rawResult.enabled) !== undefined
        ? { enabled: readBoolean(params.rawResult.enabled) }
        : {}),
      ...(readBoolean(params.rawResult.active) !== undefined
        ? { active: readBoolean(params.rawResult.active) }
        : {}),
      summary: buildSelfHealSummary(params.rawResult),
    },
    meta: buildGptControlResponseMeta({
      plan: params.plan,
      generatedAt: params.generatedAt,
      availableSections: getGptExecutionPlanAvailableSections(params.action),
      truncated: true,
      omittedSections: params.omittedSections,
    }),
    message: PARTIAL_RESPONSE_MESSAGE,
    _route: params.routeMeta,
  };
}

function buildEnvelope(params: {
  action: ShapableControlAction;
  rawResult: Record<string, unknown>;
  plan: GptExecutionPlan<ShapableControlAction>;
  routeMeta: Record<string, unknown>;
  generatedAt: string;
  returnedSections: string[];
  omittedSections: string[];
  truncated: boolean;
}): Record<string, unknown> {
  return params.action === 'runtime.inspect'
    ? buildRuntimeInspectionEnvelope({
        action: params.action,
        rawResult: params.rawResult,
        plan: params.plan as GptExecutionPlan<'runtime.inspect'>,
        routeMeta: params.routeMeta,
        generatedAt: params.generatedAt,
        returnedSections: params.returnedSections,
        omittedSections: params.omittedSections,
        truncated: params.truncated,
      })
    : buildSelfHealEnvelope({
        action: params.action,
        rawResult: params.rawResult,
        plan: params.plan as GptExecutionPlan<'self_heal.status'>,
        routeMeta: params.routeMeta,
        generatedAt: params.generatedAt,
        returnedSections: params.returnedSections,
        omittedSections: params.omittedSections,
        truncated: params.truncated,
      });
}

export function prepareShapedControlResponse(params: {
  action: ShapableControlAction;
  rawResult: Record<string, unknown>;
  plan: GptExecutionPlan<ShapableControlAction>;
  routeMeta: Record<string, unknown>;
  logger?: RequestScopedLogger;
  logEvent?: string;
}): PlannedControlPreparedResponse {
  const maxResponseBytes = resolveClientResponseMaxBytes();
  const generatedAt = new Date().toISOString();
  const initialReturnedSections = [...params.plan.sections];
  let returnedSections = [...initialReturnedSections];
  let omittedSections: string[] = [];
  let explicitTruncated = false;
  let envelope = buildEnvelope({
    action: params.action,
    rawResult: params.rawResult,
    plan: params.plan,
    routeMeta: params.routeMeta,
    generatedAt,
    returnedSections,
    omittedSections,
    truncated: false,
  });

  while (measureJsonBytes(envelope) > maxResponseBytes && returnedSections.length > 0) {
    explicitTruncated = true;
    const removedSection = returnedSections.pop();
    if (removedSection) {
      omittedSections = [...omittedSections, removedSection];
    }
    envelope = buildEnvelope({
      action: params.action,
      rawResult: params.rawResult,
      plan: params.plan,
      routeMeta: params.routeMeta,
      generatedAt,
      returnedSections,
      omittedSections,
      truncated: true,
    });
  }

  if (measureJsonBytes(envelope) > maxResponseBytes) {
    explicitTruncated = true;
    omittedSections = [...initialReturnedSections];
    returnedSections = [];
    envelope = buildMinimalPartialEnvelope({
      action: params.action,
      rawResult: params.rawResult,
      plan: params.plan,
      routeMeta: params.routeMeta,
      generatedAt,
      omittedSections,
    });
  }

  let preparedPayload = prepareBoundedClientJsonPayload(envelope, {
    logger: params.logger,
    logEvent: params.logEvent,
    maxBytes: maxResponseBytes,
  });

  if (preparedPayload.truncated) {
    explicitTruncated = true;
    preparedPayload = prepareBoundedClientJsonPayload(
      buildMinimalPartialEnvelope({
        action: params.action,
        rawResult: params.rawResult,
        plan: params.plan,
        routeMeta: params.routeMeta,
        generatedAt,
        omittedSections: [...initialReturnedSections],
      }),
      {
        logger: params.logger,
        logEvent: params.logEvent,
        maxBytes: maxResponseBytes,
      },
    );
  }

  return {
    ...preparedPayload,
    explicitTruncated,
  };
}
