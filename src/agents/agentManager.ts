import { AGENTS, type DagAgentHandler } from './registry.js';

/**
 * Mutable DAG agent registry used by queued task runners.
 *
 * Purpose:
 * - Provide a single registration and lookup surface for built-in and custom DAG agents.
 *
 * Inputs/outputs:
 * - Input: agent keys and handlers.
 * - Output: resolved handlers for task execution.
 *
 * Edge case behavior:
 * - Starts with the built-in `AGENTS` map and allows runtime extension.
 */
export class DagAgentManager {
  private readonly registeredAgents = new Map<string, DagAgentHandler>(
    Object.entries(AGENTS)
  );

  /**
   * Register or replace a DAG agent handler.
   *
   * Purpose:
   * - Allow feature code or tests to inject specialized node handlers.
   *
   * Inputs/outputs:
   * - Input: agent key and executable handler.
   * - Output: none.
   *
   * Edge case behavior:
   * - Replaces the previous handler when the key already exists.
   */
  registerAgent(agentKey: string, handler: DagAgentHandler): void {
    this.registeredAgents.set(agentKey, handler);
  }

  /**
   * Resolve one DAG agent handler by key.
   *
   * Purpose:
   * - Give worker task runners a deterministic lookup for queued nodes.
   *
   * Inputs/outputs:
   * - Input: agent key string from the queued node definition.
   * - Output: registered handler or `null`.
   *
   * Edge case behavior:
   * - Returns `null` instead of throwing when the key is unknown.
   */
  getAgent(agentKey: string): DagAgentHandler | null {
    return this.registeredAgents.get(agentKey) ?? null;
  }

  /**
   * List the currently registered DAG agent keys.
   *
   * Purpose:
   * - Support diagnostics and tests that need to inspect the active registry.
   *
   * Inputs/outputs:
   * - Input: none.
   * - Output: sorted agent key list.
   *
   * Edge case behavior:
   * - Returns an empty array only when every agent has been explicitly removed or the manager was reinitialized that way.
   */
  listAgentKeys(): string[] {
    return Array.from(this.registeredAgents.keys()).sort();
  }
}

export const dagAgentManager = new DagAgentManager();
