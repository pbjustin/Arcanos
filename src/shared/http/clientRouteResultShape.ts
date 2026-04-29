import {
  INTERNAL_RESPONSE_KEYS,
  STRING_PREVIEW_MAX_BYTES,
  isRecord,
  readBoolean,
  readNumber,
  readString,
  readStringArray,
  truncateText,
} from './clientResponseCommon.js';

function pickTrinitySummary(value: Record<string, unknown>): Record<string, unknown> | null {
  const result = readString(value.result);
  const moduleName = readString(value.module);

  if (!result || !moduleName) {
    return null;
  }

  const trinityMeta = pickTrinityPublicMeta(value.meta);

  return {
    result,
    module: moduleName,
    ...(readString(value.activeModel) ? { activeModel: readString(value.activeModel) } : {}),
    ...(readBoolean(value.fallbackFlag) !== undefined ? { fallbackFlag: readBoolean(value.fallbackFlag) } : {}),
    ...(readStringArray(value.routingStages) ? { routingStages: readStringArray(value.routingStages) } : {}),
    ...(readBoolean(value.gpt5Used) !== undefined ? { gpt5Used: readBoolean(value.gpt5Used) } : {}),
    ...(readString(value.gpt5Model) ? { gpt5Model: readString(value.gpt5Model) } : {}),
    ...(readBoolean(value.dryRun) !== undefined ? { dryRun: readBoolean(value.dryRun) } : {}),
    ...(readString(value.error) ? { error: readString(value.error) } : {}),
    ...(trinityMeta ? { meta: trinityMeta } : {}),
  };
}

function pickTrinityPublicMeta(value: unknown): Record<string, unknown> | null {
  if (!isRecord(value)) {
    return null;
  }

  const output: Record<string, unknown> = {
    ...(readString(value.pipeline) ? { pipeline: readString(value.pipeline) } : {}),
    ...(readBoolean(value.bypass) !== undefined ? { bypass: readBoolean(value.bypass) } : {}),
    ...(readString(value.sourceEndpoint) ? { sourceEndpoint: readString(value.sourceEndpoint) } : {}),
    ...(readString(value.classification) ? { classification: readString(value.classification) } : {}),
    ...(readString(value.gptId) ? { gptId: readString(value.gptId) } : {}),
    ...(readString(value.moduleId) ? { moduleId: readString(value.moduleId) } : {}),
    ...(readString(value.requestedAction) ? { requestedAction: readString(value.requestedAction) } : {}),
    ...(readString(value.executionMode) ? { executionMode: readString(value.executionMode) } : {}),
    ...(readNumber(value.tokenLimit) !== undefined ? { tokenLimit: readNumber(value.tokenLimit) } : {}),
    ...(readNumber(value.outputLimit) !== undefined ? { outputLimit: readNumber(value.outputLimit) } : {}),
    ...(readBoolean(value.cached) !== undefined ? { cached: readBoolean(value.cached) } : {}),
    ...(readBoolean(value.cacheHit) !== undefined ? { cacheHit: readBoolean(value.cacheHit) } : {}),
  };

  const tokens = pickTrinityPublicTokenMeta(value.tokens);
  if (tokens) {
    output.tokens = tokens;
  }

  const cache = pickTrinityPublicCacheMeta(value.cache);
  if (cache) {
    output.cache = cache;
  }

  return Object.keys(output).length > 0 ? output : null;
}

function pickTrinityPublicTokenMeta(value: unknown): Record<string, number> | null {
  if (!isRecord(value)) {
    return null;
  }

  const output: Record<string, number> = {};
  for (const key of ['prompt_tokens', 'completion_tokens', 'total_tokens'] as const) {
    const numberValue = readNumber(value[key]);
    if (numberValue !== undefined) {
      output[key] = numberValue;
    }
  }

  return Object.keys(output).length > 0 ? output : null;
}

function pickTrinityPublicCacheMeta(value: unknown): Record<string, boolean> | null {
  if (!isRecord(value)) {
    return null;
  }

  const hit = readBoolean(value.hit);
  return hit === undefined ? null : { hit };
}

function pickHealthSummary(value: Record<string, unknown>): Record<string, unknown> | null {
  const status = readString(value.status);
  const summary = readString(value.summary);

  if (!status && !summary) {
    return null;
  }

  return {
    ...(status ? { status } : {}),
    ...(summary ? { summary } : {}),
    ...(readString(value.timestamp) ? { timestamp: readString(value.timestamp) } : {}),
  };
}

function pickModulesSummary(value: Record<string, unknown>): Record<string, unknown> | null {
  const rawModules = Array.isArray(value.value)
    ? value.value
    : Array.isArray(value.modules)
      ? value.modules
      : null;

  if (!rawModules) {
    return null;
  }

  const modules = rawModules
    .filter(isRecord)
    .slice(0, 16)
    .map((entry) => {
      const definition = isRecord(entry.definition) ? entry.definition : null;
      return {
        ...(readString(entry.route) ? { route: readString(entry.route) } : {}),
        ...(definition && readString(definition.name) ? { name: readString(definition.name) } : {}),
        ...(definition && readString(definition.description)
          ? { description: truncateText(readString(definition.description) as string, 240) }
          : {}),
        ...(definition && readString(definition.defaultAction)
          ? { defaultAction: readString(definition.defaultAction) }
          : {}),
        ...(definition && readStringArray(definition.gptIds, 6)
          ? { gptIds: readStringArray(definition.gptIds, 6) }
          : {}),
      };
    });

  return {
    total: rawModules.length,
    modules,
  };
}

function computeNodeDurationMs(node: Record<string, unknown>): number | undefined {
  const startedAt = readString(node.startedAt);
  const completedAt = readString(node.completedAt);
  if (!startedAt || !completedAt) {
    return undefined;
  }

  const startedAtMs = Date.parse(startedAt);
  const completedAtMs = Date.parse(completedAt);
  if (!Number.isFinite(startedAtMs) || !Number.isFinite(completedAtMs) || completedAtMs < startedAtMs) {
    return undefined;
  }

  return completedAtMs - startedAtMs;
}

function pickDagTraceNodeSummary(node: Record<string, unknown>): Record<string, unknown> {
  const nodeId = readString(node.nodeId);
  const agentRole = readString(node.agentRole);
  const jobType = readString(node.jobType);
  const status = readString(node.status);
  const workerId = readString(node.workerId);
  const startedAt = readString(node.startedAt);
  const completedAt = readString(node.completedAt);
  const spawnDepth = readNumber(node.spawnDepth);
  const durationMs = computeNodeDurationMs(node);

  return {
    ...(nodeId ? { nodeId } : {}),
    ...(agentRole ? { agentRole } : {}),
    ...(jobType ? { jobType } : {}),
    ...(status ? { status } : {}),
    ...(workerId ? { workerId } : {}),
    ...(startedAt ? { startedAt } : {}),
    ...(completedAt ? { completedAt } : {}),
    ...(spawnDepth !== undefined ? { spawnDepth } : {}),
    ...(durationMs !== undefined ? { durationMs } : {}),
  };
}

function pickDagRunSummary(run: Record<string, unknown>): Record<string, unknown> {
  const runId = readString(run.runId);
  const sessionId = readString(run.sessionId);
  const status = readString(run.status);
  const template = readString(run.template);
  const durationMs = readNumber(run.durationMs);
  const totalNodes = readNumber(run.totalNodes);
  const completedNodes = readNumber(run.completedNodes);
  const failedNodes = readNumber(run.failedNodes);
  const createdAt = readString(run.createdAt);
  const updatedAt = readString(run.updatedAt);

  return {
    ...(runId ? { runId } : {}),
    ...(sessionId ? { sessionId } : {}),
    ...(status ? { status } : {}),
    ...(template ? { template } : {}),
    ...(durationMs !== undefined ? { durationMs } : {}),
    ...(totalNodes !== undefined ? { totalNodes } : {}),
    ...(completedNodes !== undefined ? { completedNodes } : {}),
    ...(failedNodes !== undefined ? { failedNodes } : {}),
    ...(createdAt ? { createdAt } : {}),
    ...(updatedAt ? { updatedAt } : {}),
  };
}

function pickDagMetricsSummary(metricBody: Record<string, unknown>): Record<string, unknown> {
  const totalNodes = readNumber(metricBody.totalNodes);
  const totalAiCalls = readNumber(metricBody.totalAiCalls);
  const totalRetries = readNumber(metricBody.totalRetries);
  const totalFailures = readNumber(metricBody.totalFailures);
  const wallClockDurationMs = readNumber(metricBody.wallClockDurationMs);
  const maxParallelNodesObserved = readNumber(metricBody.maxParallelNodesObserved);
  const maxSpawnDepthObserved = readNumber(metricBody.maxSpawnDepthObserved);

  return {
    ...(totalNodes !== undefined ? { totalNodes } : {}),
    ...(totalAiCalls !== undefined ? { totalAiCalls } : {}),
    ...(totalRetries !== undefined ? { totalRetries } : {}),
    ...(totalFailures !== undefined ? { totalFailures } : {}),
    ...(wallClockDurationMs !== undefined ? { wallClockDurationMs } : {}),
    ...(maxParallelNodesObserved !== undefined ? { maxParallelNodesObserved } : {}),
    ...(maxSpawnDepthObserved !== undefined ? { maxSpawnDepthObserved } : {}),
  };
}

function pickDagVerificationSummary(verificationBody: Record<string, unknown>): Record<string, unknown> {
  const runCompleted = readBoolean(verificationBody.runCompleted);
  const parallelExecutionObserved = readBoolean(verificationBody.parallelExecutionObserved);
  const aggregationRanLast = readBoolean(verificationBody.aggregationRanLast);
  const retryPolicyRespected = readBoolean(verificationBody.retryPolicyRespected);
  const budgetPolicyRespected = readBoolean(verificationBody.budgetPolicyRespected);
  const loopDetected = readBoolean(verificationBody.loopDetected);

  return {
    ...(runCompleted !== undefined ? { runCompleted } : {}),
    ...(parallelExecutionObserved !== undefined ? { parallelExecutionObserved } : {}),
    ...(aggregationRanLast !== undefined ? { aggregationRanLast } : {}),
    ...(retryPolicyRespected !== undefined ? { retryPolicyRespected } : {}),
    ...(budgetPolicyRespected !== undefined ? { budgetPolicyRespected } : {}),
    ...(loopDetected !== undefined ? { loopDetected } : {}),
  };
}

function pickDagLineageSummary(lineage: Record<string, unknown>): Record<string, unknown> {
  const loopDetected = readBoolean(lineage.loopDetected);

  return {
    ...(Array.isArray(lineage.lineage) ? { total: lineage.lineage.length } : {}),
    ...(loopDetected !== undefined ? { loopDetected } : {}),
  };
}

function pickDagErrorsSummary(errors: Record<string, unknown>): Record<string, unknown> {
  return {
    ...(Array.isArray(errors.errors) ? { total: errors.errors.length } : {}),
  };
}

function pickDagTraceSummary(value: Record<string, unknown>): Record<string, unknown> | null {
  const run = isRecord(value.run) ? value.run : null;
  const tree = isRecord(value.tree) ? value.tree : null;
  if (!run || !tree) {
    return null;
  }

  const nodes = Array.isArray(tree.nodes)
    ? tree.nodes
        .filter(isRecord)
        .slice(0, 32)
        .map((node) => pickDagTraceNodeSummary(node))
    : [];

  const metrics = isRecord(value.metrics) ? value.metrics : null;
  const metricBody = metrics && isRecord(metrics.metrics) ? metrics.metrics : null;
  const verification = isRecord(value.verification) ? value.verification : null;
  const verificationBody = verification && isRecord(verification.verification) ? verification.verification : null;
  const sections = isRecord(value.sections) ? pruneGenericValue(value.sections) : undefined;
  const lineage = isRecord(value.lineage) ? value.lineage : null;
  const errors = isRecord(value.errors) ? value.errors : null;

  return {
    run: pickDagRunSummary(run),
    nodes,
    ...(metricBody ? { metrics: pickDagMetricsSummary(metricBody) } : {}),
    ...(verificationBody ? { verification: pickDagVerificationSummary(verificationBody) } : {}),
    ...(lineage ? { lineage: pickDagLineageSummary(lineage) } : {}),
    ...(errors ? { errors: pickDagErrorsSummary(errors) } : {}),
    ...(sections !== undefined ? { sections } : {}),
  };
}

function extractMcpText(value: Record<string, unknown>): string | null {
  if (!Array.isArray(value.content)) {
    return null;
  }

  const parts = value.content
    .filter(isRecord)
    .map((item) => readString(item.text))
    .filter((item): item is string => typeof item === 'string');

  if (parts.length === 0) {
    return null;
  }

  return parts.join('\n').trim();
}

function pruneGenericValue(value: unknown, depth = 0): unknown {
  if (typeof value === 'string') {
    return truncateText(value, STRING_PREVIEW_MAX_BYTES);
  }

  if (typeof value === 'number' || typeof value === 'boolean' || value === null) {
    return value;
  }

  if (Array.isArray(value)) {
    if (depth >= 2) {
      return { total: value.length };
    }

    return value.slice(0, 8).map((item) => pruneGenericValue(item, depth + 1));
  }

  if (!isRecord(value)) {
    return undefined;
  }

  if (depth >= 3) {
    return undefined;
  }

  const output: Record<string, unknown> = {};
  for (const [key, entryValue] of Object.entries(value)) {
    if (INTERNAL_RESPONSE_KEYS.has(key)) {
      continue;
    }

    const normalized = pruneGenericValue(entryValue, depth + 1);
    if (normalized !== undefined) {
      output[key] = normalized;
    }
  }

  return Object.keys(output).length > 0 ? output : undefined;
}

function shapeMcpToolOutput(toolName: string | undefined, rawResult: unknown): unknown {
  if (!isRecord(rawResult)) {
    return rawResult;
  }

  const structured = isRecord(rawResult.structuredContent) ? rawResult.structuredContent : rawResult;

  if (structured) {
    const trinitySummary = pickTrinitySummary(structured);
    if (trinitySummary) {
      return trinitySummary;
    }

    const healthSummary = pickHealthSummary(structured);
    if (healthSummary) {
      return healthSummary;
    }

    if (toolName === 'modules.list') {
      const modulesSummary = pickModulesSummary(structured);
      if (modulesSummary) {
        return modulesSummary;
      }
    }

    if (toolName === 'dag.run.trace') {
      const dagTraceSummary = pickDagTraceSummary(structured);
      if (dagTraceSummary) {
        return dagTraceSummary;
      }
    }

    const genericStructured = pruneGenericValue(structured);
    if (genericStructured !== undefined) {
      return genericStructured;
    }
  }

  const text = extractMcpText(rawResult);
  if (text) {
    return { text: truncateText(text, STRING_PREVIEW_MAX_BYTES) };
  }

  const genericRaw = pruneGenericValue(rawResult);
  return genericRaw ?? { ok: true };
}

function shapeMcpDispatchResult(value: Record<string, unknown>): Record<string, unknown> | null {
  if (value.handledBy !== 'mcp-dispatcher' || !isRecord(value.mcp)) {
    return null;
  }

  const mcpAction = readString(value.mcp.action) ?? 'invoke';
  const toolName = readString(value.mcp.toolName);

  return {
    handledBy: 'mcp-dispatcher',
    mcp: {
      action: mcpAction,
      ...(toolName ? { toolName } : {}),
      ...(readString(value.mcp.dispatchMode) ? { dispatchMode: readString(value.mcp.dispatchMode) } : {}),
      ...(readString(value.mcp.reason) ? { reason: readString(value.mcp.reason) } : {}),
      output: shapeMcpToolOutput(toolName, value.mcp.output ?? value.mcp.result),
    },
  };
}

function shapeRepoInspectionResult(value: Record<string, unknown>): Record<string, unknown> | null {
  if (value.handledBy !== 'repo-inspection' || !isRecord(value.repoInspection)) {
    return null;
  }

  return {
    handledBy: 'repo-inspection',
    repoInspection: {
      ...(readString(value.repoInspection.reason) ? { reason: readString(value.repoInspection.reason) } : {}),
      answer: readString(value.repoInspection.answer) ?? 'Repository inspection completed.',
    },
  };
}

function shapeMemoryDispatchResult(value: Record<string, unknown>): Record<string, unknown> | null {
  if (value.handledBy !== 'memory-dispatcher' || !isRecord(value.memory)) {
    return null;
  }

  const output = pruneGenericValue(value.memory);
  return {
    handledBy: 'memory-dispatcher',
    ...(output !== undefined ? { memory: output } : {}),
  };
}

function shapeDagDispatchResult(value: Record<string, unknown>): Record<string, unknown> | null {
  if (value.handledBy !== 'dag-dispatcher' || !isRecord(value.dag)) {
    return null;
  }

  const followUp = isRecord(value.dag.followUp)
    ? {
        ...(readString(value.dag.followUp.runId) ? { runId: readString(value.dag.followUp.runId) } : {}),
        ...(readString(value.dag.followUp.trace) ? { trace: readString(value.dag.followUp.trace) } : {}),
        ...(readString(value.dag.followUp.tree) ? { tree: readString(value.dag.followUp.tree) } : {}),
        ...(readString(value.dag.followUp.lineage) ? { lineage: readString(value.dag.followUp.lineage) } : {}),
        ...(readString(value.dag.followUp.metrics) ? { metrics: readString(value.dag.followUp.metrics) } : {}),
        ...(readString(value.dag.followUp.errors) ? { errors: readString(value.dag.followUp.errors) } : {}),
        ...(readString(value.dag.followUp.verification)
          ? { verification: readString(value.dag.followUp.verification) }
          : {}),
      }
    : undefined;
  const deferredTools = isRecord(value.dag.deferredTools)
    ? {
        ...(readNumber(value.dag.deferredTools.total) !== undefined
          ? { total: readNumber(value.dag.deferredTools.total) }
          : {}),
        ...(readStringArray(value.dag.deferredTools.tools, 12)
          ? { tools: readStringArray(value.dag.deferredTools.tools, 12) }
          : {}),
      }
    : undefined;

  return {
    handledBy: 'dag-dispatcher',
    dag: {
      ...(readString(value.dag.dispatchMode) ? { dispatchMode: readString(value.dag.dispatchMode) } : {}),
      ...(readString(value.dag.reason) ? { reason: readString(value.dag.reason) } : {}),
      ...(readString(value.dag.summary) ? { summary: readString(value.dag.summary) } : {}),
      ...(readString(value.dag.runId) ? { runId: readString(value.dag.runId) } : {}),
      ...(isRecord(value.dag.run) ? { run: pickDagRunSummary(value.dag.run) } : {}),
      ...(readStringArray(value.dag.artifactKeys, 12) ? { artifactKeys: readStringArray(value.dag.artifactKeys, 12) } : {}),
      ...(followUp && Object.keys(followUp).length > 0 ? { followUp } : {}),
      ...(deferredTools && Object.keys(deferredTools).length > 0 ? { deferredTools } : {}),
    },
  };
}

function pickRuntimeInspectionEvidenceItem(value: unknown): Record<string, unknown> | null {
  if (!isRecord(value)) {
    return null;
  }

  const output: Record<string, unknown> = {};
  const timestamp = readString(value.ts) ?? readString(value.timestamp);
  const type = readString(value.type) ?? readString(value.kind);
  const source = readString(value.source);
  const eventId = readString(value.eventId) ?? readString(value.id);
  const requestId = readString(value.requestId);
  const traceId = readString(value.traceId);
  const correlationId = readString(value.correlationId);

  if (timestamp) {
    output.ts = timestamp;
  }

  if (type) {
    output.type = type;
  }

  if (source) {
    output.source = source;
  }

  if (eventId) {
    output.eventId = eventId;
  }

  if (requestId) {
    output.requestId = requestId;
  }

  if (traceId) {
    output.traceId = traceId;
  }

  if (correlationId) {
    output.correlationId = correlationId;
  }

  const payload = pruneGenericValue(value.payload);
  if (payload !== undefined || value.payload === null) {
    output.payload = payload ?? null;
  }

  return Object.keys(output).length > 0 ? output : null;
}

function pickRuntimeInspectionEvidenceArray(value: unknown, maxItems = 12): Record<string, unknown>[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  return value
    .slice(0, maxItems)
    .map((item) => pickRuntimeInspectionEvidenceItem(item))
    .filter((item): item is Record<string, unknown> => item !== null);
}

function pickRuntimeInspectionSources(value: unknown, maxItems = 12): Record<string, unknown>[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const items = value
    .filter(isRecord)
    .slice(0, maxItems)
    .map((entry) => {
      const data = isRecord(entry.data) ? entry.data : null;
      const observedAt = data ? readString(data.timestamp) : undefined;

      return {
        ...(readString(entry.tool) ? { tool: readString(entry.tool) } : {}),
        ...(readString(entry.sourceType) ? { sourceType: readString(entry.sourceType) } : {}),
        ...(observedAt ? { observedAt } : {}),
      };
    })
    .filter((entry) => Object.keys(entry).length > 0);

  return items.length > 0 ? items : undefined;
}

function pickRuntimeInspectionFailures(value: unknown, maxItems = 8): Record<string, unknown>[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const items = value
    .filter(isRecord)
    .slice(0, maxItems)
    .map((entry) => ({
      ...(readString(entry.tool) ? { tool: readString(entry.tool) } : {}),
      ...(readString(entry.sourceType) ? { sourceType: readString(entry.sourceType) } : {}),
      ...(readString(entry.error) ? { error: truncateText(readString(entry.error) as string, 320) } : {}),
    }))
    .filter((entry) => Object.keys(entry).length > 0);

  return items.length > 0 ? items : undefined;
}

function pickSelfHealRuntimeInspectionSnapshot(value: unknown): Record<string, unknown> | null {
  if (!isRecord(value)) {
    return null;
  }

  const loopStatus = isRecord(value.loopStatus) ? value.loopStatus : null;
  const output: Record<string, unknown> = {
    ...(readString(value.status) ? { status: readString(value.status) } : {}),
    ...(readString(value.timestamp) ? { timestamp: readString(value.timestamp) } : {}),
    ...(readBoolean(value.enabled) !== undefined ? { enabled: readBoolean(value.enabled) } : {}),
    ...(readBoolean(value.active) !== undefined ? { active: readBoolean(value.active) } : {}),
    ...(readBoolean(value.isHealing) !== undefined ? { isHealing: readBoolean(value.isHealing) } : {}),
    ...(readString(value.lastHealRun) ? { lastHealRun: readString(value.lastHealRun) } : {}),
    ...(readString(value.lastDecision) ? { lastDecision: readString(value.lastDecision) } : {}),
    ...(readString(value.lastAction) ? { lastAction: readString(value.lastAction) } : {}),
    ...(readString(value.lastResult) ? { lastResult: readString(value.lastResult) } : {}),
  };

  if (Object.prototype.hasOwnProperty.call(value, 'aiUsedInRuntime')) {
    output.aiUsedInRuntime =
      readBoolean(value.aiUsedInRuntime) !== undefined ? readBoolean(value.aiUsedInRuntime) : null;
  }

  const systemState = pruneGenericValue(value.systemState);
  if (systemState !== undefined) {
    output.systemState = systemState;
  }

  const lastAIDiagnosis = pruneGenericValue(value.lastAIDiagnosis);
  if (lastAIDiagnosis !== undefined) {
    output.lastAIDiagnosis = lastAIDiagnosis;
  }

  const lastDispatchAttempt = pruneGenericValue(value.lastDispatchAttempt);
  if (lastDispatchAttempt !== undefined) {
    output.lastDispatchAttempt = lastDispatchAttempt;
  }

  const lastDispatchTarget = pruneGenericValue(value.lastDispatchTarget);
  if (lastDispatchTarget !== undefined) {
    output.lastDispatchTarget = lastDispatchTarget;
  }

  const lastWorkerReceipt = pruneGenericValue(value.lastWorkerReceipt);
  if (lastWorkerReceipt !== undefined) {
    output.lastWorkerReceipt = lastWorkerReceipt;
  }

  const lastHealResult = pruneGenericValue(value.lastHealResult);
  if (lastHealResult !== undefined) {
    output.lastHealResult = lastHealResult;
  }

  const timeline = pruneGenericValue(value.timeline);
  if (timeline !== undefined) {
    output.timeline = timeline;
  }

  if (loopStatus) {
    const compactLoopStatus = {
      ...(readBoolean(loopStatus.loopRunning) !== undefined ? { loopRunning: readBoolean(loopStatus.loopRunning) } : {}),
      ...(readNumber(loopStatus.tickCount) !== undefined ? { tickCount: readNumber(loopStatus.tickCount) } : {}),
      ...(readString(loopStatus.lastTick) ? { lastTick: readString(loopStatus.lastTick) } : {}),
    };

    if (Object.keys(compactLoopStatus).length > 0) {
      output.loopStatus = compactLoopStatus;
    }
  }

  return Object.keys(output).length > 0 ? output : null;
}

function pickRuntimeInspectionEvidence(value: unknown): Record<string, unknown> | null {
  if (!isRecord(value)) {
    return null;
  }

  const output: Record<string, unknown> = {};
  const selfHealRuntimeSnapshot = pickSelfHealRuntimeInspectionSnapshot(value.selfHealRuntimeSnapshot);
  const recentSelfHealEvents = pickRuntimeInspectionEvidenceArray(value.recentSelfHealEvents);
  const recentPromptDebugEvents = pickRuntimeInspectionEvidenceArray(value.recentPromptDebugEvents, 8);
  const recentAIRoutingEvents = pickRuntimeInspectionEvidenceArray(value.recentAIRoutingEvents, 8);
  const recentWorkerEvidence = pickRuntimeInspectionEvidenceArray(value.recentWorkerEvidence, 8);

  if (selfHealRuntimeSnapshot) {
    output.selfHealRuntimeSnapshot = selfHealRuntimeSnapshot;
  }

  if (recentSelfHealEvents) {
    output.recentSelfHealEvents = recentSelfHealEvents;
  }

  if (recentPromptDebugEvents) {
    output.recentPromptDebugEvents = recentPromptDebugEvents;
  }

  if (recentAIRoutingEvents) {
    output.recentAIRoutingEvents = recentAIRoutingEvents;
  }

  if (recentWorkerEvidence) {
    output.recentWorkerEvidence = recentWorkerEvidence;
  }

  return Object.keys(output).length > 0 ? output : null;
}

function shapeRuntimeInspectionResult(value: Record<string, unknown>): Record<string, unknown> | null {
  if (value.handledBy !== 'runtime-inspection' || !isRecord(value.runtimeInspection)) {
    return null;
  }

  const runtimeInspection = value.runtimeInspection;
  const evidence = pickRuntimeInspectionEvidence(runtimeInspection.evidence);
  const sources = pickRuntimeInspectionSources(runtimeInspection.sources);
  const failures = pickRuntimeInspectionFailures(runtimeInspection.failures);

  return {
    handledBy: 'runtime-inspection',
    runtimeInspection: {
      ...(readString(runtimeInspection.detectedIntent)
        ? { detectedIntent: readString(runtimeInspection.detectedIntent) }
        : {}),
      ...(readString(runtimeInspection.status) ? { status: readString(runtimeInspection.status) } : {}),
      ...(readString(runtimeInspection.summary)
        ? { summary: truncateText(readString(runtimeInspection.summary) as string, 600) }
        : {}),
      ...(readStringArray(runtimeInspection.matchedKeywords, 12)
        ? { matchedKeywords: readStringArray(runtimeInspection.matchedKeywords, 12) }
        : {}),
      ...(readBoolean(runtimeInspection.repoInspectionDisabled) !== undefined
        ? { repoInspectionDisabled: readBoolean(runtimeInspection.repoInspectionDisabled) }
        : {}),
      ...(readBoolean(runtimeInspection.onlyReturnRuntimeValues) !== undefined
        ? { onlyReturnRuntimeValues: readBoolean(runtimeInspection.onlyReturnRuntimeValues) }
        : {}),
      ...(readBoolean(runtimeInspection.cliUsed) !== undefined
        ? { cliUsed: readBoolean(runtimeInspection.cliUsed) }
        : {}),
      ...(readBoolean(runtimeInspection.repoFallbackUsed) !== undefined
        ? { repoFallbackUsed: readBoolean(runtimeInspection.repoFallbackUsed) }
        : {}),
      ...(readStringArray(runtimeInspection.runtimeEndpointsQueried, 16)
        ? { runtimeEndpointsQueried: readStringArray(runtimeInspection.runtimeEndpointsQueried, 16) }
        : {}),
      ...(readStringArray(runtimeInspection.toolsSelected, 16)
        ? { toolsSelected: readStringArray(runtimeInspection.toolsSelected, 16) }
        : {}),
      ...(evidence ? { evidence } : {}),
      ...(sources ? { sources } : {}),
      ...(failures ? { failures } : {}),
    },
  };
}

function shapeDiagnosticResult(value: Record<string, unknown>): Record<string, unknown> | null {
  if (value.ok !== true || readString(value.route) !== 'diagnostic') {
    return null;
  }

  return {
    status: 'ok',
    route: 'diagnostic',
    message: readString(value.message) ?? 'backend operational',
  };
}

export function shapeClientRouteResult(result: unknown): unknown {
  if (typeof result === 'string') {
    return truncateText(result, STRING_PREVIEW_MAX_BYTES);
  }

  if (Array.isArray(result)) {
    return result.slice(0, 8).map((item) => shapeClientRouteResult(item));
  }

  if (!isRecord(result)) {
    return result;
  }

  const diagnostic = shapeDiagnosticResult(result);
  if (diagnostic) {
    return diagnostic;
  }

  const mcpDispatch = shapeMcpDispatchResult(result);
  if (mcpDispatch) {
    return mcpDispatch;
  }

  const repoInspection = shapeRepoInspectionResult(result);
  if (repoInspection) {
    return repoInspection;
  }

  const memoryDispatch = shapeMemoryDispatchResult(result);
  if (memoryDispatch) {
    return memoryDispatch;
  }

  const dagDispatch = shapeDagDispatchResult(result);
  if (dagDispatch) {
    return dagDispatch;
  }

  const runtimeInspection = shapeRuntimeInspectionResult(result);
  if (runtimeInspection) {
    return runtimeInspection;
  }

  const trinitySummary = pickTrinitySummary(result);
  if (trinitySummary) {
    return trinitySummary;
  }

  const generic = pruneGenericValue(result);
  return generic ?? { status: 'ok' };
}
