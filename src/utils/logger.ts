/**
 * Common Logger Utilities for ARCANOS Backend
 * Consolidates repeated logging patterns
 */

export type LogLevel = "info" | "success" | "warning" | "error" | "debug";

/**
 * Common log emojis and colors
 */
const LOG_ICONS = {
  info: "ℹ️",
  success: "✅",
  warning: "⚠️",
  error: "❌",
  debug: "🔍",
} as const;

/**
 * Service-specific context logger
 */
export class ServiceLogger {
  constructor(private serviceName: string) {}

  private formatMessage(
    level: LogLevel,
    message: string,
    context?: any,
  ): string {
    const icon = LOG_ICONS[level];
    const timestamp = new Date().toISOString();
    let logMessage = `${icon} ${this.serviceName} - ${message}`;

    if (context) {
      logMessage += ` ${JSON.stringify(context)}`;
    }

    return logMessage;
  }

  info(message: string, context?: any): void {
    console.log(this.formatMessage("info", message, context));
  }

  success(message: string, context?: any): void {
    console.log(this.formatMessage("success", message, context));
  }

  warning(message: string, context?: any): void {
    console.warn(this.formatMessage("warning", message, context));
  }

  error(message: string, error?: any, context?: any): void {
    const errorContext =
      error instanceof Error
        ? { ...context, error: error.message }
        : { ...context, error };
    console.error(this.formatMessage("error", message, errorContext));
  }

  debug(message: string, context?: any): void {
    if (process.env.NODE_ENV === "development") {
      console.log(this.formatMessage("debug", message, context));
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
    console.log(
      `🚀 ${serviceName} - Starting ${operation}`,
      context ? JSON.stringify(context) : "",
    );
  },

  /**
   * Log service operation success
   */
  serviceSuccess(serviceName: string, operation: string, context?: any): void {
    console.log(
      `✅ ${serviceName} - Successfully completed ${operation}`,
      context ? JSON.stringify(context) : "",
    );
  },

  /**
   * Log service operation error
   */
  serviceError(
    serviceName: string,
    operation: string,
    error: any,
    context?: any,
  ): void {
    const errorMessage = error instanceof Error ? error.message : String(error);
    const logContext = { ...context, error: errorMessage };
    console.error(
      `❌ ${serviceName} - ${operation} error:`,
      JSON.stringify(logContext),
    );
  },

  /**
   * Log OpenAI API errors (common pattern)
   */
  openaiError(serviceName: string, response: any): void {
    console.error(`❌ OpenAI error in ${serviceName} service:`, response.error);
  },

  /**
   * Log database operations
   */
  databaseOperation(operation: string, success: boolean, details?: any): void {
    const icon = success ? "✅" : "❌";
    const status = success ? "successful" : "failed";
    console.log(
      `${icon} Database ${operation} ${status}`,
      details ? JSON.stringify(details) : "",
    );
  },

  /**
   * Log memory operations
   */
  memorySnapshot(operation: string, data: any): void {
    console.log(`💾 [MEMORY-SNAPSHOT] ${operation}:`, {
      ...data,
      timestamp: new Date().toISOString(),
    });
  },
};

/**
 * Create a service-specific logger
 */
export function createServiceLogger(serviceName: string): ServiceLogger {
  return new ServiceLogger(serviceName);
}
