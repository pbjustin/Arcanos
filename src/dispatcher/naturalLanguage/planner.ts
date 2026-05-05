import { getEnv } from '@platform/runtime/env.js';

import {
  resolveLlmDispatchPlan,
  shouldFallBackToRulePlanAfterLlm
} from './llmResolver.js';
import { resolveRuleBasedDispatchPlan } from './resolver.js';
import {
  INTENT_CLARIFICATION_REQUIRED,
  type DispatchPlan,
  type ResolveDispatchPlanInput
} from './types.js';

type NaturalLanguageDispatchMode = 'rules' | 'hybrid' | 'llm_first';

function readDispatchMode(): NaturalLanguageDispatchMode {
  const mode = getEnv('GPT_ACCESS_NL_DISPATCH_MODE')?.trim().toLowerCase();
  return mode === 'hybrid' || mode === 'llm_first' || mode === 'rules' ? mode : 'rules';
}

function requiresClarification(plan: DispatchPlan): boolean {
  return plan.action === INTENT_CLARIFICATION_REQUIRED;
}

export async function resolveDispatchPlan(input: ResolveDispatchPlanInput): Promise<DispatchPlan> {
  const mode = readDispatchMode();
  const rulePlan = resolveRuleBasedDispatchPlan({
    utterance: input.utterance,
    registry: input.registry
  });

  if (mode === 'rules') {
    return rulePlan;
  }

  if (mode === 'llm_first') {
    const llmPlan = await resolveLlmDispatchPlan({
      utterance: input.utterance,
      registry: input.registry
    });

    return requiresClarification(llmPlan) ? rulePlan : llmPlan;
  }

  if (!requiresClarification(rulePlan)) {
    return rulePlan;
  }

  const llmPlan = await resolveLlmDispatchPlan({
    utterance: input.utterance,
    registry: input.registry
  });

  return shouldFallBackToRulePlanAfterLlm(llmPlan) ? rulePlan : llmPlan;
}
