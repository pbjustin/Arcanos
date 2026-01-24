import { TokenParameterResult } from '../../utils/tokenParameterHelper.js';
import { prepareGPT5Request } from './requestTransforms.js';
import type { ChatCompletion, ChatCompletionCreateParams, ChatCompletionMessageParam, CallOpenAIOptions } from './types.js';

const FALLBACK_TEXT_SELECTOR = '[No text output]';

const mapMessagesToResponseInput = (
  messages: ChatCompletionMessageParam[]
): ChatCompletionMessageParam[] => messages;

type GPT5Payload = ChatCompletionCreateParams & {
  max_output_tokens?: number;
};

export const buildResponseRequestPayload = ({
  model,
  messages,
  tokenParams,
  options
}: {
  model: string;
  messages: ChatCompletionMessageParam[];
  tokenParams: TokenParameterResult;
  options: CallOpenAIOptions;
}): GPT5Payload => {
  const basePayload = prepareGPT5Request({
    model,
    messages: mapMessagesToResponseInput(messages),
    ...tokenParams,
    ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
    ...(options.top_p !== undefined ? { top_p: options.top_p } : {}),
    ...(options.frequency_penalty !== undefined ? { frequency_penalty: options.frequency_penalty } : {}),
    ...(options.presence_penalty !== undefined ? { presence_penalty: options.presence_penalty } : {}),
    ...(options.responseFormat !== undefined ? { response_format: options.responseFormat } : {}),
    ...(options.user !== undefined ? { user: options.user } : {})
  });

  const payload: GPT5Payload = { ...basePayload };
  //audit Assumption: GPT-5 variants accept max_output_tokens; Handling: mirror
  if (payload.max_output_tokens === undefined && typeof payload.max_tokens === 'number') {
    payload.max_output_tokens = payload.max_tokens;
  }

  return payload;
};

type ResponseOutput = ChatCompletion & {
  output_text?: string;
  output?: Array<{ content?: Array<{ text?: string }> }>;
};

export const extractResponseOutput = (response: ResponseOutput): string => {
  //audit Assumption: response may carry output_text/output/choices; Handling: fallback
  const rawOutput =
    response?.output_text ||
    response?.output?.[0]?.content?.[0]?.text ||
    response?.choices?.[0]?.message?.content ||
    FALLBACK_TEXT_SELECTOR;

  return typeof rawOutput === 'string' ? rawOutput : FALLBACK_TEXT_SELECTOR;
};
