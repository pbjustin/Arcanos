import { describe, expect, it } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { BackendQueryAgent, ClarificationAgent, IntentRouterAgent } from '../src/services/gamingAgents.js';
import { parsePublicGamingQueryRequest, validateGamingRequest } from '../src/services/gamingModes.js';
import { GAMING_CONTEXT_STRING_LIMITS, resolveGamingPlayerContext, validateGamingPlayerContextInput } from '../src/shared/gaming/gamingPlayerContext.js';

const context = {
  platform: 'PC', edition: 'Original', version: '1.2', difficulty: 'Hard',
  currentArea: 'Copper Harbor', lastCompletedObjective: 'Restored the ferry beacon',
  progressPoint: 'Dock checkpoint', class: 'Navigator', role: 'Support',
  constraints: ['No rare fuel', 'Solo'], spoilerTolerance: 'light', answerDepth: 'standard'
};

describe('validated request-scoped Gaming player context', () => {
  it.each(['contracts/arcanos_gaming.openapi.v1.json', 'contracts/custom_gpt_route.openapi.v1.json'])('keeps the maintained public schema bounds aligned: %s', file => {
    const schema = JSON.parse(readFileSync(file, 'utf8')).components.schemas.GamingQueryPayload;
    expect(schema.additionalProperties).toBe(false);
    expect(schema.required).toEqual(['mode', 'prompt']);
    for (const [field, maximum] of Object.entries(GAMING_CONTEXT_STRING_LIMITS)) {
      expect(schema.properties[field]).toMatchObject({ type: 'string', minLength: 1, maxLength: maximum });
    }
    expect(schema.properties.spoilerTolerance.enum).toEqual(['none', 'light', 'full', 'avoid', 'allowed', 'unknown', 'no spoilers', 'ok', 'spoilers ok']);
    expect(schema.properties.answerDepth.enum).toEqual(['auto', 'concise', 'standard', 'detailed']);
    expect(schema.properties.constraints).toMatchObject({ maxItems: 8, items: { maxLength: 160 } });
    expect(schema.properties.spoilerMode).toBeUndefined();
  });
  it.each(['Lantern Vale', 'Iron Duel', 'Star Hauler'])('forwards every field through public validation, intent, backend mapping and backend validation for %s', game => {
    const publicRequest = parsePublicGamingQueryRequest({ action: 'query', payload: { mode: 'guide', game, prompt: 'What next?', ...context } });
    expect(publicRequest.ok).toBe(true);
    if (!publicRequest.ok) throw new Error('Expected public request');
    const intent = IntentRouterAgent.classify(publicRequest.value.payload);
    const action = BackendQueryAgent.build({ ...intent, mode: 'guide' });
    const validated = validateGamingRequest(action.payload);
    expect(validated.ok).toBe(true);
    if (!validated.ok) throw new Error('Expected backend request');
    expect(validated.value).toMatchObject({ ...context, game, spoilerMode: 'light', requestedVersion: '1.2' });
    for (const field of Object.keys(context)) expect(validated.value.contextOrigins?.[field as keyof typeof context]).toBe('explicit');
    expect(JSON.stringify(action)).not.toMatch(/contextOrigins|contextConflicts|spoilerMode/);
  });

  it('keeps the legacy minimum request usable without claiming an explicit spoiler preference', () => {
    const result = validateGamingRequest({ mode: 'guide', prompt: 'How do I use the grappling hook?' });
    expect(result).toMatchObject({ ok: true, value: { spoilerMode: 'none', answerDepth: 'auto', contextOrigins: { spoilerTolerance: 'default' } } });
  });

  it('preserves userInput prompt aliases and explicit payload precedence', () => {
    expect(parsePublicGamingQueryRequest({ action: 'query', prompt: 'Check my backend.', payload: { mode: 'guide', userInput: 'What next?', currentArea: 'Copper Harbor' } }))
      .toMatchObject({ ok: true, value: { payload: { prompt: 'What next?', currentArea: 'Copper Harbor' } } });
    expect(parsePublicGamingQueryRequest({ action: 'query', userInput: 'What next?', payload: { mode: 'guide' } }))
      .toMatchObject({ ok: true, value: { payload: { prompt: 'What next?' } } });
  });

  it.each(['If I install patch 2.1, what changes?', 'I am not using patch 2.1. What next?'])('does not turn a hypothetical or denied version into a player-state selector: %s', prompt => {
    const intent = IntentRouterAgent.classify({ mode: 'guide', game: 'Lantern Vale', prompt });
    expect(intent.version).toBeUndefined();
    const result = validateGamingRequest(BackendQueryAgent.build({ ...intent, mode: 'guide' }).payload);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.requestedVersion).toBeUndefined();
  });

  it.each(Object.entries(GAMING_CONTEXT_STRING_LIMITS))('rejects oversized %s before normalizing it', (field, maximum) => {
    const payload = { mode: 'guide', prompt: 'What next?', [field]: `x${' '.repeat(maximum)}` };
    expect(parsePublicGamingQueryRequest({ action: 'query', payload }).ok).toBe(false);
    expect(validateGamingRequest(payload).ok).toBe(false);
  });

  it.each([
    { constraints: ['a'.repeat(161)] }, { constraints: Array(9).fill('solo') }, { constraints: 'solo' },
    { spoilerTolerance: 'maybe' }, { spoilerTolerance: '__proto__' }, { answerDepth: 'unlimited' },
    { edition: 'Original\u202e' }, { currentArea: '' }, { role: null },
    { ...Object.fromEntries(Object.entries(GAMING_CONTEXT_STRING_LIMITS).map(([key, count]) => [key, 'x'.repeat(count)])), constraints: Array(8).fill('x'.repeat(160)) }
  ])('rejects invalid or aggregate oversized context %j', supplied => {
    expect(validateGamingPlayerContextInput(supplied)).toBeDefined();
    expect(parsePublicGamingQueryRequest({ action: 'query', payload: { mode: 'guide', prompt: 'What next?', ...supplied } }).ok).toBe(false);
  });

  it.each(['contextOrigins', 'contextConflicts', 'spoilerMode', 'playerContext', '__proto__', 'constructor'])('rejects unsupported or server-owned public field %s', field => {
    const payload = JSON.parse(`{"mode":"guide","prompt":"What next?","${field}":{}}`);
    expect(parsePublicGamingQueryRequest({ action: 'query', payload })).toMatchObject({ ok: false, error: { code: 'BAD_REQUEST' } });
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('retains explicit payload context over top-level aliases and bounds inherited values', () => {
    const parsed = parsePublicGamingQueryRequest({ action: 'query', currentArea: 'Old Mill', platform: 'PC', payload: { mode: 'guide', prompt: 'What next?', currentArea: 'Harbor' } });
    expect(parsed).toMatchObject({ ok: true, value: { payload: { currentArea: 'Harbor', platform: 'PC' } } });
    expect(parsePublicGamingQueryRequest({ action: 'query', currentArea: 'x'.repeat(161), payload: { mode: 'guide', prompt: 'What next?' } }).ok).toBe(false);
  });

  it.each([
    ['version', 'patch', '1.2', '2.0', 'version', '1.2'],
    ['version', 'requestedVersion', '1.2', '2.0', 'version', '1.2'],
    ['class', 'className', 'Navigator', 'Scout', 'class', 'Navigator'],
    ['progressPoint', 'progress', 'Dock checkpoint', 'Old Mill', 'progressPoint', 'Dock checkpoint'],
    ['progressPoint', 'checkpoint', 'Dock checkpoint', 'Old Mill', 'progressPoint', 'Dock checkpoint'],
    ['patch', 'version', '1.2', '2.0', 'version', '1.2'],
    ['requestedVersion', 'version', '1.2', '2.0', 'version', '1.2'],
    ['className', 'class', 'Navigator', 'Scout', 'class', 'Navigator'],
    ['progress', 'progressPoint', 'Dock checkpoint', 'Old Mill', 'progressPoint', 'Dock checkpoint'],
    ['checkpoint', 'progressPoint', 'Dock checkpoint', 'Old Mill', 'progressPoint', 'Dock checkpoint'],
    ['progress', 'checkpoint', 'Dock checkpoint', 'Old Mill', 'progressPoint', 'Dock checkpoint']
  ])('gives nested %s precedence over top-level equivalent %s', (nestedField, topField, nestedValue, topValue, canonical, expected) => {
    const parsed = parsePublicGamingQueryRequest({
      action: 'query', [topField]: topValue,
      payload: { mode: 'guide', game: 'Lantern Vale', prompt: 'What next?', [nestedField]: nestedValue }
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error('Expected valid nested context');
    expect(parsed.value.payload).not.toHaveProperty(topField);
    const intent = IntentRouterAgent.classify(parsed.value.payload);
    expect(intent).toMatchObject({ [canonical]: expected, contextConflicts: [] });
    expect(ClarificationAgent.evaluate(intent)).toEqual({ required: false });
    const backend = validateGamingRequest(BackendQueryAgent.build({ ...intent, mode: 'guide' }).payload);
    expect(backend).toMatchObject({ ok: true, value: { [canonical]: expected, contextConflicts: [] } });
  });

  it.each([
    'How do I beat the Brass Warden?', 'I have not defeated the Brass Warden.',
    "I haven't completed the beacon.", 'If I defeated the Brass Warden, what next?',
    'Imagine I am in Copper Harbor.', 'The guide says I am at the final palace.',
    'After the Brass Warden, where should I go?', 'I am not in Copper Harbor.'
  ])('does not turn a question, negation, hypothetical or source claim into progression: %s', prompt => {
    const intent = IntentRouterAgent.classify({ mode: 'guide', prompt });
    expect(intent.lastCompletedObjective).toBeUndefined();
    expect(intent.currentArea).toBeUndefined();
    expect(intent.progressPoint).toBeUndefined();
  });

  it('takes affirmative first-person progression only from the current question', () => {
    const value = resolveGamingPlayerContext({}, 'I am at Copper Harbor. I have completed the ferry beacon. What next?');
    expect(value).toMatchObject({ currentArea: 'Copper Harbor', lastCompletedObjective: 'the ferry beacon', contextOrigins: { currentArea: 'question', lastCompletedObjective: 'question' } });
  });

  it.each([
    ['Lantern Voyage 1.5 Remix', 'Copper Harbor'],
    ['Iron Duel II: Remake', 'Ash Foundry'],
    ['Star Hauler 2.0', 'Glass Dock'],
    ['İris 2.0', 'Copper Harbor']
  ])('does not mistake a repeated game title for part of the current area: %s', (game, currentArea) => {
    const prompt = `I am in ${currentArea} in ${game}. I finished the first local objective. What should I do next? No spoilers, and keep the answer concise.`;
    const payload = { mode: 'guide', game, prompt, currentArea,
      progressPoint: 'immediately after the first local objective', spoilerTolerance: 'none', answerDepth: 'concise' };
    const parsed = parsePublicGamingQueryRequest({ action: 'query', payload });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error('Expected valid browser Action request');
    const intent = IntentRouterAgent.classify(parsed.value.payload);
    expect(intent).toMatchObject({ currentArea, contextConflicts: [] });
    expect(ClarificationAgent.evaluate(intent)).toEqual({ required: false });
    const backend = validateGamingRequest(BackendQueryAgent.build({ ...intent, mode: 'guide' }).payload);
    expect(backend).toMatchObject({ ok: true, value: { currentArea, contextConflicts: [] } });
    expect(resolveGamingPlayerContext({ game }, prompt)).toMatchObject({ currentArea,
      contextOrigins: { currentArea: 'question' }, contextConflicts: [] });
  });

  it('keeps real area conflicts and unmatched location or edition suffixes', () => {
    const payload = { game: 'Lantern Voyage 1.5 Remix', currentArea: 'Copper Harbor' };
    expect(resolveGamingPlayerContext(payload, 'I am in Old Mill in Lantern Voyage 1.5 Remix. What next?').contextConflicts)
      .toContain('currentArea');
    expect(resolveGamingPlayerContext(payload, 'I am in Copper Harbor in Lower Basin. What next?').contextConflicts)
      .toContain('currentArea');
    expect(resolveGamingPlayerContext(payload, 'I am in Copper Harbor in Lantern Voyage II. What next?').contextConflicts)
      .toContain('currentArea');
    expect(resolveGamingPlayerContext(payload, 'I am in Copper Harbor in Lantern Voyage 1x5 Remix. What next?').contextConflicts)
      .toContain('currentArea');
    expect(resolveGamingPlayerContext({ game: payload.game }, 'I am in Copper Harbor in Lower Basin. What next?').currentArea)
      .toBe('Copper Harbor in Lower Basin');
  });

  it.each(['I am not in Copper Harbor', 'If I am in Copper Harbor', 'Imagine I am in Copper Harbor'])('does not infer an area from a repeated title in %s', statement => {
    const game = 'Lantern Voyage 1.5 Remix';
    expect(resolveGamingPlayerContext({ game }, `${statement} in ${game}. What next?`).currentArea).toBeUndefined();
  });

  it.each([
    { currentArea: 'Old Mill', prompt: 'I am at Copper Harbor. What next?' },
    { prompt: 'I am at Old Mill. I am at Copper Harbor. What next?' },
    { version: '1.0', requestedVersion: '2.0', prompt: 'What next?' }
  ])('asks one targeted question for conflicting material context', payload => {
    const intent = IntentRouterAgent.classify({ mode: 'guide', game: 'Lantern Vale', ...payload });
    expect(ClarificationAgent.evaluate(intent)).toMatchObject({ required: true, mode: 'guide', question: expect.stringMatching(/^Which (current area|version) should I use\?/) });
  });

  it('normalizes compatible version/progression aliases and keeps precise titles and edition claims separate', () => {
    const intent = IntentRouterAgent.classify({ mode: 'guide', game: 'Iron Duel II: Complete Edition', prompt: 'What next?', version: 'v1.2', requestedVersion: '1.2', checkpoint: 'Gate', className: 'Scout', guideUrl: 'https://example.com/iron-duel-remastered' });
    expect(intent).toMatchObject({ game: 'Iron Duel II: Complete Edition', version: '1.2', progressPoint: 'Gate', class: 'Scout', contextConflicts: [] });
    expect(intent.edition).toBeUndefined();
  });

  it.each([
    ['none', 'none'], ['light', 'light'], ['full', 'full'], ['avoid', 'none'], ['allowed', 'full'],
    ['unknown', 'none'], ['no spoilers', 'none'], ['ok', 'full'], ['spoilers ok', 'full']
  ])('maps spoiler preference %s to %s', (spoilerTolerance, spoilerMode) => {
    expect(resolveGamingPlayerContext({ spoilerTolerance }, 'What next?').spoilerMode).toBe(spoilerMode);
  });

  it.each([
    [{ spoilerTolerance: 'full' }, 'No spoilers please.', 'none'],
    [{ spoilerTolerance: 'none' }, 'Include full spoilers.', 'none'],
    [{ spoilerTolerance: 'light' }, 'Spoilers allowed.', 'light'],
    [{}, 'I do not want spoilers allowed.', 'none'],
    [{}, 'If spoilers were allowed, could you explain?', 'none']
  ])('never widens contradictory spoiler permissions', (payload, prompt, mode) => {
    expect(resolveGamingPlayerContext(payload, prompt as string).spoilerMode).toBe(mode);
  });

  it.each([
    ['Not a detailed explanation, keep it brief.', 'detailed', 'concise'],
    ['Explain in detail.', 'concise', 'detailed'],
    ['No detailed explanation.', 'standard', 'standard'],
    ['How does it work?', 'detailed', 'detailed']
  ])('resolves explicit question depth ahead of structured depth', (prompt, answerDepth, effective) => {
    expect(resolveGamingPlayerContext({ answerDepth }, prompt).answerDepth).toBe(effective);
  });
});
