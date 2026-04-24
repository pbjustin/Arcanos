import { describe, expect, it, jest } from '@jest/globals';

import {
  measureJsonBytes,
  prepareBoundedClientJsonPayload,
  shapeClientRouteResult,
  withJsonResponseBytes,
} from '../src/shared/http/clientResponseGuards.js';
import { truncateText } from '../src/shared/http/clientResponseCommon.js';

describe('client response guards', () => {
  it('reduces oversized MCP health results to a compact public shape', () => {
    const rawResult = {
      handledBy: 'mcp-dispatcher',
      mcp: {
        action: 'invoke',
        toolName: 'ops.health_report',
        dispatchMode: 'automatic',
        reason: 'prompt_requests_ops_health',
        output: {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                status: 'ok',
                summary: 'Heap stable',
                raw: { heapUsed: 12345678 },
              }),
            },
          ],
          structuredContent: {
            status: 'ok',
            summary: 'Heap stable',
            raw: {
              heapUsed: 12345678,
              rss: 98765432,
            },
            components: {
              workers: {
                healthy: true,
                files: new Array(50).fill('worker.js'),
              },
            },
          },
        },
      },
    };

    const shaped = shapeClientRouteResult(rawResult) as Record<string, unknown>;
    const mcp = shaped.mcp as Record<string, unknown>;
    const output = mcp.output as Record<string, unknown>;

    expect(shaped).toEqual({
      handledBy: 'mcp-dispatcher',
      mcp: {
        action: 'invoke',
        toolName: 'ops.health_report',
        dispatchMode: 'automatic',
        reason: 'prompt_requests_ops_health',
        output: {
          status: 'ok',
          summary: 'Heap stable',
        },
      },
    });
    expect(output.raw).toBeUndefined();
    expect(measureJsonBytes(shaped)).toBeLessThan(1024);
  });

  it('preserves node-level DAG trace output for MCP dispatcher responses', () => {
    const shaped = shapeClientRouteResult({
      handledBy: 'mcp-dispatcher',
      mcp: {
        action: 'invoke',
        toolName: 'dag.run.trace',
        dispatchMode: 'automatic',
        reason: 'prompt_requests_latest_dag_run',
        output: {
          run: {
            runId: 'dagrun_trace_1',
            sessionId: 'sess-1',
            status: 'complete',
            template: 'trinity-core',
            durationMs: 181693,
            totalNodes: 2,
            completedNodes: 2,
            failedNodes: 0,
            createdAt: '2026-03-24T08:05:19.514Z',
            updatedAt: '2026-03-24T08:08:21.207Z',
          },
          tree: {
            nodes: [
              {
                nodeId: 'planner',
                agentRole: 'planner',
                jobType: 'plan',
                status: 'complete',
                workerId: 'async-queue-slot-2',
                spawnDepth: 0,
                startedAt: '2026-03-24T08:05:55.425Z',
                completedAt: '2026-03-24T08:06:28.711Z',
              },
              {
                nodeId: 'writer',
                agentRole: 'writer',
                jobType: 'synthesize',
                status: 'complete',
                workerId: 'async-queue-slot-3',
                spawnDepth: 2,
                startedAt: '2026-03-24T08:07:48.844Z',
                completedAt: '2026-03-24T08:08:21.168Z',
              },
            ],
          },
          metrics: {
            metrics: {
              totalNodes: 2,
              totalAiCalls: 2,
              totalRetries: 0,
              totalFailures: 0,
              wallClockDurationMs: 181693,
              maxParallelNodesObserved: 1,
              maxSpawnDepthObserved: 2,
            },
          },
          verification: {
            verification: {
              runCompleted: true,
              parallelExecutionObserved: false,
              aggregationRanLast: true,
              retryPolicyRespected: true,
              budgetPolicyRespected: true,
              loopDetected: false,
            },
          },
          lineage: {
            lineage: [{ nodeId: 'planner' }, { nodeId: 'writer' }],
            loopDetected: false,
          },
          errors: {
            errors: [],
          },
          sections: {
            requested: ['run', 'tree', 'metrics', 'verification'],
            events: {
              total: 22,
              returned: 22,
              truncated: false,
              maxEvents: 200,
            },
          },
        },
      },
    }) as Record<string, unknown>;

    expect(shaped).toEqual({
      handledBy: 'mcp-dispatcher',
      mcp: {
        action: 'invoke',
        toolName: 'dag.run.trace',
        dispatchMode: 'automatic',
        reason: 'prompt_requests_latest_dag_run',
        output: {
          run: expect.objectContaining({
            runId: 'dagrun_trace_1',
            totalNodes: 2,
          }),
          nodes: [
            expect.objectContaining({
              nodeId: 'planner',
              durationMs: 33286,
            }),
            expect.objectContaining({
              nodeId: 'writer',
              durationMs: 32324,
            }),
          ],
          metrics: expect.objectContaining({
            totalNodes: 2,
            wallClockDurationMs: 181693,
          }),
          verification: expect.objectContaining({
            runCompleted: true,
          }),
          lineage: {
            total: 2,
            loopDetected: false,
          },
          errors: {
            total: 0,
          },
          sections: expect.objectContaining({
            requested: expect.any(Array),
          }),
        },
      },
    });
  });

  it('strips internal Trinity fields from client-visible results', () => {
    const shaped = shapeClientRouteResult({
      result: 'Visible answer',
      module: 'ARCANOS:CORE',
      activeModel: 'gpt-5.1',
      fallbackFlag: false,
      routingStages: ['ARCANOS-INTAKE', 'GPT5-REASONING', 'ARCANOS-FINAL'],
      gpt5Used: true,
      gpt5Model: 'gpt-5.1',
      dryRun: false,
      taskLineage: { requestId: 'secret' },
      memoryContext: { entriesAccessed: 99 },
      auditSafe: { mode: true },
      pipelineDebug: { intake: 'hidden' },
    }) as Record<string, unknown>;

    expect(shaped).toEqual({
      result: 'Visible answer',
      module: 'ARCANOS:CORE',
      activeModel: 'gpt-5.1',
      fallbackFlag: false,
      routingStages: ['ARCANOS-INTAKE', 'GPT5-REASONING', 'ARCANOS-FINAL'],
      gpt5Used: true,
      gpt5Model: 'gpt-5.1',
      dryRun: false,
    });
  });

  it('preserves compact self-heal runtime inspection evidence arrays for client responses', () => {
    const shaped = shapeClientRouteResult({
      handledBy: 'runtime-inspection',
      runtimeInspection: {
        detectedIntent: 'RUNTIME_INSPECTION_REQUIRED',
        status: 'ok',
        summary: 'Collected live runtime state from multiple sources.',
        repoInspectionDisabled: true,
        onlyReturnRuntimeValues: true,
        cliUsed: true,
        repoFallbackUsed: false,
        runtimeEndpointsQueried: ['/api/self-heal/runtime', '/api/self-heal/events', '/api/self-heal/inspection'],
        toolsSelected: ['/api/self-heal/runtime', '/api/self-heal/events', '/api/self-heal/inspection', 'cli:status'],
        evidence: {
          selfHealRuntimeSnapshot: {
            status: 'ok',
            isHealing: false,
            lastHealRun: '2026-03-29T06:47:34.525Z',
            lastDecision: 'observe',
            lastResult: 'fallback',
            aiUsedInRuntime: false,
            systemState: {
              errorRate: 0,
              latency: 18,
            },
            lastAIDiagnosis: {
              advisor: 'deterministic_fallback_v1',
              decision: 'observe',
              fallbackUsed: true,
            },
            timeline: {
              lastAIRequestAt: '2026-03-29T06:47:34.356Z',
              lastAIResultAt: '2026-03-29T06:47:34.530Z',
              lastDecisionAt: '2026-03-29T06:47:34.530Z',
            },
            loopStatus: {
              loopRunning: true,
              tickCount: 42,
              lastTick: '2026-03-29T06:47:34.344Z',
            },
          },
          recentSelfHealEvents: [
            {
              ts: '2026-03-29T06:47:34.356Z',
              type: 'AI_DIAGNOSIS_REQUEST',
              source: '/api/self-heal/events',
              payload: { trigger: 'interval' },
            },
            {
              ts: '2026-03-29T06:47:34.530Z',
              type: 'AI_DIAGNOSIS_RESULT',
              source: '/api/self-heal/events',
              payload: { decision: 'observe', fallbackUsed: true },
            },
            {
              ts: '2026-03-29T06:47:34.530Z',
              type: 'CONTROLLER_DECISION',
              source: '/api/self-heal/events',
              payload: { decision: 'observe' },
            },
          ],
          recentPromptDebugEvents: [
            {
              ts: '2026-03-29T06:47:35.726Z',
              type: 'PROMPT_DEBUG_TRACE',
              source: '/api/prompt-debug/events',
              payload: {
                requestId: 'req_123',
                selectedTools: ['/api/self-heal/runtime', '/api/self-heal/events', '/api/self-heal/inspection'],
              },
            },
          ],
          recentAIRoutingEvents: [
            {
              ts: '2026-03-29T06:47:35.728Z',
              type: 'AI_ROUTING_DEBUG',
              source: 'runtimeInspectionRoutingService',
              payload: {
                routingDecision: 'runtime_inspection_completed',
                toolsSelected: ['/api/self-heal/runtime', '/api/self-heal/events', '/api/self-heal/inspection'],
              },
            },
          ],
          recentWorkerEvidence: [],
        },
        sources: [
          {
            tool: '/api/self-heal/runtime',
            sourceType: 'runtime-endpoint',
            data: { timestamp: '2026-03-29T06:47:34.525Z' },
          },
          {
            tool: '/api/self-heal/events',
            sourceType: 'runtime-endpoint',
            data: { timestamp: '2026-03-29T06:47:34.530Z' },
          },
        ],
      },
    }) as Record<string, unknown>;

    expect(shaped).toEqual({
      handledBy: 'runtime-inspection',
      runtimeInspection: {
        detectedIntent: 'RUNTIME_INSPECTION_REQUIRED',
        status: 'ok',
        summary: 'Collected live runtime state from multiple sources.',
        repoInspectionDisabled: true,
        onlyReturnRuntimeValues: true,
        cliUsed: true,
        repoFallbackUsed: false,
        runtimeEndpointsQueried: ['/api/self-heal/runtime', '/api/self-heal/events', '/api/self-heal/inspection'],
        toolsSelected: ['/api/self-heal/runtime', '/api/self-heal/events', '/api/self-heal/inspection', 'cli:status'],
        evidence: {
          selfHealRuntimeSnapshot: {
            status: 'ok',
            isHealing: false,
            lastHealRun: '2026-03-29T06:47:34.525Z',
            lastDecision: 'observe',
            lastResult: 'fallback',
            aiUsedInRuntime: false,
            systemState: {
              errorRate: 0,
              latency: 18,
            },
            lastAIDiagnosis: {
              advisor: 'deterministic_fallback_v1',
              decision: 'observe',
              fallbackUsed: true,
            },
            timeline: {
              lastAIRequestAt: '2026-03-29T06:47:34.356Z',
              lastAIResultAt: '2026-03-29T06:47:34.530Z',
              lastDecisionAt: '2026-03-29T06:47:34.530Z',
            },
            loopStatus: {
              loopRunning: true,
              tickCount: 42,
              lastTick: '2026-03-29T06:47:34.344Z',
            },
          },
          recentSelfHealEvents: [
            {
              ts: '2026-03-29T06:47:34.356Z',
              type: 'AI_DIAGNOSIS_REQUEST',
              source: '/api/self-heal/events',
              payload: { trigger: 'interval' },
            },
            {
              ts: '2026-03-29T06:47:34.530Z',
              type: 'AI_DIAGNOSIS_RESULT',
              source: '/api/self-heal/events',
              payload: { decision: 'observe', fallbackUsed: true },
            },
            {
              ts: '2026-03-29T06:47:34.530Z',
              type: 'CONTROLLER_DECISION',
              source: '/api/self-heal/events',
              payload: { decision: 'observe' },
            },
          ],
          recentPromptDebugEvents: [
            {
              ts: '2026-03-29T06:47:35.726Z',
              type: 'PROMPT_DEBUG_TRACE',
              source: '/api/prompt-debug/events',
              payload: {
                requestId: 'req_123',
                selectedTools: ['/api/self-heal/runtime', '/api/self-heal/events', '/api/self-heal/inspection'],
              },
            },
          ],
          recentAIRoutingEvents: [
            {
              ts: '2026-03-29T06:47:35.728Z',
              type: 'AI_ROUTING_DEBUG',
              source: 'runtimeInspectionRoutingService',
              payload: {
                routingDecision: 'runtime_inspection_completed',
                toolsSelected: ['/api/self-heal/runtime', '/api/self-heal/events', '/api/self-heal/inspection'],
              },
            },
          ],
          recentWorkerEvidence: [],
        },
        sources: [
          {
            tool: '/api/self-heal/runtime',
            sourceType: 'runtime-endpoint',
            observedAt: '2026-03-29T06:47:34.525Z',
          },
          {
            tool: '/api/self-heal/events',
            sourceType: 'runtime-endpoint',
            observedAt: '2026-03-29T06:47:34.530Z',
          },
        ],
      },
    });
  });

  it('enforces a hard byte ceiling by truncating the client payload', () => {
    const prepared = prepareBoundedClientJsonPayload({
      result: 'x'.repeat(10_000),
      module: 'ARCANOS:CORE',
      meta: {
        gptId: 'core',
        route: 'core',
        timestamp: '2026-03-21T10:00:00.000Z',
      },
    }, {
      maxBytes: 1200,
    });

    expect(prepared.truncated).toBe(true);
    expect(prepared.responseBytes).toBeLessThanOrEqual(1200);
    expect(prepared.payload).toEqual({
      result: expect.stringContaining('[truncated]'),
      module: 'ARCANOS:CORE',
      meta: {
        gptId: 'core',
        route: 'core',
        timestamp: '2026-03-21T10:00:00.000Z',
        truncated: true,
      },
    });
  });

  it('emits a warning event when a response is truncated', () => {
    const logger = {
      debug: jest.fn(),
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    };

    const prepared = prepareBoundedClientJsonPayload({
      result: 'x'.repeat(12_000),
      module: 'ARCANOS:CORE',
      meta: {
        gptId: 'core',
        route: 'core',
        timestamp: '2026-03-21T10:00:00.000Z',
      },
    }, {
      maxBytes: 1200,
      logger,
      logEvent: 'api.ask.response',
    });

    expect(prepared.truncated).toBe(true);
    expect(logger.warn).toHaveBeenCalledWith(
      'http.client_response_truncated',
      expect.objectContaining({
        sourceEvent: 'api.ask.response',
        truncated: true,
        alert: true,
      })
    );
  });

  it('keeps truncated payloads within the JSON byte ceiling for JSON-escaped strings', () => {
    const prepared = prepareBoundedClientJsonPayload({
      result: '\u0000'.repeat(2_000),
      module: 'ARCANOS:CORE',
      meta: {
        gptId: 'core',
        route: 'core',
        timestamp: '2026-03-21T10:00:00.000Z',
      },
    }, {
      maxBytes: 2048,
    });

    expect(prepared.truncated).toBe(true);
    expect(prepared.responseBytes).toBeLessThanOrEqual(prepared.maxResponseBytes);
  });

  it('preserves generic job lookup metadata when truncating oversized payloads', () => {
    const prepared = prepareBoundedClientJsonPayload({
      jobId: 'job-123',
      status: 'completed',
      jobStatus: 'completed',
      lifecycleStatus: 'completed',
      poll: '/jobs/job-123/result',
      stream: '/jobs/job-123/stream',
      result: {
        answer: 'x'.repeat(16_000),
      },
      error: null,
    }, {
      maxBytes: 2048,
    });

    expect(prepared.truncated).toBe(true);
    expect(prepared.responseBytes).toBeLessThanOrEqual(prepared.maxResponseBytes);
    expect(prepared.payload).toMatchObject({
      jobId: 'job-123',
      status: 'completed',
      jobStatus: 'completed',
      lifecycleStatus: 'completed',
      poll: '/jobs/job-123/result',
      stream: '/jobs/job-123/stream',
      truncated: true,
      result: expect.stringContaining('[truncated]'),
      error: null,
    });
  });

  it('stamps lightweight probe payloads with their JSON response size', () => {
    const payload = withJsonResponseBytes({
      status: 'ok',
      service: 'arcanos-backend',
      timestamp: '2026-03-21T10:00:00.000Z',
      version: '1.0.0',
    });

    expect(payload.response_bytes).toBe(measureJsonBytes(payload));
    expect(payload.response_bytes).toBeGreaterThan(0);
  });

  it('supports a custom response byte field without adding the default field', () => {
    const payload = withJsonResponseBytes(
      {
        status: 'ok',
        service: 'arcanos-backend',
      },
      'bytes'
    );

    expect(payload.bytes).toBe(measureJsonBytes(payload));
    expect((payload as Record<string, unknown>).response_bytes).toBeUndefined();
  });

  it('does not truncate strings that fit within the raw UTF-8 budget', () => {
    const text = '"quoted"';

    expect(truncateText(text, Buffer.byteLength(text, 'utf8'))).toBe(text);
  });
});
