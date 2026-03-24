/**
 * Specialized Logging Utilities
 * Consolidates AI, GPT, OpenAI, Audit, and Boot logging
 */

import { logger, aiLogger } from "./logger.js";
import { recordTraceEvent } from "./telemetry.js";
import { OPENAI_REQUEST_LOG_CONTEXT } from "@services/openai/config.js";
import type { WorkerInitResult } from "@platform/runtime/workerBoot.js";
import { SERVER_MESSAGES, SERVER_CONSTANTS } from "@platform/runtime/serverMessages.js";

// --- AI & Arcanos Routing (formerly aiLogger.ts) ---

/**
 * Enhanced logging for ARCANOS routing stages
 */
export function logArcanosRouting(stage: string, model: string, details?: string) {
  aiLogger.info(`🔀 [ARCANOS ROUTING] ${stage}`, { model, details });
}

/**
 * Log when ARCANOS routes to GPT-5.1
 */
export function logGPT5Invocation(reason: string, input: string) {
  aiLogger.info(`🚀 [GPT-5.1 INVOCATION] Reason: ${reason}`, { 
    input: input.substring(0, 100) + (input.length > 100 ? '...' : '') 
  });
}

/**
 * Log the final routing summary
 */
export function logRoutingSummary(arcanosModel: string, gpt5Used: boolean, finalStage: string) {
  aiLogger.info(`📊 [ROUTING SUMMARY]`, { arcanosModel, gpt5Used, finalStage });
}

// --- GPT Connection (formerly gptLogger.ts) ---

export type GptMatchMethod = 'exact' | 'substring' | 'token-subset' | 'fuzzy' | 'none';

export interface GptRoutingInfo {
  gptId: string;
  moduleName: string;
  route: string;
  matchMethod: GptMatchMethod;
}

/**
 * Log when a GPT connects and is matched to a module.
 */
export function logGptConnection(info: GptRoutingInfo): void {
  logger.info(`🔗 [GPT CONNECTION] GPT: ${info.gptId}`, { ...info });
}

/**
 * Log when a GPT connection fails to match any module.
 */
export function logGptConnectionFailed(gptId: string): void {
  logger.warn(`❌ [GPT CONNECTION] GPT: ${gptId} | No matching module found`, { gptId });
}

/**
 * Log the final acknowledgment being sent back to the GPT.
 */
export function logGptAckSent(info: GptRoutingInfo, actionCount: number): void {
  logger.info(`✅ [GPT ACK] GPT: ${info.gptId} → ${info.moduleName}`, { ...info, actionCount });
}

// --- OpenAI (formerly openaiLogger.ts) ---

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

// --- Audit (formerly auditLogger.ts) ---

export interface AuditLogEntry {
  event: string;
  timestamp: string;
  [key: string]: unknown;
}

export interface AuditLogger {
  log: (entry: AuditLogEntry) => void;
}

interface AuditLoggerDependencies {
  baseLogger?: Pick<typeof logger, 'info' | 'warn' | 'error'>;
}

/**
 * Create an audit logger for structured audit events.
 */
export function createAuditLogger({
  baseLogger = logger.child({ module: 'audit' })
}: AuditLoggerDependencies = {}): AuditLogger {
  return {
    log: (entry: AuditLogEntry) => {
      baseLogger.info(entry.event, entry);
    }
  };
}

export const auditLogger = createAuditLogger();

// --- Boot (formerly bootLogger.ts) ---

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
