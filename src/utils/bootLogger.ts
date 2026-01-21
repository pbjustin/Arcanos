/**
 * Boot Logger Utilities
 * Reusable functions for server startup logging
 */

import type { WorkerInitResult } from './workerBoot.js';
import { SERVER_MESSAGES, SERVER_CONSTANTS } from '../config/serverMessages.js';
import { logger } from './structuredLogging.js';

const bootLogger = logger.child({ module: 'boot' });

/**
 * Formats a boot log message with prefix and content
 */
export function formatBootMessage(prefix: string, content: string): string {
  return `[${prefix}] ${content}`;
}

/**
 * Logs server startup information
 */
export function logServerInfo(actualPort: number, configuredPort: number, environment: string, pid: number): void {
  bootLogger.info(formatBootMessage(SERVER_MESSAGES.BOOT.SERVER_RUNNING, `Server running on port ${actualPort}`), {
    configuredPort,
    actualPort,
    environment,
    pid
  });

  if (actualPort !== configuredPort) {
    bootLogger.warn(
      formatBootMessage(
        SERVER_MESSAGES.BOOT.PORT_SWITCH,
        `Originally configured for port ${configuredPort}, using ${actualPort} instead`
      ),
      { configuredPort, actualPort }
    );
  }

  bootLogger.info(formatBootMessage(SERVER_MESSAGES.BOOT.ENVIRONMENT, `Environment: ${environment}`), {
    environment
  });
  bootLogger.info(formatBootMessage(SERVER_MESSAGES.BOOT.PROCESS_ID, `Process ID: ${pid}`), { pid });
}

/**
 * Logs AI model configuration
 */
export function logAIConfig(defaultModel: string, fallbackModel: string): void {
  bootLogger.info(formatBootMessage(SERVER_MESSAGES.BOOT.AI_MODEL, `Model: ${defaultModel}`), {
    model: defaultModel
  });
  bootLogger.info(formatBootMessage(SERVER_MESSAGES.BOOT.AI_FALLBACK, `Fallback: ${fallbackModel}`), {
    fallbackModel
  });
}

/**
 * Logs core route information
 */
export function logCoreRoutes(): void {
  bootLogger.info(SERVER_MESSAGES.ROUTES.TITLE);
  bootLogger.info(SERVER_MESSAGES.ROUTES.ASK);
  bootLogger.info(SERVER_MESSAGES.ROUTES.ARCANOS);
  bootLogger.info(SERVER_MESSAGES.ROUTES.AI_ENDPOINTS);
  bootLogger.info(SERVER_MESSAGES.ROUTES.MEMORY);
  bootLogger.info(SERVER_MESSAGES.ROUTES.WORKERS);
  bootLogger.info(SERVER_MESSAGES.ROUTES.ORCHESTRATION);
  bootLogger.info(SERVER_MESSAGES.ROUTES.SDK);
  bootLogger.info(SERVER_MESSAGES.ROUTES.STATUS);
  bootLogger.info(SERVER_MESSAGES.ROUTES.SIRI);
  bootLogger.info(SERVER_MESSAGES.ROUTES.HEALTH);
}

/**
 * Logs complete boot summary with all server information
 */
export function logCompleteBootSummary(
  actualPort: number,
  configuredPort: number,
  environment: string,
  activeModel: string,
  workerResults: WorkerInitResult
): void {
  bootLogger.info(SERVER_MESSAGES.SUMMARY.HEADER);
  bootLogger.info('🤖 Active Model summary', { activeModel });
  bootLogger.info('🔌 Database status', { connected: workerResults.database.connected });
  bootLogger.info('📁 Workers Directory', { directory: SERVER_CONSTANTS.WORKERS_DIRECTORY });
  bootLogger.info('🔧 Workers Initialized', { initialized: workerResults.initialized.length });
  bootLogger.info('📅 Workers Scheduled', { scheduled: workerResults.scheduled.length });

  if (workerResults.failed.length > 0) {
    bootLogger.warn('❌ Workers Failed', { failed: workerResults.failed.length, failures: workerResults.failed });
  }

  logCoreRoutes();
  bootLogger.info(SERVER_MESSAGES.SUMMARY.FOOTER);
  bootLogger.info(SERVER_MESSAGES.SUMMARY.OPERATIONAL, {
    actualPort,
    configuredPort,
    environment
  });
}

export function logShutdownEvent(signal: string, mem: NodeJS.MemoryUsage, uptimeSeconds: number, metadata?: Record<string, any>) {
  bootLogger.warn(`Received ${signal}, initiating shutdown`, {
    signal,
    uptimeSeconds,
    memory: {
      heapMB: Number((mem.heapUsed / 1024 / 1024).toFixed(1)),
      rssMB: Number((mem.rss / 1024 / 1024).toFixed(1))
    },
    ...metadata
  });
}
