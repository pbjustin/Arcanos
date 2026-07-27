import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const persistDecisionMock = jest.fn();
const logDecisionMock = jest.fn();
const projectDecisionMock = jest.fn();
const executeRouteMock = jest.fn();
const recordTraceEventMock = jest.fn();

jest.unstable_mockModule('@core/afol/analytics.js', () => ({
  persistDecision: persistDecisionMock,
}));
jest.unstable_mockModule('@core/afol/logger.js', () => ({
  logDecision: logDecisionMock,
}));
jest.unstable_mockModule('@core/afol/persistence.js', () => ({
  projectAfolDecisionForPersistence: projectDecisionMock,
}));
jest.unstable_mockModule('@core/afol/routes.js', () => ({
  executeRoute: executeRouteMock,
}));
jest.unstable_mockModule('@core/afol/health.js', () => ({
  getStatus: jest.fn(() => ({
    primary: { ok: true, latency: 1 },
  })),
}));
jest.unstable_mockModule('@core/afol/policies.js', () => ({
  evaluate: jest.fn(() => ({
    allow: true,
    primaryAvailable: true,
    backupAvailable: false,
    rationale: 'Primary path stable',
  })),
}));
jest.unstable_mockModule('@shared/idGenerator.js', () => ({
  generateRequestId: jest.fn(() => 'afol-engine-test'),
}));
jest.unstable_mockModule('@platform/logging/telemetry.js', () => ({
  recordTraceEvent: recordTraceEventMock,
}));
jest.unstable_mockModule('@services/safety/interpreterSupervisor.js', () => ({
  interpreterSupervisor: {
    runSupervisedCycle: jest.fn(
      async (
        _name: string,
        operation: (heartbeat: () => void) => Promise<unknown>
      ) => operation(() => {})
    ),
  },
}));

const { decide } = await import('../src/core/afol/engine.js');

describe('AFOL engine persistence isolation', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    executeRouteMock.mockResolvedValue({
      route: 'primary',
      input: 'private prompt',
      output: 'successful answer',
      model: 'private-model',
      cached: true,
      metadata: {
        intent: 'private intent',
      },
    });
    projectDecisionMock.mockReturnValue({
      kind: 'decision',
      id: 'afol-engine-test',
      timestamp: '2026-07-27T12:00:00.000Z',
      ok: true,
      route: 'primary',
      latencyMs: 1,
      cached: true,
      degraded: false,
    });
  });

  it('projects once and preserves a successful decision when both persistence sinks reject', async () => {
    persistDecisionMock.mockRejectedValue(
      new Error('analytics persistence sentinel')
    );
    logDecisionMock.mockImplementation(() => {
      throw new Error('logger persistence sentinel');
    });

    const result = await decide({
      prompt: 'private prompt',
      intent: 'private intent',
    });

    expect(result.ok).toBe(true);
    expect(result.response.output).toBe('successful answer');
    expect(projectDecisionMock).toHaveBeenCalledTimes(1);
    expect(projectDecisionMock).toHaveBeenCalledWith(result);
    const projected = projectDecisionMock.mock.results[0]?.value;
    expect(persistDecisionMock).toHaveBeenCalledWith(projected);
    expect(logDecisionMock).toHaveBeenCalledWith(projected);
  });
});
