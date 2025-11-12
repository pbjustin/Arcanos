/**
 * Persistence Manager with Audit-Safe Mode
 * 
 * Provides a secure, auditable persistence layer with configurable validation modes.
 * Supports three modes: 'true' (strict validation), 'passive' (warning-only), and 'false' (no validation).
 * Includes root override capabilities for emergency administrative access with comprehensive audit logging.
 * 
 * All data is stored in memory with optional validation before persistence. Failed operations
 * trigger automatic rollback and audit event logging.
 * 
 * @module persistenceManager
 */

import { promises as fs } from 'fs';
import path from 'path';

// ----------------------
// Types and State
// ----------------------

/**
 * Audit safety modes controlling validation strictness.
 * - 'true': Strict validation, rejects invalid data
 * - 'false': No validation, accepts all data
 * - 'passive': Validation with warnings but no rejection
 */
type AuditMode = 'true' | 'false' | 'passive';

let auditSafeMode: AuditMode = 'true';
let rootOverrideActive = false;
let failedRootOverrideAttempts = 0;
const MAX_FAILED_ATTEMPTS = 5;

/**
 * Timestamped save entry structure for in-memory persistence.
 */
interface SaveEntry<T = unknown> {
  data: T;
  timestamp: number;
}

/**
 * In-memory storage organized by module name.
 */
const inMemoryStore: Record<string, SaveEntry[]> = {};

// ----------------------
// Root Override Manager
// ----------------------

/**
 * Verifies if a user has permission to enable root override mode.
 * Requires admin role, correct token, and ALLOW_ROOT_OVERRIDE=true environment variable.
 * 
 * @param userRole - User's role identifier
 * @param token - Override authorization token
 * @returns True if override is permitted
 */
function canEnableRootOverride(userRole: string, token: string): boolean {
  return (
    process.env.ALLOW_ROOT_OVERRIDE === 'true' &&
    userRole === 'admin' &&
    token === process.env.ROOT_OVERRIDE_TOKEN
  );
}

/**
 * Configures the audit-safe mode with optional root override.
 * Logs all mode changes and failed override attempts for security auditing.
 * 
 * @param mode - Target audit mode ('true', 'false', or 'passive')
 * @param options - Optional configuration including rootOverride, userRole, and token
 * @throws Error if mode is invalid or override is unauthorized
 */
export async function setAuditSafeMode(
  mode: AuditMode,
  {
    rootOverride = false,
    userRole = 'guest',
    token = '',
  }: { rootOverride?: boolean; userRole?: string; token?: string } = {}
): Promise<void> {
  if (!['true', 'false', 'passive'].includes(mode)) {
    throw new Error("Invalid mode. Use 'true', 'false', or 'passive'.");
  }

  if (rootOverride && !canEnableRootOverride(userRole, token)) {
    failedRootOverrideAttempts++;
    await logAuditEvent('ROOT_OVERRIDE_DENIED', { userRole, failedRootOverrideAttempts });
    if (failedRootOverrideAttempts > MAX_FAILED_ATTEMPTS) {
      throw new Error('🚫 Too many failed override attempts.');
    }
    throw new Error('🚫 Unauthorized attempt to enable root override.');
  }

  auditSafeMode = mode;
  rootOverrideActive = rootOverride;
  failedRootOverrideAttempts = 0;

  await logAuditEvent('MODE_CHANGE', { auditSafeMode, rootOverrideActive });
}

/**
 * Retrieves the current audit-safe mode configuration.
 * 
 * @returns Object containing current auditSafeMode and rootOverrideActive status
 */
export function getAuditSafeMode() {
  return { auditSafeMode, rootOverrideActive };
}

// ----------------------
// Generalized Save Layer
// ----------------------

/**
 * Saves data with audit-safe validation according to current mode.
 * Behavior depends on configured audit mode:
 * - 'true': Validates and rejects invalid data
 * - 'passive': Validates with warning but persists anyway
 * - 'false': Persists without validation
 * Root override bypasses all validation.
 * 
 * @param moduleName - Module identifier for organizing saved data
 * @param data - Data to persist
 * @param validator - Validation function (sync or async)
 * @returns True if save succeeded, false otherwise
 * @throws Error if validation fails in strict mode
 */
export async function saveWithAuditCheck<T>(
  moduleName: string,
  data: T,
  validator: (data: T) => boolean | Promise<boolean>
): Promise<boolean> {
  const { auditSafeMode, rootOverrideActive } = getAuditSafeMode();

  if (!inMemoryStore[moduleName]) {
    inMemoryStore[moduleName] = [];
  }

  if (rootOverrideActive) {
    return safeWrite(moduleName, data);
  }

  if (auditSafeMode === 'true') {
    if (!(await isValid(validator, data))) {
      throw new Error(`❌ Audit-Safe rejected invalid data for ${moduleName}`);
    }
    return safeWrite(moduleName, data);
  }

  if (auditSafeMode === 'passive') {
    if (!(await isValid(validator, data))) {
      await logAuditEvent('VALIDATOR_WARNING', { moduleName, data });
    }
    return safeWrite(moduleName, data);
  }

  // auditSafeMode === 'false'
  return safeWrite(moduleName, data);
}

// ----------------------
// In-Memory Persistence
// ----------------------

/**
 * Writes data to in-memory store with size validation.
 * Triggers rollback on failure and logs audit events.
 * 
 * @param moduleName - Module identifier
 * @param data - Data to write
 * @returns True if write succeeded
 */
async function safeWrite<T>(moduleName: string, data: T): Promise<boolean> {
  try {
    const payload = JSON.stringify(data);
    if (payload.length > 50000) {
      throw new Error('Payload too large for save.');
    }

    inMemoryStore[moduleName].push({ data, timestamp: Date.now() });
    return true;
  } catch (err) {
    await runRollback(moduleName, data, (err as Error).message);
    return false;
  }
}

/**
 * Retrieves all saved entries for a specific module.
 * 
 * @param moduleName - Module identifier
 * @returns Array of timestamped save entries
 */
export function getModuleSaves(moduleName: string): SaveEntry[] {
  return inMemoryStore[moduleName] || [];
}

// ----------------------
// Rollback + Audit Logs
// ----------------------

/**
 * Executes rollback procedure and logs the failure event.
 * 
 * @param moduleName - Module that experienced the failure
 * @param failedData - Data that failed to persist
 * @param errorMsg - Error message describing the failure
 */
async function runRollback(moduleName: string, failedData: unknown, errorMsg: string) {
  await logAuditEvent('ROLLBACK_TRIGGERED', {
    module: moduleName,
    failedData,
    error: errorMsg,
  });
}

const auditLogPath = path.join(process.cwd(), 'audit_logs.json');

/**
 * Appends an audit event to the audit log file.
 * Logs to console if file write fails.
 * 
 * @param event - Event type identifier
 * @param payload - Event data to log
 */
async function logAuditEvent(event: string, payload: unknown): Promise<void> {
  const entry = {
    event,
    payload,
    timestamp: Date.now(),
  };
  try {
    await fs.appendFile(auditLogPath, JSON.stringify(entry) + '\n');
  } catch (err) {
    console.error('⚠️ Audit log failed:', (err as Error).message);
  }
}

// ----------------------
// Validator Wrapper
// ----------------------

/**
 * Executes a validation function and handles both sync and async validators.
 * Catches and logs any exceptions during validation.
 * 
 * @param validator - Validation function
 * @param data - Data to validate
 * @returns True if validation passed, false otherwise
 */
async function isValid<T>(
  validator: (data: T) => boolean | Promise<boolean>,
  data: T
): Promise<boolean> {
  try {
    const result = validator(data);
    if (result instanceof Promise) {
      return await result;
    }
    return result;
  } catch (err) {
    await logAuditEvent('VALIDATOR_EXCEPTION', { error: (err as Error).message, data });
    return false;
  }
}

export default {
  setAuditSafeMode,
  getAuditSafeMode,
  saveWithAuditCheck,
  getModuleSaves,
};

