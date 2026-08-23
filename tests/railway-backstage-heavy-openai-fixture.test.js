import { afterEach, describe, expect, it } from '@jest/globals';

import {
  BACKSTAGE_HEAVY_OPENAI_FIXTURE_ATTESTATION_PATH,
  BACKSTAGE_HEAVY_OPENAI_FIXTURE_BOOKING_DIRECTIVE,
  BACKSTAGE_HEAVY_OPENAI_FIXTURE_COMPLETED_OUTPUT,
  BACKSTAGE_HEAVY_OPENAI_FIXTURE_MODEL_ID,
  BACKSTAGE_HEAVY_OPENAI_FIXTURE_OUTPUT_TOKEN_LIMIT,
  BACKSTAGE_HEAVY_OPENAI_FIXTURE_PARTIAL_OUTPUT,
  BACKSTAGE_HEAVY_OPENAI_FIXTURE_PROMPT_SENTINEL,
  BACKSTAGE_HEAVY_OPENAI_FIXTURE_RECOVERY_MARKER,
  BACKSTAGE_HEAVY_OPENAI_FIXTURE_SDK_KEY,
  startBackstageHeavyOpenAIFixture,
} from '../scripts/railway-backstage-heavy-openai-fixture.mjs';
import { createOpenAIAdapter } from '../src/core/adapters/openai.adapter.js';
import { normalizeResponsesDraft } from '../src/services/openai/requestBuilders/normalize.js';

describe('credential-free Backstage heavy OpenAI fixture', () => {
  const runId = 'proof-run-1460';
  let runtime;

  afterEach(async () => {
    await runtime?.close();
    runtime = undefined;
  });

  function buildRequest(systemText, options = {}) {
    const directive = options.omitDirective
      ? 'Generate five rewritten booking notes'
      : BACKSTAGE_HEAVY_OPENAI_FIXTURE_BOOKING_DIRECTIVE;
    const userPrompt = [
      BACKSTAGE_HEAVY_OPENAI_FIXTURE_PROMPT_SENTINEL,
      `Run ${runId}.`,
      `${directive} for a complete fictional event.`,
      'Keep every detail invented. '.repeat(60),
    ].join(' ');
    const normalized = normalizeResponsesDraft({
      model: BACKSTAGE_HEAVY_OPENAI_FIXTURE_MODEL_ID,
      prompt: userPrompt,
      preparedMessages: [
        { role: 'system', content: systemText },
        {
          role: 'user',
          content: userPrompt,
        },
      ],
      includeRoutingMessage: false,
      maxTokens: BACKSTAGE_HEAVY_OPENAI_FIXTURE_OUTPUT_TOKEN_LIMIT,
      temperature: 0,
      top_p: 1,
      store: false,
    });
    return {
      model: normalized.model,
      input: normalized.input,
      max_output_tokens: normalized.maxOutputTokens,
      store: false,
    };
  }

  it('accepts the production Responses wire shape and enforces one fresh compact retry', async () => {
    runtime = await startBackstageHeavyOpenAIFixture({
      port: 0,
      firstResponseDelayMs: 0,
      expectedRunId: runId,
    });
    const address = runtime.server.address();
    const baseURL = `http://127.0.0.1:${address.port}/v1`;
    const client = createOpenAIAdapter({
      apiKey: BACKSTAGE_HEAVY_OPENAI_FIXTURE_SDK_KEY,
      baseURL,
      maxRetries: 0,
    }).getClient();

    const models = await client.models.list({ page: 1 });
    expect(models.data.map(candidate => candidate.id)).toEqual([
      BACKSTAGE_HEAVY_OPENAI_FIXTURE_MODEL_ID,
    ]);
    const first = await client.responses.create(
      buildRequest('Fictional policy without a recovery directive.')
    );
    expect(first.status).toBe('incomplete');
    expect(first.incomplete_details).toEqual({ reason: 'max_output_tokens' });
    expect(first.output_text).toBe(BACKSTAGE_HEAVY_OPENAI_FIXTURE_PARTIAL_OUTPUT);

    const second = await client.responses.create(buildRequest(
      `Fictional policy. ${BACKSTAGE_HEAVY_OPENAI_FIXTURE_RECOVERY_MARKER}`
    ));
    expect(second.status).toBe('completed');
    expect(second.output_text).toBe(BACKSTAGE_HEAVY_OPENAI_FIXTURE_COMPLETED_OUTPUT);

    const attestationResponse = await fetch(
      `http://127.0.0.1:${address.port}${BACKSTAGE_HEAVY_OPENAI_FIXTURE_ATTESTATION_PATH}`,
      {
        headers: {
          authorization: `Bearer ${BACKSTAGE_HEAVY_OPENAI_FIXTURE_SDK_KEY}`,
        },
      }
    );
    await expect(attestationResponse.json()).resolves.toMatchObject({
      responsePhase: 'second_complete',
      modelsListCalls: 1,
      responsesCalls: 2,
      firstResponseIncomplete: true,
      secondResponseCompleted: true,
      firstRecoveryMarkerAbsent: true,
      secondRecoveryMarkerObserved: true,
      secondRequestExcludedPartialOutput: true,
      promptSentinelObserved: true,
      bookingDirectiveObserved: true,
      runMarkerObserved: true,
      thirdResponseRejected: 0,
      unknownRequests: 0,
      authorizationFailures: 0,
      invalidRequests: 0,
    });

    await expect(client.responses.create(buildRequest(
      `Fictional policy. ${BACKSTAGE_HEAVY_OPENAI_FIXTURE_RECOVERY_MARKER}`
    ))).rejects.toMatchObject({ status: 422 });
    expect(runtime.state.thirdResponseRejected).toBe(1);
  });

  it('rejects concurrent phase advancement, partial-output continuation, and unapproved model queries', async () => {
    runtime = await startBackstageHeavyOpenAIFixture({
      port: 0,
      firstResponseDelayMs: 40,
      expectedRunId: runId,
    });
    const address = runtime.server.address();
    const baseURL = `http://127.0.0.1:${address.port}/v1`;
    const client = createOpenAIAdapter({
      apiKey: BACKSTAGE_HEAVY_OPENAI_FIXTURE_SDK_KEY,
      baseURL,
      maxRetries: 0,
    }).getClient();
    await client.models.list({ page: 1 });
    await expect(client.responses.create(buildRequest(
      'Fictional invalid directive policy.',
      { omitDirective: true }
    ))).rejects.toMatchObject({ status: 422 });
    const firstPromise = client.responses.create(
      buildRequest('Fictional first-call policy.')
    );
    await new Promise(resolve => setTimeout(resolve, 5));
    await expect(client.responses.create(buildRequest(
      `Fictional policy. ${BACKSTAGE_HEAVY_OPENAI_FIXTURE_RECOVERY_MARKER}`
    ))).rejects.toMatchObject({ status: 422 });
    await firstPromise;

    await expect(client.responses.create(buildRequest(
      `${BACKSTAGE_HEAVY_OPENAI_FIXTURE_RECOVERY_MARKER} ${BACKSTAGE_HEAVY_OPENAI_FIXTURE_PARTIAL_OUTPUT}`
    ))).rejects.toMatchObject({ status: 422 });

    const invalidModels = await fetch(
      `http://127.0.0.1:${address.port}/v1/models?page=2`,
      {
        headers: {
          authorization: `Bearer ${BACKSTAGE_HEAVY_OPENAI_FIXTURE_SDK_KEY}`,
        },
      }
    );
    expect(invalidModels.status).toBe(404);
    await expect(client.models.retrieve(
      BACKSTAGE_HEAVY_OPENAI_FIXTURE_MODEL_ID
    )).rejects.toMatchObject({ status: 404 });
  });
});
