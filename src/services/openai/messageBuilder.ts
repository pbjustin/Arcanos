import { buildContextualSystemPrompt } from '../contextualReinforcement.js';
import { CallOpenAIOptions, ChatCompletionMessageParam } from './types.js';

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

    const hasSystemMessage = preparedMessages.some((message) => message.role === 'system');
    if (!hasSystemMessage || !systemInjected) {
      preparedMessages = [{ role: 'system', content: contextAwarePrompt }, ...preparedMessages];
    }
  } else {
    preparedMessages = [
      { role: 'system', content: contextAwarePrompt },
      { role: 'user', content: prompt }
    ];
  }

  return preparedMessages;
}
