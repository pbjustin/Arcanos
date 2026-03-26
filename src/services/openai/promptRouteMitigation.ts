import { getEnvNumber } from '@platform/runtime/env.js';

export type PromptRouteMitigationMode = 'reduced_latency' | 'degraded_response' | null;

export interface PromptRouteMitigationState {
  active: boolean;
  mode: PromptRouteMitigationMode;
  route: '/api/openai/prompt';
  activatedAt: string | null;
  updatedAt: string | null;
  reason: string | null;
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
const DEFAULT_PROMPT_ROUTE_PIPELINE_TIMEOUT_MS = 6_500;
const DEFAULT_PROMPT_ROUTE_PROVIDER_TIMEOUT_MS = 6_000;
const DEFAULT_PROMPT_ROUTE_MAX_RETRIES = 1;
const DEFAULT_REDUCED_LATENCY_PIPELINE_TIMEOUT_MS = 3_500;
const DEFAULT_REDUCED_LATENCY_PROVIDER_TIMEOUT_MS = 3_200;
const DEFAULT_REDUCED_LATENCY_MAX_RETRIES = 0;
const DEFAULT_REDUCED_LATENCY_MAX_TOKENS = 96;

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
  state.active = true;
  state.mode = 'reduced_latency';
  state.activatedAt = state.activatedAt ?? now;
  state.updatedAt = now;
  state.reason = reason;
  state.pipelineTimeoutMs = resolveReducedLatencyPipelineTimeoutMs();
  state.providerTimeoutMs = resolveReducedLatencyProviderTimeoutMs();
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

export function getPromptRouteExecutionPolicy(defaultTokenLimit: number): PromptRouteExecutionPolicy {
  const state = getMutableState();
  if (state.active && state.mode === 'reduced_latency') {
    return {
      mode: 'reduced_latency',
      pipelineTimeoutMs: state.pipelineTimeoutMs ?? resolveReducedLatencyPipelineTimeoutMs(),
      providerTimeoutMs: state.providerTimeoutMs ?? resolveReducedLatencyProviderTimeoutMs(),
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

  return {
    mode: 'normal',
    pipelineTimeoutMs: resolvePromptRoutePipelineTimeoutMs(),
    providerTimeoutMs: resolvePromptRouteProviderTimeoutMs(),
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
