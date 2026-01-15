/**
 * OpenAI Logging Utilities
 * Provides reusable logging functions for OpenAI service operations
 */

import { aiLogger } from './structuredLogging.js';
import { recordTraceEvent } from './telemetry.js';
import { OPENAI_REQUEST_LOG_CONTEXT } from '../services/openai/config.js';

/**
 * Centralized OpenAI event logger
 */
export const logOpenAIEvent = (
  level: 'debug' | 'info' | 'warn' | 'error',
  message: string,
  metadata?: Record<string, unknown>,
  error?: Error
) => {
  aiLogger[level](message, { ...OPENAI_REQUEST_LOG_CONTEXT, ...metadata }, undefined, error);
};

/**
 * Log OpenAI request failure with telemetry
 */
export const logOpenAIFailure = (
  level: 'warn' | 'error',
  message: string,
  context: {
    attempt?: number;
    maxRetries?: number;
    errorType?: string;
    model?: string;
    [key: string]: unknown;
  },
  error?: Error
) => {
  logOpenAIEvent(level, message, context, error);
  
  // Record telemetry for tracking
  if (context.attempt !== undefined) {
    recordTraceEvent('openai.call.failure', {
      attempt: context.attempt,
      maxRetries: context.maxRetries,
      errorType: context.errorType,
      message: error?.message
    });
  }
};

/**
 * Log OpenAI request success with metrics
 */
export const logOpenAISuccess = (
  message: string,
  context: {
    attempt?: number;
    model: string;
    totalTokens?: number | 'unknown';
    [key: string]: unknown;
  }
) => {
  logOpenAIEvent('info', message, context);
};
