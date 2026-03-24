import { MAX_BODY_SERIALIZATION_BYTES } from './constants.js';
import { resolveHeader } from '@transport/http/requestHeaders.js';

export function normalizePath(path: string): string {
  const trimmed = path.trim();
  if (!trimmed) {
    return '/';
  }
  return trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
}
export function cloneJsonSafe<T>(value: T): T {
  try {
    const serialized = JSON.stringify(value);
    if (serialized && serialized.length > MAX_BODY_SERIALIZATION_BYTES) {
      try {
        return structuredClone(value);
      } catch {
        return value;
      }
    }
    return JSON.parse(serialized) as T;
  } catch {
    try {
      return structuredClone(value);
    } catch {
      return value;
    }
  }
}
export function resolveExpectedBaselineMonotonicTs(
  headers: Record<string, string | string[] | undefined>,
  clientMemoryVersion?: string
): number | undefined {
  const baselineHeader = resolveHeader(headers, 'x-memory-baseline-ts');
  if (baselineHeader) {
    const parsed = Number(baselineHeader);
    if (Number.isFinite(parsed) && parsed >= 0) {
      return Math.floor(parsed);
    }
  }

  if (clientMemoryVersion) {
    const parsedVersionTime = Date.parse(clientMemoryVersion);
    if (!Number.isNaN(parsedVersionTime)) {
      return parsedVersionTime;
    }
  }

  return undefined;
}
export async function withTimeout<T>(
  timeoutMs: number,
  operation: () => Promise<T>
): Promise<{ timedOut: false; value: T } | { timedOut: true }> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return { timedOut: false, value: await operation() };
  }

  let timeoutHandle: NodeJS.Timeout | undefined;
  try {
    const timeoutPromise = new Promise<{ timedOut: true }>((resolve) => {
      timeoutHandle = setTimeout(() => resolve({ timedOut: true }), timeoutMs);
    });
    const operationPromise = operation().then((value) => ({ timedOut: false as const, value }));
    const result = await Promise.race([operationPromise, timeoutPromise]);
    return result;
  } finally {
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
    }
  }
}
export function isObjectBody(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
