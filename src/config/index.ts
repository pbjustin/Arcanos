/**
 * ARCANOS Configuration
 * Centralized configuration management for environment settings
 */

import dotenv from 'dotenv';
import path from 'path';
import type { ReinforcementMode } from '../types/reinforcement.js';
import { APPLICATION_CONSTANTS } from '../utils/constants.js';
import { getEnvNumber, getEnv } from './env.js';

// Load environment variables
dotenv.config();

// Use validated env for PORT (validated at startup via validateRequiredEnv)
const serverPort = getEnvNumber('PORT', APPLICATION_CONSTANTS.DEFAULT_PORT);
// //audit Assumption: development should bind to localhost by default; risk: exposing local endpoints; invariant: use 127.0.0.1 in dev unless HOST overrides; handling: conditional default.
const serverHost = getEnv('HOST') || (process.env.NODE_ENV === 'development' ? '127.0.0.1' : '0.0.0.0');
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

export const config = {
  // Server configuration
  server: {
    port: serverPort,
    host: serverHost,
    environment: getEnv('NODE_ENV') || 'development',
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
  cors: {
    origin: getEnv('NODE_ENV') === 'development' ? true : getEnv('ALLOWED_ORIGINS')?.split(','),
    credentials: true
  },

  // Request limits
  limits: {
    jsonLimit: getEnv('JSON_LIMIT') || '10mb',
    requestTimeout: Number(getEnv('REQUEST_TIMEOUT')) || 30000
  },

  fallback: {
    strictEnvironments: fallbackStrictEnvironments,
    preemptive: getEnv('ENABLE_PREEMPTIVE_FALLBACK') === 'true'
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
    enabled: getEnv('ASSISTANT_SYNC_ENABLED') !== 'false',
    schedule: getEnv('ASSISTANT_SYNC_CRON') || '15,45 * * * *',
    registryPath:
      getEnv('ASSISTANT_REGISTRY_PATH') || path.join(process.cwd(), 'config', 'assistants.json')
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

export default config;
