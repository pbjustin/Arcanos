import { describe, expect, it, jest } from '@jest/globals';
import { WorkerQueueService } from '../src/workers/queueService.js';
import { WorkerManager, type WorkerLifecycleAdapter } from '../src/workers/manager.js';
import { evaluateScaling } from '../src/workers/scaler.js';
import { MetricsAgent } from '../src/workers/metricsAgent.js';
import { TrinityOrchestrator } from '../src/workers/orchestrator.js';
import { startAutoscalingLoop } from '../src/workers/autoscalingLoop.js';

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

  it('uses the FIFO queue head as the oldest-job latency signal', () => {
    const queueService = new WorkerQueueService();

    queueService.enqueue({
      id: 'job-head',
      payload: { step: 'head' },
      metadata: {
        domain: 'async',
        priority: 1,
        auditSafe: false,
        sessionId: 'fifo-1'
      },
      enqueuedAtMs: 1_000
    });

    queueService.enqueue({
      id: 'job-tail',
      payload: { step: 'tail' },
      metadata: {
        domain: 'async',
        priority: 1,
        auditSafe: false,
        sessionId: 'fifo-2'
      },
      enqueuedAtMs: 500
    });

    expect(queueService.getOldestJobAgeSeconds('async_queue_pool', 2_600)).toBe(1);
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

  it('returns defensive snapshots and rejects duplicate run ids', () => {
    const orchestrator = new TrinityOrchestrator();

    const startedRecord = orchestrator.startRun('run-dup');
    startedRecord.activeNodes.push('mutated-outside');

    const latestRecord = orchestrator.getRun('run-dup');
    expect(latestRecord?.activeNodes).toEqual([]);
    expect(() => orchestrator.startRun('run-dup')).toThrow('Run "run-dup" already exists.');

    latestRecord?.artifacts.push('artifact://mutated-outside');
    expect(orchestrator.getRun('run-dup')?.artifacts).toEqual([]);
  });

  it('reconciles replayed terminal node updates and retires expired terminal runs', () => {
    let nowMs = 1_000;
    const orchestrator = new TrinityOrchestrator({
      terminalRunRetentionMs: 50,
      readNowMs: () => nowMs
    });

    orchestrator.startRun('run-replay');
    orchestrator.markNodeActive('run-replay', 'node-a');
    orchestrator.markNodeCompleted('run-replay', 'node-a');
    const failedRecord = orchestrator.markNodeFailed('run-replay', 'node-a');

    expect(failedRecord.completedNodes).toEqual([]);
    expect(failedRecord.failedNodes).toEqual(['node-a']);
    expect(failedRecord.status).toBe('failed');

    const reconciledRecord = orchestrator.markNodeCompleted('run-replay', 'node-a');
    expect(reconciledRecord.completedNodes).toEqual(['node-a']);
    expect(reconciledRecord.failedNodes).toEqual([]);
    expect(reconciledRecord.status).toBe('failed');

    nowMs += 51;
    expect(orchestrator.retireExpiredRuns()).toBe(1);
    expect(orchestrator.getRun('run-replay')).toBeNull();
  });

  it('serializes autoscaling ticks when one tick runs longer than the interval', async () => {
    jest.useFakeTimers();

    try {
      const pendingScaleResolvers: Array<() => void> = [];
      const collectMetrics = jest.fn(() => ({
        async: {
          depth: 101,
          oldestJobAgeSeconds: 0
        },
        main: {
          cpuRatio: 0,
          workers: 1
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
          main: 1,
          async: 1,
          audit: 1,
          creative: 1
        },
        currentTrafficByDomain: {
          main: 1,
          async: 1,
          audit: 1,
          creative: 1
        }
      }));
      const scale = jest.fn(
        () =>
          new Promise<void>(resolve => {
            pendingScaleResolvers.push(resolve);
          })
      );

      const intervalHandle = startAutoscalingLoop(
        {
          metricsAgent: { collectMetrics } as any,
          workerManager: { scale } as any
        },
        100
      );

      await Promise.resolve();
      expect(scale).toHaveBeenCalledTimes(1);

      await jest.advanceTimersByTimeAsync(300);
      expect(scale).toHaveBeenCalledTimes(1);
      expect(collectMetrics).toHaveBeenCalledTimes(1);

      const firstScaleResolver = pendingScaleResolvers.shift();
      firstScaleResolver?.();
      await Promise.resolve();

      await jest.advanceTimersByTimeAsync(100);
      expect(scale).toHaveBeenCalledTimes(2);
      expect(collectMetrics).toHaveBeenCalledTimes(2);

      clearInterval(intervalHandle);
      const secondScaleResolver = pendingScaleResolvers.shift();
      secondScaleResolver?.();
      await Promise.resolve();
    } finally {
      jest.useRealTimers();
    }
  });

  it('executes distinct pool scale actions in parallel within one tick', async () => {
    jest.useFakeTimers();

    try {
      const resolveEvents: string[] = [];
      let releaseScaleCalls: (() => void) | null = null;
      const collectMetrics = jest.fn(() => ({
        async: {
          depth: 101,
          oldestJobAgeSeconds: 0
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
          main: 1,
          async: 1,
          audit: 1,
          creative: 1
        },
        currentTrafficByDomain: {
          main: 1,
          async: 1,
          audit: 4,
          creative: 1
        }
      }));

      const scale = jest.fn(
        async (pool: string) =>
          new Promise<void>(resolve => {
            resolveEvents.push(`started:${pool}`);

            const previousReleaseScaleCalls = releaseScaleCalls;
            releaseScaleCalls = () => {
              previousReleaseScaleCalls?.();
              resolveEvents.push(`resolved:${pool}`);
              resolve();
            };
          })
      );

      const intervalHandle = startAutoscalingLoop(
        {
          metricsAgent: { collectMetrics } as any,
          workerManager: { scale } as any
        },
        1_000
      );

      await Promise.resolve();

      expect(scale).toHaveBeenCalledTimes(3);
      expect(scale.mock.calls.map(call => call[0])).toEqual(
        expect.arrayContaining(['async_queue_pool', 'main_runtime_pool', 'audit_safe_pool'])
      );
      expect(resolveEvents).toEqual([
        'started:async_queue_pool',
        'started:main_runtime_pool',
        'started:audit_safe_pool'
      ]);

      clearInterval(intervalHandle);
      releaseScaleCalls?.();
      await Promise.resolve();
    } finally {
      jest.useRealTimers();
    }
  });
});
