// ARCANOS Main Routes - Extracted from index.ts for better modularity
import { Router } from 'express';
import { memoryHandler } from '../handlers/memory-handler';
import { auditHandler } from '../handlers/audit-handler';
import { diagnosticHandler } from '../handlers/diagnostic-handler';
import { writeHandler } from '../handlers/write-handler';
import { routeRecovery } from '../handlers/route-recovery';
import { getChatGPTUserDiagnostics } from '../middleware/chatgpt-user';
import { getPagedOutputHandler } from '../modules/paged-output-handler';
import { memoryOperations } from '../services/memory-operations';
import { getMemoryAuditStreamSerializer } from '../modules/memory-audit-stream-serializer';
import fs from 'fs';
import path from 'path';

const router = Router();

// 1. /memory route - Enhanced memory handler
router.post('/memory', async (req, res) => {
  try {
    await memoryHandler.handleMemoryRequest(req, res);
  } catch (error: any) {
    console.error('❌ Memory route failure, attempting recovery:', error);
    throw error;
  }
});

// Memory status with streaming serializer
router.get('/memory/status', (req, res) => {
  const serializer = getMemoryAuditStreamSerializer();
  const payload = {
    ...memoryOperations.getStatus(),
    timestamp: new Date().toISOString(),
  };
  if (serializer) return serializer.stream(res, payload);
  res.json(payload);
});

// Memory reflection analysis
router.get('/memory/reflect', async (req, res) => {
  try {
    const userId = (req.headers['x-container-id'] as string) || 'default';
    const sessionId = (req.headers['x-session-id'] as string) || 'default';
    const reflection = await memoryOperations.analyzeMemoryContext(userId, sessionId);
    const serializer = getMemoryAuditStreamSerializer();
    const payload = { reflection, timestamp: new Date().toISOString() };
    if (serializer) return serializer.stream(res, payload);
    res.json(payload);
  } catch (error: any) {
    res.status(500).json({ error: 'Failed to analyze memory', details: error.message, timestamp: new Date().toISOString() });
  }
});

// 2. /audit route - Enhanced audit handler
router.post('/audit', async (req, res) => {
  try {
    await auditHandler.handleAuditRequest(req, res);
  } catch (error: any) {
    console.error('❌ Audit route failure, attempting recovery:', error);
    throw error;
  }
});

// Lightweight audit heartbeat
router.get('/audit/heartbeat', (_req, res) => {
  res.json({ service: 'audit', status: 'ok', timestamp: new Date().toISOString() });
});

// 3. /diagnostic route - Support both GET and POST
router.get('/diagnostic', async (req, res) => {
  try {
    await diagnosticHandler.handleDiagnosticRequest(req, res);
  } catch (error: any) {
    console.error('❌ Diagnostic route failure, attempting recovery:', error);
    throw error;
  }
});

router.post('/diagnostic', async (req, res) => {
  try {
    await diagnosticHandler.handleDiagnosticRequest(req, res);
  } catch (error: any) {
    console.error('❌ Diagnostic route failure, attempting recovery:', error);
    throw error;
  }
});

// Lightweight diagnostic heartbeat
router.get('/diagnostic/heartbeat', (_req, res) => {
  res.json({ service: 'diagnostic', status: 'ok', timestamp: new Date().toISOString() });
});

// 4. /write route - Enhanced write handler
router.post('/write', async (req, res) => {
  try {
    await writeHandler.handleWriteRequest(req, res);
  } catch (error: any) {
    console.error('❌ Write route failure, attempting recovery:', error);
    throw error;
  }
});

// Lightweight write heartbeat
router.get('/write/heartbeat', (_req, res) => {
  res.json({ service: 'write', status: 'ok', timestamp: new Date().toISOString() });
});

// Route status monitoring
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

// Audit logs endpoint
router.get('/audit-logs', (req, res) => {
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

  const result = {
    ...logs,
    timestamp: new Date().toISOString()
  };

  const paged = getPagedOutputHandler();
  if (paged) {
    const pages = paged.paginate(JSON.stringify(result));
    res.json({ pages, paged: true });
  } else {
    res.json(result);
  }
});

// Stream audit log files
router.get('/audit/logs', (req, res) => {
  try {
    const logDir = path.join(process.cwd(), 'storage', 'audit-logs');
    const logs: Record<string, string> = {};
    if (fs.existsSync(logDir)) {
      const files = fs.readdirSync(logDir).slice(-5);
      for (const file of files) {
        logs[file] = fs.readFileSync(path.join(logDir, file), 'utf8');
      }
    }
    const serializer = getMemoryAuditStreamSerializer();
    const payload = { logs, timestamp: new Date().toISOString() };
    if (serializer) return serializer.stream(res, payload);
    res.json(payload);
  } catch (error: any) {
    res.status(500).json({ error: 'Failed to load audit logs', details: error.message, timestamp: new Date().toISOString() });
  }
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