import { jest } from '@jest/globals';
import type { JobData } from '../src/core/db/schema.js';
import {
  BackstageBookerAsyncResultUnavailableError,
  readBackstageBookerAsyncResultCore,
} from '../src/shared/backstage/backstageBookerAsyncResultCore.js';
import { buildProtectedBackstageFailureEnvelope } from '../src/shared/backstage/backstageProtectedFailure.js';
import { protectBackstageQueuedGptJobOutput } from '../src/shared/backstage/backstageQueuedJobResultProtection.js';
import { buildProtectedBackstageQueuedGptJobInput } from '../src/shared/gpt/asyncGptJob.js';
import { buildGptIdempotencyScopeHash } from '../src/shared/gpt/gptIdempotency.js';

describe('HRC creative output through protected async persistence and continuation', () => {
  const jobId = '11111111-1111-4111-8111-111111111111';
  const universeId = 'creative-fixture-universe';
  const actorKey = 'creative-fixture-owner';
  const action = 'generateBookingWithHRC' as const;
  const originalKey = process.env.ARCANOS_BACKSTAGE_BOOKER_JOB_PAYLOAD_KEY;
  const storyline = [
    'Kay “Spotlight” Morales: Let the champion’s confidence crack through the silence.',
    '## Backstage promo — non-canon proposal',
    '[CAMERA: Push in as the champion sets the title on the equipment case.]',
    '**Champion:** “You earned the challenge. That does not mean you earned my championship.”',
    '> “At Night of Champions, bring every trick you have. I will still be standing.”',
    '[PRODUCTION: Hold on the challenger’s image on the monitor, then fade to black.]',
  ].join('\n\n');
  const completedEnvelope = {
    ok: true,
    result: {
      universeId,
      storyline,
      hrc: { fidelity: 0.99, resilience: 0.98, verdict: 'Complete fictional promo consistent with the supplied continuity.' },
      protectedGeneration: {
        version: 1, protected: true, protectedGenerationCompleted: true,
        official: true, continuityVerified: true, authority: 'notion',
        snapshotStatus: 'current_complete', fallbackUsed: false, fallbackPermitted: false,
      },
    },
    _route: { gptId: 'backstage-booker', action, route: 'worker' },
  };

  beforeAll(() => {
    process.env.ARCANOS_BACKSTAGE_BOOKER_JOB_PAYLOAD_KEY = Buffer.alloc(32, 0x6b).toString('base64');
  });

  afterAll(() => {
    if (originalKey === undefined) {
      Reflect.deleteProperty(process.env, 'ARCANOS_BACKSTAGE_BOOKER_JOB_PAYLOAD_KEY');
    } else {
      process.env.ARCANOS_BACKSTAGE_BOOKER_JOB_PAYLOAD_KEY = originalKey;
    }
  });

  function persistedJob(status: JobData['status'], envelope: unknown): JobData {
    const input = buildProtectedBackstageQueuedGptJobInput({
      action, universeId, notionEnrichmentAuthorized: true,
      body: { action, payload: { universeId, prompt: 'Write a non-canon backstage promo with dialogue and production directions.' } },
    });
    return {
      id: jobId, job_type: 'gpt', status, input,
      output: protectBackstageQueuedGptJobOutput({ jobId, rawInput: input, output: envelope }),
      idempotency_scope_hash: buildGptIdempotencyScopeHash({ surface: 'public-gpt', actorKey }),
    } as JobData;
  }

  const readInput = { jobId, actorKey, waitForResultMs: 30_000, pollIntervalMs: 1 };

  it('preserves every dialogue and production byte through authenticated sealing and repeated terminal reads', async () => {
    const job = persistedJob('completed', completedEnvelope);
    const getJobByIdFn = jest.fn(async () => job);
    const waitForQueuedGptJobCompletionFn = jest.fn(async () => ({ state: 'completed', job }));
    const dependencies = { getJobByIdFn, waitForQueuedGptJobCompletionFn };

    for (let read = 0; read < 2; read += 1) {
      const projected = await readBackstageBookerAsyncResultCore(readInput, dependencies);
      expect(projected).toMatchObject({ jobId, status: 'completed', result: completedEnvelope });
      expect((projected.result as typeof completedEnvelope).result.storyline).toBe(storyline);
      expect(projected).not.toHaveProperty('stream');
    }
    expect(getJobByIdFn).toHaveBeenCalledTimes(2);
    expect(waitForQueuedGptJobCompletionFn).not.toHaveBeenCalled();
    expect(JSON.stringify(job.output)).not.toContain('You earned the challenge');
  });

  it('continues the accepted job through the waiter and returns its completed output without replacing it', async () => {
    const completed = persistedJob('completed', completedEnvelope);
    const pending = { ...completed, status: 'running', output: null } as JobData;
    let reads = 0;
    const getJobByIdFn = jest.fn(async (selectedJobId: string) => {
      expect(selectedJobId).toBe(jobId);
      return reads++ === 0 ? pending : completed;
    });
    const waitForQueuedGptJobCompletionFn = jest.fn(async (
      selectedJobId: string,
      _options?: unknown,
      dependencies?: { getJobByIdFn?: (id: string) => Promise<JobData | null> },
    ) => {
      expect(selectedJobId).toBe(jobId);
      expect(await dependencies!.getJobByIdFn!(jobId)).toBe(pending);
      expect(await dependencies!.getJobByIdFn!(jobId)).toBe(completed);
      return { state: 'completed', job: completed };
    });

    const projected = await readBackstageBookerAsyncResultCore(readInput, {
      getJobByIdFn, waitForQueuedGptJobCompletionFn,
    });
    expect(projected).toMatchObject({ jobId, status: 'completed', result: completedEnvelope });
    expect(waitForQueuedGptJobCompletionFn).toHaveBeenCalledTimes(1);
    expect(getJobByIdFn.mock.calls.every(([selectedJobId]) => selectedJobId === jobId)).toBe(true);
  });

  it.each(['BACKSTAGE_BOOKER_OUTPUT_INCOMPLETE', 'BACKSTAGE_BOOKER_INTEGRITY_FAILED'] as const)(
    'retains terminal %s classification without partial content or official completion on every poll', async code => {
      const job = persistedJob('failed', buildProtectedBackstageFailureEnvelope({ gptId: 'backstage-booker', action, code }));
      job.error_message = 'Private incomplete output must not leak through the public result.';
      const waitForQueuedGptJobCompletionFn = jest.fn(async () => ({ state: 'failed', job }));

      for (let read = 0; read < 2; read += 1) {
        const projected = await readBackstageBookerAsyncResultCore(readInput, {
          getJobByIdFn: async () => job, waitForQueuedGptJobCompletionFn,
        });
        expect(projected).toMatchObject({
          jobId, status: 'failed', result: null, error: { code },
          protectedGenerationCompleted: false, official: false, continuityVerified: false,
          authority: 'none', fallbackUsed: false, fallbackPermitted: false,
        });
        expect(JSON.stringify(projected)).not.toContain('Private incomplete output');
      }
      expect(waitForQueuedGptJobCompletionFn).not.toHaveBeenCalled();
    },
  );

  it('denies another owner before unsealing and rejects a result bound to another universe', async () => {
    const job = persistedJob('completed', completedEnvelope);
    const waitForQueuedGptJobCompletionFn = jest.fn(async () => ({ state: 'completed', job }));
    const dependencies = { getJobByIdFn: async () => job, waitForQueuedGptJobCompletionFn };
    await expect(readBackstageBookerAsyncResultCore({ ...readInput, actorKey: 'another-owner' }, dependencies))
      .resolves.toMatchObject({ status: 'not_found', result: null });

    (job.output as { universeId: string }).universeId = 'another-universe';
    await expect(readBackstageBookerAsyncResultCore(readInput, dependencies))
      .rejects.toBeInstanceOf(BackstageBookerAsyncResultUnavailableError);
    expect(waitForQueuedGptJobCompletionFn).not.toHaveBeenCalled();
  });
});
