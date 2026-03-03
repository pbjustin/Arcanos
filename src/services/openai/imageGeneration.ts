import crypto from 'crypto';
import { getOpenAIClientOrAdapter } from './clientBridge.js';
import { callOpenAI } from './chatFlow.js';
import { generateMockResponse } from './mock.js';
import { logOpenAIEvent } from "@platform/logging/openaiLogger.js";
import { resolveErrorMessage } from "@core/lib/errors/index.js";
import { hasContent } from "@shared/promptUtils.js";
import { OPENAI_LOG_MESSAGES } from "@platform/runtime/openaiLogMessages.js";
import { DEFAULT_IMAGE_SIZE, IMAGE_GENERATION_MODEL } from './config.js';
import type { ImageSize } from './types.js';
import { buildImageRequest } from './requestBuilders.js';
import { getDefaultModel } from './credentialProvider.js';
import { IMAGE_PROMPT_TOKEN_LIMIT } from "./constants.js";

const buildEnhancedImagePrompt = async (input: string): Promise<string> => {
  try {
    const { output } = await callOpenAI(getDefaultModel(), input, IMAGE_PROMPT_TOKEN_LIMIT, false);
    if (hasContent(output)) {
      return output.trim();
    }
  } catch (err) {
    logOpenAIEvent('error', OPENAI_LOG_MESSAGES.IMAGE.PROMPT_GENERATION_ERROR, undefined, err as Error);
  }

  return input;
};

export async function generateImage(
  input: string,
  size: ImageSize = DEFAULT_IMAGE_SIZE
): Promise<{ image: string; prompt: string; meta: { id: string; created: number }; error?: string }> {
  const { adapter } = getOpenAIClientOrAdapter();
  if (!adapter) {
    const mock = generateMockResponse(input, 'image');
    return { image: '', prompt: input, meta: mock.meta, error: mock.error };
  }

  // Use the fine-tuned default model to craft a detailed image prompt
  const prompt = await buildEnhancedImagePrompt(input);

  try {
    const requestParams = buildImageRequest({ prompt, size });
    //audit Assumption: image generation should flow through adapter-first boundary; risk: direct SDK bypass; invariant: adapter images surface used; handling: call adapter.images.generate.
    const response = await adapter.images.generate(requestParams);

    const image = response.data?.[0]?.b64_json || '';

    return {
      image,
      prompt,
      meta: {
        id: crypto.randomUUID(),
        created: response.created
      }
    };
  } catch (err) {
    logOpenAIEvent('error', OPENAI_LOG_MESSAGES.IMAGE.GENERATION_ERROR, { model: IMAGE_GENERATION_MODEL }, err as Error);
    return {
      image: '',
      prompt,
      meta: {
        id: crypto.randomUUID(),
        created: Date.now()
      },
      error: resolveErrorMessage(err)
    };
  }
}
