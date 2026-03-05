import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const getEffectiveAutonomyLevelMock = jest.fn<() => Promise<number>>();
let activeEnvironment = 'development';

jest.unstable_mockModule('@services/incidentResponse/killSwitch.js', () => ({
  getEffectiveAutonomyLevel: getEffectiveAutonomyLevelMock
}));

jest.unstable_mockModule('@platform/runtime/unifiedConfig.js', () => ({
  getConfig: () => ({ selfImproveEnvironment: activeEnvironment })
}));

const autonomyModule = await import('../src/services/selfImprove/autonomy.js');

describe('services/selfImprove/autonomy', () => {
  beforeEach(() => {
    activeEnvironment = 'development';
    getEffectiveAutonomyLevelMock.mockReset();
  });

  it('clamps autonomy into supported bounds', async () => {
    getEffectiveAutonomyLevelMock.mockResolvedValueOnce(99);
    expect(await autonomyModule.getAutonomyLevel()).toBe(3);

    getEffectiveAutonomyLevelMock.mockResolvedValueOnce(-2);
    expect(await autonomyModule.getAutonomyLevel()).toBe(0);
  });

  it('permits soft changes in non-production at level 2+', async () => {
    activeEnvironment = 'development';
    getEffectiveAutonomyLevelMock.mockResolvedValueOnce(2);

    await expect(autonomyModule.canAutoApplySoftChanges()).resolves.toBe(true);
  });

  it('requires level 3 for soft changes in production', async () => {
    activeEnvironment = 'production';
    getEffectiveAutonomyLevelMock
      .mockResolvedValueOnce(2)
      .mockResolvedValueOnce(3);

    await expect(autonomyModule.canAutoApplySoftChanges()).resolves.toBe(false);
    await expect(autonomyModule.canAutoApplySoftChanges()).resolves.toBe(true);
  });

  it('allows patch proposals only from autonomy level 1+', async () => {
    getEffectiveAutonomyLevelMock
      .mockResolvedValueOnce(0)
      .mockResolvedValueOnce(1);

    await expect(autonomyModule.canProposePatches()).resolves.toBe(false);
    await expect(autonomyModule.canProposePatches()).resolves.toBe(true);
  });
});
