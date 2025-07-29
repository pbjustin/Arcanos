// Centralized Configuration Management for ARCANOS Backend
import * as dotenv from 'dotenv';
import type { IdentityOverride } from '../types/IdentityOverride';

// Load environment variables
dotenv.config();

function parseIdentityOverride(value?: string): string | IdentityOverride | undefined {
  if (!value) {
    return undefined;
  }
  try {
    return JSON.parse(value) as IdentityOverride;
  } catch {
    return value;
  }
}

// Configuration interface for type safety
export interface Config {
  server: {
    port: number;
    nodeEnv: string;
    maxOldSpaceSize: number;
  };
  ai: {
    openaiApiKey?: string;
    fineTunedModel?: string;
    gptToken?: string;
    identityOverride?: string | IdentityOverride;
    identityTriggerPhrase?: string;
  };
  deployment: {
    mode: 'agent-control' | 'standard';
    githubIntegration: boolean;
    allowWebhooks: boolean;
  };
  github: {
    token?: string;
    webhookSecret?: string;
    enableActions: boolean;
  };
  database: {
    url?: string;
  };
  api: {
    arcanosApiToken?: string;
  };
  railway: {
    environment?: string;
  };
  features: {
    runWorkers: boolean;
    workerLogic: string;
    enableRecovery: boolean;
    enableLogging: boolean;
  };
  chatgpt: {
    allowPostMethods: boolean;
    rateLimit: boolean;
    logToFile: boolean;
  };
}

// Configuration with defaults and validation
export const config: Config = {
  server: {
    port: Number(process.env.PORT) || 8080,
    nodeEnv: process.env.NODE_ENV || 'production',
    maxOldSpaceSize: 7168, // 7GB as configured in package.json
  },
  ai: {
    openaiApiKey: process.env.OPENAI_API_KEY,
    fineTunedModel: process.env.AI_MODEL || process.env.FINE_TUNE_MODEL || process.env.FINE_TUNED_MODEL || process.env.OPENAI_FINE_TUNED_MODEL,
    gptToken: process.env.GPT_TOKEN,
    identityOverride: parseIdentityOverride(process.env.IDENTITY_OVERRIDE),
    identityTriggerPhrase: process.env.IDENTITY_TRIGGER_PHRASE || 'I am Skynet',
  },
  deployment: {
    mode: (process.env.DEPLOY_MODE as 'agent-control' | 'standard') || 'standard',
    githubIntegration: process.env.GITHUB_INTEGRATION !== 'false',
    allowWebhooks: process.env.ALLOW_WEBHOOKS !== 'false',
  },
  github: {
    token: process.env.GITHUB_TOKEN || process.env.GITHUB_API_TOKEN,
    webhookSecret: process.env.GITHUB_WEBHOOK_SECRET,
    enableActions: process.env.ENABLE_GITHUB_ACTIONS !== 'false',
  },
  database: {
    url: process.env.DATABASE_URL,
  },
  api: {
    arcanosApiToken: process.env.ARCANOS_API_TOKEN,
  },
  railway: {
    environment: process.env.RAILWAY_ENVIRONMENT,
  },
  features: {
    runWorkers: process.env.RUN_WORKERS === 'true',
    workerLogic: process.env.WORKER_LOGIC || 'arcanos',
    enableRecovery: process.env.ENABLE_RECOVERY !== 'false', // Default to true
    enableLogging: process.env.ENABLE_LOGGING !== 'false', // Default to true
  },
  chatgpt: {
    allowPostMethods: false,
    rateLimit: true,
    logToFile: false,
  },
};

// Configuration validation
export function validateConfig(): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  // Check required environment variables
  if (!config.ai.openaiApiKey) {
    errors.push('OPENAI_API_KEY is required');
  }

  if (!config.api.arcanosApiToken) {
    console.warn('⚠️ ARCANOS_API_TOKEN not set - some endpoints will be unavailable');
  }

  if (!config.database.url) {
    console.warn('⚠️ DATABASE_URL not set - running in degraded mode');
  }

  // Validate port number
  if (isNaN(config.server.port) || config.server.port < 1 || config.server.port > 65535) {
    errors.push('PORT must be a valid port number (1-65535)');
  }

  // Validate deployment mode configuration
  if (config.deployment.mode === 'agent-control') {
    if (!config.ai.openaiApiKey) {
      errors.push('OPENAI_API_KEY is required for agent-control mode');
    }
    if (config.github.enableActions && !config.github.token) {
      console.warn('⚠️ GITHUB_TOKEN not set - GitHub Actions integration will be disabled');
    }
  }

  // GitHub integration validation
  if (config.deployment.githubIntegration && config.deployment.allowWebhooks && !config.github.webhookSecret) {
    console.warn('⚠️ GITHUB_WEBHOOK_SECRET not set - webhook signature verification will be skipped');
  }

  const expectedModel = 'REDACTED_FINE_TUNED_MODEL_ID';
  if (!config.ai.fineTunedModel) {
    errors.push(`AI_MODEL is required and must be set to ${expectedModel}`);
  } else if (config.ai.fineTunedModel !== expectedModel) {
    errors.push(`AI_MODEL mismatch. Expected ${expectedModel}`);
  }

  return {
    valid: errors.length === 0,
    errors
  };
}

// Environment status utility
export function getEnvironmentStatus() {
  return {
    fineTunedModelConfigured: !!(config.ai.fineTunedModel),
    openaiApiKeyConfigured: !!(config.ai.openaiApiKey),
    databaseConfigured: !!(config.database.url),
    apiTokenConfigured: !!(config.api.arcanosApiToken),
    workerLogic: config.features.workerLogic,
    isRailway: !!(config.railway.environment),
    isDevelopment: config.server.nodeEnv === 'development',
    isProduction: config.server.nodeEnv === 'production',
    deploymentMode: config.deployment.mode,
    githubIntegration: config.deployment.githubIntegration,
    githubActionsEnabled: config.github.enableActions,
  };
}

// Export specific config sections for convenience
export const serverConfig = config.server;
export const aiConfig = config.ai;
export const databaseConfig = config.database;
export const apiConfig = config.api;
export const railwayConfig = config.railway;
export const featureConfig = config.features;
export const deploymentConfig = config.deployment;
export const githubConfig = config.github;
export const workerLogic = config.features.workerLogic;
export const chatgptConfig = config.chatgpt;
