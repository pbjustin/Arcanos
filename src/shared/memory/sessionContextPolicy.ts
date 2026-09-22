import { isRecord } from '@shared/typeGuards.js';

const SESSION_CONTEXT_QUERY_MODULES = new Set([
  'ARCANOS:CORE',
  'ARCANOS:AUDIT',
  'ARCANOS:GUIDE',
  'ARCANOS:WRITE',
  'ARCANOS:TUTOR',
  'ARCANOS:GAMING',
]);

/** Only reviewed prompt-driven actions may consume prior conversation context. */
export function isSessionContextQueryAction(moduleName: string, action?: string | null): boolean {
  return (action === 'query' && SESSION_CONTEXT_QUERY_MODULES.has(moduleName))
    || (moduleName === 'ARCANOS:SIM' && action === 'run');
}

/** A structured session identifier selects scope; it never grants memory access. */
export function resolveExplicitSessionContextId(body: unknown, payload?: unknown): string | undefined {
  const nestedPayload = payload ?? (isRecord(body) ? body.payload : undefined);
  for (const candidate of [body, nestedPayload]) {
    if (isRecord(candidate) && typeof candidate.sessionId === 'string' && candidate.sessionId.trim()) {
      return candidate.sessionId.trim();
    }
  }
  return undefined;
}
