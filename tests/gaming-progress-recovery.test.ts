import { describe, expect, it } from '@jest/globals';
import { assessGamingProgressionRequest } from '../src/shared/gaming/gamingProgressionPolicy.js';
import { resolveGamingPlayerContext } from '../src/shared/gaming/gamingPlayerContext.js';
import { buildGamingRecoveryResponse, resolveGamingRecoveryClass } from '../src/shared/gaming/gamingRecoveryResponse.js';
import { IntentRouterAgent, ResponseComposerAgent } from '../src/services/gamingAgents.js';

describe('Gaming progression sufficiency and player recovery', () => {
  it.each(['What next?', 'What should I do next?', 'Where do I go?', 'What am I supposed to do now?',
    "I'm stuck.", 'What now?', 'What am I supposed to do?', "I don't know what to do.",
    'What next? I am completely lost.', 'Where do I go? Please make the answer concise.',
    'Can you tell me what I should do next?', 'What should I do next in the story?',
    'I am stuck in the campaign.', 'What next? I need guidance.', 'What next? I am near the beginning.'])('asks for progress for %s', prompt => {
    const input = { mode: 'guide' as const, game: 'Lantern Voyage', prompt, evidenceSelected: false,
      difficulty: 'Hard', platform: 'PC', answerDepth: 'detailed' as const, spoilerTolerance: 'none' as const };
    expect(assessGamingProgressionRequest(input).clarificationNeeded).toBe(true);
    const response = buildGamingRecoveryResponse(input);
    expect(response).toContain('Lantern Voyage');
    expect(response.match(/\?/gu)).toHaveLength(1);
    expect(response).not.toMatch(/platform|difficulty|upgrade|repair|stock|Backend-supported|Fallback status|CLEAR|Trinity/iu);
  });

  it.each(['How do I beat Guard Armor?', 'Where is the keyhole in Wonderland?', 'How do I get Scan?',
    'What do I do after defeating the Glass Warden?', 'What should I do next after defeating the Glass Warden?'])('does not interrogate an anchored question: %s', prompt => {
    expect(assessGamingProgressionRequest({ prompt, game: 'Lantern Voyage' }).clarificationNeeded).toBe(false);
  });

  it.each(['currentArea', 'lastCompletedObjective', 'progressPoint'] as const)('uses a specific %s instead of asking again', field => {
    expect(assessGamingProgressionRequest({ prompt: 'What next?', [field]: 'Copper Quay' }).clarificationNeeded).toBe(false);
  });

  it.each(['unknown', 'somewhere', 'the current area', 'not at Copper Quay', 'if I were at Copper Quay'])('does not treat %s as usable current progress', currentArea => {
    expect(assessGamingProgressionRequest({ prompt: 'What next?', currentArea }).clarificationNeeded).toBe(true);
  });

  it.each(["I haven't defeated the Glass Warden. What next?", 'If I defeated the Glass Warden, what next?',
    'Imagine I am in Copper Quay. Where do I go?'])('does not infer state from %s', prompt => {
    const context = resolveGamingPlayerContext({}, prompt);
    expect(context.currentArea).toBeUndefined();
    expect(context.lastCompletedObjective).toBeUndefined();
    expect(assessGamingProgressionRequest({ prompt, ...context }).clarificationNeeded).toBe(true);
  });

  it('does not resolve conflicting progress claims or tentative state without asking', () => {
    expect(assessGamingProgressionRequest({ prompt: 'What next?', currentArea: 'Copper Quay', contextOrigins: { currentArea: 'tentative' } }).clarificationNeeded).toBe(true);
    const input = { mode: 'guide' as const, prompt: 'What next?', currentArea: 'Copper Quay',
      contextConflicts: ['currentArea' as const], evidenceSelected: false };
    expect(assessGamingProgressionRequest(input).clarificationNeeded).toBe(true);
    expect(buildGamingRecoveryResponse(input)).toContain('What was the last objective you completed?');
  });

  it('distinguishes known source identity from selected evidence without invented gameplay', () => {
    const input = { mode: 'guide' as const, prompt: 'What next?', game: 'Orbital Workshop', evidenceSelected: false };
    expect(buildGamingRecoveryResponse({ ...input, sourceKnown: true })).toContain('I have a guide available for Orbital Workshop');
    expect(buildGamingRecoveryResponse({ ...input, sourceKnown: false })).not.toContain('guide available');
    expect(resolveGamingRecoveryClass(input)).toBe('clarification_required');
  });

  it.each([
    { evidenceSelected: false, timedOut: false, expected: 'source_unavailable', text: "couldn't locate enough guide information" },
    { evidenceSelected: true, timedOut: true, expected: 'provider_timeout_with_evidence', text: 'I found the relevant guide material' },
    { evidenceSelected: false, timedOut: true, expected: 'provider_timeout_without_evidence', text: 'timed out' },
    { evidenceSelected: true, timedOut: false, expected: 'generation_unavailable', text: 'couldn’t complete a reliable answer' }
  ])('renders $expected with clean prose and no fictional gameplay steps', fixture => {
    const input = { mode: 'guide' as const, prompt: 'How do I beat the Ash Sentinel?', game: 'Ashbound Arena', ...fixture };
    expect(resolveGamingRecoveryClass(input)).toBe(fixture.expected);
    const response = buildGamingRecoveryResponse(input);
    expect(response).toContain(fixture.text);
    expect(response).not.toMatch(/Backend-supported|Fallback status|Why It Works|CLEAR|Trinity|provider|upgrade|repair|stock|^\d+\./imu);
    expect(response).toBe(response.trim());
    expect(response).not.toContain('\n\n\n');
  });

  it('prefers one progress question for an underspecified timeout without evidence', () => {
    const response = buildGamingRecoveryResponse({ mode: 'guide', game: 'Lantern Voyage', prompt: 'What next?', evidenceSelected: false, timedOut: true });
    expect(response.match(/\?/gu)).toHaveLength(1);
    expect(response).not.toContain('timed out');
  });

  it('preserves recovery text and diagnostic metadata separately through response composition', () => {
    const intent = { ...IntentRouterAgent.classify({ mode: 'guide', game: 'Ashbound Arena', prompt: 'How do I beat the Ash Sentinel?' }), mode: 'guide' as const };
    const response = buildGamingRecoveryResponse({ ...intent, evidenceSelected: true, timedOut: true });
    const envelope = { ok: true as const, route: 'gaming' as const, mode: 'guide' as const,
      data: { response: ` \n${response}\n `, sources: [], fallbackReason: 'INTAKE_UPSTREAM_TIMEOUT' as const } };
    const composed = ResponseComposerAgent.compose({ intent, backendEnvelope: envelope });
    expect(composed.data.response).toBe(response);
    expect(composed.data.fallbackReason).toBe('INTAKE_UPSTREAM_TIMEOUT');
    expect(envelope.data.response).not.toBe(response);
  });

  it('does not reflect Markdown links, raw secrets, or diagnostic exceptions in recovery', () => {
    const intent = { ...IntentRouterAgent.classify({ mode: 'guide', game: 'Lantern Voyage', prompt: 'How do I beat the Glass Warden?' }), mode: 'guide' as const };
    const result = ResponseComposerAgent.composeBackendFailureFallback({ intent, error: new Error('PRIVATE credential provider error') });
    expect(result.data.response).not.toMatch(/PRIVATE|provider|credential/u);
    const response = buildGamingRecoveryResponse({ mode: 'guide', prompt: 'What next?', game: '[secret](https://example.com)', evidenceSelected: false });
    expect(response).not.toContain('https://');
    const secretLabel = buildGamingRecoveryResponse({ mode: 'guide', prompt: 'What next?',
      game: `Game sk-${'syntheticfixture1234567890'}`, evidenceSelected: false });
    expect(secretLabel).not.toContain('sk-synthetic');
    expect(secretLabel).toContain('this game');
  });
});
