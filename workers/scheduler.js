const cron = require('node-cron');
const { createServiceLogger } = require('../dist/utils/logger');
let executionEngine;
try {
  ({ executionEngine } = require('../dist/services/execution-engine'));
} catch {
  executionEngine = require('../src/services/execution-engine').executionEngine;
}

const logger = createServiceLogger('Scheduler');
const scheduledTasks = new Map();

function scheduleInstruction(id, cronExpr, instruction) {
  if (!cronExpr) {
    logger.warning('No schedule expression provided', { id });
    return;
  }
  if (scheduledTasks.has(id)) {
    logger.info('Task already scheduled', { id });
    return scheduledTasks.get(id);
  }

  const task = cron.schedule(cronExpr, async () => {
    await executionEngine.executeInstruction(instruction);
  }, { timezone: 'UTC' });

  scheduledTasks.set(id, task);
  logger.info('Task scheduled', { id, cron: cronExpr });
  return task;
}

function cancelInstruction(id) {
  const task = scheduledTasks.get(id);
  if (task) {
    task.stop();
    task.destroy();
    scheduledTasks.delete(id);
    logger.info('Task cancelled', { id });
  }
}

module.exports = { scheduleInstruction, cancelInstruction };
