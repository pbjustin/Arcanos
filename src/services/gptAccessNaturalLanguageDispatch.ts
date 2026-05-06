import {
  INTENT_CLARIFICATION_REQUIRED,
  createCapabilityRegistry,
  createGptAccessDispatchRegistry,
  dispatchActionRequiresConfirmation,
  evaluateDispatchPolicy,
  resolveDispatchPlan,
  runDispatchPlan,
  type CapabilityRegistry,
  type DispatchExecutionResult,
  type DispatchPolicyDecision,
  type DispatchPlan,
  type DispatchRunnerHandlers
} from '@dispatcher/naturalLanguage/index.js';
import { isModuleActionAllowed } from '../mcp/modulesAllowlist.js';
import {
  GPT_ACCESS_SCOPES,
  isGptAccessScopeAllowed,
  runDeepDiagnostics,
  runGptAccessWorkerRecovery,
  runGptAccessMcpTool,
  sanitizeGptAccessPayload,
  type GptAccessScope
} from '@services/gptAccessGateway.js';

const GPT_ACCESS_SCOPE_NAMES = new Set<string>(GPT_ACCESS_SCOPES);

export type GptAccessDispatchPolicyResponse = {
  status: DispatchPolicyDecision['status'];
  allowed: boolean;
  requiresConfirmation: boolean;
  shouldExecute: boolean;
  action: string;
  reason: string;
  code?: string;
  requiredScope: string | null;
};

export type GptAccessNaturalLanguageDispatchResponse = {
  statusCode: number;
  payload: unknown;
  plan: DispatchPlan;
  policy: DispatchPolicyDecision;
};

export type ResolveGptAccessNaturalLanguageDispatchInput = {
  utterance: string;
  context?: Record<string, unknown>;
  registry: CapabilityRegistry;
  isScopeAllowed?: (scope: string) => boolean;
  isModuleActionAllowed?: (moduleName: string, action: string) => boolean;
};

export type RunGptAccessNaturalLanguageDispatchInput =
  ResolveGptAccessNaturalLanguageDispatchInput & {
    dryRun?: boolean;
    handlers: DispatchRunnerHandlers;
    sanitizeResult?: (payload: unknown) => unknown;
  };

export function isDispatchGptAccessScopeAllowed(scope: string): boolean {
  return GPT_ACCESS_SCOPE_NAMES.has(scope) && isGptAccessScopeAllowed(scope as GptAccessScope);
}

export function createDispatchLlmPlanningRegistry(registry: CapabilityRegistry): CapabilityRegistry {
  return createCapabilityRegistry(
    registry.listActions().filter((registryAction) => {
      const policy = evaluateDispatchPolicy({
        plan: {
          action: registryAction.action,
          payload: {},
          confidence: 1,
          source: 'rules',
          requiresConfirmation: dispatchActionRequiresConfirmation(registryAction),
          reason: 'llm_planning_catalog_filter'
        },
        registry,
        isScopeAllowed: isDispatchGptAccessScopeAllowed,
        isModuleActionAllowed
      });

      return policy.status === 'allowed' || policy.status === 'confirmation_required';
    })
  );
}

export function toDispatchPolicyResponse(policy: DispatchPolicyDecision): GptAccessDispatchPolicyResponse {
  return {
    status: policy.status,
    allowed: policy.allowed,
    requiresConfirmation: policy.requiresConfirmation,
    shouldExecute: policy.shouldExecute,
    action: policy.action,
    reason: policy.reason,
    code: policy.code,
    requiredScope: policy.requiredScope ?? null
  };
}

export function toDispatchPolicyErrorMessage(policy: DispatchPolicyDecision): string {
  switch (policy.code) {
    case INTENT_CLARIFICATION_REQUIRED:
      return 'Dispatch intent could not be resolved confidently. Please clarify the requested action.';
    case 'DISPATCH_ACTION_NOT_REGISTERED':
      return 'Dispatch action is not registered for GPT Access.';
    case 'DISPATCH_ACTION_PROHIBITED':
      return 'Dispatch action is prohibited by GPT Access policy.';
    case 'GPT_ACCESS_SCOPE_DENIED':
      return 'GPT Access scope is not allowed for this dispatch action.';
    case 'GPT_ACCESS_CAPABILITY_ACTION_DENIED':
      return 'GPT Access capability action is not allowlisted.';
    default:
      return policy.status === 'clarification_required'
        ? 'Dispatch intent could not be resolved confidently. Please clarify the requested action.'
        : 'Dispatch request was denied by policy.';
  }
}

export function buildDispatchPolicyBlockPayload(plan: DispatchPlan, policy: DispatchPolicyDecision) {
  return {
    ok: false,
    error: {
      code: policy.code ?? (
        policy.status === 'clarification_required'
          ? INTENT_CLARIFICATION_REQUIRED
          : 'DISPATCH_POLICY_DENIED'
      ),
      message: toDispatchPolicyErrorMessage(policy)
    },
    plan,
    policy: toDispatchPolicyResponse(policy)
  };
}

export async function resolveGptAccessNaturalLanguageDispatch(
  input: ResolveGptAccessNaturalLanguageDispatchInput
): Promise<{ plan: DispatchPlan; policy: DispatchPolicyDecision }> {
  const plan = await resolveDispatchPlan({
    utterance: input.utterance,
    registry: input.registry,
    llmRegistry: createDispatchLlmPlanningRegistry(input.registry),
    context: input.context
  });
  const policy = evaluateDispatchPolicy({
    plan,
    registry: input.registry,
    isScopeAllowed: input.isScopeAllowed ?? isDispatchGptAccessScopeAllowed,
    isModuleActionAllowed: input.isModuleActionAllowed ?? isModuleActionAllowed
  });

  return { plan, policy };
}

export async function runGptAccessNaturalLanguageDispatch(
  input: RunGptAccessNaturalLanguageDispatchInput
): Promise<GptAccessNaturalLanguageDispatchResponse> {
  const { plan, policy } = await resolveGptAccessNaturalLanguageDispatch(input);

  if (input.dryRun) {
    return {
      statusCode: 200,
      payload: {
        ok: true,
        dryRun: true,
        plan,
        policy: toDispatchPolicyResponse(policy)
      },
      plan,
      policy
    };
  }

  if (!policy.allowed) {
    return {
      statusCode: policy.status === 'clarification_required' ? 422 : 403,
      payload: buildDispatchPolicyBlockPayload(plan, policy),
      plan,
      policy
    };
  }

  if (policy.requiresConfirmation) {
    return {
      statusCode: 403,
      payload: {
        ok: false,
        error: {
          code: 'CONFIRMATION_REQUIRED',
          message: 'Dispatch confirmation is required before execution.'
        },
        plan,
        policy: toDispatchPolicyResponse(policy)
      },
      plan,
      policy
    };
  }

  const result = await runDispatchPlan({
    plan,
    registry: input.registry,
    handlers: input.handlers
  });

  return {
    statusCode: result.statusCode,
    payload: {
      ok: result.statusCode >= 200 && result.statusCode < 300,
      plan,
      policy: toDispatchPolicyResponse(policy),
      result: input.sanitizeResult ? input.sanitizeResult(result.payload) : result.payload
    },
    plan,
    policy
  };
}

function isOperatorBackendCommand(utterance: string): boolean {
  const normalized = utterance
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();

  return /\b(?:backend|runtime|server|workers?|job runners?|queue|backlog|diagnostics?|health|stale workers?|slot \d+|recycle|recover|kick|fix)\b/u.test(normalized);
}

export async function routeOperatorCommandThroughDispatch(input: {
  utterance: string;
  context?: Record<string, unknown>;
  dryRun?: boolean;
}): Promise<GptAccessNaturalLanguageDispatchResponse | null> {
  if (!isOperatorBackendCommand(input.utterance)) {
    return null;
  }

  const registry = createGptAccessDispatchRegistry();
  return runGptAccessNaturalLanguageDispatch({
    utterance: input.utterance,
    context: input.context,
    dryRun: input.dryRun,
    registry,
    handlers: {
      runMcpTool: (body) => runGptAccessMcpTool(body),
      runDiagnostics: (payload) => runDeepDiagnostics(payload),
      runWorkerRecovery: (payload) => runGptAccessWorkerRecovery(payload),
      runCapability: async (): Promise<DispatchExecutionResult> => ({
        statusCode: 403,
        payload: {
          ok: false,
          error: {
            code: 'GPT_ACCESS_CAPABILITY_ACTION_DENIED',
            message: 'Capability dispatch is not available from ARCANOS:CORE operator routing.'
          }
        }
      })
    },
    sanitizeResult: sanitizeGptAccessPayload
  });
}
