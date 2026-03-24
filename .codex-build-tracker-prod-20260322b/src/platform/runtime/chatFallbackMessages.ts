/**
 * Chat fallback message templates and log prefixes.
 */

export const CHAT_FALLBACK_LOG_PREFIXES = {
  primary: '🧠 [PRIMARY]',
  retry: '🔄 [RETRY]',
  gpt5: '🧠 [GPT-5.1 FALLBACK]',
  final: '🛟 [FINAL FALLBACK]',
} as const;

/**
 * Build GPT-5.1 fallback reason.
 * Inputs: primaryModel (string).
 * Outputs: human-readable fallback reason.
 * Edge cases: empty model names are passed through unchanged.
 */
export const buildGpt5FallbackReason = (primaryModel: string): string =>
  `Primary model ${primaryModel} failed twice, used GPT-5.1`;

/**
 * Build final fallback reason after all models fail.
 * Inputs: primaryModel (string), gpt5Model (string).
 * Outputs: human-readable fallback reason.
 * Edge cases: empty model names are passed through unchanged.
 */
export const buildFinalFallbackReason = (primaryModel: string, gpt5Model: string): string =>
  `All models failed: ${primaryModel} (primary), ${gpt5Model} (GPT-5.1 fallback), using final fallback`;

/**
 * Build failure context summary for all model attempts.
 * Inputs: primaryModel (string), gpt5Model (string), finalFallbackModel (string).
 * Outputs: summary string for logging and errors.
 * Edge cases: empty model names are passed through unchanged.
 */
export const buildFailureContext = (
  primaryModel: string,
  gpt5Model: string,
  finalFallbackModel: string,
): string =>
  `All models failed: Primary (${primaryModel}), GPT-5.1 (${gpt5Model}), Final (${finalFallbackModel})`;

/**
 * Build GPT-5.1 attempt log message.
 * Inputs: gpt5Model (string).
 * Outputs: log-ready attempt string.
 * Edge cases: empty model names are passed through unchanged.
 */
export const buildGpt5AttemptLog = (gpt5Model: string): string =>
  `🚀 [GPT-5.1 FALLBACK] Attempting with GPT-5.1: ${gpt5Model}`;

/**
 * Build GPT-5.1 success log message.
 * Inputs: gpt5Model (string).
 * Outputs: log-ready success string.
 * Edge cases: empty model names are passed through unchanged.
 */
export const buildGpt5SuccessLog = (gpt5Model: string): string =>
  `✅ [GPT-5.1 FALLBACK] Success with ${gpt5Model}`;
