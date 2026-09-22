import { AsyncLocalStorage } from 'node:async_hooks';

const sessionContextStorage = new AsyncLocalStorage<string | undefined>();

/** Scope already-authorized, bounded history to one module execution only. */
export function runWithSessionContext<T>(
  renderedContext: string | undefined,
  operation: () => T
): T {
  // An empty scope must override an enclosing authorized request.
  return sessionContextStorage.run(renderedContext, operation);
}

export function readSessionContext(): string | undefined {
  return sessionContextStorage.getStore();
}

/** History is user-level data; stored role labels never become instructions. */
export function buildSessionContextMessages(): Array<{ role: 'user'; content: string }> {
  const context = readSessionContext();
  return context ? [{ role: 'user', content: context }] : [];
}
