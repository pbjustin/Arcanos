import OpenAI from 'openai';

export const ARCANOS_MODEL_ALIAS = 'arcanos-v2';
export const ARCANOS_MODEL_ID = 'REDACTED_FINE_TUNED_MODEL_ID';

export async function callArcanosModel(openai: OpenAI, params: any) {
  console.log('[ARCANOS] Routed to fine-tuned model: arcanos-v2 [BxRSDrhH]');
  try {
    return await openai.chat.completions.create({ ...params, model: ARCANOS_MODEL_ALIAS });
  } catch (error: any) {
    if (
      error?.status === 404 ||
      error?.code === 'model_not_found' ||
      error?.error?.code === 'model_not_found'
    ) {
      console.warn('[ARCANOS] Alias failed, retrying with full model ID');
      return await openai.chat.completions.create({ ...params, model: ARCANOS_MODEL_ID });
    }
    throw error;
  }
}
