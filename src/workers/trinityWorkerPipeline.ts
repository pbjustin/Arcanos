import type OpenAI from 'openai';
import { runThroughBrain, type TrinityResult } from '@core/logic/trinity.js';
import { createRuntimeBudget } from '@platform/resilience/runtimeBudget.js';
import type { CognitiveDomain } from '@shared/types/cognitiveDomain.js';

export interface WorkerTrinityRequest {
  prompt: string;
  sessionId?: string;
  overrideAuditSafe?: string;
  cognitiveDomain?: CognitiveDomain;
  sourceEndpoint?: string;
}

/**
 * Execute one worker-originated prompt through the shared Trinity pipeline.
 *
 * Purpose:
 * - Keep queued asks, queued DAG nodes, and in-process workers on one Trinity invocation path.
 *
 * Inputs/outputs:
 * - Input: OpenAI client plus worker routing metadata.
 * - Output: normalized Trinity result from the shared brain pipeline.
 *
 * Edge case behavior:
 * - Falls back to `worker.dispatch` when no worker-specific source endpoint is supplied.
 */
export async function runWorkerTrinityPrompt(
  openaiClient: OpenAI,
  request: WorkerTrinityRequest
): Promise<TrinityResult> {
  const normalizedSourceEndpoint =
    typeof request.sourceEndpoint === 'string' && request.sourceEndpoint.trim().length > 0
      ? request.sourceEndpoint.trim()
      : 'worker.dispatch';

  //audit Assumption: worker-triggered Trinity runs must always emit a source endpoint for traceability; failure risk: mixed worker traffic becomes impossible to debug in routing telemetry; expected invariant: every worker AI call carries a stable endpoint label; handling strategy: default missing or blank endpoints to `worker.dispatch`.
  return runThroughBrain(
    openaiClient,
    request.prompt,
    request.sessionId,
    request.overrideAuditSafe,
    {
      cognitiveDomain: request.cognitiveDomain,
      sourceEndpoint: normalizedSourceEndpoint
    },
    createRuntimeBudget()
  );
}
