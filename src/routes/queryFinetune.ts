import { Request, Response, Router } from 'express';
import { z } from 'zod';

import { getConfiguredFineTune } from '../config/openai.js';
import { runTrinity } from '../trinity/trinity.js';
import {
  createRateLimitMiddleware,
  getRequestActorKey,
  securityHeaders
} from '@platform/runtime/security.js';
import { sendInternalErrorPayload } from '@shared/http/index.js';
import {
  beginAiRouteTrace,
  completeAiRouteTrace,
  failAiRouteTrace,
  type AiRouteTraceContext
} from '@transport/http/aiRouteTelemetry.js';
import { resolveQueryFinetuneAttemptLatencyBudgetMs } from '@config/queryFinetune.js';
import { GenerativeModelPolicyError } from '@services/openai/credentialProvider.js';
import { sendOpenAIServiceUnavailable } from '@platform/resilience/serviceUnavailable.js';

const router = Router();

const queryFinetuneRequestSchema = z.object({
  prompt: z.string().trim().min(1)
});
const QUERY_FINETUNE_ATTEMPT_LATENCY_BUDGET_MS = resolveQueryFinetuneAttemptLatencyBudgetMs();

router.use(securityHeaders);
router.use('/query-finetune', createRateLimitMiddleware({
  bucketName: 'query-finetune',
  maxRequests: 30,
  windowMs: 15 * 60 * 1000,
  keyGenerator: (req) => `${getRequestActorKey(req)}:route:query-finetune`
}));

/**
 * Purpose: serve the lightweight fine-tuned query route with schema validation, telemetry, and bounded model latency.
 * Inputs/Outputs: Express request/response -> JSON success payload from Trinity or deterministic 400/500 error payloads.
 * Edge cases: invalid bodies return 400 before any model call; fine-tuned model timeouts fall back inside `runTrinity` under the same per-attempt budget.
 */
export async function queryFinetuneHandler(req: Request, res: Response) {
  const parsedRequest = queryFinetuneRequestSchema.safeParse(req.body);

  if (!parsedRequest.success) {
    //audit Assumption: `/query-finetune` should reject invalid payloads before invoking any model path; failure risk: malformed requests consume model budget or throw opaque 500s; expected invariant: invalid schema returns HTTP 400 with deterministic details; handling strategy: validate eagerly with Zod and stop before route execution telemetry begins.
    return res.status(400).json({
      error: 'invalid request schema',
      details: parsedRequest.error.issues.map(issue => issue.message)
    });
  }

  const prompt = parsedRequest.data.prompt;
  let routeTrace: AiRouteTraceContext | undefined;
  let model: string | undefined;

  try {
    model = getConfiguredFineTune();
    routeTrace = beginAiRouteTrace(req, 'query-finetune', prompt, model);
    const result = await runTrinity({
      prompt,
      model,
      temperature: 0.5,
      structured: true,
      latencyBudgetMs: QUERY_FINETUNE_ATTEMPT_LATENCY_BUDGET_MS
    });

    completeAiRouteTrace(req, routeTrace, {
      activeModel: result.activeModel ?? result.model,
      fallbackFlag: result.fallbackFlag,
      fallbackReason: 'fallbackReason' in result && typeof result.fallbackReason === 'string' ? result.fallbackReason : null,
      extra: {
        outputLength: typeof result.output === 'string' ? result.output.length : 0
      }
    });

    return res.json({
      success: true,
      ...result
    });
  } catch (error) {
    const unavailableAuthority = error instanceof GenerativeModelPolicyError && error.code === 'FINAL_AUTHORITY_UNAVAILABLE';
    failAiRouteTrace(req, routeTrace ?? beginAiRouteTrace(req, 'query-finetune', prompt), error, {
      activeModel: model,
      statusCode: unavailableAuthority ? 503 : 500
    });
    if (unavailableAuthority) {
      sendOpenAIServiceUnavailable(res, error.message);
      return;
    }
    return sendInternalErrorPayload(res, {
      success: false,
      error: error instanceof Error ? error.message : String(error)
    });
  }
}

router.post('/query-finetune', queryFinetuneHandler);

export default router;
