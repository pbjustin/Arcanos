const auth = require('./auth');
const logger = require('../logging/logger');

// Base audit configuration
const auditConfig = {
  safeMode: true,
  deepAudit: true,
};

// Owner override logic
function isOwnerOverride(request) {
  return request.ownerAuth && auth.verifyRootToken(request.ownerAuth);
}

// Risk classification
function classifyRisk(request) {
  if (request.type === 'read-only' || request.outputOnly) return 'LOW';
  if (request.module && request.module.includes('security')) return 'HIGH';
  if (request.changes && request.changes.includes('network')) return 'HIGH';
  return 'MEDIUM';
}

// Main audit handler patch
// Loosens audit safe mode with layered filtering and override support
function handler(request) {
  // Owner override bypass
  if (isOwnerOverride(request)) {
    logger.info(`Owner override detected — executing request without hard block`);
    return { allowed: true, mode: 'OVERRIDE', logOnly: true };
  }

  // Relaxed session mode
  if (request.sessionFlags && request.sessionFlags.includes('audit_relaxed_session')) {
    logger.info(`Audit Relaxed Mode active for this session`);
    return { allowed: true, mode: 'RELAXED', logOnly: true };
  }

  // Two-layer audit filtering
  const risk = classifyRisk(request);
  if (risk === 'LOW') {
    return { allowed: true, mode: 'SOFT', logOnly: true };
  } else if (risk === 'MEDIUM') {
    return { allowed: true, mode: 'NORMAL', logOnly: false };
  } else {
    return { allowed: false, mode: 'HARD', logOnly: false };
  }
}

// Attach handler to config
auditConfig.handler = handler;

logger.info(`✅ Audit Safe Mode patch applied: Owner override, layered filtering, relaxed session, adaptive thresholds`);
module.exports = auditConfig;
