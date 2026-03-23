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
let analyzePRResult: { status: string; summary: string } = { status: '✅', summary: 'ok' };

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
      return analyzePRResult;
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
    createImprovementQueueMock.mockResolvedValue([]);
    generateComponentReflectionMock.mockResolvedValue({
      metadata: { generated: '2026-03-05T00:00:00.000Z' }
    });
    gatherRepoContextMock.mockResolvedValue(null);
    generatePatchProposalMock.mockResolvedValue({
      goal: 'improve reliability',
      summary: 'improve reliability paths',
      risk: 'low',
      files: ['src/services/selfImprove/controller.ts'],
      diff: 'diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1,1 +1,1 @@\n-const x = 1;\n+const x = 2;\n',
      commands: ['npm test'],
      successMetrics: ['branch coverage increases']
    });
    createPullRequestFromPatchMock.mockResolvedValue({
      success: true,
      message: 'ok',
      branch: 'codex/self-improve-test',
      commitHash: 'abc1234'
    });
    analyzePRResult = { status: '✅', summary: 'ok' };
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

  it('proposes patches when drift exists and policy allows proposing', async () => {
    evaluateDriftMock.mockReturnValue({
      kind: 'clear_drop',
      severity: 'medium',
      details: { clearOverall: 0.4, clearMin: 0.8 }
    });
    canProposePatchesMock.mockResolvedValue(true);

    const result = await controllerModule.runSelfImproveCycle({
      trigger: 'clear',
      clearOverall: 0.4,
      clearMin: 0.8
    });

    expect(result.decision).toBe('PATCH_PROPOSAL');
  });

  it('returns NOOP for non-manual runs when no drift is detected', async () => {
    evaluateDriftMock.mockReturnValue({
      kind: 'none',
      severity: 'low',
      details: {}
    });

    const result = await controllerModule.runSelfImproveCycle({
      trigger: 'self_test',
      selfTestFailed: false
    });

    expect(result.decision).toBe('NOOP');
  });

  it('uses manual no-drift branch to propose patches when allowed', async () => {
    evaluateDriftMock.mockReturnValue({
      kind: 'none',
      severity: 'low',
      details: {}
    });
    canProposePatchesMock.mockResolvedValue(true);

    const result = await controllerModule.runSelfImproveCycle({
      trigger: 'manual'
    });

    expect(result.decision).toBe('PATCH_PROPOSAL');
  });

  it('returns NOOP with frozen note when kill switch is active', async () => {
    isSelfImproveFrozenMock.mockResolvedValue(true);
    evaluateDriftMock.mockReturnValue({
      kind: 'none',
      severity: 'low',
      details: {}
    });

    const result = await controllerModule.runSelfImproveCycle({
      trigger: 'manual'
    });

    expect(result.decision).toBe('NOOP');
    expect(result.notes).toBe('Frozen by kill switch');
    expect(metricMock).toHaveBeenCalledWith('self_improve.frozen', expect.objectContaining({
      reason: 'kill_switch'
    }));
  });

  it('returns NOOP with disabled note when self-improve is turned off in config', async () => {
    getConfigMock.mockReturnValue({
      selfImproveEnabled: false,
      selfImproveEnvironment: 'development',
      selfImproveActuatorMode: 'pr_bot',
      selfImproveAutonomyLevel: 1
    });
    evaluateDriftMock.mockReturnValue({
      kind: 'none',
      severity: 'low',
      details: {}
    });

    const result = await controllerModule.runSelfImproveCycle({
      trigger: 'manual'
    });

    expect(result.decision).toBe('NOOP');
    expect(result.notes).toBe('Disabled by config');
    expect(metricMock).toHaveBeenCalledWith('self_improve.frozen', expect.objectContaining({
      reason: 'disabled'
    }));
  });

  it('creates a PR with repo context, fallback reflection ids, and approval labels', async () => {
    getConfigMock.mockReturnValue({
      selfImproveEnabled: true,
      selfImproveEnvironment: 'development',
      selfImproveActuatorMode: 'pr_bot',
      selfImproveAutonomyLevel: 2
    });
    evaluateDriftMock.mockReturnValue({
      kind: 'clear_drop',
      severity: 'medium',
      details: { clearOverall: 0.5, clearMin: 0.7 }
    });
    canProposePatchesMock.mockResolvedValue(true);
    createImprovementQueueMock.mockResolvedValue([
      { metadata: {} }
    ]);
    generateComponentReflectionMock.mockResolvedValue({});
    gatherRepoContextMock.mockResolvedValue({
      summary: 'repo summary',
      snippets: ['snippet-1']
    });
    generatePatchProposalMock.mockResolvedValue({
      goal: 'improve reliability',
      summary: 'improve reliability paths',
      risk: 'low',
      files: ['src/services/selfImprove/controller.ts'],
      diff: 'diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1,1 +1,1 @@\n-const x = 1;\n+const x = 2;\n'
    });
    analyzePRResult = { status: '⚠️', summary: 'needs human approval' };

    const result = await controllerModule.runSelfImproveCycle({
      trigger: 'clear',
      component: 'planner',
      clearOverall: 0.5,
      clearMin: 0.7,
      context: { source: 'test' }
    });

    expect(result.decision).toBe('PATCH_PROPOSAL');
    expect(result.reflectionIds).toEqual(expect.arrayContaining([
      expect.stringMatching(/^queue-0-/),
      expect.stringMatching(/^component-planner-/)
    ]));
    expect(generatePatchProposalMock).toHaveBeenCalledWith(expect.objectContaining({
      context: {
        source: 'test',
        repoContext: {
          summary: 'repo summary',
          snippets: ['snippet-1']
        }
      }
    }));
    expect(createPullRequestFromPatchMock).toHaveBeenCalledWith(expect.objectContaining({
      labels: ['self-improve', 'autonomy-2', 'requires-human-approval']
    }));
  });

  it('retains proposal but skips PR creation when PR gates fail', async () => {
    evaluateDriftMock.mockReturnValue({
      kind: 'clear_drop',
      severity: 'medium',
      details: { clearOverall: 0.3, clearMin: 0.8 }
    });
    canProposePatchesMock.mockResolvedValue(true);
    createImprovementQueueMock.mockResolvedValue([
      { metadata: {} },
      { metadata: { generated: '2026-03-05T00:00:00.000Z' } }
    ]);
    gatherRepoContextMock.mockRejectedValueOnce(new Error('context read failed'));
    analyzePRResult = { status: '❌', summary: 'policy gate blocked' };

    const result = await controllerModule.runSelfImproveCycle({
      trigger: 'clear',
      component: 'dispatcher',
      clearOverall: 0.3,
      clearMin: 0.8
    });

    expect(result.decision).toBe('PATCH_PROPOSAL');
    expect(result.notes).toContain('PR gates failed: policy gate blocked');
    expect(generateComponentReflectionMock).toHaveBeenCalledWith('dispatcher', { priority: 'high', useMemory: true });
    expect(createPullRequestFromPatchMock).not.toHaveBeenCalled();
  });

  it('records structured proposal failures and continues with evidence output', async () => {
    evaluateDriftMock.mockReturnValue({
      kind: 'clear_drop',
      severity: 'medium',
      details: { clearOverall: 0.2, clearMin: 0.9 }
    });
    canProposePatchesMock.mockResolvedValue(true);
    generatePatchProposalMock.mockRejectedValueOnce(new Error('proposal build failed'));

    const result = await controllerModule.runSelfImproveCycle({
      trigger: 'clear',
      clearOverall: 0.2,
      clearMin: 0.9
    });

    expect(result.decision).toBe('PATCH_PROPOSAL');
    expect(result.notes).toContain('Structured patch proposal failed');
    expect(metricMock).toHaveBeenCalledWith('self_improve.patch_structured_error', expect.any(Object));
    expect(writeEvidencePackMock).toHaveBeenCalledWith(expect.objectContaining({
      errors: expect.arrayContaining([
        expect.objectContaining({ stage: 'patch_proposal_or_pr' })
      ])
    }));
  });
});
