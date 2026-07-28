import {
  hasNaturalLanguageMemoryCue,
  parseNaturalLanguageMemoryCommand,
  type NaturalLanguageMemoryIntent,
} from '@services/naturalLanguageMemory.js';
import {
  pickGptModuleAction,
  resolveGptModuleRequestedActionAlias,
} from '@shared/gpt/gptModuleAction.js';
import {
  extractMemoryDispatcherPrompt,
  shouldInterceptMemoryDispatcher,
} from '@shared/memory/memoryDispatchRouting.js';
import { isRecord } from '@shared/typeGuards.js';

export interface GptMemoryInterceptionDecision {
  intercept: boolean;
  prompt: string | null;
  parsedIntent: NaturalLanguageMemoryIntent;
  hasMemoryCue: boolean;
  hasNoRoutableAction: boolean;
  requestedAction: string | undefined;
}

/**
 * Classify the exact natural-language memory branch used by the dispatcher.
 * This function is pure: it parses request data but performs no memory I/O.
 */
export function classifyGptMemoryInterception(input: {
  body: unknown;
  availableActions: readonly string[];
  fallbackActionCandidate: string | null;
  forceDirectModuleRouting: boolean;
}): GptMemoryInterceptionDecision {
  const prompt = extractMemoryDispatcherPrompt(input.body);
  const rawRequestedAction =
    isRecord(input.body) && typeof input.body.action === 'string'
      ? input.body.action.trim()
      : undefined;
  const requestedAction = resolveGptModuleRequestedActionAlias(
    rawRequestedAction,
    input.availableActions
  );
  const initialActionCandidate = requestedAction
    ? pickGptModuleAction(input.availableActions, requestedAction)
    : input.fallbackActionCandidate;
  const parsedIntent = prompt
    ? parseNaturalLanguageMemoryCommand(prompt).intent
    : 'unknown';
  const hasMemoryCue = Boolean(prompt && hasNaturalLanguageMemoryCue(prompt));
  const hasNoRoutableAction = !initialActionCandidate;

  return {
    intercept: shouldInterceptMemoryDispatcher({
      prompt,
      parsedIntent,
      hasMemoryCue,
      hasNoRoutableAction,
      requestedAction,
      forceDirectModuleRouting: input.forceDirectModuleRouting,
    }),
    prompt,
    parsedIntent,
    hasMemoryCue,
    hasNoRoutableAction,
    requestedAction,
  };
}
