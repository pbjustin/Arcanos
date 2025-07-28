const { createServiceLogger } = require('../dist/utils/logger');
const logger = createServiceLogger('DefaultWorker');

module.exports = async function defaultWorker() {
  logger.warning('Default fallback worker executed - no action defined');
};
