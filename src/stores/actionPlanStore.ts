/**
 * ActionPlan Store — In-memory cache + Prisma persistence
 *
 * Write-through: all mutations persist to Prisma and update cache.
 * Read-first: reads from cache, falls back to Prisma.
 */

import { PrismaClient } from '@prisma/client';
import { randomUUID } from 'crypto';
import { buildClear2Summary } from '../services/clear2.js';
import type {
  ActionPlanInput,
  ActionPlanRecord,
  ClearScoreRecord,
  PlanStatus,
  ClearDecision,
  ActionDefinition,
} from '@shared/types/actionPlan.js';
import { aiLogger } from '@platform/logging/structuredLogging.js';

let prisma: PrismaClient | null = null;

function getPrisma(): PrismaClient {
  if (!prisma) {
    prisma = new PrismaClient();
  }
  return prisma;
}

// --- In-memory cache ---

/** Maximum number of plans to hold in memory. Prevents unbounded growth in long-running Railway deployments. */
const MAX_CACHE_SIZE = 200;

const planCache = new Map<string, ActionPlanRecord>();

/** Evict oldest entries when cache exceeds MAX_CACHE_SIZE. Map iterates in insertion order. */
function evictIfNeeded(): void {
  while (planCache.size > MAX_CACHE_SIZE) {
    const oldest = planCache.keys().next().value;
    if (oldest) planCache.delete(oldest);
  }
}

// --- Helpers ---

function actionDefToCreateInput(def: ActionDefinition, index: number) {
  return {
    id: def.action_id || randomUUID(),
    agentId: def.agent_id,
    capability: def.capability,
    params: def.params as object,
    timeoutMs: def.timeout_ms ?? 30000,
    rollbackAction: def.rollback_action ? (def.rollback_action as object) : undefined,
    sortOrder: index,
  };
}

// --- Store Operations ---

export async function createPlan(input: ActionPlanInput): Promise<ActionPlanRecord> {
  const db = getPrisma();

  // Compute CLEAR 2.0 score
  const hasRollbacks = input.actions.some(a => a.rollback_action != null);
  const clearResult = buildClear2Summary({
    actions: input.actions,
    origin: input.origin,
    confidence: input.confidence ?? 0,
    hasRollbacks,
    capabilitiesKnown: true,
    agentsRegistered: true,
  });

  // Determine initial status based on CLEAR decision
  let initialStatus: PlanStatus = 'planned';
  if (clearResult.decision === 'block') {
    initialStatus = 'blocked';
  } else if (clearResult.decision === 'confirm' || input.requires_confirmation) {
    initialStatus = 'awaiting_confirmation';
  } else {
    initialStatus = 'approved';
  }

  const plan = await db.actionPlan.create({
    data: {
      createdBy: input.created_by,
      origin: input.origin,
      status: initialStatus,
      confidence: input.confidence ?? 0,
      requiresConfirmation: input.requires_confirmation ?? true,
      idempotencyKey: input.idempotency_key,
      expiresAt: input.expires_at ? new Date(input.expires_at) : null,
      actions: {
        create: input.actions.map((a, i) => actionDefToCreateInput(a, i)),
      },
      clearScore: {
        create: {
          clarity: clearResult.clarity,
          leverage: clearResult.leverage,
          efficiency: clearResult.efficiency,
          alignment: clearResult.alignment,
          resilience: clearResult.resilience,
          overall: clearResult.overall,
          decision: clearResult.decision,
          notes: clearResult.notes ?? null,
        },
      },
    },
    include: { actions: true, clearScore: true, executionResults: true },
  });

  const record = plan as unknown as ActionPlanRecord;
  planCache.set(record.id, record);
  evictIfNeeded();

  aiLogger.info('ActionPlan created', {
    module: 'actionPlanStore',
    planId: record.id,
    status: record.status,
    clearDecision: clearResult.decision,
    clearOverall: clearResult.overall,
  });

  return record;
}

export async function getPlan(planId: string): Promise<ActionPlanRecord | null> {
  // Check cache first
  const cached = planCache.get(planId);
  if (cached) return cached;

  const db = getPrisma();
  const plan = await db.actionPlan.findUnique({
    where: { id: planId },
    include: { actions: true, clearScore: true, executionResults: true },
  });

  if (!plan) return null;

  const record = plan as unknown as ActionPlanRecord;
  planCache.set(planId, record);
  evictIfNeeded();
  return record;
}

export async function updatePlanStatus(planId: string, status: PlanStatus): Promise<ActionPlanRecord | null> {
  const db = getPrisma();

  const plan = await db.actionPlan.update({
    where: { id: planId },
    data: { status },
    include: { actions: true, clearScore: true, executionResults: true },
  });

  const record = plan as unknown as ActionPlanRecord;
  planCache.set(planId, record);

  aiLogger.info('ActionPlan status updated', {
    module: 'actionPlanStore',
    planId,
    status,
  });

  return record;
}

export async function approvePlan(planId: string): Promise<ActionPlanRecord | null> {
  const plan = await getPlan(planId);
  if (!plan) return null;

  // Cannot approve blocked plans
  if (plan.clearScore?.decision === 'block') {
    aiLogger.warn('Cannot approve blocked plan', {
      module: 'actionPlanStore',
      planId,
      clearDecision: plan.clearScore.decision,
    });
    return null;
  }

  // Can only approve plans in awaiting_confirmation or planned status
  if (plan.status !== 'awaiting_confirmation' && plan.status !== 'planned') {
    return null;
  }

  return updatePlanStatus(planId, 'approved');
}

export async function blockPlan(planId: string): Promise<ActionPlanRecord | null> {
  return updatePlanStatus(planId, 'blocked');
}

export async function expirePlan(planId: string): Promise<ActionPlanRecord | null> {
  return updatePlanStatus(planId, 'expired');
}

export async function listPlans(filters?: {
  status?: PlanStatus;
  createdBy?: string;
  limit?: number;
}): Promise<ActionPlanRecord[]> {
  const db = getPrisma();

  const where: Record<string, unknown> = {};
  if (filters?.status) where.status = filters.status;
  if (filters?.createdBy) where.createdBy = filters.createdBy;

  const plans = await db.actionPlan.findMany({
    where,
    include: { actions: true, clearScore: true },
    orderBy: { createdAt: 'desc' },
    take: filters?.limit ?? 50,
  });

  // Update cache
  for (const plan of plans) {
    const record = plan as unknown as ActionPlanRecord;
    planCache.set(record.id, record);
  }

  return plans as unknown as ActionPlanRecord[];
}

export async function expireStalePlans(): Promise<number> {
  const db = getPrisma();
  const now = new Date();

  const result = await db.actionPlan.updateMany({
    where: {
      expiresAt: { lte: now },
      status: { in: ['planned', 'awaiting_confirmation', 'approved'] },
    },
    data: { status: 'expired' },
  });

  if (result.count > 0) {
    // Invalidate cache for expired plans
    for (const [id, plan] of planCache) {
      if (plan.expiresAt && plan.expiresAt <= now &&
          ['planned', 'awaiting_confirmation', 'approved'].includes(plan.status)) {
        plan.status = 'expired';
      }
    }

    aiLogger.info('Expired stale plans', {
      module: 'actionPlanStore',
      count: result.count,
    });
  }

  return result.count;
}

export async function getClearScore(planId: string): Promise<ClearScoreRecord | null> {
  const plan = await getPlan(planId);
  return plan?.clearScore ?? null;
}

export async function createExecutionResult(
  planId: string,
  actionId: string,
  agentId: string,
  status: string,
  clearDecision: ClearDecision,
  output?: unknown,
  error?: unknown,
  signature?: string
) {
  const db = getPrisma();

  const result = await db.executionResult.create({
    data: {
      planId,
      actionId,
      agentId,
      status,
      output: output as object ?? undefined,
      error: error as object ?? undefined,
      signature: signature ?? null,
      clearDecision,
    },
  });

  aiLogger.info('ExecutionResult created', {
    module: 'actionPlanStore',
    planId,
    actionId,
    status,
    clearDecision,
  });

  return result;
}

export async function getExecutionResults(planId: string) {
  const db = getPrisma();
  return db.executionResult.findMany({
    where: { planId },
    orderBy: { createdAt: 'asc' },
  });
}

/**
 * Warm the in-memory cache from Prisma on startup.
 */
export async function warmCache(): Promise<void> {
  try {
    const db = getPrisma();
    const activePlans = await db.actionPlan.findMany({
      where: {
        status: { in: ['planned', 'awaiting_confirmation', 'approved', 'in_progress'] },
      },
      include: { actions: true, clearScore: true },
      take: MAX_CACHE_SIZE,
    });

    for (const plan of activePlans) {
      planCache.set(plan.id, plan as unknown as ActionPlanRecord);
    }

    aiLogger.info('ActionPlan cache warmed', {
      module: 'actionPlanStore',
      count: activePlans.length,
    });
  } catch (error) {
    aiLogger.warn('Failed to warm ActionPlan cache (DB may not be available)', {
      module: 'actionPlanStore',
    });
  }
}
