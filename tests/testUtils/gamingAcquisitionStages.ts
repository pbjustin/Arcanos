import type { Mock } from 'jest-mock';
import { createGamingLifecycleDrain } from './gamingLifecycleDrain.js';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(complete => { resolve = complete; });
  return { promise, resolve };
}

function sourceIdentity(value: string): string {
  const url = new URL(value);
  url.hash = '';
  return url.href;
}

/** The protected transport connects to an IP while preserving the source Host. */
function requestIdentity(args: unknown[]): string {
  const url = new URL(String(args[0]));
  const options = args[1] as { headers?: Record<string, unknown> } | undefined;
  const host = options?.headers?.Host ?? options?.headers?.host;
  if (typeof host === 'string') return new URL(`${url.protocol}//${host}${url.pathname}${url.search}`).href;
  url.hash = '';
  return url.href;
}

/** Stage one original acquisition operation without replacing its real evaluator.
 * Each advance releases one response and waits until that document has finished
 * processing: the next source reaches its response gate, or the operation ends.
 * Dispose before resetting HTTP mocks, timers, environment or source fixtures. */
export function createGamingAcquisitionStages(http: Mock) {
  const original = http.getMockImplementation();
  if (!original) throw new Error('Configure the HTTP fixture before staging acquisition.');
  const lifecycle = createGamingLifecycleDrain();
  type Active = {
    identities: string[];
    entered: ReturnType<typeof deferred>[];
    release: ReturnType<typeof deferred>[];
    controller: AbortController;
    requested: number;
    responded: number;
  };
  let active: Active | undefined;
  let disposed: Promise<void> | undefined;
  const wrapped = async (...args: unknown[]) => {
    const batch = active;
    if (batch) {
      batch.controller.signal.throwIfAborted();
      const index = batch.requested;
      if (batch.responded !== index || requestIdentity(args) !== batch.identities[index]) {
        throw new Error('Acquisition must request each staged source once in its original order.');
      }
      batch.requested += 1;
      batch.entered[index].resolve();
      await batch.release[index].promise;
      batch.controller.signal.throwIfAborted();
      try { return await original(...args); }
      finally { batch.responded += 1; }
    }
    return original(...args);
  };
  http.mockImplementation(wrapped);

  return {
    get signal(): AbortSignal | undefined { return active?.controller.signal; },
    begin<Result>(urls: readonly string[], operation: (signal: AbortSignal) => Promise<Result>) {
      if (disposed) throw new Error('Acquisition stages have been disposed.');
      if (active) throw new Error('Finish the current acquisition batch before starting another.');
      const identities = urls.map(sourceIdentity);
      if (!identities.length || identities.length > 3 || new Set(identities).size !== identities.length) {
        throw new Error('An acquisition batch needs one to three distinct source URLs.');
      }
      const batch: Active = { identities, entered: identities.map(deferred), release: identities.map(deferred),
        controller: new AbortController(), requested: 0, responded: 0 };
      active = batch;
      const result = lifecycle.track(() => operation(batch.controller.signal))();
      // Both outcomes settle even when Jest abandons a timed-out setup hook.
      const settled = result.then(value => ({ ok: true as const, value }), error => ({ ok: false as const, error }));
      let stage = 0;
      let advancing = false;
      return {
        result,
        async advance(): Promise<Result | undefined> {
          if (advancing || stage >= identities.length) throw new Error('Advance acquisition stages sequentially, once per source.');
          advancing = true;
          const index = stage++;
          batch.release[index].resolve();
          try {
            if (index + 1 < identities.length) {
              const progress = await Promise.race([
                batch.entered[index + 1].promise.then(() => ({ next: true as const })),
                settled.then(outcome => ({ next: false as const, outcome }))
              ]);
              if (progress.next) return undefined;
              if (!progress.outcome.ok) throw progress.outcome.error;
              throw new Error('Acquisition ended before every staged source was requested.');
            }
            const value = await result;
            if (batch.requested !== identities.length) throw new Error('Acquisition ended before every staged source was requested.');
            if (active === batch) active = undefined;
            return value;
          } finally { advancing = false; }
        }
      };
    },
    dispose(): Promise<void> {
      disposed ??= (async () => {
        const batch = active;
        if (batch) {
          batch.controller.abort(Object.assign(new Error('The acquisition fixture is closing.'), { name: 'AbortError' }));
          for (const gate of batch.release) gate.resolve();
        }
        await lifecycle.drain();
        active = undefined;
        if (http.getMockImplementation() === wrapped) http.mockImplementation(original);
      })();
      return disposed;
    }
  };
}
