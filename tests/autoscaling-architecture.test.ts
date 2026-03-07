import { describe, expect, it, jest } from '@jest/globals';
import { WorkerQueueService } from '../src/workers/queueService.js';
import { WorkerManager, type WorkerLifecycleAdapter } from '../src/workers/manager.js';
import { evaluateScaling } from '../src/workers/scaler.js';
import { MetricsAgent } from '../src/workers/metricsAgent.js';
import { TrinityOrchestrator } from '../src/workers/orchestrator.js';

function createLifecycleAdapterMock(): WorkerLifecycleAdapter {
  return {
    spawn: jest.fn(async () => undefined),
    terminate: jest.fn(async () => undefined)
  };
}

describe('Trinity autoscaling architecture', () => {
  it('routes jobs to domain-isolated pool queues', () => {
    const queueService = new WorkerQueueService();

    const selectedPool = queueService.enqueue({
      id: 'job-1',
      payload: { step: 'summarize' },
      metadata: {
        domain: 'creative',
        priority: 3,
        auditSafe: false,
        sessionId: 'abc123'
      },
      enqueuedAtMs: 1_000
    });

    expect(selectedPool).toBe('creative_domain_pool');
    expect(queueService.getQueueDepth('creative_domain_pool')).toBe(1);
    expect(queueService.getQueueDepth('main_runtime_pool')).toBe(0);
  });

  it('produces scaling actions for backlog, cpu pressure, and domain surge', () => {
    const actions = evaluateScaling({
      async: {
        depth: 101,
        oldestJobAgeSeconds: 20
      },
      main: {
        cpuRatio: 0.9,
        workers: 2
      },
      audit: {
        depth: 0,
        oldestJobAgeSeconds: 0
      },
      creative: {
        depth: 0,
        oldestJobAgeSeconds: 0
      },
      baselineTrafficByDomain: {
        main: 10,
        async: 10,
        audit: 10,
        creative: 10
      },
      currentTrafficByDomain: {
        main: 10,
        async: 10,
        audit: 40,
        creative: 5
      }
    });

    expect(actions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ pool: 'async_queue_pool', scaleTo: 5 }),
        expect.objectContaining({ pool: 'main_runtime_pool', scaleTo: 3 }),
        expect.objectContaining({ pool: 'audit_safe_pool', scaleTo: 2, reason: 'domain_surge' })
      ])
    );
  });

  it('collects metrics from queue and runtime dependencies', () => {
    const queueService = new WorkerQueueService();
    const lifecycleAdapter = createLifecycleAdapterMock();
    const manager = new WorkerManager(lifecycleAdapter);

    queueService.enqueue({
      id: 'job-2',
      payload: { x: 1 },
      metadata: {
        domain: 'async',
        priority: 1,
        auditSafe: false,
        sessionId: 's-1'
      },
      enqueuedAtMs: 1_000
    });

    const metricsAgent = new MetricsAgent({
      readCpuRatio: () => 1.2,
      queueService,
      workerManager: manager,
      readCurrentTrafficByDomain: () => ({ main: 1, async: 2, audit: 3, creative: 4 }),
      readBaselineTrafficByDomain: () => ({ main: 1, async: 1, audit: 1, creative: 1 })
    });

    const metrics = metricsAgent.collectMetrics(2_000);
    expect(metrics.main.cpuRatio).toBe(1);
    expect(metrics.async.depth).toBe(1);
    expect(metrics.async.oldestJobAgeSeconds).toBe(1);
  });

  it('tracks Trinity run state transitions with idempotent node updates', () => {
    const orchestrator = new TrinityOrchestrator();

    orchestrator.startRun('run-1');
    orchestrator.markNodeActive('run-1', 'node-a');
    orchestrator.markNodeActive('run-1', 'node-a');
    orchestrator.markNodeCompleted('run-1', 'node-a');
    orchestrator.markNodeCompleted('run-1', 'node-a');
    orchestrator.attachArtifact('run-1', 'artifact://a');
    orchestrator.attachArtifact('run-1', 'artifact://a');
    const record = orchestrator.markRunCompleted('run-1');

    expect(record.activeNodes).toEqual([]);
    expect(record.completedNodes).toEqual(['node-a']);
    expect(record.artifacts).toEqual(['artifact://a']);
    expect(record.status).toBe('completed');
  });
});
