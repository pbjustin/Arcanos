import { callOpenAI, getDefaultModel } from './openai.js';
import type { WorkerInfoDTO, WorkerStatusResponseDTO } from '../types/dto.js';
import {
  AUTO_HEAL_RECOMMENDED_ACTIONS,
  AUTO_HEAL_SEVERITY_LEVELS,
  AUTO_HEAL_TOKEN_LIMIT,
  buildAutoHealPrompt
} from '../config/autoHeal.js';

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

    const parsed = JSON.parse(result.output || '{}');
    const steps = Array.isArray(parsed.steps) ? parsed.steps.map((step: unknown) => String(step)) : [];

    return {
      planId: typeof parsed.planId === 'string' ? parsed.planId : 'ai-plan',
      severity: AUTO_HEAL_SEVERITY_LEVELS.includes(parsed.severity)
        ? (parsed.severity as AutoHealSeverity)
        : heuristics.severity,
      recommendedAction: AUTO_HEAL_RECOMMENDED_ACTIONS.includes(parsed.recommendedAction)
        ? parsed.recommendedAction
        : heuristics.recommendedAction,
      message: typeof parsed.message === 'string' ? parsed.message : heuristics.message,
      steps: steps.length > 0 ? steps : heuristics.steps,
      fallbackModel: typeof parsed.fallbackModel === 'string' ? parsed.fallbackModel : heuristics.fallbackModel,
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
