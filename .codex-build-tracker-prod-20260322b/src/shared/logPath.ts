/**
 * Log Path Utility
 * Centralizes log path management with environment variable support
 * and automatic directory creation
 */

import fs from 'fs';
import path from 'path';
import { resolveErrorMessage } from "@shared/errorUtils.js";

function getEnvValue(key: string): string | undefined {
  const value = process.env[key];
  //audit Assumption: non-string env values are invalid for path resolution; risk: runtime coercion bugs; invariant: only string values proceed; handling: return undefined fallback.
  if (typeof value !== 'string') {
    return undefined;
  }

  const trimmed = value.trim();
  //audit Assumption: empty env values should not override defaults; risk: blank path usage; invariant: non-empty string required; handling: return undefined for empty.
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Get the log directory path from environment variable or default
 */
export function getLogPath(): string {
  return getEnvValue('ARC_LOG_PATH') ?? '/tmp/arc/log';
}

/**
 * Build one log-file path under the active log directory.
 *
 * Purpose:
 * - Keep filename-specific helpers behaviorally identical while removing repeated `path.join` logic.
 *
 * Inputs/outputs:
 * - Input: log filename relative to the active log directory.
 * - Output: absolute or configured log file path.
 *
 * Edge case behavior:
 * - Assumes callers pass a stable filename segment rather than a nested user path.
 */
function buildNamedLogPath(fileName: string): string {
  //audit Assumption: log filenames are static module-defined values; risk: path traversal if user-controlled segments were ever passed through; expected invariant: only trusted filenames reach this helper; handling strategy: keep the helper private to this module.
  return path.join(getLogPath(), fileName);
}

/**
 * Get the session log file path
 */
export function getSessionLogPath(): string {
  return buildNamedLogPath('session.log');
}

/**
 * Get the audit log file path
 */
export function getAuditLogPath(): string {
  return buildNamedLogPath('audit.log');
}

/**
 * Get the lineage log file path
 */
export function getLineageLogPath(): string {
  return buildNamedLogPath('lineage.log');
}

/**
 * Get the feedback log file path
 */
export function getFeedbackLogPath(): string {
  return buildNamedLogPath('feedback.log');
}

/**
 * Get the GPT-4 trace output log file path
 */
export function getGPT4TracePath(): string {
  return buildNamedLogPath('gpt4_trace_output');
}

/**
 * Get the audit shadow log file path
 */
export function getAuditShadowPath(): string {
  return buildNamedLogPath('audit_shadow_log');
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
    console.error(`❌ Failed to create log directory ${logDir}:`, resolveErrorMessage(error));
    throw error;
  }
}

/**
 * Get environment-appropriate log path (production vs development)
 * Maintains backward compatibility with existing logic
 */
export function getEnvironmentLogPath(): string {
  if ((getEnvValue('NODE_ENV') ?? 'development') === 'production') {
    return getSessionLogPath();
  } else {
    // In development, use local memory directory as fallback
    return './memory/session.log';
  }
}
