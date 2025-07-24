const { auditBackend, processTask, logHealth } = require('../../services/workerOps');

/**
 * Dispatch handler for frontend AI tasks
 * @param {Object} payload - The request payload from the front-end
 * @returns {Object} result - Execution response
 */
async function dispatch(payload) {
  const { type, data } = payload || {};

  try {
    switch (type) {
      case 'audit':
        return await auditBackend(data);

      case 'process':
        return await processTask(data);

      case 'health':
        return await logHealth();

      default:
        return {
          status: 'error',
          message: `Unknown dispatch type: ${type}`
        };
    }
  } catch (err) {
    console.error('[DISPATCH ERROR]', err);
    return {
      status: 'error',
      message: 'Worker dispatch failed',
      detail: err.message
    };
  }
}

module.exports = dispatch;
