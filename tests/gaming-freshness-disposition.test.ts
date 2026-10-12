import { describe, expect, it } from '@jest/globals';
import { resolveGamingFreshnessDisposition, isGamingAdvisoryCurrentnessOperation } from '../src/shared/gaming/gamingFreshnessDisposition.js';
import { classifyGamingQuestionFreshness, evaluateGamingFreshness, GAMING_SOURCE_POLICY_VERSION } from '../src/shared/gaming/gamingFreshnessCore.js';

describe('semantic Gaming freshness disposition', () => {
  it.each([
    ['How do I solve the observatory puzzle?', 'guide', 'NOT_REQUIRED'],
    ['Recommend a route through the dungeon', 'guide', 'NOT_REQUIRED'],
    ['Suggest a way to solve the bell puzzle', 'guide', 'NOT_REQUIRED'],
    ['bleed Samurai build', 'build', 'ADVISORY'],
    ['What is the best current bleed build?', 'meta', 'REQUIRED'],
    ['Recommend weapons for the latest patch', 'guide', 'REQUIRED'],
    ['Recommend a weapon for Samurai', 'guide', 'ADVISORY'],
    ['Which class should I choose?', 'guide', 'ADVISORY'],
    ['Suggest talents for a healer', 'guide', 'ADVISORY'],
    ['Which weapon should I equip?', 'guide', 'ADVISORY'],
    ['Tell me a good bleed build for the current patch', 'build', 'REQUIRED'],
    ['What build works in the current patch?', 'build', 'REQUIRED'],
    ['Which build is best on the current patch?', 'build', 'REQUIRED'],
    ['Explain the current patch Samurai build', 'build', 'REQUIRED'],
    ['Describe the current season healer strategy', 'guide', 'REQUIRED'],
    ['What is the current meta?', 'meta', 'REQUIRED'],
    ['Which weapon is strongest currently?', 'build', 'REQUIRED'],
    ['Which class is best today?', 'guide', 'REQUIRED'],
    ['Recommend the latest build for a healer', 'build', 'REQUIRED'],
    ['What changed today?', 'guide', 'REQUIRED'],
    ['Suggest an early-game mage build', 'build', 'ADVISORY'],
    ['Which stat should an early-game Samurai using an Uchigatana level first?', 'build', 'NOT_REQUIRED'],
    ['Which attribute should a starting Sentinel raise first?', 'build', 'NOT_REQUIRED'],
    ['How does equipment load affect rolling for this build?', 'build', 'NOT_REQUIRED'],
    ['What does the Endurance attribute do?', 'build', 'NOT_REQUIRED'],
    ['How do I avoid heavy rolling in Elden Ring?', 'build', 'NOT_REQUIRED'],
    ['Which stat should an early-game Samurai level first in the latest patch?', 'build', 'REQUIRED'],
    ['How do I find the academy staff?', 'guide', 'NOT_REQUIRED'],
    ['What are basic stamina mechanics?', 'guide', 'NOT_REQUIRED'],
    ['Suggest a mage strategy', 'meta', 'ADVISORY'],
    ['Recommend a build for my current area', 'build', 'ADVISORY'],
    ['Help improve my current build', 'build', 'ADVISORY'],
    ['Explain weapon maintenance mechanics for a build I can use today.', 'build', 'ADVISORY'],
    ['Are servers down now?', 'build', 'REQUIRED'],
    ['What is the current Elden Ring patch?', 'guide', 'REQUIRED'],
    ['Latest patch?', 'build', 'REQUIRED'],
    ['Current patch for Elden Ring?', 'build', 'REQUIRED'],
    ['What is the current Elden Ring build?', 'guide', 'REQUIRED'],
    ['What is the current season?', 'meta', 'REQUIRED'],
    ['What is the current event?', 'guide', 'REQUIRED'],
    ['What patch is Elden Ring on now?', 'build', 'REQUIRED'],
    ['Which Elden Ring patch is live?', 'build', 'REQUIRED'],
    ['What version is current?', 'guide', 'REQUIRED'],
    ['What build is Elden Ring running now?', 'build', 'REQUIRED'],
    ['Give me a Samurai bleed build and tell me which patch is active today.', 'build', 'REQUIRED'],
    ['Which patch is active now and recommend the best build?', 'build', 'REQUIRED'],
    ['Give me an event strategy and tell me if the event has ended.', 'build', 'REQUIRED'],
    ["What's the latest Elden Ring patch?", 'meta', 'REQUIRED'],
    ['What changed in the latest patch for weapons?', 'guide', 'REQUIRED'],
    ['Tell me the latest patch and recommend a build', 'build', 'REQUIRED'],
    ['Recommend a bleed Samurai build and summarize the latest patch notes.', 'build', 'REQUIRED'],
    ['Recommend a bleed Samurai build and list the current season.', 'build', 'REQUIRED'],
    ['Summarize the latest patch notes and recommend a bleed Samurai build.', 'build', 'REQUIRED'],
    ['List the current season and recommend a healer strategy.', 'guide', 'REQUIRED'],
    ['Explain the current patch Samurai build and summarize the latest patch notes.', 'build', 'REQUIRED'],
    ['Recommend a bleed Samurai build and summarize the latest patch notes for weapons.', 'build', 'REQUIRED'],
    ['What time does maintenance end today?', 'build', 'REQUIRED'],
    ['Is the event still live?', 'guide', 'REQUIRED'],
    ['Explain this build as of historical patch 1.09', 'build', 'REQUIRED']
  ])('%s is %s', (prompt, mode, expected) => {
    expect(resolveGamingFreshnessDisposition({ prompt, mode })).toBe(expected);
  });
  it('requires compatibility evidence for an explicitly requested patch', () => {
    expect(resolveGamingFreshnessDisposition({ prompt: 'Recommend a mage build', mode: 'build', requestedVersion: '2.1' })).toBe('REQUIRED');
  });
  it.each([
    'Keep it brief.', 'Keep it concise.', 'Keep it short.', 'Keep it detailed.',
    'Make it brief.', 'Make it concise.', 'Make it short.', 'Make it detailed.',
    'Please keep it spoiler-free.', 'Please make it spoiler free.', 'No-spoilers.'
  ])('presentation instruction %s does not change basic build freshness', instruction => {
    const input = { prompt: `How does equipment load work? ${instruction}`, mode: 'build' };
    expect(classifyGamingQuestionFreshness(input)).toBe('stable');
    expect(resolveGamingFreshnessDisposition(input)).toBe('NOT_REQUIRED');
    expect(resolveGamingFreshnessDisposition({ ...input, prompt: `${input.prompt} Explain the latest patch changes.` })).toBe('REQUIRED');
  });
  it.each([
    'How does equipment load work, create a caster build for me?',
    'How does equipment load work: give me a bleed build.',
    'Which attributes should I raise first, show me a caster loadout.',
    'What does the Endurance attribute do: provide a rotation for me.',
    'How does equipment load work for the caster build you should create for me?',
    'Can you create a caster build with stats to level first?',
    'How does equipment load work, I want a caster build?',
    'I need a caster build, how does equipment load work?',
    'How does equipment load work: we want a caster loadout.',
    'We need a caster rotation, what does the Endurance attribute do?',
    'Which attributes should I raise first, I would like a caster build.',
    'We would like a caster loadout: how does equipment load work?'
  ])('an independent build request retains advisory freshness: %s', prompt => {
    const input = { prompt, mode: 'build' };
    expect(classifyGamingQuestionFreshness(input)).toBe('patch_sensitive');
    expect(resolveGamingFreshnessDisposition(input)).toBe('ADVISORY');
  });
  it.each([
    'In Elden Ring, how does equipment load affect rolling for this build?',
    'For my starting Samurai build, which stat should I level first?',
    'For my caster build: what does the Endurance attribute do?',
    'How does equipment load work, for a build with heavy armour?',
    'What does the Endurance attribute do for a build I created?',
    'For the caster build I want, how does equipment load work?',
    'How does equipment load work for the caster build we need?',
    'I would like an explanation for this build: how does equipment load work?',
    'I want to know: how does equipment load work for this build?',
    'How does equipment load work, give me an explanation for this build?',
    'How does equipment load work, give me the details about my build?',
    'How does equipment load work: provide details about my build.',
    'How does equipment load work, show me how equipment load works for this build?',
    'How does equipment load work: give me context for this build.'
  ])('contextual build wording preserves basic freshness: %s', prompt => {
    const input = { prompt, mode: 'build' };
    expect(classifyGamingQuestionFreshness(input)).toBe('stable');
    expect(resolveGamingFreshnessDisposition(input)).toBe('NOT_REQUIRED');
  });
  it('does not treat unversioned gameplay evidence as verified applicability for an independent build request', () => {
    const now = new Date('2026-09-09T12:00:00Z');
    const evaluated = evaluateGamingFreshness({ game: 'Prism Siege', mode: 'build',
      question: 'How does equipment load work, create a caster build for me?', now,
      evidence: [{ id: 'caster-guide', game: 'Prism Siege', url: 'https://synthetic.example/caster-guide',
        policyVersion: GAMING_SOURCE_POLICY_VERSION, category: 'specialist_guide', authority: 'specialist',
        currentness: 'none', durableAllowed: true, autoStoreAllowed: false, metadataConfidence: 'content_extracted',
        fetchedAt: now.toISOString(), verifiedAt: now.toISOString() }] });
    expect(evaluated).toMatchObject({ classification: 'patch_sensitive', usable: false, status: 'unverified',
      reasons: ['CURRENT_OFFICIAL_INDEX_REQUIRED'] });
  });
  it('does not treat a request for today\'s changes as stable evidence', () => {
    expect(classifyGamingQuestionFreshness({ prompt: 'What changed today?', mode: 'guide' })).toBe('patch_sensitive');
  });
  it.each(['SOURCE_INACCESSIBLE', 'SOURCE_INSTRUCTIONS_REJECTED', 'URL_BLOCKED', 'CONTRADICTORY_SOURCE_METADATA', 'UNKNOWN_FAILURE'])('keeps %s strict', reason => {
    expect(isGamingAdvisoryCurrentnessOperation({ decisions: [{ decision: 'rejected', reasonCodes: [reason] }] })).toBe(false);
  });
  it('allows only non-conflicting inability to verify and requires an actual completed outcome', () => {
    expect(isGamingAdvisoryCurrentnessOperation({ decisions: [] })).toBe(false);
    expect(isGamingAdvisoryCurrentnessOperation({ decisions: [{ decision: 'rejected', reasonCodes: ['INSUFFICIENT_EXTRACTION'] }] })).toBe(true);
  });
});
