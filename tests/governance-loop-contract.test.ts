import { describe, expect, it, jest } from '@jest/globals';

const readFileSyncMock = jest.fn();

jest.unstable_mockModule('fs', () => ({
  default: {
    readFileSync: readFileSyncMock
  },
  readFileSync: readFileSyncMock
}));

const loopContractModule = await import('../src/services/governance/loopContract.js');

describe('services/governance/loopContract', () => {
  it('loads and caches loop contract content', () => {
    readFileSyncMock.mockReset();
    readFileSyncMock.mockReturnValue(
      JSON.stringify({
        version: 'v1',
        name: 'loop-contract',
        decisionOutputs: ['NOOP', 'PATCH_PROPOSAL'],
        autonomyLevels: { '0': 'observe', '1': 'propose' },
        prohibitedPaths: ['.git/'],
        rollback: { required: true, maxAutoRollbackAttempts: 2, rollbackOn: ['drift'] },
        evidence: { required: true, store: 'filesystem', defaultDir: 'governance/evidence', retentionDays: 14 },
        privacy: { piiScrub: true, redactCredentials: true, minimizePayload: true }
      })
    );

    const first = loopContractModule.loadLoopContract();
    const second = loopContractModule.loadLoopContract();

    expect(first).toEqual(second);
    expect(first.version).toBe('v1');
    expect(readFileSyncMock).toHaveBeenCalledTimes(1);
  });
});
