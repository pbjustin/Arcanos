import { describe, expect, it } from '@jest/globals';
import { gamingStructuredResourceFixtures } from './testUtils/gamingStructuredResourceFixtures.js';
import { clearGamingBuildResourceCache, ingestGamingBuildResource, inspectGamingBuildResourceSourceUse } from '../src/services/gamingBuildResources.js';

const fixture = gamingStructuredResourceFixtures[0];
const clean = Array.from({ length: 128 }, (_, index) => `Copper shield ${index}`);
const slots = Object.fromEntries(clean.map((name, index) => [`slot-${index}`, name]));
function input(equipment: unknown, extra: Record<string, unknown> = {}) {
  const url = new URL(fixture.jsonUrl); url.search = '';
  url.searchParams.set('build', JSON.stringify({ ...fixture.payload, equipment, ...extra }));
  return { url: url.toString(), requestedGame: fixture.game };
}

describe('CR2 supported equipment fields beyond the admission count', () => {
  it.each([
    ['primitive array value', [...clean, 'No automated use.']],
    ['slot map value', { ...slots, 'slot-128': 'No automated use.' }],
    ['slot map key', { ...slots, 'No automated use.': 'Copper shield 128' }]
  ])('inspects a restriction in the 129th %s without increasing build limits', async (_label, equipment) => {
    clearGamingBuildResourceCache();
    const source = input(equipment);
    const pure = inspectGamingBuildResourceSourceUse(source);
    const result = await ingestGamingBuildResource(source, { useCache: false });
    expect({ pure, hasBuild: result.build !== null, restriction: result.sourceUseRestricted ?? false,
      failureReason: result.failureReason }).toEqual({ pure: true, hasBuild: false, restriction: true,
      failureReason: 'SOURCE_USE_RESTRICTED' });
    expect(result.evidenceText).toBe(''); expect(result.publicSnippet).toBe('');
  });

  it('preserves the 128-item admission cap for clean supported fields', async () => {
    const source = input([...clean, 'Copper shield 128']);
    expect(inspectGamingBuildResourceSourceUse(source)).toBe(false);
    const result = await ingestGamingBuildResource(source, { useCache: false });
    expect(result.build?.equipment).toHaveLength(128);
    expect(result.failureReason).toBeUndefined();
    expect(result.sourceUseRestricted).toBeUndefined();
  });

  it('does not inspect unsupported telemetry as an equipment field', async () => {
    const source = input(clean, { telemetry: { equipmentLabels: [...clean, 'No automated use.'] } });
    expect(inspectGamingBuildResourceSourceUse(source)).toBe(false);
    const result = await ingestGamingBuildResource(source, { useCache: false });
    expect(result.build?.equipment).toHaveLength(128);
    expect(result.failureReason).toBeUndefined();
    expect(result.sourceUseRestricted).toBeUndefined();
  });
});
