import OpenAI from 'openai';

// PATCHED: full model ID
export const ARCANOS_MODEL_ID = 'ft:gpt-3.5-turbo-0125:personal:arcanos-v2:BxRSDrhH';

export async function callArcanosModel(openai: OpenAI, params: any) {
  console.log('[ARCANOS] Locked routing to fine-tuned model: arcanos-v2 [BxRSDrhH]');
  // PATCHED: full model ID - removed fallback logic, use full model ID directly
  return await openai.chat.completions.create({ ...params, model: ARCANOS_MODEL_ID });
}
