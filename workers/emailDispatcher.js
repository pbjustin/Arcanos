const { createServiceLogger } = require('../dist/utils/logger');
let dispatchEmail;
try {
  ({ dispatchEmail } = require('../dist/workers/email/email-dispatcher'));
} catch {
  ({ dispatchEmail } = require('../src/workers/email/email-dispatcher'));
}
const logger = createServiceLogger('EmailDispatcherWorker');

module.exports = async function emailDispatcher(payload) {
  logger.info('Executing emailDispatcher worker');
  if (!payload || !payload.to || !payload.subject || !payload.message) {
    logger.warning('Invalid email payload, aborting dispatch');
    return;
  }
  try {
    await dispatchEmail(payload);
    logger.success('Email dispatched', { to: payload.to });
  } catch (err) {
    logger.error('Email dispatch failed', err);
    throw err;
  }
};
