export interface HrcEvaluationCache<T> {
  get(key: string): T | null;
  set(key: string, value: T): void;
}

export interface RunCachedHrcEvaluationOptions<T extends object> {
  cache: HrcEvaluationCache<T>;
  cacheKey: string;
  evaluate: () => Promise<T>;
  fallback: T;
}

const nonCacheableHrcResults = new WeakSet<object>();

export function markHRCResultNonCacheable<T extends object>(result: T): T {
  nonCacheableHrcResults.add(result);
  return result;
}

function isAbortLikeError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) {
    return false;
  }
  const candidate = error as {
    name?: unknown;
    code?: unknown;
    message?: unknown;
  };
  return [candidate.name, candidate.code, candidate.message]
    .filter((value): value is string => typeof value === 'string')
    .some((value) => {
      const normalized = value.toLowerCase();
      return normalized.includes('abort') || normalized.includes('cancel');
    });
}

export function markHRCResultNonCacheableForAbort<T extends object>(
  result: T,
  options: {
    signal?: AbortSignal;
    error?: unknown;
  }
): T {
  if (options.signal?.aborted || isAbortLikeError(options.error)) {
    return markHRCResultNonCacheable(result);
  }
  return result;
}

export function isHRCResultCacheable(result: object): boolean {
  return !nonCacheableHrcResults.has(result);
}

export async function runCachedHrcEvaluation<T extends object>(
  options: RunCachedHrcEvaluationOptions<T>
): Promise<T> {
  const cached = options.cache.get(options.cacheKey);
  if (cached) {
    return cached;
  }

  try {
    const result = await options.evaluate();
    if (isHRCResultCacheable(result)) {
      options.cache.set(options.cacheKey, result);
    }
    return result;
  } catch {
    return options.fallback;
  }
}
