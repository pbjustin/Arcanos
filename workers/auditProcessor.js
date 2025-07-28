const { createServiceLogger } = require('../dist/utils/logger');
let runStreamAudit;
try {
  ({ runStreamAudit } = require('../dist/workers/audit/stream-audit-worker'));
} catch {
  ({ runStreamAudit } = require('../src/workers/audit/stream-audit-worker'));
}
const logger = createServiceLogger('AuditProcessorWorker');

module.exports = async function auditProcessor(payload) {
  logger.info('Executing auditProcessor worker');
  if (!payload || !payload.message) {
    logger.warning('No audit message provided');
    return;
  }
  try {
    await runStreamAudit(payload);
    logger.success('Audit completed');
  } catch (err) {
    logger.error('Audit processing failed', err);
    throw err;
  }
};
