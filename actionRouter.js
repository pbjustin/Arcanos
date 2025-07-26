const { executionEngine } = require('./src/services/execution-engine');
const { createServiceLogger } = require('./src/utils/logger');
const logger = createServiceLogger('ActionRouter');

const actions = {
  respond: instruction => executionEngine.handleResponse(instruction),
  execute: instruction => executionEngine.handleExecution(instruction),
  schedule: instruction => executionEngine.handleSchedule(instruction),
  delegate: instruction => executionEngine.handleDelegation(instruction),
  write: instruction => executionEngine.executeWriteOperation(instruction.parameters || {}),
};

function fallback(instruction) {
  logger.error(`Unknown action: ${instruction.action}`);
  return { success: false, error: `Unknown action: ${instruction.action}` };
}

function routeAction(instruction) {
  const handler = actions[instruction.action];
  if (handler) {
    return handler(instruction);
  }
  return fallback(instruction);
}

module.exports = { routeAction, actions };
