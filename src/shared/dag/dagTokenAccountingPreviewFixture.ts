import { redactSensitive } from '@arcanos/runtime/redaction';
import {
  createAttemptTokenUsage,
  normalizeAttemptTokenUsage,
  readAttemptTokenUsage,
  readDagChildTokenUsage,
  recordAttemptTokenUsage,
  runWithAttemptTokenUsage,
} from '@services/openai/attemptTokenUsage.js';
import { runWithDagChildAccounting } from '@workers/dagChildAccounting.js';

export const DAG_TOKEN_ACCOUNTING_PREVIEW_VERSION = 'dag-token-accounting/v1';
const FAILURE = 'DAG_TOKEN_ACCOUNTING_PREVIEW_FIXTURE_FAILED';
const CHILD_INPUT = Object.freeze({
  requestPath: '/gpt-access/jobs/create',
  body: Object.freeze({
    payload: Object.freeze({
      input: Object.freeze({ pipeline: 'trinity', dagId: 'sealed-dag', nodeId: 'sealed-node' }),
    }),
  }),
});

function requireProof(condition: unknown): asserts condition {
  if (!condition) throw new Error(FAILURE);
}

function roundTrip<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function publicOutput(totalTokens: number) {
  return {
    ok: true,
    result: {
      answer: 'Sealed accounting fixture.',
      meta: { tokens: { total_tokens: totalTokens } },
      guardInfo: { sessionTokensUsed: 4_000 },
    },
  };
}

async function caughtFailure(callback: () => Promise<unknown>): Promise<Error> {
  try {
    await callback();
  } catch (error: unknown) {
    requireProof(error instanceof Error);
    return error;
  }
  throw new Error(FAILURE);
}

function requireInvalidUsage(error: Error): void {
  const details = error as Error & { code?: unknown; retryable?: unknown };
  requireProof(error.message === 'Invalid provider token usage for execution attempt.');
  requireProof(details.code === 'INVALID_PROVIDER_TOKEN_USAGE');
  requireProof(details.retryable === false);
}

/**
 * Execute the production attempt collector and child-envelope wrapper with fixed
 * observations. No SDK, provider, database, worker loop, or scheduler is started.
 * The served marker proves this component contract; real worker/retry/budget and
 * PostgreSQL behavior are verified separately by dag-accounting-e2e.test.ts.
 */
export async function assertDagTokenAccountingPreviewFixture(): Promise<void> {
  const parent = createAttemptTokenUsage();
  await runWithAttemptTokenUsage(parent, async () => {
    const child = await runWithDagChildAccounting(CHILD_INPUT, async () => {
      recordAttemptTokenUsage({ input_tokens: 8, output_tokens: 3, total_tokens: 11 });
      recordAttemptTokenUsage({ input_tokens: 80, output_tokens: 9, total_tokens: 89 });
      recordAttemptTokenUsage({ input_tokens: 5, output_tokens: 2, total_tokens: 7 });
      return { status: 'completed' as const, output: publicOutput(7) };
    });
    // A child's separate attempt scope cannot charge its awaiting parent directly.
    requireProof(parent.totalTokens === undefined);
    const persisted = roundTrip(child);
    requireProof(persisted.status === 'completed');
    requireProof(persisted.output.result.meta.tokens.total_tokens === 7);
    requireProof(readDagChildTokenUsage(persisted.output) === 107);
    const redacted = redactSensitive(persisted.output) as {
      result: { meta: { tokens: unknown } };
    };
    requireProof(redacted.result.meta.tokens === '[REDACTED]');
    requireProof(readDagChildTokenUsage(roundTrip(redacted)) === 107);
    recordAttemptTokenUsage({ total_tokens: readDagChildTokenUsage(redacted) });
  });
  requireProof(parent.totalTokens === 107 && parent.closed === true);

  const failed = await runWithDagChildAccounting(CHILD_INPUT, async () => {
    recordAttemptTokenUsage({ total_tokens: 27 });
    return {
      status: 'failed' as const, retryable: true,
      output: { ok: false, error: { message: 'Sealed retryable child failure.' } },
    };
  });
  requireProof(failed.status === 'failed' && (failed as { retryable?: boolean }).retryable === false);
  requireProof((failed.output as { retryable?: unknown }).retryable === true);
  requireProof(readDagChildTokenUsage(roundTrip(failed.output)) === 27);
  const retry = await runWithDagChildAccounting(CHILD_INPUT, async () => {
    recordAttemptTokenUsage({ total_tokens: 43 });
    return { status: 'completed' as const, output: publicOutput(3) };
  });
  requireProof(readDagChildTokenUsage(roundTrip(retry.output)) === 43);

  const cancelled = await runWithDagChildAccounting(CHILD_INPUT, async () => {
    recordAttemptTokenUsage({ total_tokens: 39 });
    return { status: 'cancelled' as const, retryable: false, output: { result: null } };
  });
  requireProof(cancelled.status === 'cancelled' && cancelled.retryable === false);
  requireProof(readDagChildTokenUsage(roundTrip(cancelled.output)) === 39);

  const originalFailure = new Error('Sealed failure after consumed provider work.');
  const consumedFailure = await caughtFailure(() => runWithDagChildAccounting(CHILD_INPUT, async () => {
    recordAttemptTokenUsage({ total_tokens: 19 });
    recordAttemptTokenUsage({ prompt_tokens: 20, completion_tokens: 11 });
    throw originalFailure;
  }));
  requireProof(consumedFailure === originalFailure);
  requireProof(readAttemptTokenUsage(consumedFailure) === 50);

  const unknown = createAttemptTokenUsage();
  await runWithAttemptTokenUsage(unknown, async () => {
    for (const usage of [undefined, null, {}, { input_tokens: 11 }, { completion_tokens: 7 }]) {
      recordAttemptTokenUsage(usage);
    }
  });
  requireProof(unknown.totalTokens === undefined && unknown.closed === true);
  requireProof(!Object.hasOwn(roundTrip(unknown), 'totalTokens'));
  requireProof(normalizeAttemptTokenUsage(undefined) === undefined);
  const zero = await runWithDagChildAccounting(CHILD_INPUT, async () => {
    recordAttemptTokenUsage({ total_tokens: 0 });
    return { status: 'completed' as const, output: publicOutput(7) };
  });
  requireProof(readDagChildTokenUsage(roundTrip(zero.output)) === 0);

  for (const invalidTotal of [-1, 1.5, '7', Number.MAX_SAFE_INTEGER + 1]) {
    const invalidFirst = await caughtFailure(() => runWithDagChildAccounting(CHILD_INPUT, async () => {
      recordAttemptTokenUsage({ total_tokens: invalidTotal });
      return { status: 'completed' as const, output: publicOutput(7) };
    }));
    requireInvalidUsage(invalidFirst);
    requireProof(readAttemptTokenUsage(invalidFirst) === undefined);
  }

  const stickyFailure = await caughtFailure(() => runWithDagChildAccounting(CHILD_INPUT, async () => {
    recordAttemptTokenUsage({ total_tokens: 11 });
    try {
      recordAttemptTokenUsage({ total_tokens: -1 });
    } catch {
      // A provider fallback must not hide the collector's invalid-accounting state.
    }
    throw new Error('A later sealed fallback also failed.');
  }));
  requireInvalidUsage(stickyFailure);
  requireProof(readAttemptTokenUsage(stickyFailure) === 11);

  const overflow = await caughtFailure(() => runWithDagChildAccounting(CHILD_INPUT, async () => {
    recordAttemptTokenUsage({ total_tokens: Number.MAX_SAFE_INTEGER });
    recordAttemptTokenUsage({ total_tokens: 1 });
    return { status: 'completed' as const, output: publicOutput(1) };
  }));
  requireInvalidUsage(overflow);
  requireProof(readAttemptTokenUsage(overflow) === Number.MAX_SAFE_INTEGER);

  const firstConcurrent = createAttemptTokenUsage();
  const secondConcurrent = createAttemptTokenUsage();
  await Promise.all([
    runWithAttemptTokenUsage(firstConcurrent, async () => {
      recordAttemptTokenUsage({ total_tokens: 11 });
      await Promise.resolve();
      recordAttemptTokenUsage({ total_tokens: 7 });
    }),
    runWithAttemptTokenUsage(secondConcurrent, async () => {
      recordAttemptTokenUsage({ input_tokens: 80, output_tokens: 9 });
      await Promise.resolve();
      recordAttemptTokenUsage({ total_tokens: 0 });
    }),
  ]);
  requireProof(firstConcurrent.totalTokens === 18 && secondConcurrent.totalTokens === 89);
  requireProof(firstConcurrent.closed === true && secondConcurrent.closed === true);

  const closed = createAttemptTokenUsage();
  let releaseLate: () => void = () => { throw new Error(FAILURE); };
  const release = new Promise<void>(resolve => { releaseLate = resolve; });
  let lateObservation = Promise.resolve();
  await runWithAttemptTokenUsage(closed, async () => {
    recordAttemptTokenUsage({ total_tokens: 11 });
    lateObservation = release.then(() => recordAttemptTokenUsage({ total_tokens: 31 }));
  });
  const next = createAttemptTokenUsage();
  await runWithAttemptTokenUsage(next, async () => {
    recordAttemptTokenUsage({ total_tokens: 7 });
    releaseLate();
    await lateObservation;
  });
  requireProof(closed.closed === true && closed.totalTokens === 11);
  requireProof(next.closed === true && next.totalTokens === 7);
}
