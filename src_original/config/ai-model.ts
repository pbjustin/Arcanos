import OpenAI from 'openai';

// PATCHED: full model ID
export const ARCANOS_MODEL_ID = 'REDACTED_FINE_TUNED_MODEL_ID';

export async function callArcanosModel(openai: OpenAI, params: any) {
  console.log('[ARCANOS] Locked routing to fine-tuned model: arcanos-v2 [BxRSDrhH]');
  // PATCHED: full model ID - removed fallback logic, use full model ID directly
  return await openai.chat.completions.create({ ...params, model: ARCANOS_MODEL_ID });
}
