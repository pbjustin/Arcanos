import { describe, expect, it, jest } from '@jest/globals';

import {
  measureJsonBytes,
  prepareBoundedClientJsonPayload,
  shapeClientRouteResult,
  withJsonResponseBytes,
} from '../src/shared/http/clientResponseGuards.js';

describe('client response guards', () => {
  it('passes raw MCP dispatcher output through without reshaping it', () => {
    const rawResult = {
      handledBy: 'mcp-dispatcher',
      mcp: {
        action: 'invoke',
        toolName: 'dag.run.latest',
        dispatchMode: 'automatic',
        reason: 'prompt_requests_latest_dag_run',
        output: {
          __debug: 'NEW_DAG_LOGIC_ACTIVE',
          found: true,
          runId: 'dagrun_latest_1',
          status: 'complete',
          nodeCount: 4,
          timings: {
            lookupMs: 5,
            totalMs: 9,
          },
          topLevelMetrics: {
            eventCount: 8,
            completedNodes: 4,
            failedNodes: 0,
          },
          available: {
            nodes: true,
            events: true,
            metrics: true,
            verification: true,
            fullTrace: true,
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
        toolName: 'dag.run.latest',
        dispatchMode: 'automatic',
        reason: 'prompt_requests_latest_dag_run',
        output: rawResult.mcp.output,
      },
    });
    expect(output.__debug).toBe('NEW_DAG_LOGIC_ACTIVE');
    expect(output.summary).toBeUndefined();
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
});
