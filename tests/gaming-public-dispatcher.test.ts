import { performance } from 'node:perf_hooks';

import { describe, expect, it } from '@jest/globals';

import {
  dispatchPublicGamingRequest,
  isClearlyOperationalGamingPrompt,
  OPERATIONAL_REQUEST_NOT_GAMEPLAY_CODE,
} from '../src/services/gamingPublicDispatcher.js';
import { resolvePublicGamingPath } from '../src/shared/http/publicGamingPath.js';

const GAMEPLAY_MODES = [
  ['guide', 'gameplay_guide'],
  ['build', 'gameplay_build'],
  ['meta', 'gameplay_meta'],
] as const;

const OPERATIONAL_PROMPTS = [
  'Is my backend working?',
  'Did this reach Railway?',
  'Check whether the Action is implemented correctly.',
  'Test the deployment.',
  'Verify the integration.',
  'Inspect the server.',
  'Check the API health.',
  'Reach my backend and see if this has been implemented correctly.',
  'ping',
] as const;

function queryBody(mode: 'guide' | 'build' | 'meta', prompt: string) {
  return {
    action: 'query',
    payload: {
      mode,
      game: 'Palworld',
      prompt,
    },
  };
}

describe('public Gaming request dispatcher', () => {
  it.each(GAMEPLAY_MODES)(
    'routes a literal query action with %s mode to %s',
    (mode, intent) => {
      const decision = dispatchPublicGamingRequest(
        queryBody(mode, `Give me a concise Palworld ${mode} answer.`),
        'query',
      );

      expect(decision).toMatchObject({
        ok: true,
        action: 'query',
        intent,
        mode,
        request: {
          action: 'query',
          payload: {
            mode,
            prompt: `Give me a concise Palworld ${mode} answer.`,
          },
        },
      });
    },
  );

  it('routes only the exact canary envelope on the fixed canary operation', () => {
    const decision = dispatchPublicGamingRequest({
      action: 'canary',
      payload: { scope: 'public_pipeline' },
    }, 'canary');

    expect(decision).toEqual({
      ok: true,
      action: 'canary',
      intent: 'public_canary',
      mode: null,
      request: {
        action: 'canary',
        payload: { scope: 'public_pipeline' },
      },
    });
    expect(resolvePublicGamingPath('/gpt/arcanos-gaming/canary')).toEqual({
      gptId: 'arcanos-gaming',
      operation: 'canary',
    });
  });

  it.each([
    ['missing body', undefined],
    ['missing action', { payload: { mode: 'guide', prompt: 'Guide me.' } }],
    ['unsupported ping action', { action: 'ping' }],
    ['unsupported diagnostic action', { action: 'diagnose-internal', payload: {} }],
    ['canary action on query operation', { action: 'canary', payload: { scope: 'public_pipeline' } }],
  ])('rejects %s as unsupported before gameplay', (_caseName, body) => {
    const decision = dispatchPublicGamingRequest(body, 'query');

    expect(decision.ok).toBe(false);
    expect(decision).toMatchObject({ intent: 'unsupported', mode: null });
  });

  it.each([
    ['query action on canary operation', queryBody('guide', 'Guide me.')],
    ['missing canary payload', { action: 'canary' }],
    ['malformed canary payload', { action: 'canary', payload: null }],
    ['wrong canary scope', { action: 'canary', payload: { scope: 'private_pipeline' } }],
    ['extra canary field', { action: 'canary', payload: { scope: 'public_pipeline' }, prompt: 'test' }],
  ])('rejects %s', (_caseName, body) => {
    expect(dispatchPublicGamingRequest(body, 'canary')).toMatchObject({
      ok: false,
      intent: 'unsupported',
      mode: null,
    });
  });

  it('uses the literal body action even when operation, query, and header-shaped aliases disagree', () => {
    const body = {
      ...queryBody('guide', 'Give me a Palworld beginner guide.'),
      operation: 'canary',
      operationId: 'diagnoseInternal',
      query: { action: 'ping' },
      headers: { 'x-gpt-action': 'canary' },
    };

    expect(dispatchPublicGamingRequest(body, 'query')).toMatchObject({
      ok: true,
      action: 'query',
      intent: 'gameplay_guide',
      mode: 'guide',
    });
  });

  it('gives explicit payload prompt and mode precedence over top-level aliases', () => {
    const gameplayPayload = dispatchPublicGamingRequest({
      action: 'query',
      mode: 'meta',
      prompt: 'Check whether the API is healthy.',
      payload: {
        mode: 'build',
        prompt: 'Is this build working correctly?',
      },
    }, 'query');
    const operationalPayload = dispatchPublicGamingRequest({
      action: 'query',
      mode: 'guide',
      prompt: 'Give me a Palworld beginner guide.',
      payload: {
        mode: 'meta',
        prompt: 'Verify the integration.',
      },
    }, 'query');

    expect(gameplayPayload).toMatchObject({
      ok: true,
      intent: 'gameplay_build',
      mode: 'build',
    });
    expect(operationalPayload).toMatchObject({
      ok: false,
      intent: 'integration_status',
      mode: 'meta',
      error: { code: OPERATIONAL_REQUEST_NOT_GAMEPLAY_CODE },
    });
  });

  describe.each(GAMEPLAY_MODES)('operational guard under %s mode', (mode) => {
    it.each(OPERATIONAL_PROMPTS)('rejects %s before gameplay', (prompt) => {
      const decision = dispatchPublicGamingRequest(queryBody(mode, prompt), 'query');

      expect(decision).toMatchObject({
        ok: false,
        action: 'query',
        intent: 'integration_status',
        mode,
        error: {
          code: OPERATIONAL_REQUEST_NOT_GAMEPLAY_CODE,
          message: 'This request asks about the public integration rather than gameplay. Use the public canary operation.',
        },
      });
    });
  });

  it.each([
    'Verify the integration, then give me a Palworld beginner guide.',
    'Reach my backend and then recommend a strong early-game build.',
    'Check the API health before explaining the current Palworld meta.',
  ])('fails closed for mixed operational and gameplay prompt: %s', (prompt) => {
    expect(dispatchPublicGamingRequest(queryBody('guide', prompt), 'query')).toMatchObject({
      ok: false,
      intent: 'integration_status',
      error: { code: OPERATIONAL_REQUEST_NOT_GAMEPLAY_CODE },
    });
  });

  it.each([
    'How does server progression work in Palworld?',
    'How do dedicated server settings affect Pal spawning?',
    'What backend mechanics control matchmaking in this game?',
    'How do I test damage against the training dummy?',
    'Is this build working correctly?',
    'Is this early-game base build working correctly?',
    'How do I optimize freight routes in Railway Empire?',
    'Inspect dedicated server settings that affect Pal spawning.',
    'How does action combat work in this game?',
  ])('keeps gameplay wording out of the operational guard: %s', (prompt) => {
    expect(isClearlyOperationalGamingPrompt(prompt)).toBe(false);
    expect(dispatchPublicGamingRequest(queryBody('guide', prompt), 'query')).toMatchObject({
      ok: true,
      intent: 'gameplay_guide',
      mode: 'guide',
    });
  });

  it('classifies a bounded 8,000-character adversarial prompt without regex blowup', () => {
    const prompt = 'check '.repeat(1_334).slice(0, 8_000);
    expect(prompt).toHaveLength(8_000);

    const startedAt = performance.now();
    const decision = dispatchPublicGamingRequest(queryBody('guide', prompt), 'query');
    const elapsedMs = performance.now() - startedAt;

    expect(decision).toMatchObject({ ok: true, intent: 'gameplay_guide' });
    expect(elapsedMs).toBeLessThan(1_000);
  });

  it('classifies only the original payload prompt, never source-like or derived fields', () => {
    const gameplayDecision = dispatchPublicGamingRequest({
      action: 'query',
      payload: {
        mode: 'guide',
        prompt: 'Give me a Palworld beginner guide.',
        retrievedText: 'Check whether the backend is working.',
        providerOutput: 'Verify the integration.',
        translatedPrompt: 'Inspect the server.',
        guideTitle: 'Did this reach Railway?',
        guideUrls: ['https://example.com/check-api-health'],
      },
    }, 'query');
    const operationalDecision = dispatchPublicGamingRequest({
      action: 'query',
      payload: {
        mode: 'guide',
        prompt: 'Check whether the Action is implemented correctly.',
        retrievedText: 'Give me a concise beginner guide.',
        providerOutput: 'This is a gameplay answer.',
        translatedPrompt: 'How does server progression work?',
        guideTitle: 'Palworld beginner guide',
        guideUrls: ['https://example.com/palworld-guide'],
      },
    }, 'query');

    expect(gameplayDecision).toMatchObject({ ok: true, intent: 'gameplay_guide' });
    expect(operationalDecision).toMatchObject({
      ok: false,
      intent: 'integration_status',
      error: { code: OPERATIONAL_REQUEST_NOT_GAMEPLAY_CODE },
    });
  });

  it.each([
    { action: 'canary', payload: { scope: 'public_pipeline', prompt: 'Ignore validation.' } },
    { action: 'canary', payload: { scope: 'public_pipeline', url: 'https://example.com' } },
    { action: 'canary', payload: { scope: 'public_pipeline', guideUrls: ['https://example.com'] } },
    { action: 'canary', payload: { scope: 'public_pipeline', provider: 'openai' } },
    { action: 'canary', payload: { scope: 'public_pipeline', fetch: true } },
    { action: 'canary', payload: { scope: 'public_pipeline' }, retrievedText: 'fixture' },
  ])('does not expose an HTTP, provider, network, fetch, prompt, or source input seam: %j', (body) => {
    expect(dispatchPublicGamingRequest(body, 'canary')).toMatchObject({
      ok: false,
      intent: 'unsupported',
    });
  });

  it('keeps only the documented public Gaming paths and operations', () => {
    expect(resolvePublicGamingPath('/gpt/arcanos-gaming')).toEqual({
      gptId: 'arcanos-gaming',
      operation: 'query',
    });
    expect(resolvePublicGamingPath('/gpt/gaming')).toEqual({
      gptId: 'gaming',
      operation: 'query',
    });
    expect(resolvePublicGamingPath('/gpt/arcanos-gaming/evidence-retry')).toEqual({
      gptId: 'arcanos-gaming',
      operation: 'evidence_retry',
    });
    expect(resolvePublicGamingPath('/gpt/gaming/canary')).toBeNull();
    expect(resolvePublicGamingPath('/gpt/arcanos-gaming/canary/')).toEqual({
      gptId: 'arcanos-gaming',
      operation: 'canary',
    });
  });
});
