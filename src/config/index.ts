/**
 * ARCANOS Configuration
 * Centralized configuration management for environment settings
 */

import dotenv from 'dotenv';
import path from 'path';
import type { ReinforcementMode } from '../types/reinforcement.js';
import { APPLICATION_CONSTANTS } from '../utils/constants.js';

// Load environment variables
dotenv.config();

const serverPort = Number(process.env.PORT) || 8080;
const serverHost = process.env.HOST || '0.0.0.0';
const serverBaseUrl = process.env.SERVER_URL || `http://127.0.0.1:${serverPort}`;
const statusEndpoint = process.env.BACKEND_STATUS_ENDPOINT || '/status';

const parseNumber = (value: string | undefined, fallback: number, min: number = 0): number => {
  const parsed = Number(value);
  if (Number.isFinite(parsed) && parsed >= min) {
    return parsed;
  }
  return fallback;
};

const reinforcementMode = (process.env.ARCANOS_CONTEXT_MODE || 'reinforcement') as ReinforcementMode;
const reinforcementWindow = parseNumber(process.env.ARCANOS_CONTEXT_WINDOW, 50, 1);
const reinforcementDigestSize = parseNumber(process.env.ARCANOS_MEMORY_DIGEST_SIZE, 8, 1);
const reinforcementMinimumClearScore = parseNumber(process.env.ARCANOS_CLEAR_MIN_SCORE, 0.85);
const statelessMode = process.env.ARCANOS_STATELESS === 'true';
const fallbackStrictEnvironments = (process.env.FALLBACK_STRICT_ENVIRONMENTS || 'production,staging')
  .split(',')
  .map(value => value.trim())
  .filter(Boolean);

export const config = {
  // Server configuration
  server: {
    port: serverPort,
    host: serverHost,
    environment: process.env.NODE_ENV || 'development',
    baseUrl: serverBaseUrl,
    statusEndpoint,
    stateless: statelessMode
  },

  // AI configuration
  ai: {
    apiKey: process.env.OPENAI_API_KEY,
    model: process.env.AI_MODEL || APPLICATION_CONSTANTS.MODEL_GPT_4_TURBO,
    fallbackModel: APPLICATION_CONSTANTS.MODEL_GPT_4,
    defaultMaxTokens: 200,
    defaultTemperature: 0.2
  },

  // CORS configuration
  cors: {
    origin: process.env.NODE_ENV === 'development' ? true : process.env.ALLOWED_ORIGINS?.split(','),
    credentials: true
  },

  // Request limits
  limits: {
    jsonLimit: process.env.JSON_LIMIT || '10mb',
    requestTimeout: Number(process.env.REQUEST_TIMEOUT) || 30000
  },

  fallback: {
    strictEnvironments: fallbackStrictEnvironments,
    preemptive: process.env.ENABLE_PREEMPTIVE_FALLBACK === 'true'
  },

  // Logging configuration
  logging: {
    level: process.env.LOG_LEVEL || 'info',
    sessionLogPath: process.env.ARC_LOG_PATH || './memory/session.log'
  },

  telemetry: {
    recentLogLimit: parseNumber(process.env.TELEMETRY_RECENT_LOGS_LIMIT, 100, 10),
    traceEventLimit: parseNumber(process.env.TELEMETRY_TRACE_EVENT_LIMIT, 200, 25)
  },

  // External integrations
  external: {
    backendRegistryUrl: process.env.BACKEND_REGISTRY_URL
  },

  assistantSync: {
    enabled: process.env.ASSISTANT_SYNC_ENABLED !== 'false',
    schedule: process.env.ASSISTANT_SYNC_CRON || '15,45 * * * *',
    registryPath:
      process.env.ASSISTANT_REGISTRY_PATH || path.join(process.cwd(), 'config', 'assistants.json')
  },

  reinforcement: {
    mode: reinforcementMode,
    window: reinforcementWindow,
    digestSize: reinforcementDigestSize,
    minimumClearScore: reinforcementMinimumClearScore
  },

  tracing: {
    audit: {
      enabled: process.env.ARCANOS_AUDIT_TRACE !== 'false'
    }
  }
};

export default config;
