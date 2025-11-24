/**
 * Boot Logger Utilities
 * Reusable functions for server startup logging
 */

import type { WorkerInitResult } from './workerBoot.js';
import { SERVER_MESSAGES, SERVER_CONSTANTS } from '../config/serverMessages.js';

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
  console.log(formatBootMessage(SERVER_MESSAGES.BOOT.SERVER_RUNNING, `Server running on port ${actualPort}`));
  
  if (actualPort !== configuredPort) {
    console.log(
      formatBootMessage(
        SERVER_MESSAGES.BOOT.PORT_SWITCH,
        `Originally configured for port ${configuredPort}, using ${actualPort} instead`
      )
    );
  }
  
  console.log(formatBootMessage(SERVER_MESSAGES.BOOT.ENVIRONMENT, `Environment: ${environment}`));
  console.log(formatBootMessage(SERVER_MESSAGES.BOOT.PROCESS_ID, `Process ID: ${pid}`));
}

/**
 * Logs AI model configuration
 */
export function logAIConfig(defaultModel: string, fallbackModel: string): void {
  console.log(formatBootMessage(SERVER_MESSAGES.BOOT.AI_MODEL, `Model: ${defaultModel}`));
  console.log(formatBootMessage(SERVER_MESSAGES.BOOT.AI_FALLBACK, `Fallback: ${fallbackModel}`));
}

/**
 * Logs core route information
 */
export function logCoreRoutes(): void {
  console.log(SERVER_MESSAGES.ROUTES.TITLE);
  console.log(SERVER_MESSAGES.ROUTES.ASK);
  console.log(SERVER_MESSAGES.ROUTES.ARCANOS);
  console.log(SERVER_MESSAGES.ROUTES.AI_ENDPOINTS);
  console.log(SERVER_MESSAGES.ROUTES.MEMORY);
  console.log(SERVER_MESSAGES.ROUTES.WORKERS);
  console.log(SERVER_MESSAGES.ROUTES.ORCHESTRATION);
  console.log(SERVER_MESSAGES.ROUTES.SDK);
  console.log(SERVER_MESSAGES.ROUTES.STATUS);
  console.log(SERVER_MESSAGES.ROUTES.SIRI);
  console.log(SERVER_MESSAGES.ROUTES.HEALTH);
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
  console.log(SERVER_MESSAGES.SUMMARY.HEADER);
  console.log(`🤖 Active Model: ${activeModel}`);
  console.log(`🔌 Database: ${workerResults.database.connected ? 'Connected' : 'Disconnected'}`);
  console.log(`📁 Workers Directory: ${SERVER_CONSTANTS.WORKERS_DIRECTORY}`);
  console.log(`🔧 Workers Initialized: ${workerResults.initialized.length}`);
  console.log(`📅 Workers Scheduled: ${workerResults.scheduled.length}`);
  
  if (workerResults.failed.length > 0) {
    console.log(`❌ Workers Failed: ${workerResults.failed.length}`);
  }
  
  logCoreRoutes();
  console.log(SERVER_MESSAGES.SUMMARY.FOOTER);
  console.log(SERVER_MESSAGES.SUMMARY.OPERATIONAL);
}
