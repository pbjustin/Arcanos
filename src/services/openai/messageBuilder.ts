import { buildContextualSystemPrompt } from "@services/contextualReinforcement.js";
import { CallOpenAIOptions, ChatCompletionMessageParam } from './types.js';
import { buildSystemPromptMessages } from "@shared/messageBuilderUtils.js";

export function buildChatMessages(
  prompt: string,
  systemPrompt: string,
  options: CallOpenAIOptions
): ChatCompletionMessageParam[] {
  const contextAwarePrompt = buildContextualSystemPrompt(systemPrompt);
  let preparedMessages: ChatCompletionMessageParam[];

  if (options.messages && options.messages.length > 0) {
    let systemInjected = false;
    preparedMessages = options.messages.map((message) => {
      if (message.role === 'system' && typeof message.content === 'string') {
        systemInjected = true;
        return { ...message, content: buildContextualSystemPrompt(message.content) };
      }
      return message;
    });

    // Check if we need to inject the system prompt if it wasn't found/updated
    const hasSystemMessage = preparedMessages.some((message) => message.role === 'system');
    if (!hasSystemMessage || !systemInjected) {
      // If we have existing messages but no system message, prepend the context-aware system prompt
      preparedMessages = [{ role: 'system', content: contextAwarePrompt }, ...preparedMessages];
    }
  } else {
    // Standard case: just prompt and system prompt
    preparedMessages = buildSystemPromptMessages(prompt, contextAwarePrompt);
  }

  return preparedMessages;
}
