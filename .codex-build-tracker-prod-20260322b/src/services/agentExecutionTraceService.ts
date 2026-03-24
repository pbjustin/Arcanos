/**
 * In-memory execution tracing for capability-planned runs.
 */

import type { AgentExecutionTraceEvent, AgentTraceLevel } from './agentExecutionTypes.js';

/**
 * Recorder that stores execution trace events only in memory.
 *
 * Purpose:
 * - Keep planner/capability traces visible to callers without letting agent-layer code touch durable infrastructure.
 *
 * Inputs/outputs:
 * - Input: execution identifiers used to enrich emitted events.
 * - Output: append-only in-memory trace snapshot.
 *
 * Edge case behavior:
 * - Returns cloned event data to protect recorder state from external mutation.
 */
export class AgentExecutionTraceRecorder {
  private readonly events: AgentExecutionTraceEvent[] = [];

  private readonly executionId: string;

  private readonly traceId: string;

  constructor(executionId: string, traceId: string) {
    this.executionId = executionId;
    this.traceId = traceId;
  }

  /**
   * Record one in-memory trace event.
   *
   * Purpose:
   * - Capture planner- and orchestration-layer events that sit above the CEF boundary.
   *
   * Inputs/outputs:
   * - Input: log level, message, and structured metadata.
   * - Output: the recorded trace event.
   *
   * Edge case behavior:
   * - Always adds `executionId` and `traceId` even when the caller omits metadata.
   */
  async record(
    level: AgentTraceLevel,
    message: string,
    metadata: Record<string, unknown> = {}
  ): Promise<AgentExecutionTraceEvent> {
    const event: AgentExecutionTraceEvent = {
      timestamp: new Date().toISOString(),
      level,
      message,
      metadata: {
        executionId: this.executionId,
        traceId: this.traceId,
        ...metadata
      }
    };

    this.events.push(event);
    return event;
  }

  /**
   * Return the recorded trace events.
   *
   * Purpose:
   * - Expose the structured execution trace for HTTP responses and tests.
   *
   * Inputs/outputs:
   * - Input: none.
   * - Output: append-order trace snapshot.
   *
   * Edge case behavior:
   * - Returns a cloned array to protect recorder state from external mutation.
   */
  snapshot(): AgentExecutionTraceEvent[] {
    return this.events.map(event => ({
      ...event,
      metadata: {
        ...event.metadata
      }
    }));
  }
}
