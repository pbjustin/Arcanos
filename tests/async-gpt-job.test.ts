import { afterAll, describe, expect, it } from '@jest/globals';
import {
  buildProtectedBackstageQueuedGptJobInput,
  buildQueuedGptBackstageMutationAdmission,
  buildQueuedGptJobInput,
  parseQueuedGptJobInput
} from '../src/shared/gpt/asyncGptJob.js';
import {
  protectBackstageQueuedGptJobOutput,
  unprotectBackstageQueuedGptJobOutput,
} from '../src/shared/backstage/backstageQueuedJobResultProtection.js';
import {
  GPT_HEALTH_ECHO_ACTION,
  isQueuedBridgeSmokeJobInput
} from '../src/shared/gpt/bridgeSmoke.js';

describe('async GPT job payload helpers', () => {
  const originalPayloadKey = process.env.ARCANOS_BACKSTAGE_BOOKER_JOB_PAYLOAD_KEY;

  afterAll(() => {
    if (originalPayloadKey === undefined) {
      delete process.env.ARCANOS_BACKSTAGE_BOOKER_JOB_PAYLOAD_KEY;
    } else {
      process.env.ARCANOS_BACKSTAGE_BOOKER_JOB_PAYLOAD_KEY = originalPayloadKey;
    }
  });

  it('bounds route metadata to the worker parser contract', () => {
    const longValue = 'x'.repeat(129);

    const payload = buildQueuedGptJobInput({
      gptId: 'arcanos-core',
      body: {},
      requestId: longValue,
      traceId: longValue,
      correlationId: longValue,
      routeHint: 'query',
      requestPath: '/gpt/arcanos-core'
    });

    expect(payload.requestId).toHaveLength(128);
    expect(payload.traceId).toHaveLength(128);
    expect(payload.correlationId).toHaveLength(128);
    expect(parseQueuedGptJobInput(payload).ok).toBe(true);
  });

  it('recognizes only queued jobs with a supported bridge smoke action', () => {
    expect(isQueuedBridgeSmokeJobInput({
      bridgeSmoke: true,
      bridgeAction: GPT_HEALTH_ECHO_ACTION
    })).toBe(true);
    expect(isQueuedBridgeSmokeJobInput({
      bridgeSmoke: true
    })).toBe(false);
    expect(isQueuedBridgeSmokeJobInput({
      bridgeAction: GPT_HEALTH_ECHO_ACTION
    })).toBe(false);
  });

  it('round-trips only schema-valid server-owned Backstage mutation admission', () => {
    const backstageMutationAdmission = buildQueuedGptBackstageMutationAdmission({
      action: 'updateRoster',
      principalId: 'operator:queued-backstage-test',
    });
    const payload = buildQueuedGptJobInput({
      gptId: 'backstage',
      body: { action: 'updateRoster', payload: [] },
      backstageMutationAdmission,
    });

    expect(parseQueuedGptJobInput(payload)).toEqual({
      ok: true,
      value: expect.objectContaining({ backstageMutationAdmission }),
    });
    expect(parseQueuedGptJobInput({
      ...payload,
      backstageMutationAdmission: {
        ...backstageMutationAdmission,
        source: 'caller-supplied',
      },
    })).toMatchObject({ ok: false });
  });

  it('preserves persisted mutation action drift for worker mismatch enforcement', () => {
    const backstageMutationAdmission = buildQueuedGptBackstageMutationAdmission({
      action: 'updateRoster',
      principalId: 'operator:queued-backstage-test',
    });

    expect(parseQueuedGptJobInput({
      gptId: 'backstage',
      body: { action: 'trackStoryline', payload: {} },
      backstageMutationAdmission,
    })).toMatchObject({
      ok: true,
      value: {
        body: { action: 'trackStoryline', payload: {} },
        backstageMutationAdmission,
      },
    });
  });

  it('persists private Booker input and output only as authenticated ciphertext', () => {
    const privatePrompt = 'private-booking-prompt-sentinel';
    const privateResult = 'private-booking-result-sentinel';
    process.env.ARCANOS_BACKSTAGE_BOOKER_JOB_PAYLOAD_KEY =
      Buffer.alloc(32, 0x42).toString('base64');
    const queuedInput = buildProtectedBackstageQueuedGptJobInput({
      action: 'generateBooking',
      body: {
        action: 'generateBooking',
        payload: {
          universeId: 'my-universe-2k26',
          prompt: privatePrompt,
        },
      },
      prompt: privatePrompt,
      universeId: 'my-universe-2k26',
      notionEnrichmentAuthorized: true,
      requestId: 'request-protected-booker',
      traceId: 'trace-protected-booker',
      correlationId: 'trace-protected-booker',
      executionModeReason: 'backstage_notion_authority_context',
    });

    expect(JSON.stringify(queuedInput)).not.toContain(privatePrompt);
    expect(queuedInput).not.toHaveProperty('body');
    expect(queuedInput).not.toHaveProperty('prompt');
    expect(parseQueuedGptJobInput(queuedInput)).toMatchObject({
      ok: true,
      value: {
        body: {
          action: 'generateBooking',
          payload: { universeId: 'my-universe-2k26', prompt: privatePrompt },
        },
        prompt: privatePrompt,
        requestId: 'request-protected-booker',
        traceId: 'trace-protected-booker',
        protectedBackstage: {
          action: 'generateBooking',
          universeId: 'my-universe-2k26',
          notionEnrichmentAuthorized: true,
        },
      },
    });

    const protectedOutput = protectBackstageQueuedGptJobOutput({
      jobId: '11111111-1111-4111-8111-111111111111',
      rawInput: queuedInput,
      output: { ok: true, result: privateResult },
    });
    expect(JSON.stringify(protectedOutput)).not.toContain(privateResult);
    expect(unprotectBackstageQueuedGptJobOutput({
      jobId: '11111111-1111-4111-8111-111111111111',
      rawInput: queuedInput,
      output: protectedOutput,
    })).toEqual({ ok: true, result: privateResult });
  });

  it('fails a tampered protected Booker input without reflecting ciphertext', () => {
    process.env.ARCANOS_BACKSTAGE_BOOKER_JOB_PAYLOAD_KEY =
      Buffer.alloc(32, 0x43).toString('base64');
    const queuedInput = buildProtectedBackstageQueuedGptJobInput({
      action: 'generateBooking',
      body: { action: 'generateBooking', payload: { prompt: 'private-input' } },
      prompt: 'private-input',
      universeId: 'my-universe-2k26',
      notionEnrichmentAuthorized: true,
    });
    const serialized = JSON.parse(JSON.stringify(queuedInput)) as typeof queuedInput;
    serialized.protectedBackstage.sealedPayload.ciphertext =
      `${serialized.protectedBackstage.sealedPayload.ciphertext.slice(0, -4)}AAAA`;

    const parsed = parseQueuedGptJobInput(serialized);
    expect(parsed).toMatchObject({ ok: false });
    expect(JSON.stringify(parsed)).not.toContain(
      serialized.protectedBackstage.sealedPayload.ciphertext
    );
  });

  it('binds the protected descriptor to the executed action and universe', () => {
    process.env.ARCANOS_BACKSTAGE_BOOKER_JOB_PAYLOAD_KEY =
      Buffer.alloc(32, 0x44).toString('base64');

    expect(() => buildProtectedBackstageQueuedGptJobInput({
      action: 'generateBooking',
      body: {
        action: 'generateBookingWithHRC',
        payload: { universeId: 'my-universe-2k26' },
      },
      universeId: 'my-universe-2k26',
      notionEnrichmentAuthorized: true,
    })).toThrow('Backstage job payload identity is invalid.');
    expect(() => buildProtectedBackstageQueuedGptJobInput({
      action: 'generateBooking',
      body: {
        action: 'generateBooking',
        payload: { universeId: 'other-universe' },
      },
      universeId: 'my-universe-2k26',
      notionEnrichmentAuthorized: true,
    })).toThrow('Backstage job payload identity is invalid.');
    expect(() => buildProtectedBackstageQueuedGptJobInput({
      action: 'generateBooking',
      body: { action: 'generateBooking', payload: {} },
      universeId: '../my-universe-2k26',
      notionEnrichmentAuthorized: true,
    })).toThrow('Backstage job payload identity is invalid.');

    const queuedInput = buildProtectedBackstageQueuedGptJobInput({
      action: 'generateBooking',
      body: { action: 'generateBooking', payload: { prompt: 'private-input' } },
      universeId: 'my-universe-2k26',
      notionEnrichmentAuthorized: true,
    });
    expect(parseQueuedGptJobInput(queuedInput)).toMatchObject({
      ok: true,
      value: {
        body: {
          action: 'generateBooking',
          payload: {
            prompt: 'private-input',
            universeId: 'my-universe-2k26',
          },
        },
        protectedBackstage: {
          action: 'generateBooking',
          universeId: 'my-universe-2k26',
        },
      },
    });

    const defaultedActionInput = buildProtectedBackstageQueuedGptJobInput({
      action: 'generateBooking',
      body: { payload: { prompt: 'private-defaulted-input' } },
      universeId: 'my-universe-2k26',
      notionEnrichmentAuthorized: false,
    });
    expect(parseQueuedGptJobInput(defaultedActionInput)).toMatchObject({
      ok: true,
      value: {
        body: {
          action: 'generateBooking',
          payload: {
            prompt: 'private-defaulted-input',
            universeId: 'my-universe-2k26',
          },
        },
        protectedBackstage: {
          action: 'generateBooking',
          universeId: 'my-universe-2k26',
          notionEnrichmentAuthorized: false,
        },
      },
    });

    const canonicalizedActionInput = buildProtectedBackstageQueuedGptJobInput({
      action: 'generateBooking',
      body: {
        action: ' GENERATEBOOKING ',
        payload: { prompt: 'private-canonicalized-input' },
      },
      universeId: 'my-universe-2k26',
      notionEnrichmentAuthorized: true,
    });
    expect(parseQueuedGptJobInput(canonicalizedActionInput)).toMatchObject({
      ok: true,
      value: {
        body: { action: 'generateBooking' },
        protectedBackstage: { action: 'generateBooking' },
      },
    });

    const nestedActionInput = buildProtectedBackstageQueuedGptJobInput({
      action: 'generateBooking',
      body: {
        action: [null, ['', ['generateBooking']]],
        payload: { prompt: 'private-nested-action-input' },
      },
      universeId: 'my-universe-2k26',
      notionEnrichmentAuthorized: false,
    });
    expect(parseQueuedGptJobInput(nestedActionInput)).toMatchObject({
      ok: true,
      value: {
        body: { action: 'generateBooking' },
        protectedBackstage: {
          action: 'generateBooking',
          notionEnrichmentAuthorized: false,
        },
      },
    });

    const payloadAliasInput = buildProtectedBackstageQueuedGptJobInput({
      action: 'generateBooking',
      body: {
        action: null,
        payload: {
          action: ['', ['generateBooking']],
          prompt: 'private-payload-action-input',
        },
      },
      universeId: 'my-universe-2k26',
      notionEnrichmentAuthorized: false,
    });
    expect(parseQueuedGptJobInput(payloadAliasInput)).toMatchObject({
      ok: true,
      value: { body: { action: 'generateBooking' } },
    });

    expect(() => buildProtectedBackstageQueuedGptJobInput({
      action: 'generateBooking',
      body: {
        action: 'generateBooking',
        payload: {
          action: 'generateBookingWithHRC',
          prompt: 'private-conflicting-action-input',
        },
      },
      universeId: 'my-universe-2k26',
      notionEnrichmentAuthorized: false,
    })).toThrow(expect.objectContaining({
      code: 'BACKSTAGE_JOB_PAYLOAD_IDENTITY_INVALID',
    }));
  });

  it('never downgrades a malformed protected marker to the plaintext job schema', () => {
    const privatePrompt = 'private-malformed-protected-fallback-sentinel';
    const parsed = parseQueuedGptJobInput({
      gptId: 'backstage-booker',
      protectedBackstage: {
        version: 99,
        source: 'backstage-booker-http',
        ciphertext: 'private-ciphertext-sentinel',
      },
      body: {
        action: 'generateBooking',
        payload: { universeId: 'my-universe-2k26', prompt: privatePrompt },
      },
    });

    expect(parsed).toEqual({
      ok: false,
      error: 'Protected Backstage job payload is invalid.',
    });
    expect(JSON.stringify(parsed)).not.toContain(privatePrompt);
    expect(JSON.stringify(parsed)).not.toContain('private-ciphertext-sentinel');
  });
});
