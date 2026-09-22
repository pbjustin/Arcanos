import { readRuntimeEnv } from '@platform/runtime/env.js';
import {
  buildSessionContextFromStoredTurns,
  createEmptySessionContextResult,
  type SessionContextHydrationResult,
} from '@shared/memory/sessionContextCore.js';

export type { SessionContextHydrationResult, SessionContextTurn } from '@shared/memory/sessionContextCore.js';

export interface SessionContextHydrationInput {
  sessionId: string;
  moduleName: string;
  route?: string | null;
  action?: string | null;
  requestId?: string;
}

const SESSION_CONTEXT_LOAD_TIMEOUT_MS = 1_000;
const LOAD_TIMEOUT = Symbol('session-context-load-timeout');

function readBoundedLimit(name: string, fallback: number, maximum: number): number {
  const rawValue = readRuntimeEnv(name)?.trim();
  if (!rawValue || !/^\d+$/u.test(rawValue)) return fallback;
  const value = Number(rawValue);
  return Number.isSafeInteger(value) && value > 0 && value <= maximum ? value : fallback;
}

/** Read only conversations_core; authorization belongs to the dispatch boundary. */
export async function hydrateSessionContext(input: SessionContextHydrationInput): Promise<SessionContextHydrationResult> {
  const sessionId = input.sessionId.trim();
  if (!sessionId) return createEmptySessionContextResult(sessionId, 'missing_session_id');
  const maxTurns = readBoundedLimit('SESSION_CONTEXT_MAX_TURNS', 12, 100);
  const maxChars = readBoundedLimit('SESSION_CONTEXT_MAX_CHARS', 8_000, 64_000);
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    // A slow storage read must not consume the entire module execution deadline.
    // The read has no writes; Promise.race also observes any eventual rejection.
    const loaded: unknown = await Promise.race([
      import('@services/sessionMemoryService.js').then(({ getChannel }) => getChannel(sessionId, 'conversations_core')),
      new Promise<typeof LOAD_TIMEOUT>(resolve => {
        timeout = setTimeout(() => resolve(LOAD_TIMEOUT), SESSION_CONTEXT_LOAD_TIMEOUT_MS);
      }),
    ]);
    if (loaded === LOAD_TIMEOUT) return createEmptySessionContextResult(sessionId, 'load_timeout');
    return buildSessionContextFromStoredTurns(sessionId, loaded, { maxTurns, maxChars });
  } catch {
    return createEmptySessionContextResult(sessionId, 'load_failed');
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}
