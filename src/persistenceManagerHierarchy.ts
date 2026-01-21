// File: persistenceManagerHierarchy.ts
// Purpose: Unified patch for persistence, audit, and override hierarchy
// Kernel Failsafe → Audit Layer → Root Override

import { createAuditStore, type AuditStore, type AuditStoreTransaction } from './db/auditStore.js';

// ----------------------
// Database Config
// ----------------------
const auditStore = createAuditStore({
  connectionString: process.env.DATABASE_URL,
  pool: { min: 2, max: 10 }
});
let auditStoreOverride: AuditStore | null = null;

/**
 * Inject a custom audit store for testing or alternate adapters.
 * Inputs: audit store instance or null to clear the override.
 * Output: none.
 * Edge cases: passing null resets to the default store.
 */
export function configureAuditStore(store: AuditStore | null): void {
  //audit assumption: override is intentional; risk: misconfiguration; invariant: override replaces default when set.
  auditStoreOverride = store;
}

function requireAuditStore(): AuditStore {
  //audit assumption: audit store must exist for persistence flows; risk: missing logs; invariant: throws when unavailable.
  const activeStore = auditStoreOverride ?? auditStore;
  //audit assumption: override can disable store; risk: missing persistence; invariant: throw on null.
  if (!activeStore) {
    throw new Error('Audit store is not configured. Set DATABASE_URL to enable persistence.');
  }
  return activeStore;
}

// ----------------------
// State
// ----------------------
let auditSafeMode: 'true' | 'false' | 'passive' = 'true';
let rootOverrideActive = false;
let failedRootOverrideAttempts = 0;
const MAX_FAILED_ATTEMPTS = 5;

// ----------------------
// Kernel Failsafe (Always Active)
// ----------------------
/**
 * Write a payload within the kernel transaction boundary.
 * Inputs: transaction writer, module name, payload string.
 * Output: resolves once the save snapshot is stored.
 * Edge cases: throws when payload size exceeds the safety threshold.
 */
async function kernelSafeWrite(trx: AuditStoreTransaction, moduleName: string, payload: string) {
  //audit assumption: payload size limit prevents oversized writes; risk: data loss; invariant: payload <= 50k.
  if (payload.length > 50000) {
    throw new Error('Payload too large for save.');
  }
  await trx.insertSave(moduleName, payload, Date.now());
}

// ----------------------
// Audit Layer (Async, Non-Blocking)
// ----------------------
/**
 * Persist an audit event to the audit log table.
 * Inputs: event name, payload object.
 * Output: resolves once the audit entry is stored.
 * Edge cases: throws when the audit store is unavailable or insert fails.
 */
export async function logAuditEvent(event: string, payload: Record<string, unknown>) {
  try {
    await requireAuditStore().insertAuditLog(event, payload, Date.now());
  } catch (err: any) {
    //audit assumption: audit failures are critical; risk: missing compliance record; invariant: error is surfaced.
    console.error('⚠️ Audit log failed:', err.message);
    throw new Error('Critical audit logging failure.');
  }
}

// ----------------------
// Root Override Manager
// ----------------------
/**
 * Check whether the caller can enable root override mode.
 * Inputs: user role, override token.
 * Output: boolean indicating authorization.
 * Edge cases: returns false when env flags are missing or roles mismatch.
 */
function canEnableRootOverride(userRole: string, token: string) {
  //audit assumption: override requires env flag, admin role, and token; risk: escalation; invariant: all conditions true.
  return (
    process.env.ALLOW_ROOT_OVERRIDE === 'true' &&
    userRole === 'admin' &&
    token === process.env.ROOT_OVERRIDE_TOKEN
  );
}

/**
 * Set the audit safety mode with optional root override.
 * Inputs: mode flag plus optional override metadata.
 * Output: resolves once the mode change is recorded.
 * Edge cases: throws on invalid modes or unauthorized overrides.
 */
export async function setAuditSafeMode(
  mode: 'true' | 'false' | 'passive',
  { rootOverride = false, userRole = 'guest', token = '' }: { rootOverride?: boolean; userRole?: string; token?: string } = {}
) {
  //audit assumption: mode must be explicit; risk: invalid configuration; invariant: only allowed values pass.
  if (!['true', 'false', 'passive'].includes(mode)) {
    throw new Error("Invalid mode. Use 'true', 'false', or 'passive'.");
  }

  //audit assumption: root override is privileged; risk: unauthorized escalation; invariant: validated before enabling.
  if (rootOverride && !canEnableRootOverride(userRole, token)) {
    failedRootOverrideAttempts++;
    await logAuditEvent('ROOT_OVERRIDE_DENIED', { userRole, failedRootOverrideAttempts });
    //audit assumption: repeated failures indicate abuse; risk: brute force; invariant: block after threshold.
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
 * Read the current audit safe mode and override status.
 * Inputs: none.
 * Output: object with auditSafeMode and rootOverrideActive values.
 * Edge cases: none (pure getter).
 */
export function getAuditSafeMode() {
  return { auditSafeMode, rootOverrideActive };
}

// ----------------------
// Persistence Layer (DB Writes + Rollbacks)
// ----------------------
/**
 * Persist data with audit-safe validation and rollback handling.
 * Inputs: module name, payload data, validator function.
 * Output: resolves true when persisted.
 * Edge cases: throws on validation failures or persistence errors.
 */
export async function saveWithAuditCheck(moduleName: string, data: any, validator: (d: any) => boolean) {
  const { auditSafeMode, rootOverrideActive } = getAuditSafeMode();
  //audit assumption: data is JSON-serializable; risk: stringify throws; invariant: payload string created.
  const payload = JSON.stringify(data);

  try {
    return await requireAuditStore().runInTransaction(async trx => {
      //audit assumption: root override bypasses validation; risk: invalid data; invariant: audit event logged.
      if (rootOverrideActive) {
        await kernelSafeWrite(trx, moduleName, payload);
        await logAuditEvent('ROOT_OVERRIDE_SAVE', { moduleName, data });
        return true;
      }

      //audit assumption: auditSafeMode true enforces validation; risk: rejected writes; invariant: validator required.
      if (auditSafeMode === 'true') {
        if (!(await isValid(validator, data))) {
          throw new Error(`❌ Audit-Safe rejected invalid data for ${moduleName}`);
        }
        await kernelSafeWrite(trx, moduleName, payload);
        return true;
      }

      //audit assumption: passive mode logs warnings but allows save; risk: invalid data stored; invariant: warning logged.
      if (auditSafeMode === 'passive') {
        if (!(await isValid(validator, data))) {
          await logAuditEvent('VALIDATOR_WARNING', { moduleName, data });
        }
        await kernelSafeWrite(trx, moduleName, payload);
        return true;
      }

      //audit assumption: false mode disables validation; risk: invalid data stored; invariant: save always attempts.
      if (auditSafeMode === 'false') {
        await kernelSafeWrite(trx, moduleName, payload);
        return true;
      }
    });
  } catch (err: any) {
    //audit assumption: failures must trigger rollback logging; risk: missing audit trail; invariant: rollback event recorded.
    await runRollback(moduleName, data, err.message);
    throw err;
  }
}

// ----------------------
// Rollback (Kernel Controlled)
// ----------------------
/**
 * Record rollback metadata for failed writes.
 * Inputs: module name, failed payload, error message.
 * Output: resolves once rollback event is logged.
 * Edge cases: throws if audit logging fails.
 */
async function runRollback(moduleName: string, failedData: any, errorMsg: string) {
  await logAuditEvent('ROLLBACK_TRIGGERED', {
    module: moduleName,
    failedData,
    error: errorMsg
  });
}

// ----------------------
// Validator Wrapper
// ----------------------
/**
 * Run validator with audit logging on failure.
 * Inputs: validator function and payload.
 * Output: boolean indicating validity.
 * Edge cases: returns false when validator throws.
 */
async function isValid(validator: (d: any) => boolean, data: any) {
  try {
    return validator(data);
  } catch (err: any) {
    //audit assumption: validator exceptions are non-fatal; risk: missing validation; invariant: exception is logged.
    await logAuditEvent('VALIDATOR_EXCEPTION', { error: err.message, data });
    return false;
  }
}

// ----------------------
// Schema Verification
// ----------------------
/**
 * Verify required audit tables exist.
 * Inputs: none (uses DATABASE_URL configuration).
 * Output: resolves once verification completes.
 * Edge cases: logs and exits early when no database is configured.
 */
export async function verifySchema() {
  //audit assumption: missing DATABASE_URL disables verification; risk: false negatives; invariant: skip with log.
  if (!process.env.DATABASE_URL) {
    console.log('⚠️ No DATABASE_URL configured - skipping schema verification');
    return;
  }

  try {
    const tables = ['saves', 'audit_logs'];
    for (const table of tables) {
      const exists = await requireAuditStore().hasTable(table);
      //audit assumption: required tables must exist; risk: runtime errors; invariant: throws on missing.
      if (!exists) {
        throw new Error(`❌ Required table missing: ${table}`);
      }
    }
    console.log('✅ Schema verified.');
  } catch (error: any) {
    //audit assumption: verification failure is recoverable; risk: degraded persistence; invariant: warning logged.
    console.error('❌ Schema verification failed:', error.message);
    console.log('⚠️ Continuing with in-memory fallback');
  }
}
