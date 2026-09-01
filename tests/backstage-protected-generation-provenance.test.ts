import {
  getBackstageProtectedGenerationProvenance,
  recordBackstageProtectedGenerationAuthority,
  runWithBackstageNotionEnrichmentAuthorization,
  runWithBackstageProtectedQueuedExecution,
} from '../src/services/backstageNotionEnrichmentAuthorization.js';
import {
  buildBackstageBookerProtectedOverflowFailure,
  projectBackstageBookerManagedProtectedFailurePayload,
  resolveBackstageBookerProtectedPayloadRejection,
} from '../src/shared/backstage/backstageBookerAsyncContinuation.js';
import {
  buildProtectedBackstageFailureEnvelope,
  readProtectedBackstageFailureCode,
  readProtectedBackstageGenerationProvenance,
  resolveBackstageProtectedFailureCode,
} from '../src/shared/backstage/backstageProtectedFailure.js';
import {
  BackstageBookerAsyncResultUnavailableError,
  projectTrustedProtectedBackstageTerminalFailure,
  readBackstageBookerAsyncResultCore,
} from '../src/shared/backstage/backstageBookerAsyncResultCore.js';
import {
  protectBackstageQueuedGptJobOutput,
} from '../src/shared/backstage/backstageQueuedJobResultProtection.js';
import {
  buildProtectedBackstageQueuedGptJobInput,
} from '../src/shared/gpt/asyncGptJob.js';
import { buildGptIdempotencyScopeHash } from '../src/shared/gpt/gptIdempotency.js';
import { buildGptJobResultLookupPayload } from '../src/shared/gpt/gptJobResult.js';

describe('protected Backstage generation provenance', () => {
  const jobId = '11111111-1111-4111-8111-111111111111';

  const completedProvenance = {
    version: 1,
    protected: true,
    protectedGenerationCompleted: true,
    official: true,
    continuityVerified: true,
    authority: 'notion',
    snapshotStatus: 'current_complete',
    fallbackUsed: false,
    fallbackPermitted: false,
  } as const;

  it('does not let authorization or caller-shaped context spoof retrieval authority', () => {
    runWithBackstageNotionEnrichmentAuthorization(true, () => {
      recordBackstageProtectedGenerationAuthority('notion');
      expect(getBackstageProtectedGenerationProvenance()).toBeNull();
    });

    expect(getBackstageProtectedGenerationProvenance()).toBeNull();
  });

  it.each([
    ['notion', {
      authority: 'notion', snapshotStatus: 'current_complete', official: true,
      continuityVerified: true, fallbackUsed: false,
    }],
    ['legacy_postgresql', {
      authority: 'legacy_postgresql', snapshotStatus: 'not_applicable', official: true,
      continuityVerified: true, fallbackUsed: false,
    }],
  ] as const)('uses truthful closed state for %s', (authority, expected) => {
    runWithBackstageProtectedQueuedExecution(false, () => {
      expect(getBackstageProtectedGenerationProvenance()).toBeNull();
      recordBackstageProtectedGenerationAuthority(authority);
      expect(getBackstageProtectedGenerationProvenance()).toEqual({
        version: 1,
        protected: true,
        protectedGenerationCompleted: true,
        fallbackPermitted: false,
        ...expected,
      });
    });
  });

  it('fails closed for an unrecognized runtime authority marker', () => {
    runWithBackstageProtectedQueuedExecution(false, () => {
      recordBackstageProtectedGenerationAuthority('conversation' as never);
      expect(getBackstageProtectedGenerationProvenance()).toBeNull();
    });
  });

  it('rejects process-memory and contradictory completed provenance', () => {
    const baseline = {
      version: 1,
      protected: true,
      protectedGenerationCompleted: true,
      official: true,
      continuityVerified: true,
      fallbackUsed: false,
      fallbackPermitted: false,
    } as const;
    expect(readProtectedBackstageGenerationProvenance({
      ...baseline,
      authority: 'process_memory',
      snapshotStatus: 'not_applicable',
    })).toBeNull();
    expect(readProtectedBackstageGenerationProvenance({
      ...baseline,
      authority: 'notion',
      snapshotStatus: 'not_applicable',
    })).toBeNull();
  });

  it('projects a sealed protected failure without result text while generic lookup remains unchanged', () => {
    const generic = buildGptJobResultLookupPayload(jobId, {
      id: jobId,
      status: 'failed',
      job_type: 'gpt',
      input: { action: 'ordinary-gpt-job' },
      output: { storyline: 'private draft sentinel', partial: 'do not expose' },
      error_message: 'provider stack private draft sentinel',
    } as never);
    const managed = projectBackstageBookerManagedProtectedFailurePayload(
      generic,
      'provider stack private draft sentinel'
    );

    expect(generic.error?.code).toBe('JOB_FAILED');
    expect(generic.result).toMatchObject({ storyline: 'private draft sentinel' });
    expect(managed).toMatchObject({
      result: null,
      error: { code: 'BACKSTAGE_ASYNC_EXECUTION_FAILED' },
      protected: true,
      protectedGenerationCompleted: false,
      official: false,
      continuityVerified: false,
      authority: 'none',
      snapshotStatus: 'not_applicable',
      fallbackUsed: false,
      fallbackPermitted: false,
    });
    expect(JSON.stringify(managed)).not.toContain('private draft sentinel');
  });

  it('allowlists worker failure codes before a protected envelope can be sealed', () => {
    const privateProviderFailure = {
      code: 'PROVIDER_STACK_TRACE',
      message: 'preview draft partial storyline sentinel',
    };
    const code = resolveBackstageProtectedFailureCode(privateProviderFailure.code);
    const envelope = buildProtectedBackstageFailureEnvelope({
      gptId: 'backstage-booker',
      action: 'generateBooking',
      code,
    });

    expect(envelope).toEqual({
      ok: false,
      error: { code: 'BACKSTAGE_ASYNC_EXECUTION_FAILED' },
      _route: {
        gptId: 'backstage-booker',
        action: 'generateBooking',
        route: 'worker',
      },
    });
    expect(JSON.stringify(envelope)).not.toContain('preview draft partial storyline sentinel');
  });

  it('rejects a protected failure envelope with any non-canonical field', () => {
    const envelope = buildProtectedBackstageFailureEnvelope({
      gptId: 'backstage-booker',
      action: 'generateBooking',
      code: 'BACKSTAGE_ASYNC_EXECUTION_FAILED',
    });

    expect(readProtectedBackstageFailureCode({
      ...envelope,
      providerMessage: 'private provider sentinel',
    }, {
      gptId: 'backstage-booker',
      action: 'generateBooking',
    })).toBeNull();
  });

  it('preserves the bounded structural integrity domain code', () => {
    expect(resolveBackstageProtectedFailureCode(
      'BACKSTAGE_BOOKER_INTEGRITY_FAILED'
    )).toBe('BACKSTAGE_BOOKER_INTEGRITY_FAILED');
  });

  it.each([
    ['BACKSTAGE_JOB_PAYLOAD_TOO_LARGE', {
      code: 'BACKSTAGE_ASYNC_PAYLOAD_TOO_LARGE',
      message: 'Protected Backstage generation request exceeds the queue payload size limit.',
      statusCode: 413,
    }],
    ['BACKSTAGE_JOB_PAYLOAD_IDENTITY_INVALID', {
      code: 'BAD_REQUEST',
      message: 'Protected Backstage generation request identity is invalid.',
      statusCode: 400,
    }],
    ['BACKSTAGE_JOB_PAYLOAD_SERIALIZATION_FAILED', {
      code: 'BAD_REQUEST',
      message: 'Protected Backstage generation request identity is invalid.',
      statusCode: 400,
    }],
    ['BACKSTAGE_JOB_PAYLOAD_CONFIG_MISSING', {
      code: 'BACKSTAGE_ASYNC_UNAVAILABLE',
      message: 'Protected Backstage generation is temporarily unavailable.',
      statusCode: 503,
    }],
    ['BACKSTAGE_JOB_PAYLOAD_CONFIG_INVALID', {
      code: 'BACKSTAGE_ASYNC_UNAVAILABLE',
      message: 'Protected Backstage generation is temporarily unavailable.',
      statusCode: 503,
    }],
    ['BACKSTAGE_JOB_PAYLOAD_CONFIG_COLLISION', {
      code: 'BACKSTAGE_ASYNC_UNAVAILABLE',
      message: 'Protected Backstage generation is temporarily unavailable.',
      statusCode: 503,
    }],
    ['BACKSTAGE_JOB_PAYLOAD_ENVELOPE_INVALID', {
      code: 'BACKSTAGE_ASYNC_UNAVAILABLE',
      message: 'Protected Backstage generation is temporarily unavailable.',
      statusCode: 503,
    }],
    ['BACKSTAGE_JOB_PAYLOAD_AUTHENTICATION_FAILED', {
      code: 'BACKSTAGE_ASYNC_UNAVAILABLE',
      message: 'Protected Backstage generation is temporarily unavailable.',
      statusCode: 503,
    }],
  ] as const)(
    'maps private payload protection code %s onto a fixed public rejection',
    (errorCode, expected) => {
      expect(resolveBackstageBookerProtectedPayloadRejection(errorCode))
        .toEqual(expected);
    }
  );

  it.each([
    [{}],
    [{ _route: null }],
    [{ _route: 'backstage-booker' }],
    [{ _route: [] }],
    [{ _route: { gptId: 'arcanos-core', action: 'generateBooking' } }],
    [{ _route: { gptId: 'backstage-booker', action: 'queryContinuity' } }],
    [{
      ok: true,
      result: {},
      _route: { gptId: 'backstage-booker', action: 'generateBooking' },
    }],
  ])('does not manufacture a protected overflow failure for %j', (payload) => {
    expect(buildBackstageBookerProtectedOverflowFailure(payload)).toBeUndefined();
  });

  it('preserves safe correlation fields in a protected overflow failure', () => {
    const overflow = buildBackstageBookerProtectedOverflowFailure({
      ok: true,
      jobId,
      poll: `/managed/${jobId}`,
      requestId: 'request-overflow',
      traceId: 'trace-overflow',
      result: { protectedGeneration: completedProvenance },
      _route: {
        requestId: 'route-request-overflow',
        traceId: 'route-trace-overflow',
        gptId: 'backstage-booker',
        action: 'generateBooking',
        timestamp: '2026-08-31T12:00:00.000Z',
      },
    });

    expect(overflow).toMatchObject({
      ok: false,
      jobId,
      poll: `/managed/${jobId}`,
      status: 'failed',
      requestId: 'request-overflow',
      traceId: 'trace-overflow',
      result: null,
      error: { code: 'BACKSTAGE_ASYNC_RESULT_UNAVAILABLE' },
      _route: {
        requestId: 'route-request-overflow',
        traceId: 'route-trace-overflow',
        gptId: 'backstage-booker',
        action: 'generateBooking',
        timestamp: '2026-08-31T12:00:00.000Z',
      },
    });
  });

  it('omits absent optional fields from a protected HRC overflow failure', () => {
    expect(buildBackstageBookerProtectedOverflowFailure({
      ok: true,
      result: { protectedGeneration: completedProvenance },
      _route: {
        gptId: 'backstage-booker',
        action: 'generateBookingWithHRC',
      },
    })).toEqual({
      ok: false,
      status: 'failed',
      result: null,
      error: {
        code: 'BACKSTAGE_ASYNC_RESULT_UNAVAILABLE',
        message: 'Protected Backstage generation result exceeded the public response limit, so no official result was delivered.',
      },
      protected: true,
      protectedGenerationCompleted: false,
      official: false,
      continuityVerified: false,
      authority: 'none',
      snapshotStatus: 'not_applicable',
      fallbackUsed: false,
      fallbackPermitted: false,
      _route: {
        gptId: 'backstage-booker',
        action: 'generateBookingWithHRC',
      },
    });
  });

  it('requires authenticated unsealing and a valid protected failure envelope before projecting its code', async () => {
    const originalKey = process.env.ARCANOS_BACKSTAGE_BOOKER_JOB_PAYLOAD_KEY;
    process.env.ARCANOS_BACKSTAGE_BOOKER_JOB_PAYLOAD_KEY =
      Buffer.alloc(32, 0x4d).toString('base64');
    const actorKey = 'managed-principal';
    const input = buildProtectedBackstageQueuedGptJobInput({
      action: 'generateBooking',
      universeId: 'protected-universe',
      notionEnrichmentAuthorized: true,
      body: {
        action: 'generateBooking',
        payload: { universeId: 'protected-universe', prompt: 'private prompt' },
      },
    });
    const output = protectBackstageQueuedGptJobOutput({
      jobId,
      rawInput: input,
      output: buildProtectedBackstageFailureEnvelope({
        gptId: 'backstage-booker',
        action: 'generateBooking',
        code: 'BACKSTAGE_NOTION_INDEX_UNAVAILABLE',
      }),
    }) as {
      version: number;
      source: string;
      gptId: string;
      action: string;
      universeId: string;
      sealedPayload: Record<string, string>;
    };
    const job = {
      id: jobId,
      status: 'failed',
      job_type: 'gpt',
      input,
      output,
      error_message: 'BACKSTAGE_NOTION_INDEX_UNAVAILABLE: private provider text',
      idempotency_scope_hash: buildGptIdempotencyScopeHash({
        surface: 'public-gpt', actorKey,
      }),
    } as never;
    const read = () => readBackstageBookerAsyncResultCore({
      jobId,
      actorKey,
      waitForResultMs: 0,
      pollIntervalMs: 1,
    }, {
      getJobByIdFn: async () => job,
      waitForQueuedGptJobCompletionFn: async () => ({ state: 'failed', job }),
    });

    try {
      await expect(read()).resolves.toMatchObject({
        result: null,
        error: { code: 'BACKSTAGE_NOTION_INDEX_UNAVAILABLE' },
        authority: 'none',
      });
      (job as { output: unknown }).output = protectBackstageQueuedGptJobOutput({
        jobId,
        rawInput: input,
        output: {
          ok: false,
          error: { code: 'PRIVATE_PROVIDER_FAILURE' },
          _route: {
            gptId: 'backstage-booker',
            action: 'generateBooking',
            route: 'worker',
          },
        },
      });
      await expect(read()).rejects.toBeInstanceOf(
        BackstageBookerAsyncResultUnavailableError
      );
      const tamperedOutput = {
        ...output,
        sealedPayload: {
          ...output.sealedPayload,
          ciphertext: `${output.sealedPayload.ciphertext.slice(0, -4)}AAAA`,
        },
      };
      (job as { output: unknown }).output = tamperedOutput;
      await expect(read()).rejects.toBeInstanceOf(
        BackstageBookerAsyncResultUnavailableError
      );
    } finally {
      if (originalKey === undefined) {
        Reflect.deleteProperty(process.env, 'ARCANOS_BACKSTAGE_BOOKER_JOB_PAYLOAD_KEY');
      } else {
        process.env.ARCANOS_BACKSTAGE_BOOKER_JOB_PAYLOAD_KEY = originalKey;
      }
    }
  });

  it('rejects non-terminal jobs from the trusted terminal failure projector', () => {
    expect(() => projectTrustedProtectedBackstageTerminalFailure({
      id: jobId,
      status: 'running',
      job_type: 'gpt',
      input: {},
    } as never)).toThrow(BackstageBookerAsyncResultUnavailableError);
  });

  it('rejects a sealed completed result whose provenance or action binding was spoofed', async () => {
    const originalKey = process.env.ARCANOS_BACKSTAGE_BOOKER_JOB_PAYLOAD_KEY;
    process.env.ARCANOS_BACKSTAGE_BOOKER_JOB_PAYLOAD_KEY =
      Buffer.alloc(32, 0x4e).toString('base64');
    const actorKey = 'completed-managed-principal';
    const input = buildProtectedBackstageQueuedGptJobInput({
      action: 'generateBooking',
      universeId: 'protected-universe',
      notionEnrichmentAuthorized: true,
      body: {
        action: 'generateBooking',
        payload: { universeId: 'protected-universe', prompt: 'private prompt' },
      },
    });
    const job = {
      id: jobId,
      status: 'completed',
      job_type: 'gpt',
      input,
      output: protectBackstageQueuedGptJobOutput({
        jobId,
        rawInput: input,
        output: {
          ok: true,
          result: {
            booking: 'private completed booking sentinel',
            protectedGeneration: {
              version: 1,
              protected: true,
              protectedGenerationCompleted: true,
              official: true,
              continuityVerified: true,
              authority: 'process_memory',
              snapshotStatus: 'not_applicable',
              fallbackUsed: false,
              fallbackPermitted: false,
            },
          },
          _route: {
            gptId: 'backstage-booker',
            action: 'generateBookingWithHRC',
          },
        },
      }),
      idempotency_scope_hash: buildGptIdempotencyScopeHash({
        surface: 'public-gpt', actorKey,
      }),
    } as never;

    try {
      await expect(readBackstageBookerAsyncResultCore({
        jobId,
        actorKey,
        waitForResultMs: 0,
        pollIntervalMs: 1,
      }, {
        getJobByIdFn: async () => job,
        waitForQueuedGptJobCompletionFn: async () => ({ state: 'completed', job }),
      })).rejects.toBeInstanceOf(BackstageBookerAsyncResultUnavailableError);
    } finally {
      if (originalKey === undefined) {
        Reflect.deleteProperty(process.env, 'ARCANOS_BACKSTAGE_BOOKER_JOB_PAYLOAD_KEY');
      } else {
        process.env.ARCANOS_BACKSTAGE_BOOKER_JOB_PAYLOAD_KEY = originalKey;
      }
    }
  });
});
