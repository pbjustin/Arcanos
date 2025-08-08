/**
 * ARCANOS Configuration
 * Centralized configuration management for environment settings
 */

import dotenv from 'dotenv';

// Load environment variables
dotenv.config();

export const config = {
  // Server configuration
  server: {
    port: Number(process.env.PORT) || 3000,
    host: '0.0.0.0',
    environment: process.env.NODE_ENV || 'development'
  },

  // AI configuration
  ai: {
    apiKey: process.env.OPENAI_API_KEY,
    model: process.env.AI_MODEL || 'ft:gpt-3.5-turbo-0125:personal:arcanos-v2',
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
  }
};

export default config;