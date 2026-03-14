import type OpenAI from 'openai';

import type { TrinityResult } from '@core/logic/trinity.js';
import type { DagAgentPromptOptions } from '../agents/registry.js';
import { runWorkerTrinityPrompt } from './trinityWorkerPipeline.js';

export interface DagNodePromptBridgeDependencies {
  runWorkerPrompt?: typeof runWorkerTrinityPrompt;
}

/**
 * Create the queued DAG-node prompt bridge used by the DB-backed worker.
 *
 * Purpose:
 * - Keep queued DAG nodes on the same Trinity worker path while preserving all routing and capability metadata.
 *
 * Inputs/outputs:
 * - Input: shared OpenAI client plus optional dependency overrides for tests.
 * - Output: `runPrompt` adapter compatible with DAG agent execution helpers.
 *
 * Edge case behavior:
 * - Forwards optional metadata only when present so blank values do not overwrite worker defaults downstream.
 */
export function createDagNodeRunPromptBridge(
  openaiClient: OpenAI,
  dependencies: DagNodePromptBridgeDependencies = {}
): (prompt: string, options: DagAgentPromptOptions) => Promise<TrinityResult> {
  const activeRunWorkerPrompt = dependencies.runWorkerPrompt ?? runWorkerTrinityPrompt;

  return async (prompt: string, options: DagAgentPromptOptions): Promise<TrinityResult> => {
    const workerRequest = {
      prompt,
      sessionId: options.sessionId,
      tokenAuditSessionId: options.tokenAuditSessionId,
      overrideAuditSafe: options.overrideAuditSafe,
      cognitiveDomain: options.cognitiveDomain,
      sourceEndpoint: options.sourceEndpoint,
      ...(options.toolBackedCapabilities
        ? {
            toolBackedCapabilities: options.toolBackedCapabilities
          }
        : {})
    };

    //audit Assumption: queued DAG nodes must preserve capability hints from the agent registry all the way into Trinity; failure risk: verification agents lose provided-data permissions and trigger false guard refusals; expected invariant: every non-empty `toolBackedCapabilities` payload survives this bridge unchanged; handling strategy: copy the capability object through verbatim when present.
    return activeRunWorkerPrompt(openaiClient, workerRequest);
  };
}
