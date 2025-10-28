/**
 * ARCANOS Configuration
 * Centralized configuration management for environment settings
 */

import dotenv from 'dotenv';

// Load environment variables
dotenv.config();

const serverPort = Number(process.env.PORT) || 8080;
const serverHost = process.env.HOST || '0.0.0.0';
const serverBaseUrl = process.env.SERVER_URL || `http://127.0.0.1:${serverPort}`;
const statusEndpoint = process.env.BACKEND_STATUS_ENDPOINT || '/status';

export const config = {
  // Server configuration
  server: {
    port: serverPort,
    host: serverHost,
    environment: process.env.NODE_ENV || 'development',
    baseUrl: serverBaseUrl,
    statusEndpoint
  },

  // AI configuration
  ai: {
    apiKey: process.env.OPENAI_API_KEY,
    model: process.env.AI_MODEL || 'gpt-4-turbo',
    fallbackModel: 'gpt-4',
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
    jsonLimit: '10mb',
    requestTimeout: 30000
  },

  // Logging configuration
  logging: {
    level: process.env.LOG_LEVEL || 'info',
    sessionLogPath: process.env.ARC_LOG_PATH || './memory/session.log'
  },

  // External integrations
  external: {
    backendRegistryUrl: process.env.BACKEND_REGISTRY_URL
  }
};

export default config;