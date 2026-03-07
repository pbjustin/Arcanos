import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import {
  ArcanosDagRunService,
  type DagRunWaitResult
} from '../src/services/arcanosDagRunService.js';

function buildStoredRunRecord(updatedAt: string) {
  return {
    runId: 'run-1',
    sessionId: 'session-1',
    template: 'archetype-v2',
    plannerNodeId: 'planner',
    rootNodeId: 'writer',
    status: 'running',
    createdAt: '2026-03-07T00:00:00.000Z',
    updatedAt,
    summary: {
      runId: 'run-1',
      sessionId: 'session-1',
      template: 'archetype-v2',
      status: 'running',
      plannerNodeId: 'planner',
      rootNodeId: 'writer',
      createdAt: '2026-03-07T00:00:00.000Z',
      updatedAt
    },
    nodesById: new Map(),
    events: [],
    errors: [],
    guardViolations: [],
    metrics: {
      totalNodes: 0,
      maxParallelNodesObserved: 0,
      maxSpawnDepthObserved: 0,
      totalRetries: 0,
      totalFailures: 0,
      totalAiCalls: 0,
      estimatedCostUsd: 0,
      wallClockDurationMs: 0,
      sumNodeDurationMs: 0,
      queueWaitMsP50: 0,
      queueWaitMsP95: 0
    },
    verification: {
      runCompleted: false,
      plannerSpawnedChildren: false,
      parallelExecutionObserved: false,
      aggregationRanLast: false,
      retryPolicyRespected: true,
      budgetPolicyRespected: true,
      deadlockDetected: false,
      stalledJobsDetected: false,
      loopDetected: false
    },
    limits: {
      maxConcurrency: 5,
      maxSpawnDepth: 3,
      maxChildrenPerNode: 5,
      maxRetriesPerNode: 2,
      maxAiCallsPerRun: 20,
      defaultNodeTimeoutMs: 180000
    },
    features: {
      dagOrchestration: true,
      parallelExecution: true,
      recursiveSpawning: false,
      jobTreeInspection: true,
      eventStreaming: false
    },
    loopDetected: false
  } as any;
}

describe('ArcanosDagRunService.waitForRunUpdate', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  it('returns immediately when the run is already newer than the caller cursor', async () => {
    const service = new ArcanosDagRunService();
    const record = buildStoredRunRecord('2026-03-07T00:00:05.000Z');

    (service as any).runsById.set('run-1', record);

    const result = await service.waitForRunUpdate('run-1', {
      updatedAfter: '2026-03-07T00:00:01.000Z',
      waitForUpdateMs: 5000
    });

    expect(result).toEqual({
      run: expect.objectContaining({
        runId: 'run-1',
        template: 'trinity-core',
        updatedAt: '2026-03-07T00:00:05.000Z'
      }),
      updated: true,
      waited: false
    });
  });

  it('resolves waiting callers when the run summary advances', async () => {
    const service = new ArcanosDagRunService();
    const record = buildStoredRunRecord('2026-03-07T00:00:01.000Z');

    (service as any).runsById.set('run-1', record);

    const waitPromise = service.waitForRunUpdate('run-1', {
      updatedAfter: '2026-03-07T00:00:01.000Z',
      waitForUpdateMs: 5000
    }) as Promise<DagRunWaitResult | null>;

    record.updatedAt = '2026-03-07T00:00:03.000Z';
    record.summary = {
      ...record.summary,
      updatedAt: '2026-03-07T00:00:03.000Z',
      status: 'complete'
    };
    record.status = 'complete';

    await jest.advanceTimersByTimeAsync(250);

    await expect(waitPromise).resolves.toEqual({
      run: expect.objectContaining({
        updatedAt: '2026-03-07T00:00:03.000Z',
        status: 'complete'
      }),
      updated: true,
      waited: true
    });
  });

  it('returns the latest summary when the wait window expires without a change', async () => {
    const service = new ArcanosDagRunService();
    const record = buildStoredRunRecord('2026-03-07T00:00:01.000Z');

    (service as any).runsById.set('run-1', record);

    const waitPromise = service.waitForRunUpdate('run-1', {
      updatedAfter: '2026-03-07T00:00:01.000Z',
      waitForUpdateMs: 5000
    }) as Promise<DagRunWaitResult | null>;

    await jest.advanceTimersByTimeAsync(5000);

    await expect(waitPromise).resolves.toEqual({
      run: expect.objectContaining({
        template: 'trinity-core',
        updatedAt: '2026-03-07T00:00:01.000Z'
      }),
      updated: false,
      waited: true
    });
  });

  it('canonicalizes legacy DAG template aliases in run summaries', async () => {
    const service = new ArcanosDagRunService();
    const record = buildStoredRunRecord('2026-03-07T00:00:01.000Z');

    (service as any).runsById.set('run-1', record);

    const run = await service.getRun('run-1');

    expect(run).toEqual(
      expect.objectContaining({
        pipeline: 'trinity',
        trinity_version: '1.0',
        template: 'trinity-core'
      })
    );
  });

  it('recomputes live verification data when node state changes mid-run', () => {
    const service = new ArcanosDagRunService();
    const record = buildStoredRunRecord('2026-03-07T00:00:01.000Z');

    (service as any).queuePersistRecord = jest.fn();

    record.nodesById.set('planner', {
      nodeId: 'planner',
      runId: 'run-1',
      parentNodeId: null,
      agentRole: 'planner',
      jobType: 'plan',
      status: 'complete',
      dependencyIds: [],
      spawnDepth: 0,
      attempt: 1,
      maxRetries: 2,
      input: {},
      childNodeIds: ['research', 'build', 'audit'],
      error: null,
      startedAt: '2026-03-07T00:00:00.500Z',
      completedAt: '2026-03-07T00:00:01.000Z'
    });

    record.nodesById.set('research', {
      nodeId: 'research',
      runId: 'run-1',
      parentNodeId: 'planner',
      agentRole: 'research',
      jobType: 'search',
      status: 'queued',
      dependencyIds: ['planner'],
      spawnDepth: 1,
      attempt: 1,
      maxRetries: 2,
      input: {},
      childNodeIds: ['writer'],
      error: null
    });

    record.nodesById.set('build', {
      nodeId: 'build',
      runId: 'run-1',
      parentNodeId: 'planner',
      agentRole: 'build',
      jobType: 'execute',
      status: 'queued',
      dependencyIds: ['planner'],
      spawnDepth: 1,
      attempt: 1,
      maxRetries: 2,
      input: {},
      childNodeIds: ['writer'],
      error: null
    });

    record.nodesById.set('audit', {
      nodeId: 'audit',
      runId: 'run-1',
      parentNodeId: 'planner',
      agentRole: 'audit',
      jobType: 'verify',
      status: 'queued',
      dependencyIds: ['planner'],
      spawnDepth: 1,
      attempt: 1,
      maxRetries: 2,
      input: {},
      childNodeIds: ['writer'],
      error: null
    });

    (service as any).touchRecord(record);

    expect(record.metrics.maxSpawnDepthObserved).toBe(1);
    expect(record.summary.spawnDepthMaxObserved).toBe(1);
    expect(record.verification.plannerSpawnedChildren).toBe(true);
    expect(record.verification.parallelExecutionObserved).toBe(false);
    expect((service as any).queuePersistRecord).toHaveBeenCalledWith(record);
  });

  it('records the concrete worker slot on node start events', () => {
    const service = new ArcanosDagRunService();
    const record = buildStoredRunRecord('2026-03-07T00:00:01.000Z');

    (service as any).queuePersistRecord = jest.fn();

    record.nodesById.set('research', {
      nodeId: 'research',
      runId: 'run-1',
      parentNodeId: 'planner',
      agentRole: 'research',
      jobType: 'search',
      status: 'queued',
      dependencyIds: ['planner'],
      spawnDepth: 1,
      attempt: 0,
      maxRetries: 2,
      input: {},
      childNodeIds: ['writer'],
      error: null
    });

    const observer = (service as any).createObserver(record);
    observer.onNodeStarted?.({
      dagId: 'run-1',
      nodeId: 'research',
      jobId: 'job-1',
      attempt: 0,
      startedAt: '2026-03-07T00:00:02.500Z',
      workerId: 'async-queue-slot-2'
    });

    expect(record.nodesById.get('research')?.workerId).toBe('async-queue-slot-2');
    expect(record.nodesById.get('research')?.status).toBe('running');
    expect((service as any).queuePersistRecord).toHaveBeenCalledWith(record);
  });

  it('includes worker ids in tree responses when nodes have them', async () => {
    const service = new ArcanosDagRunService();
    const record = buildStoredRunRecord('2026-03-07T00:00:04.000Z');

    record.nodesById.set('research', {
      nodeId: 'research',
      runId: 'run-1',
      parentNodeId: 'planner',
      agentRole: 'research',
      jobType: 'search',
      status: 'running',
      dependencyIds: ['planner'],
      spawnDepth: 1,
      attempt: 1,
      maxRetries: 2,
      workerId: 'async-queue-slot-2',
      input: {},
      childNodeIds: ['writer'],
      error: null,
      startedAt: '2026-03-07T00:00:03.000Z'
    });

    (service as any).runsById.set('run-1', record);

    const tree = await service.getRunTree('run-1');
    const researchNode = tree?.nodes.find(node => node.nodeId === 'research');

    expect(tree?.pipeline).toBe('trinity');
    expect(tree?.trinity_version).toBe('1.0');
    expect(researchNode?.workerId).toBe('async-queue-slot-2');
    expect(researchNode?.role).toBe('trinity_research');
  });

  it('includes Trinity lineage metadata in verification responses', async () => {
    const service = new ArcanosDagRunService();
    const record = buildStoredRunRecord('2026-03-07T00:00:04.000Z');

    record.nodesById.set('planner', {
      nodeId: 'planner',
      runId: 'run-1',
      parentNodeId: null,
      agentRole: 'planner',
      jobType: 'plan',
      status: 'complete',
      dependencyIds: [],
      spawnDepth: 0,
      attempt: 1,
      maxRetries: 2,
      workerId: 'async-queue-slot-1',
      input: {},
      childNodeIds: ['research', 'build', 'audit'],
      error: null,
      completedAt: '2026-03-07T00:00:02.000Z'
    });

    record.nodesById.set('audit', {
      nodeId: 'audit',
      runId: 'run-1',
      parentNodeId: 'planner',
      agentRole: 'audit',
      jobType: 'verify',
      status: 'running',
      dependencyIds: ['planner'],
      spawnDepth: 1,
      attempt: 1,
      maxRetries: 2,
      workerId: 'async-queue-slot-2',
      input: {},
      childNodeIds: ['writer'],
      error: null,
      startedAt: '2026-03-07T00:00:03.000Z'
    });

    (service as any).runsById.set('run-1', record);

    const verificationData = await service.getRunVerification('run-1');

    expect(verificationData?.lineage).toEqual({
      workerPipeline: 'trinity',
      workerEntryPoint: 'runWorkerTrinityPrompt',
      sessionId: 'session-1',
      sessionPropagationMode: 'inherit_run_session',
      tokenAuditSessionMode: 'dag_node_branch',
      observedWorkerIds: ['async-queue-slot-1', 'async-queue-slot-2'],
      observedSourceEndpoints: ['dag.agent.planner', 'dag.agent.audit']
    });
  });

  it('enriches DAG events with Trinity runtime markers', async () => {
    const service = new ArcanosDagRunService();
    const record = buildStoredRunRecord('2026-03-07T00:00:04.000Z');

    record.nodesById.set('planner', {
      nodeId: 'planner',
      runId: 'run-1',
      parentNodeId: null,
      agentRole: 'planner',
      jobType: 'plan',
      status: 'running',
      dependencyIds: [],
      spawnDepth: 0,
      attempt: 1,
      maxRetries: 2,
      input: {},
      childNodeIds: ['writer'],
      error: null
    });

    record.events.push({
      eventId: 'event-1',
      type: 'node.started',
      at: '2026-03-07T00:00:04.000Z',
      data: {
        runId: 'run-1',
        nodeId: 'planner'
      }
    });

    (service as any).runsById.set('run-1', record);

    const events = await service.getRunEvents('run-1');

    expect(events?.pipeline).toBe('trinity');
    expect(events?.trinity_version).toBe('1.0');
    expect(events?.events[0]?.data).toEqual({
      runId: 'run-1',
      nodeId: 'planner',
      pipeline: 'trinity',
      trinity_version: '1.0',
      role: 'trinity_planner'
    });
  });

  it('detects parallel node overlap from live timestamps before run completion', () => {
    const service = new ArcanosDagRunService();
    const record = buildStoredRunRecord('2026-03-07T00:00:39.000Z');

    (service as any).queuePersistRecord = jest.fn();

    record.nodesById.set('planner', {
      nodeId: 'planner',
      runId: 'run-1',
      parentNodeId: null,
      agentRole: 'planner',
      jobType: 'plan',
      status: 'complete',
      dependencyIds: [],
      spawnDepth: 0,
      attempt: 1,
      maxRetries: 2,
      input: {},
      childNodeIds: ['research', 'build', 'audit'],
      error: null,
      startedAt: '2026-03-07T00:00:05.200Z',
      completedAt: '2026-03-07T00:00:23.249Z'
    });

    record.nodesById.set('research', {
      nodeId: 'research',
      runId: 'run-1',
      parentNodeId: 'planner',
      agentRole: 'research',
      jobType: 'search',
      status: 'running',
      dependencyIds: ['planner'],
      spawnDepth: 1,
      attempt: 1,
      maxRetries: 2,
      input: {},
      childNodeIds: ['writer'],
      error: null,
      startedAt: '2026-03-07T00:00:23.552Z'
    });

    record.nodesById.set('build', {
      nodeId: 'build',
      runId: 'run-1',
      parentNodeId: 'planner',
      agentRole: 'build',
      jobType: 'execute',
      status: 'complete',
      dependencyIds: ['planner'],
      spawnDepth: 1,
      attempt: 1,
      maxRetries: 2,
      input: {},
      childNodeIds: ['writer'],
      error: null,
      startedAt: '2026-03-07T00:00:23.721Z',
      completedAt: '2026-03-07T00:00:43.174Z'
    });

    record.nodesById.set('audit', {
      nodeId: 'audit',
      runId: 'run-1',
      parentNodeId: 'planner',
      agentRole: 'audit',
      jobType: 'verify',
      status: 'complete',
      dependencyIds: ['planner'],
      spawnDepth: 1,
      attempt: 1,
      maxRetries: 2,
      input: {},
      childNodeIds: ['writer'],
      error: null,
      startedAt: '2026-03-07T00:00:24.146Z',
      completedAt: '2026-03-07T00:00:36.329Z'
    });

    record.nodesById.set('writer', {
      nodeId: 'writer',
      runId: 'run-1',
      parentNodeId: 'planner',
      agentRole: 'writer',
      jobType: 'synthesize',
      status: 'waiting',
      dependencyIds: ['research', 'build', 'audit'],
      spawnDepth: 1,
      attempt: 0,
      maxRetries: 2,
      input: {},
      childNodeIds: [],
      error: null
    });

    (service as any).touchRecord(record);

    expect(record.metrics.maxParallelNodesObserved).toBe(3);
    expect(record.verification.parallelExecutionObserved).toBe(true);
    expect(record.summary.totalNodes).toBe(5);
    expect((service as any).queuePersistRecord).toHaveBeenCalledWith(record);
  });
});
