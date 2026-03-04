/**
 * Central switch for whether OpenAI should store Responses / ChatCompletions on the OpenAI side.
 *
 * Best-practice default is `false` (stateless). Enable explicitly per-environment when needed.
 */
export function shouldStoreOpenAIResponses(): boolean {
  const raw = process.env.OPENAI_STORE;
  if (!raw) return false;
  const v = String(raw).trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes' || v === 'on';
}
