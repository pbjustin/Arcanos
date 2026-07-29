import { extractGptPromptText } from '@shared/gpt/messageContentText.js';
import { isRecord } from '@shared/typeGuards.js';

const DISPATCH_PROMPT_ALIAS_KEYS = [
  'message',
  'prompt',
  'userInput',
  'content',
  'text',
  'query',
  'messages',
] as const;

/**
 * Reproduce the dispatcher's explicit-payload prompt precedence without
 * constructing or retaining the full dispatch payload.
 */
export function extractMemoryDispatcherPrompt(body: unknown): string | null {
  if (!isRecord(body) || !Object.prototype.hasOwnProperty.call(body, 'payload')) {
    return extractGptPromptText(body);
  }

  const explicitPayload = body.payload;
  if (!isRecord(explicitPayload)) {
    return null;
  }

  const explicitPayloadHasPromptAlias = DISPATCH_PROMPT_ALIAS_KEYS.some(
    (key) => Object.prototype.hasOwnProperty.call(explicitPayload, key)
  );
  return explicitPayloadHasPromptAlias
    ? extractGptPromptText({ ...explicitPayload })
    : extractGptPromptText(body);
}

export function shouldInterceptMemoryDispatcher(input: {
  prompt: string | null;
  parsedIntent: string;
  hasMemoryCue: boolean;
  hasNoRoutableAction: boolean;
  requestedAction: string | null | undefined;
  forceDirectModuleRouting: boolean;
}): boolean {
  return (
    !input.forceDirectModuleRouting
    && typeof input.prompt === 'string'
    && input.parsedIntent !== 'unknown'
    && (input.hasMemoryCue || input.hasNoRoutableAction)
    && (!input.requestedAction || input.requestedAction === 'query')
  );
}
