import { executionEngine } from './execution-engine';
import { DispatchInstruction } from './ai-dispatcher';
import { createServiceLogger } from '../utils/logger';

const logger = createServiceLogger('ActionRouter');

export interface ActionHandler {
  (instruction: DispatchInstruction): any;
}

// Streamlined action handlers - no fallback logic
const actions: Record<string, ActionHandler> = {
  respond: (instruction: DispatchInstruction) => executionEngine.handleResponse(instruction),
  execute: (instruction: DispatchInstruction) => executionEngine.handleExecution(instruction),
  schedule: (instruction: DispatchInstruction) => executionEngine.handleSchedule(instruction),
  delegate: (instruction: DispatchInstruction) => executionEngine.handleDelegation(instruction),
  write: (instruction: DispatchInstruction) => executionEngine.executeWriteOperation(instruction.parameters || {}),
};

export function routeAction(instruction: DispatchInstruction) {
  const handler = actions[instruction.action];
  if (handler) {
    return handler(instruction);
  }
  
  // No fallback - fail fast for unknown actions
  logger.error(`Unknown action: ${instruction.action}`);
  return { success: false, error: `Unknown action: ${instruction.action}` };
}

export { actions };