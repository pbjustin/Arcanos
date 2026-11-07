/** Preserve a whole async scenario beyond Jest's timeout until fixture cleanup can finish. */
export function createGamingLifecycleDrain() {
  const pending = new Set<Promise<unknown>>();
  return {
    track<Args extends unknown[], Result>(scenario: (...args: Args) => Promise<Result>): (...args: Args) => Promise<Result> {
      return (...args: Args) => {
        // Register before the scenario starts, including synchronous failures.
        const operation = Promise.resolve().then(() => scenario(...args));
        pending.add(operation);
        // Handle both branches without creating an unhandled rejection; the
        // original promise still reaches Jest with its original result/error.
        operation.then(() => { pending.delete(operation); }, () => { pending.delete(operation); });
        return operation;
      };
    },
    async drain(): Promise<void> {
      while (pending.size) await Promise.allSettled([...pending]);
    }
  };
}
