import { callOpenAI, getDefaultModel } from './openai.js';
import type { WorkerInfoDTO, WorkerStatusResponseDTO } from "@shared/types/dto.js";
import {
  AUTO_HEAL_RECOMMENDED_ACTIONS,
  AUTO_HEAL_SEVERITY_LEVELS,
  AUTO_HEAL_TOKEN_LIMIT,
  buildAutoHealPrompt
} from "@platform/runtime/autoHeal.js";

export type AutoHealSeverity = (typeof AUTO_HEAL_SEVERITY_LEVELS)[number];
export type AutoHealRecommendedAction = (typeof AUTO_HEAL_RECOMMENDED_ACTIONS)[number];

export interface AutoHealPlan {
  planId: string;
  severity: AutoHealSeverity;
  recommendedAction: AutoHealRecommendedAction;
  message: string;
  steps: string[];
  fallbackModel?: string;
  generatedAt: string;
}

export interface AutoHealContext {
  failingWorkers: WorkerInfoDTO[];
  lastError?: string;
  lastDispatchAt?: string;
  totalDispatched: number;
}

const autoHealPlanOutputSchema = z.object({
  planId: z.string().min(1).optional(),
  severity: z.enum(AUTO_HEAL_SEVERITY_LEVELS).optional(),
  recommendedAction: z.enum(AUTO_HEAL_RECOMMENDED_ACTIONS).optional(),
  message: z.string().min(1).optional(),
  steps: z.array(z.string().min(1)).optional(),
  fallbackModel: z.string().min(1).optional()
});

function buildHeuristicPlan(context: AutoHealContext, model: string): AutoHealPlan {
  const severity: AutoHealSeverity = context.failingWorkers.length > 0 || context.lastError ? 'critical' : 'ok';
  const recommendedAction = severity === 'critical' ? 'restart-workers' : 'monitor';
  const steps =
    severity === 'critical'
      ? [
          'Restart ARCANOS workers with force flag',
          'Verify fallback model health',
          'Monitor /workers/status after restart'
        ]
      : ['Monitor /workers/status for anomalies'];

  return {
    planId: 'heuristic',
    severity,
    recommendedAction,
    message:
      severity === 'critical'
        ? 'Detected worker failures or runtime errors that require a restart'
        : 'Workers operating normally',
    steps,
    fallbackModel: model,
    generatedAt: new Date().toISOString()
  };
}

export async function buildAutoHealPlan(status: WorkerStatusResponseDTO): Promise<AutoHealPlan> {
  const model = getDefaultModel();
  const context: AutoHealContext = {
    failingWorkers: status.workers.filter(worker => !worker.available),
    lastError: status.arcanosWorkers.runtime.lastError,
    lastDispatchAt: status.arcanosWorkers.runtime.lastDispatchAt,
    totalDispatched: status.arcanosWorkers.runtime.totalDispatched
  };

  const heuristics = buildHeuristicPlan(context, model);
  const shouldConsultAI = context.failingWorkers.length > 0 || Boolean(context.lastError);
  if (!shouldConsultAI) {
    return heuristics;
  }

  try {
    const payload = {
      context,
      status: {
        timestamp: status.timestamp,
        model: status.system.model,
        arcanosWorkers: status.arcanosWorkers
      },
      heuristic: heuristics
    };

    const prompt = buildAutoHealPrompt(model, payload);

    const result = await callOpenAI(model, prompt, AUTO_HEAL_TOKEN_LIMIT, false, {
      responseFormat: { type: 'json_object' },
      metadata: { route: 'auto-heal' }
    });

    const parsed = parseModelOutputWithSchema(result.output || '{}', autoHealPlanOutputSchema, {
      source: 'autoHealService.buildAutoHealPlan',
      allowFallback: true,
      fallbackValue: {
        planId: heuristics.planId,
        severity: heuristics.severity,
        recommendedAction: heuristics.recommendedAction,
        message: heuristics.message,
        steps: heuristics.steps,
        fallbackModel: heuristics.fallbackModel
      }
    });
    const steps = Array.isArray(parsed.steps) ? parsed.steps.map((step: unknown) => String(step)) : [];

    return {
      planId: parsed.planId || 'ai-plan',
      severity: parsed.severity || heuristics.severity,
      recommendedAction: parsed.recommendedAction || heuristics.recommendedAction,
      message: parsed.message || heuristics.message,
      steps: steps.length > 0 ? steps : heuristics.steps,
      fallbackModel: parsed.fallbackModel || heuristics.fallbackModel,
      generatedAt: new Date().toISOString()
    };
  } catch (error) {
    console.error('[AUTO-HEAL] Failed to consult AI for plan', error);
    return heuristics;
  }
}

export function summarizeAutoHeal(status: WorkerStatusResponseDTO) {
  const failingWorkers = status.workers.filter(worker => !worker.available).map(worker => worker.id);
  const lastError = status.arcanosWorkers.runtime.lastError;
  const severity: AutoHealSeverity = failingWorkers.length > 0 || lastError ? 'critical' : 'ok';

  return {
    status: severity,
    failingWorkers,
    lastError,
    recommendedAction: severity === 'critical' ? 'review /workers/heal for plan' : 'monitor'
  };
}
