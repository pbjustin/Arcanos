/**
 * Runs async work over a list with deterministic result ordering and bounded parallelism.
 * Inputs/Outputs: ordered items + concurrency limit + mapper -> ordered mapper results.
 * Edge cases: invalid concurrency falls back to one worker; empty inputs do not invoke the mapper.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  mapper: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  if (items.length === 0) {
    return [];
  }

  const boundedConcurrency = normalizeConcurrency(concurrency);
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  const workerCount = Math.min(boundedConcurrency, items.length);

  await Promise.all(Array.from({ length: workerCount }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await mapper(items[index] as T, index);
    }
  }));

  return results;
}

export function normalizeConcurrency(value: number | undefined, fallback = 1, max = Number.MAX_SAFE_INTEGER): number {
  const fallbackValue = normalizePositiveInteger(fallback, 1);
  const maxValue = Math.max(1, normalizePositiveInteger(max, Number.MAX_SAFE_INTEGER));
  if (!Number.isFinite(value) || Number(value) <= 0) {
    return Math.min(fallbackValue, maxValue);
  }

  return Math.min(maxValue, Math.max(1, Math.trunc(Number(value))));
}

function normalizePositiveInteger(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) && Number(value) > 0 ? Math.trunc(Number(value)) : fallback;
}
