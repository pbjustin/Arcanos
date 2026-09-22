import { describe, expect, it } from '@jest/globals';
import { instrumentOpenAIOperation } from '../src/core/adapters/openai.adapter.js';
import {
  createAttemptTokenUsage,
  readDagChildTokenUsage,
  recordAttemptTokenUsage,
  runWithAttemptTokenUsage
} from '../src/services/openai/attemptTokenUsage.js';
import { isDagChildJobInput, runWithDagChildAccounting } from '../src/workers/dagChildAccounting.js';

function childInput() {
  return {
    requestPath: '/gpt-access/jobs/create',
    body: {
      payload: {
        input: {
          pipeline: 'trinity',
          dagId: 'synthetic-accounting-dag',
          nodeId: 'synthetic-accounting-node',
          attempt: 0
        }
      }
    }
  };
}

async function observeProviderUsage(usage: unknown): Promise<void> {
  await instrumentOpenAIOperation({
    operation: 'responses_create',
    model: 'synthetic-child-accounting',
    callback: async () => ({ usage })
  });
}

async function consume(totalTokens: number): Promise<void> {
  await observeProviderUsage({ total_tokens: totalTokens });
}

describe('DAG child accounting through real provider instrumentation', () => {
  it('recognizes the existing DAG child envelope', () => {
    expect(isDagChildJobInput(childInput())).toBe(true);
  });

  it.each([
    null,
    {},
    { requestPath: '/gpt/other', body: childInput().body },
    { requestPath: '/gpt-access/jobs/create', body: {} },
    { requestPath: '/gpt-access/jobs/create', body: { payload: { input: {} } } },
    { requestPath: '/gpt-access/jobs/create', body: { payload: { input: { pipeline: 'other', dagId: 'dag', nodeId: 'node' } } } },
    { requestPath: '/gpt-access/jobs/create', body: { payload: { input: { pipeline: 'trinity', dagId: '', nodeId: 'node' } } } },
    { requestPath: '/gpt-access/jobs/create', body: { payload: { input: { pipeline: 'trinity', dagId: 'dag', nodeId: '' } } } }
  ])('does not identify unrelated or incomplete queue input as a DAG child: %j', input => {
    expect(isDagChildJobInput(input)).toBe(false);
  });

  it('adds aggregate 107 to the child envelope while preserving public final usage 7', async () => {
    const publicResult = { result: 'Synthetic answer.', meta: { tokens: { total_tokens: 7 } } };
    const original = { status: 'completed' as const, output: { ok: true, result: publicResult } };
    const outcome = await runWithDagChildAccounting(childInput(), async () => {
      await consume(11);
      await consume(89);
      await consume(7);
      return original;
    });

    expect(outcome).toEqual({
      status: 'completed',
      output: { ok: true, dagAttemptUsage: 107, result: publicResult }
    });
    expect(original.output).not.toHaveProperty('dagAttemptUsage');
    expect(outcome.output.result).toBe(publicResult);
    expect(outcome.output.result.meta.tokens.total_tokens).toBe(7);
  });

  it('makes a consumed child failure terminal while retaining its retry hint for the parent', async () => {
    const outcome = await runWithDagChildAccounting(childInput(), async () => {
      await consume(39);
      return {
        status: 'failed' as const,
        retryable: true,
        output: { ok: false, error: { message: 'Synthetic consumed failure.' } }
      };
    });

    expect(outcome).toEqual({
      status: 'failed',
      retryable: false,
      output: {
        ok: false,
        error: { message: 'Synthetic consumed failure.' },
        retryable: true,
        dagAttemptUsage: 39
      }
    });
  });

  it.each(['Error', 'AbortError'])('attaches known usage to thrown %s without changing error identity', async name => {
    const original = new Error('Synthetic error after consumed provider response.');
    original.name = name;
    const operation = runWithDagChildAccounting(childInput(), async () => {
      await consume(29);
      throw original;
    });

    await expect(operation).rejects.toBe(original);
    expect(original).toMatchObject({ name, attemptTokenUsage: 29 });
  });

  it('preserves a cancelled terminal outcome and its known consumption', async () => {
    const outcome = await runWithDagChildAccounting(childInput(), async () => {
      await consume(13);
      return { status: 'cancelled' as const, output: null };
    });

    expect(outcome).toEqual({ status: 'cancelled', output: { result: null, dagAttemptUsage: 13 } });
  });

  it('keeps a child failure without known provider usage unchanged', async () => {
    const original = { status: 'failed' as const, retryable: true, output: { error: 'Before provider work.' } };
    const outcome = await runWithDagChildAccounting(childInput(), async () => original);

    expect(outcome).toBe(original);
    expect(outcome.retryable).toBe(true);
    expect(outcome.output).not.toHaveProperty('dagAttemptUsage');
  });

  it('leaves a thrown failure with unknown usage unchanged', async () => {
    const original = new Error('Before provider work.');
    await expect(runWithDagChildAccounting(childInput(), async () => { throw original; })).rejects.toBe(original);
    expect(original).not.toHaveProperty('attemptTokenUsage');
  });

  it('preserves explicit provider zero as known usage', async () => {
    const outcome = await runWithDagChildAccounting(childInput(), async () => {
      await consume(0);
      return { status: 'completed' as const, output: { ok: true, result: 'Zero-token result.' } };
    });

    expect(outcome.output).toHaveProperty('dagAttemptUsage', 0);
  });

  it('leaves generic GPT queue outcomes unchanged even when provider usage is known', async () => {
    const original = { status: 'completed' as const, output: { ok: true, result: 'Generic GPT result.' } };
    const outcome = await runWithDagChildAccounting({
      requestPath: '/gpt-access/jobs/create',
      body: { payload: { input: { task: 'Generic request without DAG metadata.' } } }
    }, async () => {
      await consume(53);
      return original;
    });

    expect(outcome).toBe(original);
    expect(outcome.output).not.toHaveProperty('dagAttemptUsage');
  });

  it('isolates parallel child scopes and charges the parent only after explicit transport import', async () => {
    const parent = createAttemptTokenUsage();
    const childTotals = await runWithAttemptTokenUsage(parent, async () => {
      await consume(5);
      const results = await Promise.all([17, 23].map(tokens => runWithDagChildAccounting(childInput(), async () => {
        await consume(tokens);
        return { status: 'completed' as const, output: { ok: true, result: 'Child result.' } };
      })));
      expect(parent.totalTokens).toBe(5);
      const totals = results.map(result => readDagChildTokenUsage(result.output));
      for (const total of totals) {
        recordAttemptTokenUsage({ total_tokens: total });
      }
      return totals;
    });

    expect(childTotals).toEqual([17, 23]);
    expect(parent.totalTokens).toBe(45);
  });

  it('does not let a caught malformed usage response erase earlier known child consumption', async () => {
    const operation = runWithDagChildAccounting(childInput(), async () => {
      await consume(13);
      try {
        await observeProviderUsage({ total_tokens: -1 });
      } catch {
        // Simulate an existing provider fallback catching its operation error.
      }
      return { status: 'completed' as const, output: { ok: true, result: 'Fallback result.' } };
    });

    await expect(operation).rejects.toMatchObject({
      code: 'INVALID_PROVIDER_TOKEN_USAGE',
      retryable: false,
      attemptTokenUsage: 13
    });
  });
});
