import type OpenAI from 'openai';
import { createOpenAIClient as createSDKClient } from './client.js';

export interface ClientOptions {
  /** API key override (defaults to dependency resolution) */
  apiKey?: string;
  /** Base URL override (defaults to dependency resolution) */
  baseURL?: string;
  /** Timeout in milliseconds (defaults to dependency timeout or 60000) */
  timeout?: number;
  /** Whether to use singleton pattern (default: true) */
  singleton?: boolean;
}

export interface HealthStatus {
  /** Whether client is initialized and healthy */
  healthy: boolean;
  /** Whether API key is configured */
  apiKeyConfigured: boolean;
  /** Source of API key */
  apiKeySource: string | null;
  /** Default model configured */
  defaultModel: string;
  /** Fallback model configured */
  fallbackModel: string;
  /** Circuit breaker state */
  circuitBreakerHealthy: boolean;
  /** Cache statistics */
  cacheEnabled: boolean;
  /** Last health check timestamp */
  lastCheck: string;
  /** Error message if unhealthy */
  error?: string;
}

export interface UnifiedOpenAIAdapterLike {
  getClient: () => OpenAI;
}

export interface UnifiedClientDependencies {
  /** Resolve the API key for this process/runtime. Return null when unavailable. */
  resolveApiKey: () => string | null;

  /** Resolve a baseURL override (optional). */
  resolveBaseURL?: () => string | undefined;

  /** Optional: indicates where the key came from (env/config/secret store). */
  getApiKeySource?: () => string | null;

  /** Optional: quick boolean check for key availability (used for late-key retry). */
  hasValidAPIKey?: () => boolean;

  /** Optional: model helpers for health/status reporting. */
  setDefaultModel?: (model: string) => void;
  getDefaultModel?: () => string;
  getFallbackModel?: () => string;

  /** Optional: read configured OpenAI defaults. */
  getTimeoutMs?: () => number;
  getMaxRetries?: () => number | undefined;
  getConfiguredDefaultModel?: () => string | undefined;

  /** Optional: adapter integration for apps that enforce an adapter boundary. */
  createAdapter?: (config: Record<string, unknown>) => UnifiedOpenAIAdapterLike;
  getAdapter?: (config?: Record<string, unknown>) => UnifiedOpenAIAdapterLike;
  isAdapterInitialized?: () => boolean;
  resetAdapter?: () => void;

  /** Optional: routing/system message for all completions (ARCANOS). */
  getRoutingMessage?: () => string;

  /** Optional: circuit breaker snapshot for health checks. */
  getCircuitBreakerSnapshot?: () => { state?: string } | null;

  /** Optional: cache availability for health checks. */
  isCacheEnabled?: () => boolean;

  /** Optional: tracing hook. */
  trace?: (event: string, data?: Record<string, unknown>) => string | void;

  /** Optional: structured logger hook. */
  logger?: {
    info: (message: string, meta?: Record<string, unknown>) => void;
    warn: (message: string, meta?: Record<string, unknown>) => void;
    error: (message: string, meta?: Record<string, unknown>, error?: Error) => void;
  };

  /** Optional: error-to-message resolver. */
  resolveErrorMessage?: (error: unknown) => string;

  /** Optional: time source (for tests). */
  now?: () => number;
}

export interface UnifiedClient {
  API_TIMEOUT_MS: number;
  ARCANOS_ROUTING_MESSAGE: string;

  createOpenAIClient: (options?: ClientOptions) => OpenAI | null;
  getOrCreateClient: () => OpenAI | null;
  getClient: () => OpenAI | null;
  validateClientHealth: () => HealthStatus;
  resetClient: () => void;
}

/**
 * Creates a unified OpenAI client wrapper with injected environment/platform dependencies.
 *
 * This keeps the shared package dependency-free while still allowing the backend to provide:
 * - credential resolution
 * - structured logging/telemetry
 * - adapter/circuit breaker integration
 */
export function createUnifiedClient(deps: UnifiedClientDependencies): UnifiedClient {
  const logger = deps.logger ?? {
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined
  };

  const trace = deps.trace ?? (() => undefined);
  const resolveErrorMessage =
    deps.resolveErrorMessage ??
    ((error: unknown) => (error instanceof Error ? error.message : String(error)));

  const now = deps.now ?? (() => Date.now());

  const API_TIMEOUT_MS = (() => {
    try {
      const value = deps.getTimeoutMs?.();
      return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 60000;
    } catch {
      return 60000;
    }
  })();

  const ARCANOS_ROUTING_MESSAGE = (() => {
    try {
      return deps.getRoutingMessage?.() ?? '';
    } catch {
      return '';
    }
  })();

  let singletonClient: OpenAI | null = null;
  let initializationAttempted = false;

  function buildAdapterConfig(args: { apiKey: string; baseURL?: string; timeout: number }): Record<string, unknown> {
    const maxRetries = deps.getMaxRetries?.();
    const configuredDefaultModel = deps.getConfiguredDefaultModel?.();
    return {
      apiKey: args.apiKey,
      baseURL: args.baseURL,
      timeout: args.timeout,
      ...(typeof maxRetries === 'number' ? { maxRetries } : {}),
      ...(configuredDefaultModel ? { defaultModel: configuredDefaultModel } : {})
    };
  }

  function createClientViaAdapter(args: { apiKey: string; baseURL?: string; timeout: number; singleton: boolean }): OpenAI {
    const adapterConfig = buildAdapterConfig({ apiKey: args.apiKey, baseURL: args.baseURL, timeout: args.timeout });

    if (args.singleton) {
      if (!deps.getAdapter) {
        throw new Error('getAdapter dependency not provided');
      }
      return deps.getAdapter(adapterConfig).getClient();
    }

    if (deps.createAdapter) {
      return deps.createAdapter(adapterConfig).getClient();
    }

    // Fallback: if createAdapter isn't provided, but getAdapter exists, use it.
    if (deps.getAdapter) {
      return deps.getAdapter(adapterConfig).getClient();
    }

    throw new Error('Adapter dependencies not provided');
  }

  function createClientViaSDK(args: { apiKey: string; baseURL?: string; timeout: number }): OpenAI {
    return createSDKClient({
      apiKey: args.apiKey,
      baseURL: args.baseURL,
      timeoutMs: args.timeout
    });
  }

  function createOpenAIClient(options: ClientOptions = {}): OpenAI | null {
    const startTime = now();
    const traceId = trace('openai.client.create.start', {
      hasApiKeyOverride: Boolean(options.apiKey),
      hasBaseURLOverride: Boolean(options.baseURL),
      timeout: options.timeout || API_TIMEOUT_MS
    });

    try {
      const apiKey = options.apiKey || deps.resolveApiKey();
      if (!apiKey) {
        logger.warn('OpenAI API key not configured - AI endpoints will return mock responses', {
          module: 'openai.unified',
          operation: 'createOpenAIClient'
        });
        trace('openai.client.create.no_key', { traceId: String(traceId ?? '') });
        return null;
      }

      const baseURL = options.baseURL || deps.resolveBaseURL?.();
      const timeout = options.timeout || API_TIMEOUT_MS;

      const useSingleton = options.singleton !== false;
      const client =
        deps.getAdapter || deps.createAdapter
          ? createClientViaAdapter({ apiKey, baseURL, timeout, singleton: useSingleton })
          : createClientViaSDK({ apiKey, baseURL, timeout });

      const configuredDefaultModel = deps.getConfiguredDefaultModel?.();
      if (configuredDefaultModel && deps.setDefaultModel) {
        deps.setDefaultModel(configuredDefaultModel);
      }

      const duration = now() - startTime;

      logger.info('✅ OpenAI client created', {
        module: 'openai.unified',
        operation: 'createOpenAIClient',
        duration,
        model: configuredDefaultModel,
        source: deps.getApiKeySource?.() ?? null
      });

      trace('openai.client.create.success', {
        traceId: String(traceId ?? ''),
        duration,
        model: configuredDefaultModel
      });

      return client;
    } catch (error) {
      const duration = now() - startTime;
      const errorMessage = resolveErrorMessage(error);

      logger.error(
        '❌ Failed to create OpenAI client',
        {
          module: 'openai.unified',
          operation: 'createOpenAIClient',
          duration,
          error: errorMessage
        },
        error instanceof Error ? error : undefined
      );

      trace('openai.client.create.error', {
        traceId: String(traceId ?? ''),
        duration,
        error: errorMessage
      });

      return null;
    }
  }

  function getOrCreateClient(): OpenAI | null {
    if (singletonClient) {
      return singletonClient;
    }

    if (deps.isAdapterInitialized?.()) {
      try {
        if (deps.getAdapter) {
          singletonClient = deps.getAdapter().getClient();
          initializationAttempted = true;
          return singletonClient;
        }
      } catch {
        // ignore and fall through
      }
    }

    const validKey = deps.hasValidAPIKey ? deps.hasValidAPIKey() : deps.resolveApiKey() !== null;

    if (initializationAttempted && validKey) {
      logger.info('OpenAI API key now available - retrying client creation', {
        module: 'openai.unified',
        operation: 'getOrCreateClient'
      });
      initializationAttempted = false;
      singletonClient = null;
    }

    if (initializationAttempted) {
      logger.warn('OpenAI client initialization already attempted, returning null', {
        module: 'openai.unified',
        operation: 'getOrCreateClient'
      });
      return null;
    }

    initializationAttempted = true;
    singletonClient = createOpenAIClient({ singleton: true });
    return singletonClient;
  }

  function getClient(): OpenAI | null {
    if (!singletonClient && deps.isAdapterInitialized?.()) {
      try {
        if (deps.getAdapter) {
          singletonClient = deps.getAdapter().getClient();
        }
      } catch {
        // ignore
      }
    }
    return singletonClient;
  }

  function validateClientHealth(): HealthStatus {
    const configured = deps.hasValidAPIKey ? deps.hasValidAPIKey() : deps.resolveApiKey() !== null;
    const initialized = singletonClient !== null;

    const circuitBreakerSnapshot = deps.getCircuitBreakerSnapshot?.() ?? null;
    const circuitOpen = circuitBreakerSnapshot?.state === 'OPEN';

    const defaultModel = deps.getDefaultModel?.() ?? '';
    const fallbackModel = deps.getFallbackModel?.() ?? '';

    const health: HealthStatus = {
      healthy: configured && initialized && !circuitOpen,
      apiKeyConfigured: configured,
      apiKeySource: deps.getApiKeySource?.() ?? null,
      defaultModel,
      fallbackModel,
      circuitBreakerHealthy: !circuitOpen,
      cacheEnabled: deps.isCacheEnabled?.() ?? true,
      lastCheck: new Date().toISOString()
    };

    if (!health.healthy) {
      if (!configured) {
        health.error = 'API key not configured';
      } else if (!initialized) {
        health.error = 'Client not initialized';
      } else if (!health.circuitBreakerHealthy) {
        health.error = 'Circuit breaker is OPEN';
      }
    }

    return health;
  }

  function resetClient(): void {
    singletonClient = null;
    initializationAttempted = false;
    deps.resetAdapter?.();
    trace('openai.client.reset', { module: 'openai.unified' });
    logger.info('OpenAI client reset', {
      module: 'openai.unified',
      operation: 'resetClient'
    });
  }

  return {
    API_TIMEOUT_MS,
    ARCANOS_ROUTING_MESSAGE,
    createOpenAIClient,
    getOrCreateClient,
    getClient,
    validateClientHealth,
    resetClient
  };
}

// ---------------------------------------------------------------------------
// Global (process-wide) unified client wiring
// ---------------------------------------------------------------------------

/**
 * Global singleton unified client instance.
 * Consumers that don't want singletons should use `createUnifiedClient()` directly.
 */
let globalUnifiedClient: UnifiedClient | null = null;

/**
 * Tracks whether the global unified client was explicitly configured by the host application.
 * When false, `ensureGlobalClient()` may fall back to a minimal env-based configuration (unless strict mode is enabled).
 */
let globalExplicitlyConfigured = false;

/**
 * Live bindings (ESM) for convenience imports.
 *
 * ⚠️ These are kept for backward compatibility. In CommonJS builds, destructuring imports can snapshot values.
 * Prefer the getters `getApiTimeoutMs()` and `getRoutingMessage()` instead.
 */
// eslint-disable-next-line @typescript-eslint/naming-convention
export let API_TIMEOUT_MS: number = 60000;
// eslint-disable-next-line @typescript-eslint/naming-convention
export let ARCANOS_ROUTING_MESSAGE: string = '';

function isStrictRequireConfig(): boolean {
  const raw =
    process.env.ARCANOS_OPENAI_REQUIRE_CONFIG ??
    process.env.ARCANOS_REQUIRE_OPENAI_CONFIG ??
    process.env.ARCANOS_UNIFIEDCLIENT_STRICT;
  if (!raw) return false;
  const value = raw.trim().toLowerCase();
  return value === '1' || value === 'true' || value === 'yes';
}

function resolveEnvApiKey(): string | null {
  const candidates = [
    process.env.OPENAI_API_KEY,
    process.env.RAILWAY_OPENAI_API_KEY,
    process.env.API_KEY,
    process.env.OPENAI_KEY
  ];
  for (const value of candidates) {
    if (typeof value === 'string') {
      const trimmed = value.trim();
      if (trimmed.length > 0) return trimmed;
    }
  }
  return null;
}

function resolveEnvBaseURL(): string | undefined {
  const value = process.env.OPENAI_BASE_URL ?? process.env.OPENAI_BASEURL;
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function syncLiveBindings(client: UnifiedClient): void {
  API_TIMEOUT_MS = client.API_TIMEOUT_MS;
  ARCANOS_ROUTING_MESSAGE = client.ARCANOS_ROUTING_MESSAGE;
}

function ensureGlobalClient(): UnifiedClient {
  if (globalUnifiedClient) {
    return globalUnifiedClient;
  }

  if (isStrictRequireConfig()) {
    throw new Error(
      'Unified OpenAI client not configured. Call configureUnifiedClient(...) during startup, ' +
        'or disable strict mode (ARCANOS_OPENAI_REQUIRE_CONFIG).'
    );
  }

  // Minimal default wiring: env-based API key + SDK client (no adapter boundary).
  globalUnifiedClient = createUnifiedClient({
    resolveApiKey: resolveEnvApiKey,
    resolveBaseURL: resolveEnvBaseURL,
    getApiKeySource: () => (resolveEnvApiKey() ? 'env' : null),
    hasValidAPIKey: () => resolveEnvApiKey() !== null
  });

  globalExplicitlyConfigured = false;
  syncLiveBindings(globalUnifiedClient);

  return globalUnifiedClient;
}

/**
 * Configure the process-wide unified client instance.
 *
 * Call this once during application startup so all consumers importing from
 * `@arcanos/openai/unifiedClient` share a single, correctly wired instance.
 */
export function configureUnifiedClient(deps: UnifiedClientDependencies): UnifiedClient {
  // If a default client was already created, reset it to avoid mixed-mode behavior.
  if (globalUnifiedClient) {
    try {
      globalUnifiedClient.resetClient();
    } catch {
      // ignore
    }
  }

  globalUnifiedClient = createUnifiedClient(deps);
  globalExplicitlyConfigured = true;
  syncLiveBindings(globalUnifiedClient);
  return globalUnifiedClient;
}

/**
 * Whether the global unified client was explicitly configured by the host application.
 */
export function isUnifiedClientConfigured(): boolean {
  return globalExplicitlyConfigured;
}

/**
 * Throw if the global unified client has not been explicitly configured.
 * Useful for backends that must enforce adapter/circuit-breaker wiring.
 */
export function requireUnifiedClientConfigured(): void {
  if (!globalExplicitlyConfigured) {
    throw new Error(
      'Unified OpenAI client is using the default env-based configuration. ' +
        'Call configureUnifiedClient(...) during startup to ensure adapter/circuit-breaker wiring.'
    );
  }
}

/**
 * Retrieve the process-wide unified client instance.
 * If not configured, a minimal env-based client wrapper is created (unless strict mode is enabled).
 */
export function getUnifiedClient(): UnifiedClient {
  return ensureGlobalClient();
}

/**
 * Getter for the effective API timeout (robust across ESM/CJS).
 */
export function getApiTimeoutMs(): number {
  return ensureGlobalClient().API_TIMEOUT_MS;
}

/**
 * Getter for the effective ARCANOS routing message (robust across ESM/CJS).
 */
export function getRoutingMessage(): string {
  return ensureGlobalClient().ARCANOS_ROUTING_MESSAGE;
}

// Convenience re-exports that mirror the legacy backend module surface.
export function createOpenAIClient(options: ClientOptions = {}): OpenAI | null {
  return ensureGlobalClient().createOpenAIClient(options);
}

export function getOrCreateClient(): OpenAI | null {
  return ensureGlobalClient().getOrCreateClient();
}

export function getClient(): OpenAI | null {
  return ensureGlobalClient().getClient();
}

export function validateClientHealth(): HealthStatus {
  return ensureGlobalClient().validateClientHealth();
}

export function resetClient(): void {
  ensureGlobalClient().resetClient();
}
