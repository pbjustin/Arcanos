const auditConfig = require('./audit_config');
const logger = require('./logger');
const rollbackIsolation = require('./rollback_isolation');

// Trusted module IDs or names for bypass
const TRUSTED_MODULES = [
  'logic_optimizer_v2',
  'decision_engine_alpha',
  // Add more trusted module IDs here
];

/**
 * Executes a module with optional audit bypass for trusted logic-heavy modules.
 * @param {string} moduleName - Name or ID of the module
 * @param {Function} executeFn - Function that runs the module
 * @returns {*} - Module execution result
 */
async function runWithAuditEscape(moduleName, executeFn) {
  const auditSafeActive = auditConfig.safeMode;
  let bypassActive = false;

  try {
    // Check if we can bypass deep audit for this module
    if (auditSafeActive && TRUSTED_MODULES.includes(moduleName)) {
      bypassActive = true;
      logger.warn(`[AUDIT-SAFE-ESCAPE] Bypass enabled for trusted module: ${moduleName}`);
    }

    // Temporarily disable deep audit checks
    if (bypassActive) {
      auditConfig.deepAudit = false;
    }

    // Execute the module
    const result = await executeFn();

    // Integrity check: If output looks suspicious, rollback and log
    if (detectAnomalies(result)) {
      logger.error(`[AUDIT-SAFE-ESCAPE] Anomaly detected in ${moduleName}, triggering rollback`);
      rollbackIsolation(moduleName);
      throw new Error(`Audit anomaly detected in ${moduleName}`);
    }

    return result;
  } finally {
    // Always restore deep audit mode after execution
    if (bypassActive) {
      auditConfig.deepAudit = true;
    }
  }
}

/**
 * Very basic anomaly detection — can be expanded
 */
function detectAnomalies(output) {
  if (!output) return true;
  if (typeof output === 'string' && output.toLowerCase().includes('unauthorized')) return true;
  return false;
}

module.exports = { runWithAuditEscape };
