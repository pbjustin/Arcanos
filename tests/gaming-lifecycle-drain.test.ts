import { describe, expect, it } from '@jest/globals';
import { createGamingLifecycleDrain } from './testUtils/gamingLifecycleDrain.js';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(complete => { resolve = complete; });
  return { promise, resolve };
}

describe('whole Gaming test-scenario cleanup', () => {
  it('starts at invocation and forwards parameterized scenario arguments and results', async () => {
    const lifecycle = createGamingLifecycleDrain();
    const events: string[] = [];
    const scenario = lifecycle.track(async (number: number, label: string) => {
      events.push(label); return number + 1;
    });
    expect(events).toEqual([]);
    const operation = scenario(2, 'parameterized');
    expect(events).toEqual([]);
    expect(await operation).toBe(3);
    await lifecycle.drain();
    expect(events).toEqual(['parameterized']);
  });

  it('waits for the whole continuation after a worker completes before allowing fixture reset', async () => {
    const lifecycle = createGamingLifecycleDrain();
    const worker = deferred(); const continuation = deferred(); const enteredTail = deferred();
    const events: string[] = [];
    const operation = lifecycle.track(async () => {
      await worker.promise; events.push('worker completed'); enteredTail.resolve();
      await continuation.promise; events.push('whole scenario completed');
    })();
    const reset = lifecycle.drain().then(() => { events.push('fixture reset'); });
    worker.resolve(); await enteredTail.promise; await Promise.resolve();
    expect(events).toEqual(['worker completed']);
    continuation.resolve(); await operation; await reset;
    expect(events).toEqual(['worker completed', 'whole scenario completed', 'fixture reset']);
  });

  it('preserves the original rejection while allowing cleanup and the next scenario to finish', async () => {
    const lifecycle = createGamingLifecycleDrain();
    const release = deferred();
    const original = new Error('synthetic scenario failure');
    const operation = lifecycle.track(async () => { await release.promise; throw original; })();
    const rejected = expect(operation).rejects.toBe(original);
    const cleanup = lifecycle.drain();
    release.resolve(); await rejected; await cleanup;
    expect(await lifecycle.track(async () => 'next scenario')()).toBe('next scenario');
    await lifecycle.drain();
  });
});
