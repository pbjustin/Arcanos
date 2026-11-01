import { createHash } from 'node:crypto';
import { responseCache } from '@platform/resilience/cache.js';
import {
  instrumentOpenAIOperation,
  isOpenAIAdapterInitialized,
  rethrowWorkerAiBudgetError,
  resetOpenAIAdapter
} from '@core/adapters/openai.adapter.js';
import { RESILIENCE_CONSTANTS, getCircuitBreakerSnapshot } from './resilience.js';
import {
  getApiTimeoutMs,
  getUnifiedClient,
  isUnifiedClientConfigured,
  validateClientHealth
} from '@arcanos/openai/unifiedClient';
import {
  getOpenAIKeySource,
  resetCredentialCache,
  resolveOpenAIBaseURL
} from './credentialProvider.js';
import { getOpenAIClientOrAdapter } from './clientBridge.js';
import { getConfig } from '@platform/runtime/unifiedConfig.js';
import { getEnv, getEnvNumber } from '@platform/runtime/env.js';
import { logger } from '@platform/logging/structuredLogging.js';
import { resolveErrorMessage } from '@core/lib/errors/index.js';
import { getAiExecutionContext } from './aiExecutionContext.js';

export type OpenAIProviderFailureCategory =
  | 'missing_client'
  | 'circuit_open'
  | 'authentication'
  | 'rate_limited'
  | 'network'
  | 'timeout'
  | 'invalid_request'
  | 'provider_error'
  | 'unknown';

export interface OpenAIProviderRuntimeStatus {
  configSource: string | null;
  configVersion: string | null;
  lastReloadAt: string | null;
  reloadCount: number;
  lastAttemptAt: string | null;
  lastSuccessAt: string | null;
  lastFailureAt: string | null;
  lastFailureReason: string | null;
  lastFailureCategory: OpenAIProviderFailureCategory | null;
  lastFailureStatus: number | null;
  consecutiveFailures: number;
  backoffMs: number;
  nextRetryAt: string | null;
}

export interface OpenAIProviderProbeResult {
  ok: boolean;
  skipped: boolean;
  reason: string | null;
  runtime: OpenAIProviderRuntimeStatus;
}

export interface OpenAIProviderReloadResult extends OpenAIProviderProbeResult {
  reloaded: boolean;
}

type OpenAIProviderRuntimeState = OpenAIProviderRuntimeStatus & {
  configFingerprint: string | null;
  authenticationFailureFingerprint: string | null;
};

const DEFAULT_PROVIDER_RETRY_BASE_MS = 1_000;
const DEFAULT_PROVIDER_RETRY_MAX_MS = 60_000;
const DEFAULT_PROVIDER_PROBE_TIMEOUT_MS = 4_000;
// The pinned SDK has no disabled-timeout sentinel: zero fires immediately and
// values above the signed 32-bit timer ceiling are clamped by Node. Keep its
// pre-fetch timer inert while the probe's transport-gated controller owns the
// meaningful provider timeout.
const OPENAI_PROVIDER_PROBE_SDK_TIMEOUT_MS = 0x7fffffff;
let providerRuntimeState: OpenAIProviderRuntimeState | null = null;
let providerProbeInFlight: {
  authenticationFingerprint: string;
  settled: Promise<void>;
} | null = null;

function createInitialProviderRuntimeState(): OpenAIProviderRuntimeState {
  return {
    configSource: null,
    configVersion: null,
    lastReloadAt: null,
    reloadCount: 0,
    lastAttemptAt: null,
    lastSuccessAt: null,
    lastFailureAt: null,
    lastFailureReason: null,
    lastFailureCategory: null,
    lastFailureStatus: null,
    consecutiveFailures: 0,
    backoffMs: 0,
    nextRetryAt: null,
    configFingerprint: null,
    authenticationFailureFingerprint: null
  };
}

function getProviderRuntimeState(): OpenAIProviderRuntimeState {
  if (!providerRuntimeState) {
    providerRuntimeState = createInitialProviderRuntimeState();
  }

  return providerRuntimeState;
}

function cloneProviderRuntimeState(state: OpenAIProviderRuntimeState): OpenAIProviderRuntimeStatus {
  return {
    configSource: state.configSource,
    configVersion: state.configVersion,
    lastReloadAt: state.lastReloadAt,
    reloadCount: state.reloadCount,
    lastAttemptAt: state.lastAttemptAt,
    lastSuccessAt: state.lastSuccessAt,
    lastFailureAt: state.lastFailureAt,
    lastFailureReason: state.lastFailureReason,
    lastFailureCategory: state.lastFailureCategory,
    lastFailureStatus: state.lastFailureStatus,
    consecutiveFailures: state.consecutiveFailures,
    backoffMs: state.backoffMs,
    nextRetryAt: state.nextRetryAt
  };
}

function resolveProviderProbeTimeoutMs(): number {
  return Math.max(
    1_000,
    getEnvNumber('OPENAI_PROVIDER_PROBE_TIMEOUT_MS', DEFAULT_PROVIDER_PROBE_TIMEOUT_MS)
  );
}

function resolveProviderRetryBaseMs(): number {
  return Math.max(
    500,
    getEnvNumber('OPENAI_PROVIDER_RETRY_BASE_MS', DEFAULT_PROVIDER_RETRY_BASE_MS)
  );
}

function resolveProviderRetryMaxMs(): number {
  return Math.max(
    resolveProviderRetryBaseMs(),
    getEnvNumber('OPENAI_PROVIDER_RETRY_MAX_MS', DEFAULT_PROVIDER_RETRY_MAX_MS)
  );
}

function resolveProviderConfigFingerprint(): {
  fingerprint: string;
  source: string | null;
} {
  const config = getConfig();
  const configuredKeyText = config.openaiApiKey?.trim() || '';
  const source = getOpenAIKeySource() || null;
  const fingerprintInput = JSON.stringify({
    source: source ?? 'unknown',
    baseUrl: resolveOpenAIBaseURL() || '',
    defaultModel: config.defaultModel || '',
    credentialDigestSource: configuredKeyText
  });
  const fingerprint = createHash('sha256').update(fingerprintInput).digest('hex').slice(0, 16);

  return {
    fingerprint,
    source
  };
}

function resolveProviderAuthenticationFingerprint(): string {
  // Credential source is a lazy cache and changes when a client is reset.
  // Authentication denial must instead follow the actual credential/endpoint.
  return createHash('sha256').update(JSON.stringify({
    apiKey: getConfig().openaiApiKey?.trim() ?? '',
    baseUrl: resolveOpenAIBaseURL() ?? ''
  })).digest('hex');
}

function resetConfiguredUnifiedOpenAIClient(): boolean {
  if (!isUnifiedClientConfigured()) {
    return false;
  }

  // The configured flag and singleton snapshot are read synchronously, so this
  // cannot materialize the package's env-only fallback during runtime reload.
  getUnifiedClient().resetClient();
  return true;
}

async function runProbeWithTimeout<T>(
  operation: (armTimeout: () => void) => Promise<T>,
  timeoutMs: number,
  resolveTimeoutError: () => Error,
  onTimeout?: (error: Error) => void,
  deferTimeoutUntilTransport = false
): Promise<T> {
  let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
  let settled = false;
  let rejectTimeout: ((error: Error) => void) | null = null;
  const timeoutPromise = new Promise<never>((_, reject) => {
    rejectTimeout = reject;
  });
  const armTimeout = () => {
    if (settled || timeoutHandle !== null) {
      return;
    }
    timeoutHandle = setTimeout(() => {
      const timeoutError = resolveTimeoutError();
      onTimeout?.(timeoutError);
      rejectTimeout?.(timeoutError);
    }, timeoutMs);

    if (timeoutHandle && typeof timeoutHandle.unref === 'function') {
      timeoutHandle.unref();
    }
  };

  try {
    if (!deferTimeoutUntilTransport) {
      armTimeout();
    }
    return await Promise.race([operation(armTimeout), timeoutPromise]);
  } finally {
    settled = true;
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
    }
  }
}

function extractErrorStatus(error: unknown): number | null {
  if (!error || typeof error !== 'object') {
    return null;
  }

  const candidate = error as {
    status?: unknown;
    code?: unknown;
    response?: { status?: unknown };
  };
  if (typeof candidate.status === 'number') {
    return candidate.status;
  }

  if (typeof candidate.response?.status === 'number') {
    return candidate.response.status;
  }

  return null;
}

function classifyProviderFailure(error: unknown): {
  reason: string;
  status: number | null;
  category: OpenAIProviderFailureCategory;
} {
  const reason = resolveErrorMessage(error);
  const normalizedReason = reason.toLowerCase();
  const status = extractErrorStatus(error);

  if (
    normalizedReason.includes('openai_client_unavailable') ||
    normalizedReason.includes('adapter unavailable') ||
    normalizedReason.includes('api key missing')
  ) {
    return {
      reason,
      status,
      category: 'missing_client'
    };
  }

  if (normalizedReason.includes('circuit breaker is open')) {
    return {
      reason,
      status,
      category: 'circuit_open'
    };
  }

  if (
    status === 401 ||
    normalizedReason.includes('incorrect api key') ||
    normalizedReason.includes('invalid api key') ||
    normalizedReason.includes('authentication')
  ) {
    return {
      reason,
      status,
      category: 'authentication'
    };
  }

  if (status === 429 || normalizedReason.includes('rate limit') || normalizedReason.includes('quota')) {
    return {
      reason,
      status,
      category: 'rate_limited'
    };
  }

  if (
    normalizedReason.includes('timeout') ||
    normalizedReason.includes('timed out') ||
    normalizedReason.includes('aborted')
  ) {
    return {
      reason,
      status,
      category: 'timeout'
    };
  }

  if (
    normalizedReason.includes('econn') ||
    normalizedReason.includes('network') ||
    normalizedReason.includes('socket') ||
    normalizedReason.includes('fetch failed')
  ) {
    return {
      reason,
      status,
      category: 'network'
    };
  }

  if (status !== null && status >= 400 && status < 500) {
    return {
      reason,
      status,
      category: 'invalid_request'
    };
  }

  if (status !== null && status >= 500) {
    return {
      reason,
      status,
      category: 'provider_error'
    };
  }

  return {
    reason,
    status,
    category: 'unknown'
  };
}

function calculateNextBackoffMs(consecutiveFailures: number): number {
  const baseMs = resolveProviderRetryBaseMs();
  const maxMs = resolveProviderRetryMaxMs();
  return Math.min(maxMs, baseMs * 2 ** Math.max(0, consecutiveFailures - 1));
}

function markProviderFailure(
  error: unknown,
  context: {
    attemptedAt: string;
    source: string;
    authenticationFingerprint?: string;
  }
): OpenAIProviderRuntimeStatus {
  const state = getProviderRuntimeState();
  const failure = classifyProviderFailure(error);
  const consecutiveFailures = state.consecutiveFailures + 1;
  const backoffMs = calculateNextBackoffMs(consecutiveFailures);
  const nextRetryAt = new Date(Date.now() + backoffMs).toISOString();

  state.lastAttemptAt = context.attemptedAt;
  state.lastFailureAt = new Date().toISOString();
  state.lastFailureReason = failure.reason;
  state.lastFailureCategory = failure.category;
  state.lastFailureStatus = failure.status;
  state.consecutiveFailures = consecutiveFailures;
  state.backoffMs = backoffMs;
  state.nextRetryAt = nextRetryAt;
  if (failure.category === 'authentication') {
    state.authenticationFailureFingerprint = context.authenticationFingerprint ??
      resolveProviderAuthenticationFingerprint();
  }

  logger.error('openai.provider.failure', {
    module: 'openai.service_health',
    source: context.source,
    category: failure.category,
    status: failure.status,
    nextRetryAt,
    consecutiveFailures,
    reason: failure.reason
  });

  return cloneProviderRuntimeState(state);
}

function markProviderSuccess(
  context: {
    attemptedAt: string;
    source: string;
  }
): OpenAIProviderRuntimeStatus {
  const state = getProviderRuntimeState();
  state.lastAttemptAt = context.attemptedAt;
  state.lastSuccessAt = new Date().toISOString();
  state.lastFailureReason = null;
  state.lastFailureCategory = null;
  state.lastFailureStatus = null;
  state.consecutiveFailures = 0;
  state.backoffMs = 0;
  state.nextRetryAt = null;
  state.authenticationFailureFingerprint = null;

  logger.info('openai.provider.healthy', {
    module: 'openai.service_health',
    source: context.source,
    at: state.lastSuccessAt
  });

  return cloneProviderRuntimeState(state);
}

export function syncOpenAIProviderRuntime(options: {
  forceReload?: boolean;
  reason?: string;
} = {}): {
  reloaded: boolean;
  runtime: OpenAIProviderRuntimeStatus;
} {
  const state = getProviderRuntimeState();
  const { fingerprint, source } = resolveProviderConfigFingerprint();
  const configChanged = state.configFingerprint !== fingerprint;
  const shouldReload = Boolean(options.forceReload || configChanged);

  state.configFingerprint = fingerprint;
  state.configSource = source;
  state.configVersion = fingerprint;

  if (!shouldReload) {
    return {
      reloaded: false,
      runtime: cloneProviderRuntimeState(state)
    };
  }

  resetCredentialCache();
  if (!resetConfiguredUnifiedOpenAIClient()) {
    resetOpenAIAdapter();
  }
  state.reloadCount += 1;
  state.lastReloadAt = new Date().toISOString();

  logger.info('openai.provider.reload', {
    module: 'openai.service_health',
    reason: options.reason ?? (configChanged ? 'config_changed' : 'forced'),
    configSource: source,
    reloadCount: state.reloadCount
  });

  return {
    reloaded: true,
    runtime: cloneProviderRuntimeState(state)
  };
}

function isProviderBackoffActive(state: OpenAIProviderRuntimeState): boolean {
  return Boolean(state.nextRetryAt && Date.parse(state.nextRetryAt) > Date.now());
}

export function getOpenAIProviderRuntimeStatus(): OpenAIProviderRuntimeStatus {
  return cloneProviderRuntimeState(getProviderRuntimeState());
}

export async function probeOpenAIProviderHealth(options: {
  force?: boolean;
  source?: string;
  timeoutMs?: number;
} = {}): Promise<OpenAIProviderProbeResult> {
  // A forced startup/recovery request may bypass backoff, but must not start
  // another transport while a probe is pending. Do not share its promise:
  // worker-budget admission and failures belong to the initiating context.
  if (providerProbeInFlight) {
    return {
      ok: false,
      skipped: true,
      reason: 'provider_probe_in_flight',
      runtime: cloneProviderRuntimeState(getProviderRuntimeState())
    };
  }

  const source = options.source ?? 'runtime_probe';
  syncOpenAIProviderRuntime({
    reason: source
  });
  const state = getProviderRuntimeState();

  if (!options.force && isProviderBackoffActive(state)) {
    return {
      ok: false,
      skipped: true,
      reason: 'provider_backoff_active',
      runtime: cloneProviderRuntimeState(state)
    };
  }

  const attemptedAt = new Date().toISOString();
  const health = validateClientHealth();
  if (!health.apiKeyConfigured) {
    return {
      ok: false,
      skipped: false,
      reason: 'api_key_missing',
      runtime: markProviderFailure(new Error('OpenAI API key missing at runtime'), {
        attemptedAt,
        source
      })
    };
  }

  const { client } = getOpenAIClientOrAdapter();
  if (!client) {
    return {
      ok: false,
      skipped: false,
      reason: 'openai_client_unavailable',
      runtime: markProviderFailure(new Error('openai_client_unavailable'), {
        attemptedAt,
        source
      })
    };
  }

  const timeoutMs = Math.max(1_000, options.timeoutMs ?? resolveProviderProbeTimeoutMs());
  // Keep the outcome bound to the configuration that sent this request even
  // if another local reload happens while its transport is pending.
  const attemptedAuthenticationFingerprint = resolveProviderAuthenticationFingerprint();
  const supersededResult = (outcome: 'succeeded' | 'failed', error?: unknown): OpenAIProviderProbeResult | null => {
    if (attemptedAuthenticationFingerprint === resolveProviderAuthenticationFingerprint()) return null;
    const failure = outcome === 'failed' ? classifyProviderFailure(error) : null;
    logger.warn('openai.provider.probe_superseded', {
      module: 'openai.service_health',
      source,
      reason: 'provider_configuration_changed',
      outcome,
      ...(failure ? { category: failure.category, status: failure.status } : {})
    });
    return {
      ok: false,
      skipped: true,
      reason: 'provider_configuration_changed',
      runtime: cloneProviderRuntimeState(getProviderRuntimeState())
    };
  };
  const timeoutError = new Error(`OpenAI provider probe timed out after ${timeoutMs}ms`);
  const probeController = new AbortController();
  const probeExecutionContext = getAiExecutionContext();
  const previousTransportReady = probeExecutionContext?.workerBudgetTransportReady;
  let scopedTransportReady: ((operation: string) => void) | undefined;

  let settleProbe!: () => void;
  providerProbeInFlight = {
    authenticationFingerprint: attemptedAuthenticationFingerprint,
    settled: new Promise<void>(resolve => { settleProbe = resolve; })
  };
  try {
    await runProbeWithTimeout(
      armTimeout => {
        if (probeExecutionContext?.workerBudget) {
          scopedTransportReady = (operation: string) => {
            try {
              previousTransportReady?.(operation);
            } finally {
              // This health probe owns one provider call. Arm synchronously
              // immediately before its first admitted native transport.
              armTimeout();
            }
          };
          probeExecutionContext.workerBudgetTransportReady = scopedTransportReady;
        }
        return instrumentOpenAIOperation({
          operation: 'models_list',
          callback: () => client.models.list({
            signal: probeController.signal,
            maxRetries: 0,
            timeout: OPENAI_PROVIDER_PROBE_SDK_TIMEOUT_MS
          })
        });
      },
      timeoutMs,
      () => timeoutError,
      error => probeController.abort(error),
      Boolean(probeExecutionContext?.workerBudget)
    );

    const superseded = supersededResult('succeeded');
    if (superseded) return superseded;
    return {
      ok: true,
      skipped: false,
      reason: null,
      runtime: markProviderSuccess({
        attemptedAt,
        source
      })
    };
  } catch (error) {
    // Local worker-budget denials are admission outcomes, not provider health
    // failures. Preserve them for the worker's paused-budget control flow and
    // do not poison the shared provider backoff/circuit state.
    rethrowWorkerAiBudgetError(error);
    const superseded = supersededResult('failed', error);
    if (superseded) return superseded;
    return {
      ok: false,
      skipped: false,
      reason: resolveErrorMessage(error),
      runtime: markProviderFailure(error, {
        attemptedAt,
        source,
        authenticationFingerprint: attemptedAuthenticationFingerprint
      })
    };
  } finally {
    providerProbeInFlight = null;
    if (
      probeExecutionContext
      && probeExecutionContext.workerBudgetTransportReady === scopedTransportReady
    ) {
      probeExecutionContext.workerBudgetTransportReady = previousTransportReady;
    }
    settleProbe();
  }
}

export async function reinitializeOpenAIProvider(options: {
  forceReload?: boolean;
  ignoreBackoff?: boolean;
  suppressUnchangedAuthenticationProbe?: boolean;
  source?: string;
} = {}): Promise<OpenAIProviderReloadResult> {
  const source = options.source ?? 'runtime_reinitialize';
  const failedAuthenticationFingerprint = getProviderRuntimeState().authenticationFailureFingerprint;
  const reload = syncOpenAIProviderRuntime({
    forceReload: options.forceReload ?? true,
    reason: source
  });
  const pendingProbe = providerProbeInFlight;
  const requestedAuthenticationFingerprint = resolveProviderAuthenticationFingerprint();
  if (pendingProbe && pendingProbe.authenticationFingerprint !== requestedAuthenticationFingerprint) {
    // Keep the one replacement probe inside this explicit caller's lifetime
    // and budget context. Settlement carries no other caller's health/budget result.
    await pendingProbe.settled;
    if (requestedAuthenticationFingerprint !== resolveProviderAuthenticationFingerprint()) {
      return {
        ok: false, skipped: true, reason: 'provider_configuration_changed',
        runtime: cloneProviderRuntimeState(getProviderRuntimeState()), reloaded: reload.reloaded
      };
    }
  }
  const state = getProviderRuntimeState();

  // A local client reload cannot repair revoked credentials. Self-healing can
  // opt into retaining this denial across reloads without changing the retry
  // policy of explicitly requested probes or unrelated provider workflows.
  if (
    options.suppressUnchangedAuthenticationProbe === true &&
    failedAuthenticationFingerprint !== null &&
    failedAuthenticationFingerprint === resolveProviderAuthenticationFingerprint()
  ) {
    logger.info('openai.provider.reinitialize_probe_skipped', {
      module: 'openai.service_health',
      source,
      reason: 'provider_authentication_unchanged'
    });
    return {
      ok: false,
      skipped: true,
      reason: 'provider_authentication_unchanged',
      runtime: cloneProviderRuntimeState(state),
      reloaded: reload.reloaded
    };
  }

  if (!options.ignoreBackoff && isProviderBackoffActive(state)) {
    return {
      ok: false,
      skipped: true,
      reason: 'provider_backoff_active',
      runtime: cloneProviderRuntimeState(state),
      reloaded: reload.reloaded
    };
  }

  const probe = await probeOpenAIProviderHealth({
    force: true,
    source
  });

  return {
    ...probe,
    reloaded: reload.reloaded
  };
}

// Legacy export for backward compatibility
export function getOpenAIServiceHealth() {
  const health = validateClientHealth();
  const circuitBreakerMetrics = getCircuitBreakerSnapshot();
  const cacheStats = responseCache.getStats();

  // Health reads from unified client singleton; init-openai sets only the adapter. Treat adapter as source of truth for "initialized" so AI readiness matches actual request path.
  const adapterInitialized = isOpenAIAdapterInitialized();
  const effectiveInitialized = health.healthy || adapterInitialized;
  const effectiveApiKeyConfigured = health.apiKeyConfigured || adapterInitialized;

  const result = {
    apiKey: {
      configured: effectiveApiKeyConfigured,
      status: effectiveApiKeyConfigured ? 'valid' : 'missing_or_invalid',
      source: health.apiKeySource
    },
    client: {
      initialized: effectiveInitialized,
      model: health.defaultModel,
      timeout: getApiTimeoutMs(),
      baseURL: resolveOpenAIBaseURL()
    },
    circuitBreaker: {
      ...circuitBreakerMetrics,
      healthy: health.circuitBreakerHealthy
    },
    cache: {
      ...cacheStats,
      enabled: health.cacheEnabled
    },
    lastHealthCheck: health.lastCheck,
    defaults: {
      maxTokens: RESILIENCE_CONSTANTS.DEFAULT_MAX_TOKENS
    },
    providerRuntime: {
      ...getOpenAIProviderRuntimeStatus(),
      // Historical failure categories remain visible after configuration changes;
      // admission must compare their private identity with the current credential.
      authenticationBlocked: getProviderRuntimeState().authenticationFailureFingerprint ===
        resolveProviderAuthenticationFingerprint()
    }
  };
  return result;
}

// Legacy export for backward compatibility
export function validateAPIKeyAtStartup(): boolean {
  const health = validateClientHealth();
  const apiKeyConfigured = health.apiKeyConfigured;
  const forceMock = getEnv('FORCE_MOCK') === 'true';

  if (!forceMock) {
    syncOpenAIProviderRuntime({
      reason: 'startup'
    });
  }

  if (!apiKeyConfigured) {
    markProviderFailure(new Error('OpenAI API key missing at startup'), {
      attemptedAt: new Date().toISOString(),
      source: 'startup'
    });
    return false;
  }

  logger.info('openai.provider.startup', {
    module: 'openai.service_health',
    status: 'configured',
    source: health.apiKeySource
  });

  if (forceMock) {
    logger.info('openai.provider.startup_probe_skipped', {
      module: 'openai.service_health',
      reason: 'force_mock'
    });
    return true;
  }

  void probeOpenAIProviderHealth({
    force: true,
    source: 'startup'
  });

  return true;
}
