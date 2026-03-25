import type { Tier } from '@core/logic/trinityTier.js';
import type { TrinitySelfHealingStage } from './selfHealingV2.js';

export type SelfHealingSignalCluster =
  | 'timeout_cluster'
  | 'worker_stall'
  | 'provider_failure'
  | 'validation_error'
  | 'unknown';

export interface SelfHealingHttpSignal {
  kind: 'http';
  timestampMs: number;
  route: string;
  method: string;
  statusCode: number;
  latencyMs: number;
  requestId?: string;
  expected: boolean;
  cluster: SelfHealingSignalCluster | null;
}

export interface SelfHealingStageFailureSignal {
  kind: 'stage_failure';
  timestampMs: number;
  stage: TrinitySelfHealingStage;
  tier: Tier;
  error: string;
  errorCode?: string | null;
  requestId: string;
  sourceEndpoint?: string;
  cluster: SelfHealingSignalCluster;
}

export type SelfHealingSignal = SelfHealingHttpSignal | SelfHealingStageFailureSignal;

const MAX_SIGNAL_BUFFER = 500;
const signalBuffer: SelfHealingSignal[] = [];
const TIMEOUT_ERROR_CODES = new Set([
  'request_aborted',
  'timeout',
  'module_timeout',
  'openai_call_aborted_due_to_budget'
]);
const PROVIDER_ERROR_CODES = new Set([
  'provider_failure',
  'rate_limit',
  'openai_rate_limit',
  'circuit_breaker_open'
]);
const VALIDATION_ERROR_CODES = new Set([
  'validation_error'
]);

function appendSignal(signal: SelfHealingSignal): void {
  signalBuffer.push(signal);
  if (signalBuffer.length > MAX_SIGNAL_BUFFER) {
    signalBuffer.splice(0, signalBuffer.length - MAX_SIGNAL_BUFFER);
  }
}

function normalizeErrorCode(errorCode: string | null | undefined): string | null {
  if (typeof errorCode !== 'string') {
    return null;
  }

  const normalizedCode = errorCode.trim().toLowerCase();
  return normalizedCode.length > 0 ? normalizedCode : null;
}

function isProtectedAdminRoute(route: string): boolean {
  return route.startsWith('/api/self-improve')
    || route.startsWith('/status/safety/quarantine');
}

function isOperationalRoute(route: string): boolean {
  return route.startsWith('/gpt/')
    || route.startsWith('/api/arcanos/')
    || route.startsWith('/modules/')
    || route.startsWith('/workers/')
    || route.startsWith('/worker-helper/')
    || route === '/arcanos'
    || route === '/arcanos-pipeline'
    || route === '/query-finetune';
}

export function classifyHttpSignal(route: string, statusCode: number): {
  expected: boolean;
  cluster: SelfHealingSignalCluster | null;
} {
  if (statusCode < 400) {
    return { expected: false, cluster: null };
  }

  if (statusCode >= 500 || statusCode === 408 || statusCode === 429) {
    return {
      expected: false,
      cluster: statusCode === 429 ? 'provider_failure' : 'timeout_cluster'
    };
  }

  if (statusCode === 401 || statusCode === 403) {
    return {
      expected: isProtectedAdminRoute(route) || !isOperationalRoute(route),
      cluster: isOperationalRoute(route) ? 'validation_error' : null
    };
  }

  if (statusCode === 400 || statusCode === 404 || statusCode === 422) {
    return {
      expected: !isOperationalRoute(route),
      cluster: 'validation_error'
    };
  }

  return {
    expected: !isOperationalRoute(route),
    cluster: 'unknown'
  };
}

export function classifyStageFailureSignal(params: {
  error: string;
  errorCode?: string | null;
}): SelfHealingSignalCluster {
  const normalizedErrorCode = normalizeErrorCode(params.errorCode);
  if (normalizedErrorCode) {
    if (TIMEOUT_ERROR_CODES.has(normalizedErrorCode)) {
      return 'timeout_cluster';
    }

    if (PROVIDER_ERROR_CODES.has(normalizedErrorCode)) {
      return 'provider_failure';
    }

    if (VALIDATION_ERROR_CODES.has(normalizedErrorCode)) {
      return 'validation_error';
    }
  }

  const normalizedError = params.error.toLowerCase();

  if (
    normalizedError.includes('request was aborted')
    || normalizedError.includes('timeout')
    || normalizedError.includes('module_timeout')
    || normalizedError.includes('openai_call_aborted_due_to_budget')
  ) {
    return 'timeout_cluster';
  }

  if (
    normalizedError.includes('rate limit')
    || normalizedError.includes('429')
    || normalizedError.includes('circuit breaker')
    || normalizedError.includes('openai')
    || normalizedError.includes('provider')
  ) {
    return 'provider_failure';
  }

  return 'unknown';
}

export function recordSelfHealingHttpSignal(signal: Omit<SelfHealingHttpSignal, 'kind' | 'timestampMs' | 'expected' | 'cluster'>): SelfHealingHttpSignal {
  const classification = classifyHttpSignal(signal.route, signal.statusCode);
  const recordedSignal: SelfHealingHttpSignal = {
    kind: 'http',
    timestampMs: Date.now(),
    ...signal,
    expected: classification.expected,
    cluster: classification.cluster
  };
  appendSignal(recordedSignal);
  return { ...recordedSignal };
}

export function recordSelfHealingStageFailureSignal(signal: Omit<SelfHealingStageFailureSignal, 'kind' | 'timestampMs' | 'cluster'>): SelfHealingStageFailureSignal {
  const recordedSignal: SelfHealingStageFailureSignal = {
    kind: 'stage_failure',
    timestampMs: Date.now(),
    ...signal,
    cluster: classifyStageFailureSignal({
      error: signal.error,
      errorCode: signal.errorCode
    })
  };
  appendSignal(recordedSignal);
  return { ...recordedSignal };
}

export function getSelfHealingSignalsSince(sinceMs: number): SelfHealingSignal[] {
  return signalBuffer.filter((signal) => signal.timestampMs >= sinceMs).map((signal) => ({ ...signal }));
}

export function resetSelfHealingSignalsForTests(): void {
  if (process.env.NODE_ENV !== 'test') {
    return;
  }
  signalBuffer.splice(0, signalBuffer.length);
}
