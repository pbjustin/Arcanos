// ARCANOS Main Routes - Extracted from index.ts for better modularity
import { Router } from 'express';
import { modelControlHooks } from '../services/model-control-hooks';
import { memoryHandler } from '../handlers/memory-handler';
import { auditHandler } from '../handlers/audit-handler';
import { diagnosticHandler } from '../handlers/diagnostic-handler';
import { writeHandler } from '../handlers/write-handler';
import { routeRecovery } from '../handlers/route-recovery';
import { getChatGPTUserDiagnostics } from '../middleware/chatgpt-user';
import { requireArcanosToken } from '../middleware/api-token';

const router = Router();

// 1. /memory route - Enhanced memory handler (requires ARCANOS token)
router.post('/memory', requireArcanosToken, async (req, res) => {
  try {
    await memoryHandler.handleMemoryRequest(req, res);
  } catch (error: any) {
    console.error('❌ Memory route failure, attempting recovery:', error);
    throw error;
  }
});

// 2. /audit route - Enhanced audit handler (requires ARCANOS token)
router.post('/audit', requireArcanosToken, async (req, res) => {
  try {
    await auditHandler.handleAuditRequest(req, res);
  } catch (error: any) {
    console.error('❌ Audit route failure, attempting recovery:', error);
    throw error;
  }
});

// 3. /diagnostic route - Support both GET and POST (requires ARCANOS token)
router.get('/diagnostic', requireArcanosToken, async (req, res) => {
  try {
    await diagnosticHandler.handleDiagnosticRequest(req, res);
  } catch (error: any) {
    console.error('❌ Diagnostic route failure, attempting recovery:', error);
    throw error;
  }
});

router.post('/diagnostic', requireArcanosToken, async (req, res) => {
  try {
    await diagnosticHandler.handleDiagnosticRequest(req, res);
  } catch (error: any) {
    console.error('❌ Diagnostic route failure, attempting recovery:', error);
    throw error;
  }
});

// 4. /write route - Enhanced write handler (requires ARCANOS token)
router.post('/write', requireArcanosToken, async (req, res) => {
  try {
    await writeHandler.handleWriteRequest(req, res);
  } catch (error: any) {
    console.error('❌ Write route failure, attempting recovery:', error);
    throw error;
  }
});

// Route status monitoring (public for health checks)
router.get('/route-status', (req, res) => {
  const routeStatuses = routeRecovery.getRouteStatuses();
  const recoveryLogs = routeRecovery.getRecoveryLogs();
  
  res.json({
    routes: routeStatuses,
    recovery_logs: recoveryLogs.slice(-10),
    handlers: {
      memory: memoryHandler.constructor.name,
      write: writeHandler.constructor.name,
      audit: auditHandler.constructor.name,
      diagnostic: diagnosticHandler.constructor.name
    },
    timestamp: new Date().toISOString()
  });
});

// Audit logs endpoint (requires ARCANOS token for sensitive data)
router.get('/audit-logs', requireArcanosToken, (req, res) => {
  const writeLogType = req.query.type as string;
  
  let logs: any = {};
  
  if (!writeLogType || writeLogType === 'write') {
    logs.write_malformed = writeHandler.getMalformedResponseLogs();
  }
  
  if (!writeLogType || writeLogType === 'audit') {
    logs.audit_malformed = auditHandler.getMalformedAuditLogs();
    logs.audit_activity = auditHandler.getAuditActivityLogs().slice(-20);
  }
  
  if (!writeLogType || writeLogType === 'diagnostic') {
    logs.diagnostic_activity = diagnosticHandler.getDiagnosticLogs().slice(-20);
    logs.readiness_status = diagnosticHandler.getReadinessStatus();
  }
  
  res.json({
    ...logs,
    timestamp: new Date().toISOString()
  });
});

// ChatGPT-User middleware diagnostics
router.get('/chatgpt-user-status', (req, res) => {
  try {
    const diagnostics = getChatGPTUserDiagnostics();
    res.json({
      ...diagnostics,
      timestamp: new Date().toISOString()
    });
  } catch (error: any) {
    res.status(500).json({
      error: 'Failed to get ChatGPT-User status',
      details: error.message,
      timestamp: new Date().toISOString()
    });
  }
});

export default router;