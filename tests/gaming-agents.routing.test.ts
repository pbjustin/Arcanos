import { describe, expect, it } from '@jest/globals';

import {
  BackendQueryAgent,
  ClarificationAgent,
  IntentRouterAgent,
  ResponseComposerAgent,
} from '../src/services/gamingAgents.js';

describe('Gaming agent routing model', () => {
  it.each([
    ['help me beat Malenia'],
    ['where do I get smithing stones'],
  ])('classifies guide request: %s', (prompt) => {
    const intent = IntentRouterAgent.classify({ prompt });

    expect(intent.mode).toBe('guide');
    expect(intent.confidence).toBeGreaterThanOrEqual(0.6);
    expect(ClarificationAgent.evaluate(intent)).toEqual({ required: false });
  });

  it('classifies and extracts a Diablo build request', () => {
    const intent = IntentRouterAgent.classify({
      prompt: 'best lightning sorc build in Diablo 4',
    });

    expect(intent).toEqual(expect.objectContaining({
      mode: 'build',
      game: 'Diablo 4',
      class: 'lightning sorc',
    }));
    expect(intent.confidence).toBeGreaterThanOrEqual(0.7);
    expect(intent.routingSignals).toContain('known_game');
    expect(ClarificationAgent.evaluate(intent)).toEqual({ required: false });
  });

  it('classifies a build request without a game and asks one blocking question', () => {
    const intent = IntentRouterAgent.classify({
      prompt: 'make me a tank build',
    });

    expect(intent).toEqual(expect.objectContaining({
      mode: 'build',
      role: 'tank',
    }));
    expect(ClarificationAgent.evaluate(intent)).toEqual({
      required: true,
      mode: 'build',
      missing: ['game'],
      question: 'Which game should I use for this build request?',
    });
  });

  it.each([
    ['make me a build for tank', 'build'],
    ['is frost mage still viable in this patch', 'meta'],
    ['best loadout on Steam Deck', 'build'],
  ])('does not infer blacklisted terms as a game: %s', (prompt, mode) => {
    const intent = IntentRouterAgent.classify({ prompt });

    expect(intent.mode).toBe(mode);
    expect(intent.game).toBeUndefined();
    expect(ClarificationAgent.evaluate(intent)).toEqual(expect.objectContaining({
      required: true,
      missing: ['game'],
    }));
  });

  it.each([
    ['is frost mage meta', 'frost mage', undefined],
    ['is frost mage still viable this patch', 'frost mage', 'this patch'],
    ['what changed in 14.13', undefined, '14.13'],
    ['what changed this patch', undefined, 'this patch'],
  ])('classifies meta request: %s', (prompt, className, version) => {
    const intent = IntentRouterAgent.classify({ prompt });

    expect(intent.mode).toBe('meta');
    expect(intent.confidence).toBeGreaterThanOrEqual(0.6);
    if (className) {
      expect(intent.class).toBe(className);
    }
    if (version) {
      expect(intent.version).toBe(version);
    }
  });

  it('includes known_game routing signal for meta classifications', () => {
    const intent = IntentRouterAgent.classify({
      prompt: 'is frost mage meta in World of Warcraft',
    });

    expect(intent).toEqual(expect.objectContaining({
      mode: 'meta',
      game: 'World of Warcraft',
    }));
    expect(intent.routingSignals).toContain('known_game');
  });

  it('asks for game on a meta request without game', () => {
    const intent = IntentRouterAgent.classify({ prompt: 'is frost mage meta' });

    expect(ClarificationAgent.evaluate(intent)).toEqual({
      required: true,
      mode: 'meta',
      missing: ['game'],
      question: 'Which game should I use for this meta request?',
    });
  });

  it('strips markdown heading markers from composed backend summary lines', () => {
    const intent = IntentRouterAgent.classify({
      mode: 'guide',
      prompt: 'help me beat Malenia',
    });
    const result = ResponseComposerAgent.compose({
      intent: intent as any,
      backendEnvelope: {
        ok: true,
        route: 'gaming',
        mode: 'guide',
        data: {
          response: '### Guide to beating Malenia\nStay close and punish openings.',
          sources: [],
        },
      },
    });

    expect(result.data.response).toContain('Backend-supported: Guide to beating Malenia');
    expect(result.data.response).not.toContain('Backend-supported: ###');
  });

  it('preserves the exact backend payload schema and URL values', () => {
    const intent = IntentRouterAgent.classify({
      mode: 'guide',
      prompt: 'Use these guides.',
      game: ' SWTOR ',
      url: ' https://example.com/a ',
      urls: ['https://example.com/b', ' https://example.com/c '],
      guideUrls: ['https://example.com/d'],
      audit: true,
      hrc: true,
      platform: 'PC',
      role: 'tank',
    });

    expect(BackendQueryAgent.build(intent as any)).toEqual({
      action: 'query',
      payload: {
        mode: 'guide',
        prompt: 'Use these guides.',
        game: 'SWTOR',
        url: ' https://example.com/a ',
        urls: ['https://example.com/b', ' https://example.com/c '],
        guideUrls: ['https://example.com/d'],
        audit: true,
        hrc: true,
      },
    });
  });

  it.each([
    [{ action: 'runtime.inspect', payload: { prompt: 'check runtime' } }],
    [{ action: 'query', payload: { action: 'runtime.inspect', prompt: 'check runtime' } }],
    [{ prompt: 'show worker diagnostics before answering' }],
    [{ action: 'mcp.invoke', payload: { prompt: 'call a tool' } }],
    [{ prompt: 'inspect queue status' }],
    [{ prompt: 'GET /internal/control-plane/status' }],
  ])('blocks control-plane request %#', (payload) => {
    const intent = IntentRouterAgent.classify(payload);

    expect(intent.securityBlocked).toEqual(expect.objectContaining({
      code: 'SECURITY_BLOCKED',
    }));
  });
});
