import type { Request } from 'express';

import { resolveErrorMessage } from '@core/lib/errors/index.js';
import { getConfig } from '@platform/runtime/unifiedConfig.js';
import { getWorkerRuntimeStatus } from '@platform/runtime/workerConfig.js';
import { recordAiRoutingDebugSnapshot, type AiRoutingDebugSnapshot } from '@services/aiRoutingDebugService.js';
import {
  isArcanosCliAvailable,
  runArcanosCLI,
  type ArcanosCliRuntimeCommand,
} from '@services/arcanosCliRuntimeService.js';
import { shouldInspectRuntimePrompt } from '@services/promptDebugTraceService.js';
import {
  buildSafetySelfHealSnapshot,
  buildSelfHealEventsSnapshot,
  buildSelfHealInspectionSnapshot,
  buildSelfHealRuntimeSnapshot,
} from '@services/selfHealRuntimeInspectionService.js';
import { runtimeDiagnosticsService } from '@services/runtimeDiagnosticsService.js';
import { getWorkerControlHealth } from '@services/workerControlService.js';

export interface RuntimeInspectionPromptClassification {
  detectedIntent: 'RUNTIME_INSPECTION_REQUIRED' | 'STANDARD';
  matchedKeywords: string[];
  repoInspectionDisabled: boolean;
  onlyReturnRuntimeValues: boolean;
}

interface RuntimeInspectionSourceResult {
  sourceType: 'runtime-endpoint' | 'worker-health' | 'cli' | 'metrics';
  tool: string;
  data: unknown;
}

interface RuntimeInspectionFailure {
  sourceType: 'runtime-endpoint' | 'worker-health' | 'cli' | 'metrics';
  tool: string;
  error: string;
}

export interface RuntimeInspectionExecutionResult {
  ok: boolean;
  responsePayload?: {
    handledBy: 'runtime-inspection';
    runtimeInspection: Record<string, unknown>;
  };
  error?: {
    code: 'RUNTIME_INSPECTION_UNAVAILABLE';
    message: 'runtime inspection unavailable';
    details: Record<string, unknown>;
  };
  routingDebug: AiRoutingDebugSnapshot;
  repoFallbackAllowed: boolean;
  selectedTools: string[];
  runtimeEndpointsQueried: string[];
  cliUsed: boolean;
}

type RuntimeKeywordRule = {
  label: string;
  pattern: RegExp;
};

const RUNTIME_KEYWORD_RULES: RuntimeKeywordRule[] = [
  { label: 'live', pattern: /\blive\b/i },
  { label: 'runtime', pattern: /\bruntime\b/i },
  { label: 'currently running', pattern: /\bcurrently\s+running\b/i },
  { label: 'currently active', pattern: /\bcurrently\s+active\b/i },
  {
    label: 'active',
    pattern: /\b(?:runtime|worker|process|deployment|service|queue|loop)\b[^.!?\n]{0,16}\bactive\b|\bactive\b[^.!?\n]{0,16}\b(?:runtime|worker|process|deployment|service|queue|loop)\b/i,
  },
  { label: 'status now', pattern: /\bstatus\s+now\b/i },
  { label: 'production state', pattern: /\bproduction\s+state\b/i },
  { label: 'loop running', pattern: /\bloop\s+running\b/i },
  { label: 'telemetry', pattern: /\btelemetry\b/i },
  {
    label: 'events',
    pattern: /\b(?:runtime|telemetry|worker|self[-\s]?heal|process|queue|deployment)\b[^.!?\n]{0,20}\bevents?\b|\bevents?\b[^.!?\n]{0,20}\b(?:runtime|telemetry|worker|self[-\s]?heal|process|queue|deployment)\b/i,
  },
];

const REPO_BLOCK_RULES = [
  /\bdo\s+not\s+use\s+repo(?:\s+inspection)?\b/i,
  /\bno\s+repo(?:\s+inspection)?\b/i,
  /\bonly\s+return\s+runtime\s+values\b/i,
  /\bruntime\s+values\s+only\b/i,
];

function uniqueStrings(values: Array<string | null | undefined>): string[] {
  return Array.from(
    new Set(
      values
        .filter((value): value is string => typeof value === 'string')
        .map(value => value.trim())
        .filter(value => value.length > 0)
    ).values()
  );
}

function normalizePrompt(prompt: string | null | undefined): string {
  return typeof prompt === 'string' ? prompt.trim() : '';
}

function resolveBaseUrl(request?: Request): string {
  const configuredBaseUrl = process.env.ARCANOS_BACKEND_URL?.trim();
  if (configuredBaseUrl) {
    return configuredBaseUrl.replace(/\/+$/, '');
  }

  const forwardedProtoHeader = request?.headers?.['x-forwarded-proto'];
  const forwardedHostHeader = request?.headers?.['x-forwarded-host'];
  const forwardedProto = typeof forwardedProtoHeader === 'string'
    ? forwardedProtoHeader.split(',')[0]?.trim()
    : undefined;
  const forwardedHost = typeof forwardedHostHeader === 'string'
    ? forwardedHostHeader.split(',')[0]?.trim()
    : undefined;
  const host = forwardedHost || request?.get?.('host') || request?.headers?.host;
  const protocol = forwardedProto || request?.protocol || 'http';

  if (host) {
    return `${protocol}://${host}`;
  }

  return 'http://127.0.0.1:3000';
}

function buildWorkersStatusSnapshot() {
  const runtimeStatus = getWorkerRuntimeStatus();
  return {
    status: 'ok' as const,
    timestamp: new Date().toISOString(),
    arcanosWorkers: {
      enabled: runtimeStatus.enabled,
      count: runtimeStatus.configuredCount,
      model: runtimeStatus.model,
      status: runtimeStatus.started ? 'Active' : runtimeStatus.enabled ? 'Pending' : 'Disabled',
      runtime: runtimeStatus,
    },
    system: {
      model: getConfig().defaultModel || 'gpt-4o',
      environment: getConfig().nodeEnv,
    },
  };
}

function selectCliCommands(prompt: string): ArcanosCliRuntimeCommand[] {
  const commands: ArcanosCliRuntimeCommand[] = ['status'];

  if (/\bworkers?\b|\bqueue\b|\bloop\s+running\b/i.test(prompt)) {
    commands.push('workers');
  }

  if (/\bself[-\s]?heal\b|\bloop\s+running\b|\btelemetry\b|\bevents?\b/i.test(prompt)) {
    commands.push('inspect_self_heal');
  }

  if (/\blogs?\b|\btelemetry\b|\bevents?\b/i.test(prompt)) {
    commands.push('logs_recent');
  }

  return uniqueStrings(commands) as ArcanosCliRuntimeCommand[];
}

function unwrapCliPayload(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return value;
  }

  const record = value as Record<string, unknown>;
  if (record.ok === true && 'data' in record) {
    return record.data;
  }

  return value;
}

async function collectMetricsSnapshot(request?: Request): Promise<Record<string, unknown>> {
  const health = runtimeDiagnosticsService.getHealthSnapshot();
  if (!request?.app) {
    return {
      health,
      diagnostics: null,
    };
  }

  const diagnostics = await runtimeDiagnosticsService.getDiagnosticsSnapshot(request.app);
  return {
    health,
    diagnostics: {
      avg_latency_ms: diagnostics.avg_latency_ms,
      recent_latency_ms: diagnostics.recent_latency_ms,
      requests_total: diagnostics.requests_total,
      errors_total: diagnostics.errors_total,
    },
  };
}

export function classifyRuntimeInspectionPrompt(prompt: string | null | undefined): RuntimeInspectionPromptClassification {
  const normalized = normalizePrompt(prompt);
  if (!normalized) {
    return {
      detectedIntent: 'STANDARD',
      matchedKeywords: [],
      repoInspectionDisabled: false,
      onlyReturnRuntimeValues: false,
    };
  }

  const matchedKeywords = uniqueStrings(
    RUNTIME_KEYWORD_RULES
      .filter(rule => rule.pattern.test(normalized))
      .map(rule => rule.label)
  );
  const repoInspectionDisabled = REPO_BLOCK_RULES.some(rule => rule.test(normalized));
  const onlyReturnRuntimeValues = /\bonly\s+return\s+runtime\s+values\b/i.test(normalized) || /\bruntime\s+values\s+only\b/i.test(normalized);
  const detectedIntent =
    shouldInspectRuntimePrompt(normalized) || matchedKeywords.length > 0
      ? 'RUNTIME_INSPECTION_REQUIRED'
      : 'STANDARD';

  return {
    detectedIntent,
    matchedKeywords,
    repoInspectionDisabled,
    onlyReturnRuntimeValues,
  };
}

export async function executeRuntimeInspection(params: {
  requestId: string;
  rawPrompt: string;
  normalizedPrompt: string;
  request?: Request;
}): Promise<RuntimeInspectionExecutionResult> {
  const classification = classifyRuntimeInspectionPrompt(params.normalizedPrompt || params.rawPrompt);
  const availableCli = await isArcanosCliAvailable();
  const toolsAvailable = [
    '/api/self-heal/runtime',
    '/api/self-heal/events',
    '/api/self-heal/inspection',
    '/status/safety/self-heal',
    '/worker-helper/health',
    '/workers/status',
    ...(availableCli ? selectCliCommands(params.normalizedPrompt || params.rawPrompt).map(command => `cli:${command}`) : []),
    'system.metrics',
  ];
  const selectedTools: string[] = [];
  const runtimeEndpointsQueried: string[] = [];
  const sources: RuntimeInspectionSourceResult[] = [];
  const failures: RuntimeInspectionFailure[] = [];
  const cliCommands = availableCli ? selectCliCommands(params.normalizedPrompt || params.rawPrompt) : [];

  const tryCollect = async (
    sourceType: RuntimeInspectionSourceResult['sourceType'],
    tool: string,
    operation: () => Promise<unknown> | unknown
  ) => {
    if (sourceType !== 'cli' && tool.startsWith('/')) {
      runtimeEndpointsQueried.push(tool);
    }

    try {
      const data = await operation();
      sources.push({
        sourceType,
        tool,
        data,
      });
      selectedTools.push(tool);
    } catch (error) {
      failures.push({
        sourceType,
        tool,
        error: resolveErrorMessage(error),
      });
    }
  };

  await tryCollect('runtime-endpoint', '/api/self-heal/runtime', () => buildSelfHealRuntimeSnapshot());
  await tryCollect('runtime-endpoint', '/api/self-heal/events', () => buildSelfHealEventsSnapshot(20));
  await tryCollect('runtime-endpoint', '/api/self-heal/inspection', async () => await buildSelfHealInspectionSnapshot(10));
  await tryCollect('runtime-endpoint', '/status/safety/self-heal', () => buildSafetySelfHealSnapshot());
  await tryCollect('worker-health', '/worker-helper/health', async () => await getWorkerControlHealth());
  await tryCollect('worker-health', '/workers/status', () => buildWorkersStatusSnapshot());

  for (const command of cliCommands) {
    await tryCollect('cli', `cli:${command}`, async () => {
      const cliResult = await runArcanosCLI(command, {
        baseUrl: resolveBaseUrl(params.request),
      });
      if (!cliResult.available) {
        throw new Error(cliResult.error ?? 'arcanos_cli_unavailable');
      }
      if (cliResult.exitCode !== 0) {
        throw new Error(cliResult.error ?? cliResult.stderr ?? 'arcanos_cli_execution_failed');
      }

      return {
        command,
        cliPath: cliResult.cliPath,
        output: unwrapCliPayload(cliResult.parsedOutput ?? cliResult.stdout),
      };
    });
  }

  await tryCollect('metrics', 'system.metrics', async () => await collectMetricsSnapshot(params.request));

  const cliUsed = cliCommands.length > 0;
  const repoFallbackAllowed = !classification.repoInspectionDisabled;
  const routingDecision =
    selectedTools.length > 0
      ? 'runtime_inspection_completed'
      : repoFallbackAllowed
      ? 'runtime_inspection_failed_repo_fallback_allowed'
      : 'runtime_inspection_unavailable';

  const routingDebug: AiRoutingDebugSnapshot = {
    requestId: params.requestId,
    timestamp: new Date().toISOString(),
    rawPrompt: params.rawPrompt,
    normalizedPrompt: params.normalizedPrompt,
    detectedIntent: classification.detectedIntent,
    routingDecision,
    toolsAvailable,
    toolsSelected: selectedTools,
    cliUsed,
    runtimeEndpointsQueried,
    repoFallbackUsed: false,
    constraintViolations: [],
  };
  recordAiRoutingDebugSnapshot(routingDebug);

  if (selectedTools.length === 0) {
    const errorDetails = {
      detectedIntent: classification.detectedIntent,
      routingDecision,
      toolsAvailable,
      toolsSelected: selectedTools,
      cliUsed,
      runtimeEndpointsQueried,
      repoFallbackUsed: false,
      repoInspectionDisabled: classification.repoInspectionDisabled,
      onlyReturnRuntimeValues: classification.onlyReturnRuntimeValues,
      matchedKeywords: classification.matchedKeywords,
      failures,
      constraintViolations: [],
    };

    return {
      ok: false,
      error: {
        code: 'RUNTIME_INSPECTION_UNAVAILABLE',
        message: 'runtime inspection unavailable',
        details: errorDetails,
      },
      routingDebug,
      repoFallbackAllowed,
      selectedTools,
      runtimeEndpointsQueried,
      cliUsed,
    };
  }

  const selfHealInspectionSource = sources.find(source => source.tool === '/api/self-heal/inspection');
  const selfHealInspectionEvidence =
    selfHealInspectionSource &&
    selfHealInspectionSource.data &&
    typeof selfHealInspectionSource.data === 'object' &&
    !Array.isArray(selfHealInspectionSource.data)
      ? (selfHealInspectionSource.data as Record<string, unknown>).evidence ?? null
      : null;

  return {
    ok: true,
    responsePayload: {
      handledBy: 'runtime-inspection',
      runtimeInspection: {
        detectedIntent: classification.detectedIntent,
        status: 'ok',
        summary:
          typeof (selfHealInspectionSource?.data as Record<string, unknown> | undefined)?.summary === 'string'
            ? (selfHealInspectionSource?.data as Record<string, unknown>).summary
            : `Collected live runtime state from ${selectedTools.length} runtime sources.`,
        matchedKeywords: classification.matchedKeywords,
        repoInspectionDisabled: classification.repoInspectionDisabled,
        onlyReturnRuntimeValues: classification.onlyReturnRuntimeValues,
        cliUsed,
        repoFallbackUsed: false,
        runtimeEndpointsQueried,
        toolsSelected: selectedTools,
        evidence: selfHealInspectionEvidence,
        sources,
        failures,
      },
    },
    routingDebug,
    repoFallbackAllowed,
    selectedTools,
    runtimeEndpointsQueried,
    cliUsed,
  };
}
