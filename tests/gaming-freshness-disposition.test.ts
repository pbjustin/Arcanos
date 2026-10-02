import { describe, expect, it } from '@jest/globals';
import { resolveGamingFreshnessDisposition, isGamingAdvisoryCurrentnessOperation } from '../src/shared/gaming/gamingFreshnessDisposition.js';

describe('semantic Gaming freshness disposition', () => {
  it.each([
    ['How do I solve the observatory puzzle?', 'guide', 'NOT_REQUIRED'],
    ['Recommend a route through the dungeon', 'guide', 'NOT_REQUIRED'],
    ['Suggest a way to solve the bell puzzle', 'guide', 'NOT_REQUIRED'],
    ['bleed Samurai build', 'build', 'ADVISORY'],
    ['What is the best current bleed build?', 'meta', 'ADVISORY'],
    ['Recommend weapons for the latest patch', 'guide', 'ADVISORY'],
    ['Recommend a weapon for Samurai', 'guide', 'ADVISORY'],
    ['Which class should I choose?', 'guide', 'ADVISORY'],
    ['Suggest talents for a healer', 'guide', 'ADVISORY'],
    ['Which weapon should I equip?', 'guide', 'ADVISORY'],
    ['Tell me a good bleed build for the current patch', 'build', 'ADVISORY'],
    ['What build works in the current patch?', 'build', 'ADVISORY'],
    ['Which build is best on the current patch?', 'build', 'ADVISORY'],
    ['Explain the current patch Samurai build', 'build', 'ADVISORY'],
    ['Describe the current season healer strategy', 'guide', 'ADVISORY'],
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
  it.each(['SOURCE_INACCESSIBLE', 'SOURCE_INSTRUCTIONS_REJECTED', 'URL_BLOCKED', 'CONTRADICTORY_SOURCE_METADATA', 'UNKNOWN_FAILURE'])('keeps %s strict', reason => {
    expect(isGamingAdvisoryCurrentnessOperation({ decisions: [{ decision: 'rejected', reasonCodes: [reason] }] })).toBe(false);
  });
  it('allows only non-conflicting inability to verify and requires an actual completed outcome', () => {
    expect(isGamingAdvisoryCurrentnessOperation({ decisions: [] })).toBe(false);
    expect(isGamingAdvisoryCurrentnessOperation({ decisions: [{ decision: 'rejected', reasonCodes: ['INSUFFICIENT_EXTRACTION'] }] })).toBe(true);
  });
});
