// File: persistenceManagerHierarchy.js
// Purpose: Unified patch for persistence, audit, and override hierarchy
// Kernel Failsafe → Audit Layer → Root Override

import knex from "knex";

// ----------------------
// Database Config
// ----------------------
const db = knex({
  client: "pg", // swap if using mysql/sqlite
  connection: process.env.DB_URL,
  pool: { min: 2, max: 10 }
});

// ----------------------
// State
// ----------------------
let auditSafeMode = "true";
let rootOverrideActive = false;
let failedRootOverrideAttempts = 0;
const MAX_FAILED_ATTEMPTS = 5;

// ----------------------
// Kernel Failsafe (Always Active)
// ----------------------
async function kernelSafeWrite(trx, moduleName, payload) {
  if (payload.length > 50000) {
    throw new Error("Payload too large for save.");
  }
  await trx("saves").insert({
    module: moduleName,
    data: payload,
    timestamp: Date.now(),
  });
}

// ----------------------
// Audit Layer (Async, Non-Blocking)
// ----------------------
export async function logAuditEvent(event, payload) {
  try {
    await db("audit_logs").insert({
      event,
      payload: JSON.stringify(payload),
      timestamp: Date.now(),
    });
  } catch (err) {
    console.error("⚠️ Audit log failed:", err.message);
    throw new Error("Critical audit logging failure.");
  }
}

// ----------------------
// Root Override Manager
// ----------------------
function canEnableRootOverride(userRole, token) {
  return (
    process.env.ALLOW_ROOT_OVERRIDE === "true" &&
    userRole === "admin" &&
    token === process.env.ROOT_OVERRIDE_TOKEN
  );
}

export async function setAuditSafeMode(mode, { rootOverride = false, userRole = "guest", token = "" } = {}) {
  if (!["true", "false", "passive"].includes(mode)) {
    throw new Error("Invalid mode. Use 'true', 'false', or 'passive'.");
  }

  if (rootOverride && !canEnableRootOverride(userRole, token)) {
    failedRootOverrideAttempts++;
    await logAuditEvent("ROOT_OVERRIDE_DENIED", { userRole, failedRootOverrideAttempts });
    if (failedRootOverrideAttempts > MAX_FAILED_ATTEMPTS) {
      throw new Error("🚫 Too many failed override attempts.");
    }
    throw new Error("🚫 Unauthorized attempt to enable root override.");
  }

  auditSafeMode = mode;
  rootOverrideActive = rootOverride;
  failedRootOverrideAttempts = 0;

  await logAuditEvent("MODE_CHANGE", { auditSafeMode, rootOverrideActive });
}

export function getAuditSafeMode() {
  return { auditSafeMode, rootOverrideActive };
}

// ----------------------
// Persistence Layer (DB Writes + Rollbacks)
// ----------------------
export async function saveWithAuditCheck(moduleName, data, validator) {
  const { auditSafeMode, rootOverrideActive } = getAuditSafeMode();
  const payload = JSON.stringify(data);

  try {
    return await db.transaction(async (trx) => {
      if (rootOverrideActive) {
        await kernelSafeWrite(trx, moduleName, payload);
        await logAuditEvent("ROOT_OVERRIDE_SAVE", { moduleName, data });
        return true;
      }

      if (auditSafeMode === "true") {
        if (!isValid(validator, data)) {
          throw new Error(`❌ Audit-Safe rejected invalid data for ${moduleName}`);
        }
        await kernelSafeWrite(trx, moduleName, payload);
        return true;
      }

      if (auditSafeMode === "passive") {
        if (!isValid(validator, data)) {
          await logAuditEvent("VALIDATOR_WARNING", { moduleName, data });
        }
        await kernelSafeWrite(trx, moduleName, payload);
        return true;
      }

      if (auditSafeMode === "false") {
        await kernelSafeWrite(trx, moduleName, payload);
        return true;
      }
    });
  } catch (err) {
    await runRollback(moduleName, data, err.message);
    throw err;
  }
}

// ----------------------
// Rollback (Kernel Controlled)
// ----------------------
async function runRollback(moduleName, failedData, errorMsg) {
  await logAuditEvent("ROLLBACK_TRIGGERED", {
    module: moduleName,
    failedData,
    error: errorMsg,
  });
}

// ----------------------
// Validator Wrapper
// ----------------------
function isValid(validator, data) {
  try {
    return validator(data);
  } catch (err) {
    logAuditEvent("VALIDATOR_EXCEPTION", { error: err.message, data });
    return false;
  }
}

// ----------------------
// Schema Verification
// ----------------------
export async function verifySchema() {
  const tables = ["saves", "audit_logs"];
  for (const table of tables) {
    const exists = await db.schema.hasTable(table);
    if (!exists) {
      throw new Error(`❌ Required table missing: ${table}`);
    }
  }
  console.log("✅ Schema verified.");
}
