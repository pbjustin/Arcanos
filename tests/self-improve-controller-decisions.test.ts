import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const getConfigMock = jest.fn();
const loadLoopContractMock = jest.fn();
const writeEvidencePackMock = jest.fn();
const isSelfImproveFrozenMock = jest.fn();
const freezeSelfImproveMock = jest.fn();
const metricMock = jest.fn();
const evaluateDriftMock = jest.fn();
const logDriftSignalMock = jest.fn();
const getAutonomyLevelMock = jest.fn();
const canProposePatchesMock = jest.fn();
const createImprovementQueueMock = jest.fn();
const generateComponentReflectionMock = jest.fn();
const generatePatchProposalMock = jest.fn();
const gatherRepoContextMock = jest.fn();
const createPullRequestFromPatchMock = jest.fn();

jest.unstable_mockModule('uuid', () => ({
  v4: () => 'cycle-id-123'
}));

jest.unstable_mockModule('@platform/runtime/unifiedConfig.js', () => ({
  getConfig: getConfigMock
}));

jest.unstable_mockModule('@services/governance/loopContract.js', () => ({
  loadLoopContract: loadLoopContractMock
}));

jest.unstable_mockModule('@services/governance/evidencePack.js', () => ({
  writeEvidencePack: writeEvidencePackMock
}));

jest.unstable_mockModule('@services/incidentResponse/killSwitch.js', () => ({
  isSelfImproveFrozen: isSelfImproveFrozenMock,
  freezeSelfImprove: freezeSelfImproveMock
}));

jest.unstable_mockModule('@services/telemetry/selfImproveMetrics.js', () => ({
  metric: metricMock
}));

jest.unstable_mockModule('@services/selfImprove/driftWatcher.js', () => ({
  evaluateDrift: evaluateDriftMock,
  logDriftSignal: logDriftSignalMock
}));

jest.unstable_mockModule('@services/selfImprove/autonomy.js', () => ({
  getAutonomyLevel: getAutonomyLevelMock,
  canProposePatches: canProposePatchesMock
}));

jest.unstable_mockModule('@services/ai-reflections.js', () => ({
  createImprovementQueue: createImprovementQueueMock,
  generateComponentReflection: generateComponentReflectionMock
}));

jest.unstable_mockModule('@services/selfImprove/patchProposal.js', () => ({
  generatePatchProposal: generatePatchProposalMock
}));

jest.unstable_mockModule('@services/selfImprove/repoContext.js', () => ({
  gatherRepoContext: gatherRepoContextMock
}));

jest.unstable_mockModule('@services/git.js', () => ({
  createPullRequestFromPatch: createPullRequestFromPatchMock
}));

jest.unstable_mockModule('@core/lib/errors/index.js', () => ({
  resolveErrorMessage: (error: unknown) => String(error)
}));

jest.unstable_mockModule('@services/prAssistant.js', () => ({
  default: class MockPRAssistant {
    async analyzePR(): Promise<{ status: string; summary: string }> {
      return { status: '✅', summary: 'ok' };
    }
  }
}));

const controllerModule = await import('../src/services/selfImprove/controller.js');

describe('services/selfImprove/controller decision branches', () => {
  beforeEach(() => {
    getConfigMock.mockReset();
    loadLoopContractMock.mockReset();
    writeEvidencePackMock.mockReset();
    isSelfImproveFrozenMock.mockReset();
    freezeSelfImproveMock.mockReset();
    metricMock.mockReset();
    evaluateDriftMock.mockReset();
    logDriftSignalMock.mockReset();
    getAutonomyLevelMock.mockReset();
    canProposePatchesMock.mockReset();
    createImprovementQueueMock.mockReset();
    generateComponentReflectionMock.mockReset();
    generatePatchProposalMock.mockReset();
    gatherRepoContextMock.mockReset();
    createPullRequestFromPatchMock.mockReset();

    getConfigMock.mockReturnValue({
      selfImproveEnabled: true,
      selfImproveEnvironment: 'development',
      selfImproveActuatorMode: 'pr_bot',
      selfImproveAutonomyLevel: 1
    });
    loadLoopContractMock.mockReturnValue({
      version: 'v1',
      prohibitedPaths: [],
      rollback: { required: true }
    });
    writeEvidencePackMock.mockResolvedValue('/tmp/evidence/cycle-id-123.json');
    isSelfImproveFrozenMock.mockResolvedValue(false);
    getAutonomyLevelMock.mockResolvedValue(1);
  });

  it('enters rollback posture on high-severity drift', async () => {
    evaluateDriftMock.mockReturnValue({
      kind: 'self_test_fail',
      severity: 'high',
      details: { selfTestFailureCount: 4 }
    });

    const result = await controllerModule.runSelfImproveCycle({
      trigger: 'self_test',
      selfTestFailed: true,
      selfTestFailureCount: 4
    });

    expect(freezeSelfImproveMock).toHaveBeenCalledWith('High severity drift: self_test_fail');
    expect(result.decision).toBe('ROLLBACK');
  });

  it('escalates when drift is present but patch proposals are not allowed', async () => {
    evaluateDriftMock.mockReturnValue({
      kind: 'clear_drop',
      severity: 'medium',
      details: { clearOverall: 0.4, clearMin: 0.8 }
    });
    canProposePatchesMock.mockResolvedValue(false);

    const result = await controllerModule.runSelfImproveCycle({
      trigger: 'clear',
      clearOverall: 0.4,
      clearMin: 0.8
    });

    expect(result.decision).toBe('ESCALATE');
    expect(result.notes).toContain('Autonomy too low');
  });

  it('uses manual trigger decision path when no drift is detected', async () => {
    evaluateDriftMock.mockReturnValue({
      kind: 'none',
      severity: 'low',
      details: {}
    });
    canProposePatchesMock.mockResolvedValue(false);

    const result = await controllerModule.runSelfImproveCycle({
      trigger: 'manual'
    });

    expect(result.decision).toBe('ESCALATE');
    expect(writeEvidencePackMock).toHaveBeenCalledWith(
      expect.objectContaining({ decision: 'ESCALATE', autonomyLevel: 1 })
    );
  });
});
