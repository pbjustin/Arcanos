export const DEFAULT_ASYNC_GPT_WAIT_FOR_RESULT_MS = 3_500;
export const MAX_ASYNC_GPT_WAIT_FOR_RESULT_MS = 30_000;
export const DEFAULT_ASYNC_GPT_WAIT_POLL_MS = 250;
export const MAX_ASYNC_GPT_WAIT_POLLS = 601;
export const DEFAULT_GPT_ASYNC_HEAVY_WAIT_FOR_RESULT_MS = 500;

export interface GptAsyncHeavyWaitPolicyInput {
  protectedBackstageQueueRequired: boolean;
  configuredGenericWaitForResultMs?: number | string;
}

/**
 * Select the requested hybrid queue wait for one heavy GPT request.
 *
 * Protected Backstage generation owns the full bounded completion window so a
 * reused in-flight job can still complete inline. Other heavy GPT traffic
 * retains the short generic default or its positive configured override. The
 * queued completion service applies the shared absolute maximum afterward.
 */
export function resolveGptAsyncHeavyWaitForResultMs(
  input: GptAsyncHeavyWaitPolicyInput
): number {
  if (input.protectedBackstageQueueRequired) {
    return MAX_ASYNC_GPT_WAIT_FOR_RESULT_MS;
  }

  const configuredWaitForResultMs = Number(
    input.configuredGenericWaitForResultMs
  );
  return Number.isFinite(configuredWaitForResultMs)
    && configuredWaitForResultMs > 0
    ? Math.trunc(configuredWaitForResultMs)
    : DEFAULT_GPT_ASYNC_HEAVY_WAIT_FOR_RESULT_MS;
}
