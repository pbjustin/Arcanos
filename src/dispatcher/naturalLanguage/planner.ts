import { resolveRuleBasedDispatchPlan } from './resolver.js';
import type { DispatchPlan, ResolveDispatchPlanInput } from './types.js';

export async function resolveDispatchPlan(input: ResolveDispatchPlanInput): Promise<DispatchPlan> {
  return resolveRuleBasedDispatchPlan({
    utterance: input.utterance,
    registry: input.registry
  });
}
