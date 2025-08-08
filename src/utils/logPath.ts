/**
 * Log Path Utility
 * Centralizes log path management with environment variable support
 * and automatic directory creation
 */

import fs from 'fs';
import path from 'path';

/**
 * Get the log directory path from environment variable or default
 */
export function getLogPath(): string {
  return process.env.ARC_LOG_PATH || '/tmp/arc/log';
}

/**
 * Get the session log file path
 */
export function getSessionLogPath(): string {
  const logDir = getLogPath();
  return path.join(logDir, 'session.log');
}

/**
 * Get the audit log file path
 */
export function getAuditLogPath(): string {
  const logDir = getLogPath();
  return path.join(logDir, 'audit.log');
}

/**
 * Get the lineage log file path
 */
export function getLineageLogPath(): string {
  const logDir = getLogPath();
  return path.join(logDir, 'lineage.log');
}

/**
 * Get the feedback log file path
 */
export function getFeedbackLogPath(): string {
  const logDir = getLogPath();
  return path.join(logDir, 'feedback.log');
}

/**
 * Get the GPT-5 trace output log file path
 */
export function getGPT5TracePath(): string {
  const logDir = getLogPath();
  return path.join(logDir, 'gpt5_trace_output');
}

/**
 * Get the audit shadow log file path
 */
export function getAuditShadowPath(): string {
  const logDir = getLogPath();
  return path.join(logDir, 'audit_shadow_log');
}

/**
 * Ensure the log directory exists
 */
export function ensureLogDirectory(): void {
  const logDir = getLogPath();
  
  try {
    if (!fs.existsSync(logDir)) {
      fs.mkdirSync(logDir, { recursive: true });
      console.log(`📁 Created log directory: ${logDir}`);
    }
  } catch (error) {
    console.error(`❌ Failed to create log directory ${logDir}:`, error instanceof Error ? error.message : 'Unknown error');
    throw error;
  }
}

/**
 * Get environment-appropriate log path (production vs development)
 * Maintains backward compatibility with existing logic
 */
export function getEnvironmentLogPath(): string {
  if (process.env.NODE_ENV === 'production') {
    return getSessionLogPath();
  } else {
    // In development, use local memory directory as fallback
    return './memory/session.log';
  }
}