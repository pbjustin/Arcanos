import {
  createAttemptTokenUsage,
  runWithAttemptTokenUsage,
} from '@services/openai/attemptTokenUsage.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Identify the existing queued GPT envelope emitted by the DAG prompt bridge. */
export function isDagChildJobInput(input: unknown): boolean {
  if (!isRecord(input) || input.requestPath !== '/gpt-access/jobs/create') return false;
  const body = input.body;
  if (!isRecord(body) || !isRecord(body.payload) || !isRecord(body.payload.input)) return false;
  const metadata = body.payload.input;
  return metadata.pipeline === 'trinity'
    && typeof metadata.dagId === 'string' && metadata.dagId.length > 0
    && typeof metadata.nodeId === 'string' && metadata.nodeId.length > 0;
}

interface DagChildOutcome {
  status: 'completed' | 'failed' | 'cancelled';
  output: unknown;
  retryable?: boolean;
}

/**
 * Transport provider usage across the asynchronous DAG child-job boundary.
 * The child's route envelope stays intact; only a known attempt total is added.
 * A consumed failure must become terminal so the parent can charge it before retrying.
 */
export async function runWithDagChildAccounting<T extends DagChildOutcome>(
  rawInput: unknown,
  callback: () => Promise<T>,
): Promise<T> {
  if (!isDagChildJobInput(rawInput)) return callback();
  const usage = createAttemptTokenUsage();
  try {
    const outcome = await runWithAttemptTokenUsage(usage, callback);
    if (usage.totalTokens === undefined) return outcome;
    return {
      ...outcome,
      ...(outcome.status === 'failed' ? { retryable: false } : {}),
      output: {
        ...(isRecord(outcome.output) ? outcome.output : { result: outcome.output }),
        ...(outcome.status === 'failed' && outcome.retryable !== undefined
          ? { retryable: outcome.retryable }
          : {}),
        dagAttemptUsage: usage.totalTokens,
      },
    };
  } catch (error: unknown) {
    if (usage.totalTokens !== undefined) {
      const failure = error instanceof Error ? error : new Error(String(error));
      Object.assign(failure, { attemptTokenUsage: usage.totalTokens });
      throw failure;
    }
    throw error;
  }
}
