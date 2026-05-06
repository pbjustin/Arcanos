import { getEnv } from '@platform/runtime/env.js';

import {
  getLlmDispatchModel,
  getLlmDispatchTimeoutMs,
  hasConfiguredLlmDispatchCredentials,
  resolveLlmDispatchPlan,
  shouldFallBackToRulePlanAfterLlm
} from './llmResolver.js';
import { resolveRuleBasedDispatchPlan } from './resolver.js';
import {
  INTENT_CLARIFICATION_REQUIRED,
  type DispatchPlan,
  type ResolveDispatchPlanInput
} from './types.js';

export type NaturalLanguageDispatchMode = 'rules' | 'hybrid' | 'llm_first';

function readConfiguredDispatchMode(): {
  rawMode: string | null;
  validMode: NaturalLanguageDispatchMode | null;
  invalidMode: boolean;
} {
  const rawMode = getEnv('GPT_ACCESS_NL_DISPATCH_MODE')?.trim().toLowerCase() || null;
  if (!rawMode) {
    return {
      rawMode: null,
      validMode: null,
      invalidMode: false
    };
  }

  const validMode =
    rawMode === 'hybrid' || rawMode === 'llm_first' || rawMode === 'rules'
      ? rawMode
      : null;

  return {
    rawMode,
    validMode,
    invalidMode: !validMode
  };
}

function readDispatchMode(): NaturalLanguageDispatchMode {
  const configured = readConfiguredDispatchMode();
  if (configured.validMode) {
    return configured.validMode;
  }

  if (configured.invalidMode) {
    return 'rules';
  }

  return hasConfiguredLlmDispatchCredentials() ? 'hybrid' : 'rules';
}

function getReasonIfDispatchLlmDisabled(input: {
  configured: ReturnType<typeof readConfiguredDispatchMode>;
  effectiveMode: NaturalLanguageDispatchMode;
  llmCredentialsConfigured: boolean;
  llmEnabled: boolean;
}): string | null {
  if (input.llmEnabled) {
    return null;
  }

  if (input.effectiveMode !== 'rules') {
    return 'openai_credentials_unavailable';
  }

  if (input.configured.validMode === 'rules') {
    return 'mode_rules';
  }

  if (input.configured.invalidMode) {
    return 'invalid_mode';
  }

  return input.llmCredentialsConfigured ? null : 'openai_credentials_unavailable';
}

export function getNaturalLanguageDispatchRuntimeStatus() {
  const configured = readConfiguredDispatchMode();
  const llmCredentialsConfigured = hasConfiguredLlmDispatchCredentials();
  const effectiveMode = readDispatchMode();
  const llmEnabled = effectiveMode !== 'rules' && llmCredentialsConfigured;
  const reasonIfDisabled = getReasonIfDispatchLlmDisabled({
    configured,
    effectiveMode,
    llmCredentialsConfigured,
    llmEnabled
  });

  return {
    mode: configured.rawMode ?? 'unset',
    effectiveMode,
    llmEnabled,
    model: getLlmDispatchModel(),
    timeoutMs: getLlmDispatchTimeoutMs(),
    reasonIfDisabled,
    lastResolverSource: null
  };
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
      registry: input.llmRegistry ?? input.registry,
      context: input.context
    });

    return requiresClarification(llmPlan) ? rulePlan : llmPlan;
  }

  if (!requiresClarification(rulePlan)) {
    return rulePlan;
  }

  const llmPlan = await resolveLlmDispatchPlan({
    utterance: input.utterance,
    registry: input.llmRegistry ?? input.registry,
    context: input.context
  });

  return shouldFallBackToRulePlanAfterLlm(llmPlan) ? rulePlan : llmPlan;
}
