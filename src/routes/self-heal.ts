import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { resolveErrorMessage } from '@core/lib/errors/index.js';
import { capabilityGate } from '@transport/http/middleware/capabilityGate.js';
import {
  runPredictiveHealingDecision,
  type PredictiveHealingSimulationInput
} from '@services/selfImprove/predictiveHealingService.js';
import {
  buildSelfHealEventsSnapshot,
  buildSelfHealInspectionSnapshot,
  buildSelfHealProviderHealthSnapshot,
  buildSelfHealRuntimeSnapshot,
} from '@services/selfHealRuntimeInspectionService.js';
import { sendInternalErrorPayload } from '@shared/http/index.js';

const router = Router();

const simulatedWorkerSchema = z.object({
  workerId: z.string().trim().min(1),
  healthStatus: z.string().trim().min(1),
  currentJobId: z.string().trim().min(1).nullable().optional()
});

const simulatedTrinityStageSchema = z.object({
  observationsInWindow: z.number().int().min(0).optional(),
  attempts: z.number().int().min(0).optional(),
  activeAction: z.enum(['enable_degraded_mode', 'bypass_final_stage']).nullable().optional(),
  verified: z.boolean().optional(),
  cooldownUntil: z.string().datetime().nullable().optional(),
  failedActions: z.array(z.enum(['enable_degraded_mode', 'bypass_final_stage'])).optional()
}).partial();

const decidePredictiveSelfHealSchema = z.object({
  execute: z.boolean().optional(),
  dryRun: z.boolean().optional(),
  source: z.string().trim().min(1).max(64).optional(),
  simulate: z.object({
    requestCount: z.number().int().min(0).optional(),
    errorRate: z.number().min(0).max(1).optional(),
    timeoutRate: z.number().min(0).max(1).optional(),
    avgLatencyMs: z.number().min(0).optional(),
    p95LatencyMs: z.number().min(0).optional(),
    maxLatencyMs: z.number().min(0).optional(),
    degradedCount: z.number().int().min(0).optional(),
    memory: z.object({
      rssMb: z.number().min(0).optional(),
      heapUsedMb: z.number().min(0).optional(),
      heapTotalMb: z.number().min(0).optional(),
      externalMb: z.number().min(0).optional(),
      arrayBuffersMb: z.number().min(0).optional()
    }).partial().optional(),
    workerHealth: z.object({
      overallStatus: z.enum(['healthy', 'degraded', 'unhealthy', 'offline']).nullable().optional(),
      alertCount: z.number().int().min(0).optional(),
      alerts: z.array(z.string().trim().min(1)).optional(),
      pending: z.number().int().min(0).optional(),
      running: z.number().int().min(0).optional(),
      delayed: z.number().int().min(0).optional(),
      stalledRunning: z.number().int().min(0).optional(),
      oldestPendingJobAgeMs: z.number().min(0).optional(),
      degradedWorkerIds: z.array(z.string().trim().min(1)).optional(),
      unhealthyWorkerIds: z.array(z.string().trim().min(1)).optional(),
      workers: z.array(simulatedWorkerSchema).optional()
    }).partial().optional(),
    workerRuntime: z.object({
      enabled: z.boolean().optional(),
      started: z.boolean().optional(),
      configuredCount: z.number().int().min(0).optional(),
      activeListeners: z.number().int().min(0).optional(),
      maxActiveWorkers: z.number().int().min(0).optional(),
      surgeWorkerCount: z.number().int().min(0).optional(),
      workerIds: z.array(z.string().trim().min(1)).optional()
    }).partial().optional(),
    promptRoute: z.object({
      active: z.boolean().optional(),
      mode: z.enum(['reduced_latency', 'degraded_response']).nullable().optional(),
      reason: z.string().trim().min(1).nullable().optional()
    }).partial().optional(),
    trinity: z.object({
      enabled: z.boolean().optional(),
      activeStage: z.enum(['intake', 'reasoning', 'final']).nullable().optional(),
      activeAction: z.enum(['enable_degraded_mode', 'bypass_final_stage']).nullable().optional(),
      verified: z.boolean().optional(),
      config: z.object({
        triggerThreshold: z.number().int().min(1).optional(),
        maxAttempts: z.number().int().min(1).optional()
      }).partial().optional(),
      stages: z.object({
        intake: simulatedTrinityStageSchema.optional(),
        reasoning: simulatedTrinityStageSchema.optional(),
        final: simulatedTrinityStageSchema.optional()
      }).partial().optional()
    }).partial().optional()
  }).partial().optional()
}).strip();

router.post('/api/self-heal/decide', capabilityGate('self_improve_admin'), async (req: Request, res: Response) => {
  try {
    const parsed = decidePredictiveSelfHealSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({
        error: 'Invalid predictive self-heal payload',
        issues: parsed.error.issues
      });
      return;
    }

    const result = await runPredictiveHealingDecision({
      source: parsed.data.source ?? 'api_self_heal_decide',
      execute: parsed.data.execute,
      dryRun: parsed.data.dryRun,
      simulate: parsed.data.simulate as PredictiveHealingSimulationInput | undefined
    });

    res.json({
      status: 'ok',
      predictiveHealing: result
    });
  } catch (error) {
    sendInternalErrorPayload(res, {
      error: resolveErrorMessage(error),
      where: 'self-heal/decide'
    });
  }
});

router.get('/api/self-heal/runtime', (_req: Request, res: Response) => {
  try {
    res.json(buildSelfHealRuntimeSnapshot());
  } catch (error) {
    sendInternalErrorPayload(res, {
      error: resolveErrorMessage(error),
      where: 'self-heal/runtime'
    });
  }
});

router.get('/api/self-heal/events', (req: Request, res: Response) => {
  try {
    const rawLimit = typeof req.query.limit === 'string' ? Number.parseInt(req.query.limit, 10) : NaN;
    const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? rawLimit : 20;
    res.json(buildSelfHealEventsSnapshot(limit));
  } catch (error) {
    sendInternalErrorPayload(res, {
      error: resolveErrorMessage(error),
      where: 'self-heal/events'
    });
  }
});

router.get('/api/self-heal/inspection', async (req: Request, res: Response) => {
  try {
    const rawLimit = typeof req.query.limit === 'string' ? Number.parseInt(req.query.limit, 10) : NaN;
    const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? rawLimit : 10;
    res.json(await buildSelfHealInspectionSnapshot(limit));
  } catch (error) {
    sendInternalErrorPayload(res, {
      error: resolveErrorMessage(error),
      where: 'self-heal/inspection'
    });
  }
});

router.get('/api/self-heal/provider-health', async (req: Request, res: Response) => {
  try {
    const probeRequested =
      typeof req.query.probe === 'string' &&
      ['1', 'true', 'yes'].includes(req.query.probe.trim().toLowerCase());
    res.json(await buildSelfHealProviderHealthSnapshot(probeRequested));
  } catch (error) {
    sendInternalErrorPayload(res, {
      error: resolveErrorMessage(error),
      where: 'self-heal/provider-health'
    });
  }
});

export default router;
