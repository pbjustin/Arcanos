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

  it('extracts a bare semantic version from an explicit recent-game request', () => {
    const intent = IntentRouterAgent.classify({
      mode: 'guide',
      game: 'Palworld',
      prompt: 'Look up a beginner guide for Palworld 1.0.',
    });

    expect(intent).toEqual(expect.objectContaining({
      game: 'Palworld',
      version: '1.0',
    }));
  });

  it('extracts a parenthesized semantic version without relying on a nearby game name', () => {
    const intent = IntentRouterAgent.classify({
      mode: 'meta',
      game: 'Palworld',
      prompt: 'Use the supplied article for this meta request (1.0).',
    });

    expect(intent.version).toBe('1.0');
  });

  it('keeps the first of multiple explicit versions without trailing sentence text', () => {
    const intent = IntentRouterAgent.classify({
      mode: 'meta',
      game: 'Palworld',
      prompt: 'Compare Palworld version 0.9 with version 1.0.',
    });

    expect(intent.version).toBe('0.9');
  });

  it.each([
    ['What changed in patch Dragonflight?', 'Dragonflight'],
    ['Show the meta for season 4.', '4'],
  ])('preserves a bounded non-semantic patch token: %s', (prompt, version) => {
    const intent = IntentRouterAgent.classify({ mode: 'meta', game: 'Palworld', prompt });

    expect(intent.version).toBe(version);
  });

  it.each([
    'How do I beat the boss in under 3.5 minutes?',
    'What is the strategy for a 99.9% success rate?',
    'Connect to 192.168.1.1 for Palworld matchmaking.',
    'Palworld 2.0 kilograms is the download estimate.',
  ])('does not extract a general decimal as a game version: %s', (prompt) => {
    const intent = IntentRouterAgent.classify({
      mode: 'guide',
      game: 'Palworld',
      prompt,
    });

    expect(intent.version).toBeUndefined();
  });

  it.each([
    ['Elite Dangerous exploration guide', 'guide', 'Elite Dangerous'],
    ['Factorio progression guide', 'guide', 'Factorio'],
    ['Hollow Knight boss guide', 'guide', 'Hollow Knight'],
    ['Caves of Qud build request', 'build', 'Caves of Qud'],
    ['Vintage Story class meta', 'meta', 'Vintage Story'],
  ])('detects an unregistered game from an anchored request: %s', (prompt, mode, game) => {
    const intent = IntentRouterAgent.classify({ prompt });

    expect(intent).toEqual(expect.objectContaining({
      mode,
      game,
      gameDetectionSource: 'prompt',
    }));
    expect(intent.gameDetectionConfidence).toBeGreaterThanOrEqual(0.8);
    expect(intent.routingSignals).toContain('detected_game');
    expect(ClarificationAgent.evaluate(intent)).toEqual({ required: false });
  });

  it.each([
    ['Find a Caves of Qud early progression guide', 'Caves of Qud'],
    ['Look up a Vintage Story progression guide', 'Vintage Story'],
    ['Search for an Elite Dangerous exploration guide', 'Elite Dangerous'],
  ])('detects an unregistered game after a discovery verb: %s', (prompt, game) => {
    const intent = IntentRouterAgent.classify({ prompt });

    expect(intent.game).toBe(game);
    expect(intent.gameDetectionConfidence).toBeGreaterThanOrEqual(0.8);
  });

  it('detects an unregistered game from a supplied guide URL when build mode needs it', () => {
    const intent = IntentRouterAgent.classify({
      prompt: 'make me a tank build',
      guideUrl: 'https://independent.example/games/caves-of-qud/build-guide',
    });

    expect(intent).toEqual(expect.objectContaining({
      mode: 'build',
      game: 'Caves of Qud',
      gameDetectionSource: 'url',
    }));
    expect(ClarificationAgent.evaluate(intent)).toEqual({ required: false });
  });

  it('detects an unregistered game from an anchored community-wiki domain', () => {
    const intent = IntentRouterAgent.classify({
      prompt: 'make me a starter build',
      guideUrl: 'https://factorio-wiki.example/',
    });

    expect(intent).toEqual(expect.objectContaining({
      mode: 'build',
      game: 'Factorio',
      gameDetectionSource: 'url',
    }));
    expect(intent.gameDetectionConfidence).toBeGreaterThanOrEqual(0.7);
    expect(ClarificationAgent.evaluate(intent)).toEqual({ required: false });
  });

  it('defers low-confidence supplied-URL build clarification until page metadata is checked', () => {
    const intent = IntentRouterAgent.classify({
      prompt: 'make me a tank build',
      guideUrl: 'https://guides.example/builds/tank',
    });

    expect(intent.game).toBeUndefined();
    expect(intent.gameDetectionConfidence).toBeLessThan(0.7);
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
    ['best build for the current patch', 'build'],
    ['meta for the latest season', 'meta'],
    ['meta for season 4', 'meta'],
    ['best build for raids', 'build'],
    ['Need a tank build lol', 'build'],
    ['wow, what is the current meta?', 'meta'],
  ])('does not infer blacklisted terms as a game: %s', (prompt, mode) => {
    const intent = IntentRouterAgent.classify({ prompt });

    expect(intent.mode).toBe(mode);
    expect(intent.game).toBeUndefined();
    expect(ClarificationAgent.evaluate(intent)).toEqual(expect.objectContaining({
      required: true,
      missing: ['game'],
    }));
  });

  it('does not treat a sentence-initial exclamation as the WoW acronym', () => {
    const intent = IntentRouterAgent.classify({ prompt: 'Wow! Give me a beginner guide' });

    expect(intent.game).toBeUndefined();
  });

  it.each([
    'New player build guide',
    'Ultimate beginner build guide',
    'Complete class build guide',
    'Endgame tank build guide',
    'Advanced raid build guide',
    'Solo build guide',
    'Duo build guide',
    'Damage build guide',
    'Glass cannon build guide',
    'Hardcore build guide',
    'Casual beginner guide',
    'Veteran progression guide',
    'Early game build guide',
    'Late game meta guide',
    'Speedrun guide',
    'Crafting progression guide',
    'Find a current guide for the title mentioned earlier.',
    'Look up the latest guide for this game.',
    'Search for a current build guide.',
  ])('does not treat generic gameplay descriptors as a game: %s', (prompt) => {
    expect(IntentRouterAgent.classify({ prompt }).game).toBeUndefined();
  });

  it.each([
    [{ prompt: 'make me a tank build', game: 'wow' }, 'wow'],
    [{ prompt: 'make me a tank build', game: 'lol' }, 'lol'],
    [{ prompt: 'WoW, what is the current meta?' }, 'World of Warcraft'],
  ])('preserves explicit values or recognizes deliberately cased prompt aliases: %#', (payload, game) => {
    expect(IntentRouterAgent.classify(payload).game).toBe(game);
  });

  it.each([
    ['Could you give me a Noita build?', 'Noita'],
    ['I need a Hollow Knight boss guide', 'Hollow Knight'],
    ['Which build should I use in Last Epoch?', 'Last Epoch'],
    ['What is the best build for Noita right now?', 'Noita'],
    ['Tell me the meta for The Finals', 'The Finals'],
    ['What is the current meta for The Finals?', 'The Finals'],
    ['meta for Helldivers 2 season 4', 'Helldivers 2'],
    ['best build for current patch in Caves of Qud', 'Caves of Qud'],
  ])('strips conversational request framing before detecting the game: %s', (prompt, game) => {
    const intent = IntentRouterAgent.classify({ prompt });

    expect(intent.game).toBe(game);
  });

  it.each([
    ['https://expert-guides.example/', 'make me a tank build'],
    ['https://nexus-guides.example/', 'best build for the current patch'],
    ['https://example.com/arcane/build', 'make me a mage build'],
  ])('does not treat a generic site brand or ambiguous path as a game: %s', (guideUrl, prompt) => {
    const intent = IntentRouterAgent.classify({ prompt, guideUrl });

    expect(intent.game).toBeUndefined();
    expect(intent.gameDetectionConfidence).toBeLessThan(0.7);
  });

  it.each([
    ['League of Legends tier list', 'League of Legends'],
    ['Overwatch 2 tier list', 'Overwatch 2'],
    ['Give me a LoL build', 'League of Legends'],
    ['Minecraft first-night survival tips', 'Minecraft'],
    ['Path of Exile 2 build guide', 'Path of Exile 2'],
    ['Morrowind main quest guide', 'Morrowind'],
  ])('preserves generic and alias title compatibility: %s', (prompt, game) => {
    const intent = IntentRouterAgent.classify({ prompt });

    expect(intent.game).toBe(game);
    expect(intent.mode).not.toBe('non-gaming');
  });

  it('prefers the anchored requested title over a comparison-game alias', () => {
    const intent = IntentRouterAgent.classify({
      prompt: 'Factorio guide for players coming from World of Warcraft',
    });

    expect(intent.game).toBe('Factorio');
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

  it('does not treat source-numbering prose as a game title', () => {
    const intent = IntentRouterAgent.classify({
      mode: 'guide',
      prompt: 'Use the linked guides for source numbering.',
    });

    expect(intent.game).toBeUndefined();
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
