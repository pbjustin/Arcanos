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
import { GPT_ACCESS_SCOPES, type GptAccessScope } from '@services/gptAccessScopes.js';
import {
  isGptAccessScopeAllowed,
  runDeepDiagnostics,
  runGptAccessWorkerRecovery,
  runGptAccessMcpTool,
  sanitizeGptAccessPayload
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
        confirmationRequired: true,
        confirmation: {
          retryEndpoint: '/gpt-access/dispatch/run',
          confirmationTokenField: 'confirmation_token'
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

  if (isWritingPrompt(normalized)) {
    return false;
  }

  if (isAdvisoryAnalysisPrompt(normalized)) {
    return isOperationalAnalysisPrompt(normalized);
  }

  if (isExplicitWorkerControlCommand(normalized)) {
    return true;
  }

  const explicitOperatorCommand = isExplicitOperatorCommand(normalized);
  return explicitOperatorCommand;
}

function isWritingPrompt(normalized: string): boolean {
  return /\b(?:write|draft|compose|story|poem|essay|blog)\b/u.test(normalized);
}

function isAdvisoryAnalysisPrompt(normalized: string): boolean {
  return (
    /\b(?:improve|improvements?|recommend|suggest|review|analy[sz]e|opinion|advice|architecture|design|plan|refine|explain)\b/u.test(normalized)
    || /\b(?:how|what)\s+should\b.*\b(?:improve|fix|recycle|recover|unstick|architecture|design|plan|recommend|suggest|review|analy[sz]e)\b/u.test(normalized)
  );
}

function isOperationalAnalysisPrompt(normalized: string): boolean {
  return (
    /\b(?:analy[sz]e|explain|review)\b/u.test(normalized)
    && /\b(?:backend|runtime|workers?|job runners?|queue|backlog|pending jobs?)\b/u.test(normalized)
    && /\b(?:status|health|healthy|alive|up|down|okay|ok|broken|failing|failure|errors?|wrong|backed up|diagnostics?)\b/u.test(normalized)
  );
}

function isExplicitOperatorCommand(normalized: string): boolean {
  return (
    /\b(?:run|perform|start|do|deep|full)\s+(?:a\s+)?(?:diagnostics?|diagnostic|health check)\b/u.test(normalized)
    || /\b(?:check(?:\s+on)?|inspect|show(?:\s+me)?|look\s+(?:at|into)|diagnose|troubleshoot|what(?:s|\s+is)?\s+(?:wrong|going\s+on)|is|are)\b.*\b(?:backend|runtime|workers?|job runners?|queue|backlog|pending jobs?)\b/u.test(normalized)
    || /\b(?:backend|runtime|workers?|job runners?|queue|backlog|pending jobs?)\b.*\b(?:status|health|healthy|alive|up|down|okay|ok|broken|failing|failure|errors?|wrong|stale|backed up|diagnostics?)\b/u.test(normalized)
    || /\b(?:server|app)\s+(?:status|health|healthy|alive|up|down|broken|failing|failure|errors?)\b/u.test(normalized)
    || /\b(?:status|health|healthy|alive|up|down)\s+(?:server|app)\b/u.test(normalized)
  );
}

function isExplicitWorkerControlCommand(normalized: string): boolean {
  return (
    /\b(?:fix|kick|recycle|recover|unstick)\s+(?:stale\s+)?(?:workers?|job runners?|slots?|slot\s+\d+|async queue|queue slot)\b/u.test(normalized)
    || /\b(?:recycle|recover|unstick)\s+(?:slot\s+)?\d+(?:\s+(?:and|or)\s+(?:slot\s+)?\d+)*\b/u.test(normalized)
  );
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
