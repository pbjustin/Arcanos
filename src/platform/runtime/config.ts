/**
 * ARCANOS Configuration
 * Centralized configuration management for environment settings
 */

import dotenv from 'dotenv';
import type { ReinforcementMode } from "@shared/types/reinforcement.js";
import { APPLICATION_CONSTANTS } from "@shared/constants.js";
import { getEnvNumber, getEnv } from "@platform/runtime/env.js";
import { resolveRuntimeCorsConfig } from '@platform/runtime/corsConfig.js';
import { resolveAssistantRegistryPath } from '@platform/runtime/protectedConfigCandidatePaths.js';
import {
  normalizePublicProviderClientRateLimitMax,
  normalizePublicProviderRateLimitMax,
  normalizePublicProviderRateLimitStoreMode,
  normalizePublicProviderRateLimitWindowMs,
  resolvePublicProviderRateLimitNamespace,
  resolvePublicProviderTrustRailwayRealIp,
} from '@platform/runtime/publicProviderRateLimitPolicy.js';

// Load environment variables
dotenv.config();

// Use validated env for PORT (validated at startup via validateRequiredEnv)
const serverPort = getEnvNumber('PORT', APPLICATION_CONSTANTS.DEFAULT_PORT);
const nodeEnv = getEnv('NODE_ENV') || 'development';
// //audit Assumption: development should bind to localhost by default; risk: exposing local endpoints; invariant: use 127.0.0.1 in dev unless HOST overrides; handling: conditional default.
const serverHost = getEnv('HOST') || (nodeEnv === 'development' ? '127.0.0.1' : '0.0.0.0');
//audit Assumption: when SERVER_URL is unset, host/port reflect the externally reachable base URL; risk: reverse proxy uses different public hostname; invariant: internal services can reach base URL; handling: allow SERVER_URL override.
const serverBaseUrl = getEnv('SERVER_URL') || `http://${serverHost}:${serverPort}`;
const statusEndpoint = getEnv('BACKEND_STATUS_ENDPOINT') || '/status';

const parseNumber = (value: string | undefined, fallback: number, min: number = 0): number => {
  const parsed = Number(value);
  if (Number.isFinite(parsed) && parsed >= min) {
    return parsed;
  }
  return fallback;
};

const reinforcementMode = (getEnv('ARCANOS_CONTEXT_MODE') || 'reinforcement') as ReinforcementMode;
const reinforcementWindow = parseNumber(getEnv('ARCANOS_CONTEXT_WINDOW'), 50, 1);
const reinforcementDigestSize = parseNumber(getEnv('ARCANOS_MEMORY_DIGEST_SIZE'), 8, 1);
const reinforcementMinimumClearScore = parseNumber(getEnv('ARCANOS_CLEAR_MIN_SCORE'), 0.85);
const fallbackStrictEnvironments = (getEnv('FALLBACK_STRICT_ENVIRONMENTS') || 'production,staging')
  .split(',')
  .map(value => value.trim())
  .filter(Boolean);
const publicProviderRateLimitMax = normalizePublicProviderRateLimitMax(
  getEnv('PUBLIC_PROVIDER_RATE_LIMIT_MAX')
);
const publicProviderClientRateLimitMax = normalizePublicProviderClientRateLimitMax(
  getEnv('PUBLIC_PROVIDER_CLIENT_RATE_LIMIT_MAX'),
  publicProviderRateLimitMax
);
const publicProviderRateLimitWindowMs = normalizePublicProviderRateLimitWindowMs(
  getEnv('PUBLIC_PROVIDER_RATE_LIMIT_WINDOW_MS')
);
const publicProviderRateLimitStore = normalizePublicProviderRateLimitStoreMode(
  getEnv('PUBLIC_PROVIDER_RATE_LIMIT_STORE'),
  nodeEnv
);
const publicProviderRateLimitNamespace = resolvePublicProviderRateLimitNamespace({
  configuredNamespace: getEnv('PUBLIC_PROVIDER_RATE_LIMIT_NAMESPACE'),
  nodeEnvironment: nodeEnv,
  railwayProjectId: getEnv('RAILWAY_PROJECT_ID'),
  railwayEnvironmentId: getEnv('RAILWAY_ENVIRONMENT_ID'),
  railwayServiceId: getEnv('RAILWAY_SERVICE_ID'),
});
const publicProviderTrustRailwayRealIp = resolvePublicProviderTrustRailwayRealIp(
  getEnv('PUBLIC_PROVIDER_TRUST_RAILWAY_REAL_IP'),
  {
    railwayProjectId: getEnv('RAILWAY_PROJECT_ID'),
    railwayEnvironmentId: getEnv('RAILWAY_ENVIRONMENT_ID'),
    railwayServiceId: getEnv('RAILWAY_SERVICE_ID'),
  }
);

export const config = {
  // Server configuration
  server: {
    port: serverPort,
    host: serverHost,
    environment: nodeEnv,
    baseUrl: serverBaseUrl,
    statusEndpoint
  },

  // AI configuration
  ai: {
    apiKey: getEnv('OPENAI_API_KEY'),
    model: getEnv('AI_MODEL') || getEnv('OPENAI_MODEL') || APPLICATION_CONSTANTS.MODEL_GPT_4O_MINI,
    fallbackModel: APPLICATION_CONSTANTS.MODEL_GPT_4,
    defaultMaxTokens: parseNumber(getEnv('OPENAI_DEFAULT_MAX_TOKENS'), 256, 1),
    defaultTemperature: 0.2
  },

  // CORS configuration
  cors: resolveRuntimeCorsConfig(nodeEnv, getEnv('ALLOWED_ORIGINS')),

  // Request limits
  limits: {
    jsonLimit: getEnv('JSON_LIMIT') || '10mb',
    publicProviderClientRateLimitMax,
    publicProviderRateLimitMax,
    publicProviderRateLimitWindowMs,
    publicProviderRateLimitStore,
    publicProviderRateLimitNamespace,
    publicProviderTrustRailwayRealIp
  },

  fallback: {
    strictEnvironments: fallbackStrictEnvironments,
    preemptive: getEnv('ENABLE_PREEMPTIVE_FALLBACK') === 'true'
  },

  dispatchV9: {
    enabled: getEnv('DISPATCH_V9_ENABLED') === 'true',
    shadowOnly: getEnv('DISPATCH_V9_SHADOW_ONLY') === 'true',
    snapshotCacheTtlMs: parseNumber(getEnv('DISPATCH_V9_SNAPSHOT_CACHE_TTL_MS'), 3000, 0),
    policyTimeoutMs: parseNumber(getEnv('DISPATCH_V9_POLICY_TIMEOUT_MS'), 5000, 1),
    defaultRerouteTarget: getEnv('DISPATCH_V9_DEFAULT_REROUTE_TARGET') || '/gpt/arcanos-daemon',
    readonlyBindingId: getEnv('DISPATCH_V9_READONLY_BINDING_ID') || 'api.readonly'
  },

  safety: {
    heartbeatTimeoutMs: parseNumber(getEnv('SAFETY_HEARTBEAT_TIMEOUT_MS'), 15000, 1000),
    heartbeatMissThreshold: parseNumber(getEnv('SAFETY_HEARTBEAT_MISS_THRESHOLD'), 3, 1),
    healthyCyclesToRecover: parseNumber(getEnv('SAFETY_HEALTHY_CYCLES_TO_RECOVER'), 3, 1),
    quarantineCooldownMs: parseNumber(getEnv('SAFETY_QUARANTINE_COOLDOWN_MS'), 120000, 0),
    workerRestartThreshold: parseNumber(getEnv('SAFETY_WORKER_RESTART_THRESHOLD'), 5, 1),
    workerRestartWindowMs: parseNumber(getEnv('SAFETY_WORKER_RESTART_WINDOW_MS'), 300000, 1),
    failClosedIntegrity: getEnv('SAFETY_FAIL_CLOSED_INTEGRITY') !== 'false'
  },

  // Logging configuration
  logging: {
    level: getEnv('LOG_LEVEL') || 'info',
    sessionLogPath: getEnv('ARC_LOG_PATH') || './memory/session.log'
  },

  telemetry: {
    recentLogLimit: parseNumber(getEnv('TELEMETRY_RECENT_LOGS_LIMIT'), 100, 10),
    traceEventLimit: parseNumber(getEnv('TELEMETRY_TRACE_EVENT_LIMIT'), 200, 25)
  },

  // External integrations
  external: {
    backendRegistryUrl: getEnv('BACKEND_REGISTRY_URL')
  },

  assistantSync: {
    registryPath: resolveAssistantRegistryPath(getEnv('ASSISTANT_REGISTRY_PATH'))
  },

  reinforcement: {
    mode: reinforcementMode,
    window: reinforcementWindow,
    digestSize: reinforcementDigestSize,
    minimumClearScore: reinforcementMinimumClearScore
  },

  tracing: {
    audit: {
      enabled: getEnv('ARCANOS_AUDIT_TRACE') !== 'false'
    }
  }
};



