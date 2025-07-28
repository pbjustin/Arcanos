/**
 * Common Logger Utilities for ARCANOS Backend
 * Consolidates repeated logging patterns
 */

import { relayLog } from '../services/log-relay';

export type LogLevel = 'info' | 'success' | 'warning' | 'error' | 'debug';

/**
 * Common log emojis and colors
 */
const LOG_ICONS = {
  info: 'ℹ️',
  success: '✅',
  warning: '⚠️',
  error: '❌',
  debug: '🔍'
} as const;

/**
 * Service-specific context logger
 */
export class ServiceLogger {
  constructor(private serviceName: string) {}

  private formatMessage(level: LogLevel, message: string, context?: any): string {
    const icon = LOG_ICONS[level];
    const timestamp = new Date().toISOString();
    let logMessage = `${icon} ${this.serviceName} - ${message}`;
    
    if (context) {
      logMessage += ` ${JSON.stringify(context)}`;
    }
    
    return logMessage;
  }

  info(message: string, context?: any): void {
    const formatted = this.formatMessage('info', message, context);
    console.log(formatted);
    relayLog({
      timestamp: new Date().toISOString(),
      level: 'info',
      service: this.serviceName,
      message,
      context,
    });
  }

  success(message: string, context?: any): void {
    const formatted = this.formatMessage('success', message, context);
    console.log(formatted);
    relayLog({
      timestamp: new Date().toISOString(),
      level: 'success',
      service: this.serviceName,
      message,
      context,
    });
  }

  warning(message: string, context?: any): void {
    const formatted = this.formatMessage('warning', message, context);
    console.warn(formatted);
    relayLog({
      timestamp: new Date().toISOString(),
      level: 'warning',
      service: this.serviceName,
      message,
      context,
    });
  }

  error(message: string, error?: any, context?: any): void {
    const errorContext = error instanceof Error
      ? { ...context, error: error.message }
      : { ...context, error };
    const formatted = this.formatMessage('error', message, errorContext);
    console.error(formatted);
    relayLog({
      timestamp: new Date().toISOString(),
      level: 'error',
      service: this.serviceName,
      message,
      context: errorContext,
    });
  }

  debug(message: string, context?: any): void {
    if (process.env.NODE_ENV === 'development') {
      const formatted = this.formatMessage('debug', message, context);
      console.log(formatted);
      relayLog({
        timestamp: new Date().toISOString(),
        level: 'debug',
        service: this.serviceName,
        message,
        context,
      });
    }
  }
}

/**
 * Common ARCANOS service logging patterns
 */
export const arcanosLogger = {
  /**
   * Log service operation start
   */
  serviceStart(serviceName: string, operation: string, context?: any): void {
    const message = `🚀 ${serviceName} - Starting ${operation}`;
    const contextStr = context ? JSON.stringify(context) : '';
    console.log(message, contextStr);
    relayLog({
      timestamp: new Date().toISOString(),
      level: 'info',
      service: serviceName,
      message: `Starting ${operation}`,
      context,
    });
  },

  /**
   * Log service operation success
   */
  serviceSuccess(serviceName: string, operation: string, context?: any): void {
    const message = `✅ ${serviceName} - Successfully completed ${operation}`;
    const contextStr = context ? JSON.stringify(context) : '';
    console.log(message, contextStr);
    relayLog({
      timestamp: new Date().toISOString(),
      level: 'success',
      service: serviceName,
      message: `Completed ${operation}`,
      context,
    });
  },

  /**
   * Log service operation error
   */
  serviceError(serviceName: string, operation: string, error: any, context?: any): void {
    const errorMessage = error instanceof Error ? error.message : String(error);
    const logContext = { ...context, error: errorMessage };
    console.error(`❌ ${serviceName} - ${operation} error:`, JSON.stringify(logContext));
    relayLog({
      timestamp: new Date().toISOString(),
      level: 'error',
      service: serviceName,
      message: `${operation} error`,
      context: logContext,
    });
  },

  /**
   * Log OpenAI API errors (common pattern)
   */
  openaiError(serviceName: string, response: any): void {
    console.error(`❌ OpenAI error in ${serviceName} service:`, response.error);
    relayLog({
      timestamp: new Date().toISOString(),
      level: 'error',
      service: serviceName,
      message: 'OpenAI error',
      context: { error: response.error },
    });
  },

  /**
   * Log database operations
   */
  databaseOperation(operation: string, success: boolean, details?: any): void {
    const icon = success ? '✅' : '❌';
    const status = success ? 'successful' : 'failed';
    console.log(`${icon} Database ${operation} ${status}`, details ? JSON.stringify(details) : '');
    relayLog({
      timestamp: new Date().toISOString(),
      level: success ? 'success' : 'error',
      service: 'Database',
      message: `${operation} ${status}`,
      context: details,
    });
  },

  /**
   * Log memory operations
   */
  memorySnapshot(operation: string, data: any): void {
    console.log(`💾 [MEMORY-SNAPSHOT] ${operation}:`, {
      ...data,
      timestamp: new Date().toISOString()
    });
    relayLog({
      timestamp: new Date().toISOString(),
      level: 'info',
      service: 'Memory',
      message: `Snapshot ${operation}`,
      context: data,
    });
  }
};

/**
 * Create a service-specific logger
 */
export function createServiceLogger(serviceName: string): ServiceLogger {
  return new ServiceLogger(serviceName);
}