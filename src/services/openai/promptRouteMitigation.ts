import { getEnvNumber } from '@platform/runtime/env.js';

export type PromptRouteMitigationMode = 'reduced_latency' | 'degraded_response' | null;

export interface PromptRouteMitigationState {
  active: boolean;
  mode: PromptRouteMitigationMode;
  route: '/api/openai/prompt';
  activatedAt: string | null;
  updatedAt: string | null;
  reason: string | null;
  recentTimeoutCount: number;
  timeoutWindowStartedAt: string | null;
  lastTimeoutAt: string | null;
  lastAutoActivationAt: string | null;
  lastAutoActivationReason: string | null;
  pipelineTimeoutMs: number | null;
  providerTimeoutMs: number | null;
  maxRetries: number | null;
  maxTokens: number | null;
  fallbackModel: boolean;
  bypassedSubsystems: string[];
}

export interface PromptRouteExecutionPolicy {
  mode: Exclude<PromptRouteMitigationMode, 'degraded_response' | null> | 'normal' | 'degraded_response';
  pipelineTimeoutMs: number;
  providerTimeoutMs: number | null;
  maxRetries: number;
  maxTokens: number | null;
  useFallbackModel: boolean;
  bypassedSubsystems: string[];
}

export interface PromptRouteMitigationResult {
  applied: boolean;
  rolledBack: boolean;
  state: PromptRouteMitigationState;
  reason: string;
}

const GLOBAL_KEY = '__ARCANOS_PROMPT_ROUTE_MITIGATION__';
const DEFAULT_PROMPT_ROUTE_PIPELINE_TIMEOUT_MS = 4_500;
const DEFAULT_PROMPT_ROUTE_PROVIDER_TIMEOUT_MS = 4_000;
const DEFAULT_PROMPT_ROUTE_MAX_RETRIES = 1;
const DEFAULT_REDUCED_LATENCY_PIPELINE_TIMEOUT_MS = 3_500;
const DEFAULT_REDUCED_LATENCY_PROVIDER_TIMEOUT_MS = 3_200;
const DEFAULT_REDUCED_LATENCY_MAX_RETRIES = 0;
const DEFAULT_REDUCED_LATENCY_MAX_TOKENS = 96;
const PROMPT_ROUTE_PROVIDER_HEADROOM_MS = 250;
const DEFAULT_FAST_TRIP_TIMEOUT_WINDOW_MS = 60_000;
const DEFAULT_FAST_TRIP_TIMEOUT_THRESHOLD = 2;
const DEFAULT_FAST_TRIP_COOLDOWN_MS = 120_000;

function resolvePromptRoutePipelineTimeoutMs(): number {
  return Math.max(1_000, getEnvNumber('PROMPT_ROUTE_PIPELINE_TIMEOUT_MS', DEFAULT_PROMPT_ROUTE_PIPELINE_TIMEOUT_MS));
}

function resolvePromptRouteProviderTimeoutMs(): number {
  return Math.max(750, getEnvNumber('PROMPT_ROUTE_PROVIDER_TIMEOUT_MS', DEFAULT_PROMPT_ROUTE_PROVIDER_TIMEOUT_MS));
}

function resolvePromptRouteMaxRetries(): number {
  return Math.max(0, getEnvNumber('PROMPT_ROUTE_MAX_RETRIES', DEFAULT_PROMPT_ROUTE_MAX_RETRIES));
}

function resolveReducedLatencyPipelineTimeoutMs(): number {
  return Math.max(
    1_000,
    getEnvNumber('PROMPT_ROUTE_REDUCED_LATENCY_PIPELINE_TIMEOUT_MS', DEFAULT_REDUCED_LATENCY_PIPELINE_TIMEOUT_MS)
  );
}

function resolveReducedLatencyProviderTimeoutMs(): number {
  return Math.max(
    750,
    getEnvNumber('PROMPT_ROUTE_REDUCED_LATENCY_PROVIDER_TIMEOUT_MS', DEFAULT_REDUCED_LATENCY_PROVIDER_TIMEOUT_MS)
  );
}

function alignProviderTimeoutMs(pipelineTimeoutMs: number, providerTimeoutMs: number): number {
  return Math.max(750, Math.min(providerTimeoutMs, Math.max(750, pipelineTimeoutMs - PROMPT_ROUTE_PROVIDER_HEADROOM_MS)));
}

function resolveReducedLatencyMaxRetries(): number {
  return Math.max(0, getEnvNumber('PROMPT_ROUTE_REDUCED_LATENCY_MAX_RETRIES', DEFAULT_REDUCED_LATENCY_MAX_RETRIES));
}

function resolveReducedLatencyMaxTokens(defaultTokenLimit: number): number {
  const configuredLimit = Math.max(
    32,
    getEnvNumber('PROMPT_ROUTE_REDUCED_LATENCY_MAX_TOKENS', DEFAULT_REDUCED_LATENCY_MAX_TOKENS)
  );
  return Math.max(32, Math.min(defaultTokenLimit, configuredLimit));
}

function resolveFastTripTimeoutWindowMs(): number {
  return Math.max(5_000, getEnvNumber('PROMPT_ROUTE_FAST_TRIP_TIMEOUT_WINDOW_MS', DEFAULT_FAST_TRIP_TIMEOUT_WINDOW_MS));
}

function resolveFastTripTimeoutThreshold(): number {
  return Math.max(1, getEnvNumber('PROMPT_ROUTE_FAST_TRIP_TIMEOUT_THRESHOLD', DEFAULT_FAST_TRIP_TIMEOUT_THRESHOLD));
}

function resolveFastTripCooldownMs(): number {
  return Math.max(30_000, getEnvNumber('PROMPT_ROUTE_FAST_TRIP_COOLDOWN_MS', DEFAULT_FAST_TRIP_COOLDOWN_MS));
}

type PromptRouteMitigationGlobal = typeof globalThis & {
  [GLOBAL_KEY]?: PromptRouteMitigationState;
};

function createInitialState(): PromptRouteMitigationState {
  return {
    active: false,
    mode: null,
    route: '/api/openai/prompt',
    activatedAt: null,
    updatedAt: null,
    reason: null,
    recentTimeoutCount: 0,
    timeoutWindowStartedAt: null,
    lastTimeoutAt: null,
    lastAutoActivationAt: null,
    lastAutoActivationReason: null,
    pipelineTimeoutMs: null,
    providerTimeoutMs: null,
    maxRetries: null,
    maxTokens: null,
    fallbackModel: false,
    bypassedSubsystems: []
  };
}

function getMutableState(): PromptRouteMitigationState {
  const runtime = globalThis as PromptRouteMitigationGlobal;
  if (!runtime[GLOBAL_KEY]) {
    runtime[GLOBAL_KEY] = createInitialState();
  }

  return runtime[GLOBAL_KEY];
}

export function getPromptRouteMitigationState(): PromptRouteMitigationState {
  return {
    ...getMutableState()
  };
}

export function activatePromptRouteDegradedMode(reason: string): PromptRouteMitigationResult {
  const state = getMutableState();
  if (state.active && state.mode === 'degraded_response') {
    return {
      applied: false,
      rolledBack: false,
      state: { ...state },
      reason: 'already_active'
    };
  }

  const now = new Date().toISOString();
  state.active = true;
  state.mode = 'degraded_response';
  state.activatedAt = state.activatedAt ?? now;
  state.updatedAt = now;
  state.reason = reason;
  state.lastAutoActivationAt = now;
  state.lastAutoActivationReason = reason;
  state.pipelineTimeoutMs = null;
  state.providerTimeoutMs = null;
  state.maxRetries = 0;
  state.maxTokens = null;
  state.fallbackModel = true;
  state.bypassedSubsystems = ['provider_retry', 'long_generation_tail', 'openai_prompt_execution'];

  return {
    applied: true,
    rolledBack: false,
    state: { ...state },
    reason: 'applied'
  };
}

export function activatePromptRouteReducedLatencyMode(reason: string, defaultTokenLimit: number): PromptRouteMitigationResult {
  const state = getMutableState();
  if (state.active && state.mode === 'reduced_latency') {
    return {
      applied: false,
      rolledBack: false,
      state: { ...state },
      reason: 'already_active'
    };
  }

  const now = new Date().toISOString();
  const pipelineTimeoutMs = resolveReducedLatencyPipelineTimeoutMs();
  state.active = true;
  state.mode = 'reduced_latency';
  state.activatedAt = state.activatedAt ?? now;
  state.updatedAt = now;
  state.reason = reason;
  state.lastAutoActivationAt = now;
  state.lastAutoActivationReason = reason;
  state.pipelineTimeoutMs = pipelineTimeoutMs;
  state.providerTimeoutMs = alignProviderTimeoutMs(pipelineTimeoutMs, resolveReducedLatencyProviderTimeoutMs());
  state.maxRetries = resolveReducedLatencyMaxRetries();
  state.maxTokens = resolveReducedLatencyMaxTokens(defaultTokenLimit);
  state.fallbackModel = true;
  state.bypassedSubsystems = ['provider_retry', 'long_generation_tail', 'prompt_route_extended_budget'];

  return {
    applied: true,
    rolledBack: false,
    state: { ...state },
    reason: 'applied'
  };
}

export function rollbackPromptRouteMitigation(reason: string): PromptRouteMitigationResult {
  const state = getMutableState();
  if (!state.active) {
    return {
      applied: false,
      rolledBack: false,
      state: { ...state },
      reason: 'not_active'
    };
  }

  state.active = false;
  state.mode = null;
  state.activatedAt = null;
  state.updatedAt = new Date().toISOString();
  state.reason = reason;
  state.pipelineTimeoutMs = null;
  state.providerTimeoutMs = null;
  state.maxRetries = null;
  state.maxTokens = null;
  state.fallbackModel = false;
  state.bypassedSubsystems = [];

  return {
    applied: false,
    rolledBack: true,
    state: { ...state },
    reason: 'rolled_back'
  };
}

export function rollbackPromptRouteDegradedMode(reason: string): PromptRouteMitigationResult {
  return rollbackPromptRouteMitigation(reason);
}

export function recordPromptRouteTimeoutIncident(
  timeoutKind: string,
  defaultTokenLimit: number
): PromptRouteMitigationResult {
  const state = getMutableState();
  const now = new Date().toISOString();
  const nowMs = Date.parse(now);
  const timeoutWindowMs = resolveFastTripTimeoutWindowMs();
  const timeoutThreshold = resolveFastTripTimeoutThreshold();

  if (
    !state.timeoutWindowStartedAt ||
    nowMs - Date.parse(state.timeoutWindowStartedAt) > timeoutWindowMs
  ) {
    state.timeoutWindowStartedAt = now;
    state.recentTimeoutCount = 0;
  }

  state.lastTimeoutAt = now;
  state.recentTimeoutCount += 1;

  if (state.active || state.recentTimeoutCount < timeoutThreshold) {
    return {
      applied: false,
      rolledBack: false,
      state: { ...state },
      reason: state.active ? 'already_active' : 'threshold_not_met'
    };
  }

  if (
    state.lastAutoActivationAt &&
    nowMs - Date.parse(state.lastAutoActivationAt) < resolveFastTripCooldownMs()
  ) {
    return {
      applied: false,
      rolledBack: false,
      state: { ...state },
      reason: 'cooldown_active'
    };
  }

  const result = activatePromptRouteReducedLatencyMode(
    `prompt route timeout cluster detected (${timeoutKind})`,
    defaultTokenLimit
  );

  if (result.applied) {
    state.timeoutWindowStartedAt = now;
    state.recentTimeoutCount = 0;
  }

  return {
    ...result,
    state: { ...state }
  };
}

export function getPromptRouteExecutionPolicy(defaultTokenLimit: number): PromptRouteExecutionPolicy {
  const state = getMutableState();
  if (state.active && state.mode === 'reduced_latency') {
    const pipelineTimeoutMs = state.pipelineTimeoutMs ?? resolveReducedLatencyPipelineTimeoutMs();
    return {
      mode: 'reduced_latency',
      pipelineTimeoutMs,
      providerTimeoutMs: alignProviderTimeoutMs(
        pipelineTimeoutMs,
        state.providerTimeoutMs ?? resolveReducedLatencyProviderTimeoutMs()
      ),
      maxRetries: state.maxRetries ?? resolveReducedLatencyMaxRetries(),
      maxTokens:
        typeof state.maxTokens === 'number'
          ? Math.max(32, Math.min(defaultTokenLimit, state.maxTokens))
          : resolveReducedLatencyMaxTokens(defaultTokenLimit),
      useFallbackModel: state.fallbackModel,
      bypassedSubsystems: [...state.bypassedSubsystems]
    };
  }

  if (state.active && state.mode === 'degraded_response') {
    return {
      mode: 'degraded_response',
      pipelineTimeoutMs: 0,
      providerTimeoutMs: null,
      maxRetries: 0,
      maxTokens: null,
      useFallbackModel: true,
      bypassedSubsystems: [...state.bypassedSubsystems]
    };
  }

  const pipelineTimeoutMs = resolvePromptRoutePipelineTimeoutMs();
  return {
    mode: 'normal',
    pipelineTimeoutMs,
    providerTimeoutMs: alignProviderTimeoutMs(pipelineTimeoutMs, resolvePromptRouteProviderTimeoutMs()),
    maxRetries: resolvePromptRouteMaxRetries(),
    maxTokens: defaultTokenLimit,
    useFallbackModel: false,
    bypassedSubsystems: []
  };
}

export function resetPromptRouteMitigationStateForTests(): void {
  if (process.env.NODE_ENV !== 'test') {
    return;
  }

  const runtime = globalThis as PromptRouteMitigationGlobal;
  runtime[GLOBAL_KEY] = createInitialState();
}
