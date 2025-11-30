import { prepareGPT5Request } from './requestTransforms.js';
import { ChatCompletionMessageParam, CallOpenAIOptions } from './types.js';

const FALLBACK_TEXT_SELECTOR = '[No text output]';

const mapMessagesToResponseInput = (messages: ChatCompletionMessageParam[]) =>
  messages.map(({ role, content }) => ({ role, content }));

export const buildResponseRequestPayload = ({
  model,
  messages,
  tokenParams,
  options
}: {
  model: string;
  messages: ChatCompletionMessageParam[];
  tokenParams: Record<string, unknown>;
  options: CallOpenAIOptions;
}) => {
  const basePayload = prepareGPT5Request({
    model,
    input: mapMessagesToResponseInput(messages),
    ...tokenParams,
    ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
    ...(options.top_p !== undefined ? { top_p: options.top_p } : {}),
    ...(options.frequency_penalty !== undefined ? { frequency_penalty: options.frequency_penalty } : {}),
    ...(options.presence_penalty !== undefined ? { presence_penalty: options.presence_penalty } : {}),
    ...(options.responseFormat !== undefined ? { response_format: options.responseFormat } : {}),
    ...(options.user !== undefined ? { user: options.user } : {})
  });

  if (
    basePayload &&
    typeof basePayload === 'object' &&
    !('max_output_tokens' in basePayload) &&
    'max_tokens' in basePayload
  ) {
    Object.assign(basePayload, { max_output_tokens: (basePayload as any).max_tokens });
  }

  return basePayload;
};

export const extractResponseOutput = (response: any): string => {
  const rawOutput =
    response?.output_text ||
    response?.output?.[0]?.content?.[0]?.text ||
    response?.choices?.[0]?.message?.content ||
    FALLBACK_TEXT_SELECTOR;

  return typeof rawOutput === 'string' ? rawOutput : FALLBACK_TEXT_SELECTOR;
};
