import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const getFeatureFlagsMock = jest.fn();
const getExecutionLimitsMock = jest.fn();
const createRunMock = jest.fn();
const inspectLatestRunMock = jest.fn();
const inspectRunTraceMock = jest.fn();
const getRunMock = jest.fn();
const getRunMetricsMock = jest.fn();

jest.unstable_mockModule('@services/openai.js', () => ({
  getDefaultModel: jest.fn(() => 'gpt-4.1-mini')
}));

jest.unstable_mockModule('@shared/tokenParameterHelper.js', () => ({
  getTokenParameter: jest.fn(() => ({ max_output_tokens: 256 }))
}));

jest.unstable_mockModule('@config/openaiStore.js', () => ({
  shouldStoreOpenAIResponses: jest.fn(() => false)
}));

jest.unstable_mockModule('@arcanos/openai/responseParsing', () => ({
  extractResponseOutputText: jest.fn((response: { output_text?: string }, fallback: string) => response.output_text || fallback)
}));

jest.unstable_mockModule('@services/arcanosDagRunService.js', () => ({
  arcanosDagRunService: {
    getFeatureFlags: getFeatureFlagsMock,
    getExecutionLimits: getExecutionLimitsMock,
    createRun: createRunMock,
    inspectLatestRun: inspectLatestRunMock,
    inspectRunTrace: inspectRunTraceMock,
    getRun: getRunMock,
    getRunMetrics: getRunMetricsMock
  }
}));

const { tryDispatchDagTools } = await import('../src/routes/ask/dagTools.js');

describe('tryDispatchDagTools', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('executes deterministic DAG creation for explicit orchestration prompts', async () => {
    createRunMock.mockReturnValue({
      pipeline: 'trinity',
      runId: 'dagrun_100_test-1',
      sessionId: 'session-123',
      template: 'trinity-core',
      status: 'queued',
      completedNodes: 0,
      failedNodes: 0,
      createdAt: '2026-03-07T12:00:00.000Z',
      updatedAt: '2026-03-07T12:00:00.000Z'
    });

    const response = await tryDispatchDagTools(
      {} as any,
      'start a dag workflow for: investigate cache invalidation regressions',
      { sessionId: 'session-123' }
    );

    expect(createRunMock).toHaveBeenCalledTimes(1);
    expect(createRunMock).toHaveBeenCalledWith({
      sessionId: 'session-123',
      template: 'trinity-core',
      input: {
        goal: 'investigate cache invalidation regressions'
      },
      options: {
        maxConcurrency: undefined,
        debug: undefined
      }
    });
    expect(response).toEqual(
      expect.objectContaining({
        module: 'dag-tools',
        result: expect.stringContaining('pipeline=trinity, template=trinity-core')
      })
    );
  });

  it('executes deterministic DAG metrics inspection when a run id is present', async () => {
    getRunMock.mockReturnValue({
      pipeline: 'trinity',
      runId: 'dagrun_200_test-2',
      template: 'trinity-core',
      status: 'running',
      completedNodes: 2,
      failedNodes: 0,
      createdAt: '2026-03-07T12:00:00.000Z',
      updatedAt: '2026-03-07T12:00:01.000Z'
    });
    getRunMetricsMock.mockReturnValue({
      runId: 'dagrun_200_test-2',
      metrics: {
        totalNodes: 5,
        maxParallelNodesObserved: 3,
        maxSpawnDepthObserved: 1,
        totalRetries: 1,
        totalFailures: 0,
        totalAiCalls: 5,
        estimatedCostUsd: 0.02,
        wallClockDurationMs: 1000,
        sumNodeDurationMs: 900,
        queueWaitMsP50: 10,
        queueWaitMsP95: 20
      },
      limits: {
        maxConcurrency: 5,
        maxSpawnDepth: 3,
        maxChildrenPerNode: 5,
        maxRetriesPerNode: 2,
        maxAiCallsPerRun: 20,
        defaultNodeTimeoutMs: 180000
      },
      guardViolations: []
    });

    const response = await tryDispatchDagTools(
      {} as any,
      'show dag metrics for dagrun_200_test-2'
    );

    expect(getRunMetricsMock).toHaveBeenCalledTimes(1);
    expect(getRunMetricsMock).toHaveBeenCalledWith('dagrun_200_test-2');
    expect(getRunMock).toHaveBeenCalledTimes(1);
    expect(getRunMock).toHaveBeenCalledWith('dagrun_200_test-2');
    expect(response).toEqual(
      expect.objectContaining({
        module: 'dag-tools',
        result: expect.stringContaining('pipeline=trinity, template=trinity-core')
      })
    );
  });

  it('returns the latest DAG run summary for most-recent prompts without invoking OpenAI', async () => {
    inspectLatestRunMock.mockResolvedValue({
      run: {
        pipeline: 'trinity',
        trinity_version: '1.0',
        runId: 'dagrun_300_latest',
        sessionId: 'session-123',
        template: 'trinity-core',
        status: 'complete',
        createdAt: '2026-03-07T12:00:00.000Z',
        updatedAt: '2026-03-07T12:00:05.000Z'
      },
      diagnostics: {
        snapshotSource: 'persisted',
        localLookupMs: 0,
        persistedLookupMs: 4,
        totalMs: 4
      }
    });

    const response = await tryDispatchDagTools(
      {} as any,
      'Trace the most recent DAG run with full lineage, nodes, events, metrics, and verification summary.',
      { sessionId: 'session-123', logger: { info: jest.fn(), warn: jest.fn() } as any }
    );

    expect(inspectLatestRunMock).toHaveBeenCalledWith('session-123');
    expect(inspectRunTraceMock).not.toHaveBeenCalled();
    expect(response).toEqual(
      expect.objectContaining({
        module: 'dag-tools',
        result: expect.stringContaining('Most recent DAG run is dagrun_300_latest'),
      })
    );
  });

  it('collapses explicit full-trace requests into one bounded inspection', async () => {
    inspectRunTraceMock.mockResolvedValue({
      trace: {
        pipeline: 'trinity',
        trinity_version: '1.0',
        run: {
          pipeline: 'trinity',
          trinity_version: '1.0',
          runId: 'dagrun_400_trace',
          sessionId: 'session-123',
          template: 'trinity-core',
          status: 'running',
          createdAt: '2026-03-07T12:00:00.000Z',
          updatedAt: '2026-03-07T12:00:05.000Z'
        },
        tree: { pipeline: 'trinity', trinity_version: '1.0', runId: 'dagrun_400_trace', nodes: [{ nodeId: 'planner' }] },
        events: { pipeline: 'trinity', trinity_version: '1.0', runId: 'dagrun_400_trace', events: [{ eventId: 'evt-1' }] },
        metrics: { runId: 'dagrun_400_trace', metrics: {}, limits: {}, guardViolations: [] },
        errors: { runId: 'dagrun_400_trace', errors: [] },
        lineage: { runId: 'dagrun_400_trace', lineage: [{ nodeId: 'planner' }], loopDetected: false },
        verification: {
          pipeline: 'trinity',
          trinity_version: '1.0',
          runId: 'dagrun_400_trace',
          verification: { runCompleted: false },
          lineage: { workerPipeline: 'trinity' }
        },
        sections: {
          requested: ['run', 'tree', 'events', 'metrics', 'errors', 'lineage', 'verification'],
          events: { total: 10, returned: 10, truncated: false, maxEvents: 200 }
        }
      },
      diagnostics: {
        snapshotSource: 'persisted',
        localLookupMs: 0,
        persistedLookupMs: 5,
        buildMs: {
          run: 0,
          tree: 1,
          events: 1,
          metrics: 0,
          errors: 0,
          lineage: 0,
          verification: 0
        },
        totalMs: 7,
        payload: {
          nodes: 1,
          totalEvents: 10,
          returnedEvents: 10,
          errors: 0,
          lineageEntries: 1
        }
      }
    });

    const response = await tryDispatchDagTools(
      {} as any,
      'Show the full trace for dagrun_400_trace with lineage, nodes, events, metrics, and verification.'
    );

    expect(inspectRunTraceMock).toHaveBeenCalledWith('dagrun_400_trace', {
      maxEvents: undefined,
    });
    expect(response).toEqual(
      expect.objectContaining({
        module: 'dag-tools',
        result: expect.stringContaining('DAG trace for dagrun_400_trace includes nodes=1'),
      })
    );
  });

  it('falls back to OpenAI tool-calling for non-deterministic orchestration prompts', async () => {
    getFeatureFlagsMock.mockReturnValue({
      dagOrchestration: true,
      parallelExecution: true,
      recursiveSpawning: false,
      jobTreeInspection: true,
      eventStreaming: false
    });
    getExecutionLimitsMock.mockReturnValue({
      maxConcurrency: 5,
      maxSpawnDepth: 3,
      maxChildrenPerNode: 5,
      maxRetriesPerNode: 2,
      maxAiCallsPerRun: 20,
      defaultNodeTimeoutMs: 180000
    });

    const createMock = jest
      .fn()
      .mockResolvedValueOnce({
        id: 'resp-1',
        model: 'gpt-4.1-mini',
        output: [
          {
            type: 'function_call',
            name: 'get_dag_capabilities',
            call_id: 'call-1',
            arguments: '{}'
          }
        ]
      })
      .mockResolvedValueOnce({
        id: 'resp-2',
        model: 'gpt-4.1-mini',
        output: [],
        output_text: 'DAG orchestration is available with parallel execution enabled.'
      });

    const response = await tryDispatchDagTools(
      {
        responses: {
          create: createMock
        }
      } as any,
      'inspect the orchestration workflow and decide which DAG control tool to use'
    );

    expect(getFeatureFlagsMock).toHaveBeenCalledTimes(1);
    expect(getExecutionLimitsMock).toHaveBeenCalledTimes(1);
    expect(createMock).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        tools: expect.arrayContaining([
          expect.objectContaining({
            type: 'function',
            name: 'get_dag_capabilities'
          })
        ])
      })
    );
    expect(createMock.mock.calls[1]?.[0]?.previous_response_id).toBeUndefined();
    expect(createMock.mock.calls[1]?.[0]?.input).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: 'user',
          content: 'inspect the orchestration workflow and decide which DAG control tool to use'
        }),
        expect.objectContaining({
          type: 'function_call',
          name: 'get_dag_capabilities',
          call_id: 'call-1'
        }),
        expect.objectContaining({
          type: 'function_call_output',
          call_id: 'call-1'
        })
      ])
    );
    expect(response).toEqual(
      expect.objectContaining({
        module: 'dag-tools',
        result: 'DAG orchestration is available with parallel execution enabled.'
      })
    );
  });
});
