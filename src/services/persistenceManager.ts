import { promises as fs } from 'fs';
import path from 'path';

// ----------------------
// Types and State
// ----------------------
type AuditMode = 'true' | 'false' | 'passive';

let auditSafeMode: AuditMode = 'true';
let rootOverrideActive = false;
let failedRootOverrideAttempts = 0;
const MAX_FAILED_ATTEMPTS = 5;

interface SaveEntry<T = unknown> {
  data: T;
  timestamp: number;
}

const inMemoryStore: Record<string, SaveEntry[]> = {};

// ----------------------
// Root Override Manager
// ----------------------
function canEnableRootOverride(userRole: string, token: string): boolean {
  return (
    process.env.ALLOW_ROOT_OVERRIDE === 'true' &&
    userRole === 'admin' &&
    token === process.env.ROOT_OVERRIDE_TOKEN
  );
}

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

export function getAuditSafeMode() {
  return { auditSafeMode, rootOverrideActive };
}

// ----------------------
// Generalized Save Layer
// ----------------------
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

export function getModuleSaves(moduleName: string): SaveEntry[] {
  return inMemoryStore[moduleName] || [];
}

// ----------------------
// Rollback + Audit Logs
// ----------------------
async function runRollback(moduleName: string, failedData: unknown, errorMsg: string) {
  await logAuditEvent('ROLLBACK_TRIGGERED', {
    module: moduleName,
    failedData,
    error: errorMsg,
  });
}

const auditLogPath = path.join(process.cwd(), 'audit_logs.json');

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

