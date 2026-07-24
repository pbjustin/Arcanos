import type {
  ModuleDef,
  ModuleHandlerContext
} from './moduleLoader.js';
import {
  LOCAL_AGENT_ACTIONS,
  LOCAL_AGENT_ACTION_METADATA,
  LOCAL_AGENT_MODULE_NAME,
  LocalAgentContractValidationError,
  type LocalAgentAction,
  validateLocalAgentActionInput
} from './localAgent/contracts.js';
import { getLocalAgentActionExecutor } from './localAgent/executor.js';

function isTrustedContext(
  context: ModuleHandlerContext | undefined
): context is ModuleHandlerContext {
  return Boolean(
    context?.source === 'gpt-access'
    && typeof context.principalId === 'string'
    && context.principalId.trim().length > 0
    && typeof context.workspaceId === 'string'
    && context.workspaceId.trim().length > 0
    && typeof context.actorKey === 'string'
    && context.actorKey.trim().length > 0
  );
}

function errorEnvelope(
  action: LocalAgentAction,
  code: string,
  message: string,
  recommendedAction: string,
  details?: Record<string, unknown>
) {
  return {
    ok: false,
    action,
    persisted: false,
    error: {
      code,
      message,
      recoverable: true,
      recommendedAction,
      ...(details ? { details } : {})
    }
  };
}

async function executeLocalAgentAction(
  action: LocalAgentAction,
  payload: unknown,
  context?: ModuleHandlerContext
): Promise<unknown> {
  if (!isTrustedContext(context)) {
    return errorEnvelope(
      action,
      'PERMISSION_DENIED',
      'Local-agent capabilities require trusted GPT Access context.',
      'CHECK_CONFIGURATION'
    );
  }

  let validatedPayload;
  try {
    validatedPayload = validateLocalAgentActionInput(action, payload);
  } catch (error) {
    if (error instanceof LocalAgentContractValidationError) {
      return errorEnvelope(
        action,
        'VALIDATION_FAILED',
        'The local-agent action payload is invalid.',
        'FIX_INPUT',
        { issues: error.issues }
      );
    }
    throw error;
  }

  const executor = getLocalAgentActionExecutor();
  if (!executor) {
    return errorEnvelope(
      action,
      'DEPENDENCY_UNAVAILABLE',
      'The durable local-agent job service is not configured.',
      'RETRY_LATER'
    );
  }

  return executor({
    action,
    payload: validatedPayload,
    context
  });
}

const actions = Object.fromEntries(
  LOCAL_AGENT_ACTIONS.map((action) => [
    action,
    (payload: unknown, context?: ModuleHandlerContext) =>
      executeLocalAgentAction(action, payload, context)
  ])
) as ModuleDef['actions'];

export const ArcanosLocalAgent: ModuleDef = {
  name: LOCAL_AGENT_MODULE_NAME,
  description: 'Protected durable jobs executed by a paired Python local agent.',
  defaultAction: 'local_agent.status',
  defaultTimeoutMs: 900_000,
  exposeLegacyRoute: false,
  gptAccessOnly: true,
  actions,
  actionMetadata: LOCAL_AGENT_ACTION_METADATA
};

export default ArcanosLocalAgent;
