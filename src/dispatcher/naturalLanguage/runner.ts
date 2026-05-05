import {
  INTENT_CLARIFICATION_REQUIRED,
  type CapabilityRegistry,
  type DispatchExecutionResult,
  type DispatchPlan
} from './types.js';

export type DispatchRunnerHandlers = {
  runMcpTool: (body: { tool: string; args: Record<string, unknown> }) => Promise<DispatchExecutionResult>;
  runDiagnostics: (payload: unknown) => Promise<DispatchExecutionResult>;
  runCapability: (input: {
    capabilityId: string;
    action: string;
    payload: unknown;
  }) => Promise<DispatchExecutionResult>;
};

function toRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

export async function runDispatchPlan(input: {
  plan: DispatchPlan;
  registry: CapabilityRegistry;
  handlers: DispatchRunnerHandlers;
}): Promise<DispatchExecutionResult> {
  if (input.plan.action === INTENT_CLARIFICATION_REQUIRED) {
    return {
      statusCode: 422,
      payload: {
        ok: false,
        error: {
          code: INTENT_CLARIFICATION_REQUIRED,
          message: 'Intent clarification is required before dispatch execution.'
        },
        plan: input.plan
      }
    };
  }

  const action = input.registry.getAction(input.plan.action);
  if (!action) {
    return {
      statusCode: 403,
      payload: {
        ok: false,
        error: {
          code: 'DISPATCH_ACTION_NOT_REGISTERED',
          message: 'Dispatch action is not registered.'
        },
        plan: input.plan
      }
    };
  }

  switch (action.runner.kind) {
    case 'gpt-access-mcp':
      return input.handlers.runMcpTool({
        tool: action.runner.tool,
        args: toRecord(input.plan.payload)
      });
    case 'gpt-access-diagnostics':
      return input.handlers.runDiagnostics(input.plan.payload);
    case 'gpt-access-capability':
      return input.handlers.runCapability({
        capabilityId: action.runner.capabilityId,
        action: action.runner.capabilityAction,
        payload: input.plan.payload
      });
  }
}
