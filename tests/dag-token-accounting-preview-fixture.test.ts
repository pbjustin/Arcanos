import { afterEach, describe, expect, it, jest } from '@jest/globals';
import * as productionUsage from '../src/services/openai/attemptTokenUsage.js';
import { runWithDagChildAccounting } from '../src/workers/dagChildAccounting.js';

const recordUsage = jest.fn(productionUsage.recordAttemptTokenUsage);
const readChildUsage = jest.fn(productionUsage.readDagChildTokenUsage);
const childAccounting = jest.fn(runWithDagChildAccounting);
jest.unstable_mockModule('../src/services/openai/attemptTokenUsage.js', () => ({
  ...productionUsage, recordAttemptTokenUsage: recordUsage, readDagChildTokenUsage: readChildUsage,
}));
jest.unstable_mockModule('../src/workers/dagChildAccounting.js', () => ({
  runWithDagChildAccounting: childAccounting,
}));
const { assertDagTokenAccountingPreviewFixture, DAG_TOKEN_ACCOUNTING_PREVIEW_VERSION } =
  await import('../src/shared/dag/dagTokenAccountingPreviewFixture.js');

afterEach(() => {
  recordUsage.mockImplementation(productionUsage.recordAttemptTokenUsage);
  readChildUsage.mockImplementation(productionUsage.readDagChildTokenUsage);
  childAccounting.mockImplementation(runWithDagChildAccounting);
});

describe('sealed DAG token accounting component fixture', () => {
  it('executes real collector and child-envelope invariants without external effects', async () => {
    const fetch = jest.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Fixture must not invoke transport.'));
    try {
      await expect(assertDagTokenAccountingPreviewFixture()).resolves.toBeUndefined();
      expect(DAG_TOKEN_ACCOUNTING_PREVIEW_VERSION).toBe('dag-token-accounting/v1');
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      fetch.mockRestore();
    }
  });

  it('keeps overlapping fixture requests isolated', async () => {
    await expect(Promise.all([
      assertDagTokenAccountingPreviewFixture(), assertDagTokenAccountingPreviewFixture(),
    ])).resolves.toEqual([undefined, undefined]);
  });

  it('fails when an intermediate provider observation is dropped', async () => {
    recordUsage.mockImplementation(usage => {
      if (usage && typeof usage === 'object' && Reflect.get(usage, 'total_tokens') === 89) return;
      productionUsage.recordAttemptTokenUsage(usage);
    });
    await expect(assertDagTokenAccountingPreviewFixture()).rejects.toThrow('DAG_TOKEN_ACCOUNTING_PREVIEW_FIXTURE_FAILED');
  });

  it('fails when child transport falls back to final-stage public usage', async () => {
    readChildUsage.mockImplementation(value => {
      const observed = productionUsage.readDagChildTokenUsage(value);
      return observed === 107 ? 7 : observed;
    });
    await expect(assertDagTokenAccountingPreviewFixture()).rejects.toThrow('DAG_TOKEN_ACCOUNTING_PREVIEW_FIXTURE_FAILED');
  });

  it('fails when cancellation loses its observed consumption', async () => {
    childAccounting.mockImplementation(async (input, callback) => {
      const outcome = await runWithDagChildAccounting(input, callback);
      if (outcome.status !== 'cancelled') return outcome;
      const output = { ...outcome.output as Record<string, unknown> };
      delete output.dagAttemptUsage;
      return { ...outcome, output };
    });
    await expect(assertDagTokenAccountingPreviewFixture()).rejects.toThrow('DAG_TOKEN_ACCOUNTING_PREVIEW_FIXTURE_FAILED');
  });

  it('fails when an explicit observed zero becomes unknown', async () => {
    recordUsage.mockImplementation(usage => {
      if (usage && typeof usage === 'object' && Reflect.get(usage, 'total_tokens') === 0) return;
      productionUsage.recordAttemptTokenUsage(usage);
    });
    await expect(assertDagTokenAccountingPreviewFixture()).rejects.toThrow('DAG_TOKEN_ACCOUNTING_PREVIEW_FIXTURE_FAILED');
  });

  it('fails when malformed provider accounting is silently accepted', async () => {
    recordUsage.mockImplementation(usage => {
      if (usage && typeof usage === 'object' && Reflect.get(usage, 'total_tokens') === -1) return;
      productionUsage.recordAttemptTokenUsage(usage);
    });
    await expect(assertDagTokenAccountingPreviewFixture()).rejects.toThrow('DAG_TOKEN_ACCOUNTING_PREVIEW_FIXTURE_FAILED');
  });
});
