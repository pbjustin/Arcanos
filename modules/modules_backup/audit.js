import express from 'express';
import fs from 'fs';
import path from 'path';

const router = express.Router();

// Audit module - handles logging and audit operations
router.get('/audit', async (req, res) => {
  try {
    const { type, from, to, limit } = req.query;
    
    // Check for existing audit logs
    const auditLogPath = path.join(process.cwd(), 'memory', 'state', 'audit.log');
    const auditLogsDir = path.join(process.cwd(), 'storage', 'audit-logs');
    
    let auditData = {
      logs: [],
      summary: {
        totalEntries: 0,
        dateRange: null
      }
    };
    
    // Read main audit log if exists
    if (fs.existsSync(auditLogPath)) {
      try {
        const logContent = fs.readFileSync(auditLogPath, 'utf8');
        if (logContent.trim()) {
          auditData.logs.push({
            source: 'main_audit.log',
            content: logContent,
            size: logContent.length
          });
        }
      } catch (err) {
        console.warn('[🔍 AUDIT] Could not read main audit log:', err.message);
      }
    }
    
    // Check storage audit logs directory
    if (fs.existsSync(auditLogsDir)) {
      try {
        const files = fs.readdirSync(auditLogsDir);
        files.forEach(file => {
          auditData.logs.push({
            source: file,
            path: path.join(auditLogsDir, file),
            size: fs.statSync(path.join(auditLogsDir, file)).size
          });
        });
      } catch (err) {
        console.warn('[🔍 AUDIT] Could not read audit logs directory:', err.message);
      }
    }
    
    auditData.summary.totalEntries = auditData.logs.length;
    
    const result = {
      status: 'success',
      message: 'Audit request processed',
      data: {
        type: type || 'all',
        dateRange: { from, to },
        limit: limit ? parseInt(limit) : 100,
        audit: auditData,
        timestamp: new Date().toISOString()
      }
    };
    
    console.log(`[🔍 AUDIT] Processing audit request - Type: ${type}, Logs found: ${auditData.logs.length}`);
    res.json(result);
  } catch (error) {
    console.error('[🔍 AUDIT] Error:', error);
    res.status(500).json({
      status: 'error',
      message: 'Audit operation failed',
      error: error.message
    });
  }
});

// Audit log creation endpoint
router.post('/audit', async (req, res) => {
  try {
    const { event, data, level } = req.body;
    
    const logEntry = {
      timestamp: new Date().toISOString(),
      event: event || 'unknown',
      level: level || 'info',
      data: data || {},
      id: Date.now().toString()
    };
    
    // Append to audit log (create simple implementation)
    const auditLogPath = path.join(process.cwd(), 'memory', 'state', 'audit.log');
    const logLine = JSON.stringify(logEntry) + '\n';
    
    try {
      fs.appendFileSync(auditLogPath, logLine);
    } catch (err) {
      console.warn('[🔍 AUDIT] Could not write to audit log:', err.message);
    }
    
    console.log(`[🔍 AUDIT] New audit entry: ${event} [${level}]`);
    res.json({
      status: 'success',
      message: 'Audit entry created',
      entry: logEntry
    });
  } catch (error) {
    console.error('[🔍 AUDIT] Error creating audit entry:', error);
    res.status(500).json({
      status: 'error',
      message: 'Failed to create audit entry',
      error: error.message
    });
  }
});

// Audit status endpoint
router.get('/audit/status', (req, res) => {
  res.json({
    module: 'audit',
    status: 'active',
    version: '1.0.0',
    endpoints: ['/audit', '/audit/status']
  });
});

export default router;