export const DEFAULT_ASYNC_GPT_WAIT_FOR_RESULT_MS = 3_500;
export const MAX_ASYNC_GPT_WAIT_FOR_RESULT_MS = 30_000;
export const DEFAULT_ASYNC_GPT_WAIT_POLL_MS = 250;
export const MAX_ASYNC_GPT_WAIT_POLLS = 601;
export const DEFAULT_GPT_ASYNC_HEAVY_WAIT_FOR_RESULT_MS = 500;
export const BACKSTAGE_INITIAL_ACCEPTANCE_WAIT_MS = 1_000;

export interface GptAsyncHeavyWaitPolicyInput {
  protectedBackstageQueueRequired: boolean;
  configuredGenericWaitForResultMs?: number | string;
}

/**
 * Select the requested hybrid queue wait for one heavy GPT request.
 *
 * Protected Backstage generation uses only the short durable-acceptance window.
 * Other heavy GPT traffic retains the short generic default or its positive
 * configured override. The queued completion service applies the shared
 * absolute maximum afterward.
 */
export function resolveGptAsyncHeavyWaitForResultMs(
  input: GptAsyncHeavyWaitPolicyInput
): number {
  if (input.protectedBackstageQueueRequired) {
    return resolveBackstageInitialAcceptanceWaitMs();
  }

  const configuredWaitForResultMs = Number(
    input.configuredGenericWaitForResultMs
  );
  return Number.isFinite(configuredWaitForResultMs)
    && configuredWaitForResultMs > 0
    ? Math.trunc(configuredWaitForResultMs)
    : DEFAULT_GPT_ASYNC_HEAVY_WAIT_FOR_RESULT_MS;
}

/**
 * Bound the protected Backstage POST to a short durable-acceptance window.
 * Long polling belongs to the managed result GET and retains its independent
 * zero-to-thirty-second policy.
 */
export function resolveBackstageInitialAcceptanceWaitMs(
  requestedWaitForResultMs?: number | string
): number {
  const requestedWaitMs = Number(requestedWaitForResultMs);
  if (!Number.isFinite(requestedWaitMs) || requestedWaitMs < 0) {
    return BACKSTAGE_INITIAL_ACCEPTANCE_WAIT_MS;
  }

  return Math.min(
    Math.trunc(requestedWaitMs),
    BACKSTAGE_INITIAL_ACCEPTANCE_WAIT_MS
  );
}
