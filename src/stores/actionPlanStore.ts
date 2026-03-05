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
  ExecutionResultRecord,
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
const planIdByIdempotencyKey = new Map<string, string>();
const executionResultsCache = new Map<string, ExecutionResultRecord[]>();

/**
 * Remove one plan and all associated fallback indexes/caches.
 *
 * Purpose: prevent stale idempotency pointers and orphaned execution-result entries.
 * Inputs/outputs: plan id -> deletes related cache entries when present.
 * Edge cases: safe no-op when plan id is not cached.
 */
function removePlanFromCaches(planId: string): void {
  const existing = planCache.get(planId);
  if (!existing) {
    return;
  }

  planCache.delete(planId);

  //audit Assumption: idempotency key index must not outlive its backing plan; risk: stale key map growth; invariant: mapping points only to existing plans; handling: delete key only when it points to evicted plan id.
  if (existing.idempotencyKey) {
    const mappedPlanId = planIdByIdempotencyKey.get(existing.idempotencyKey);
    if (mappedPlanId === planId) {
      planIdByIdempotencyKey.delete(existing.idempotencyKey);
    }
  }

  //audit Assumption: execution results are scoped to a plan lifecycle; risk: orphaned results memory growth; invariant: no results for evicted plan ids; handling: remove per-plan result cache.
  executionResultsCache.delete(planId);
}

/** Evict oldest entries when cache exceeds MAX_CACHE_SIZE. Map iterates in insertion order. */
function evictIfNeeded(): void {
  while (planCache.size > MAX_CACHE_SIZE) {
    const oldest = planCache.keys().next().value;
    if (!oldest) {
      break;
    }
    removePlanFromCaches(oldest);
  }
}

/**
 * Cache a plan record and maintain idempotency lookup.
 *
 * Purpose: keep in-memory state consistent for DB and fallback paths.
 * Inputs/outputs: accepts a plan record and stores it in local caches.
 * Edge cases: ignores empty idempotency keys.
 */
function cachePlanRecord(record: ActionPlanRecord): void {
  const existing = planCache.get(record.id);
  //audit Assumption: a plan's idempotency key can be replaced; risk: stale reverse index; invariant: at most one active mapping per plan id; handling: clear old mapping before re-indexing.
  if (existing?.idempotencyKey && existing.idempotencyKey !== record.idempotencyKey) {
    const mappedPlanId = planIdByIdempotencyKey.get(existing.idempotencyKey);
    if (mappedPlanId === record.id) {
      planIdByIdempotencyKey.delete(existing.idempotencyKey);
    }
  }

  planCache.set(record.id, record);
  if (record.idempotencyKey) {
    planIdByIdempotencyKey.set(record.idempotencyKey, record.id);
  }
  evictIfNeeded();
}

/**
 * Return cached plans filtered/sorted like the DB list query.
 *
 * Purpose: provide deterministic fallback when Prisma is unavailable.
 * Inputs/outputs: optional filters -> ordered plan list.
 * Edge cases: defaults to maximum 50 records.
 */
function listCachedPlans(filters?: {
  status?: PlanStatus;
  createdBy?: string;
  limit?: number;
}): ActionPlanRecord[] {
  const filtered = Array.from(planCache.values())
    .filter(plan => !filters?.status || plan.status === filters.status)
    .filter(plan => !filters?.createdBy || plan.createdBy === filters.createdBy)
    .sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime());

  const limit = filters?.limit ?? 50;
  return filtered.slice(0, limit);
}

/**
 * Update cached plan status when DB writes are unavailable.
 *
 * Purpose: keep plan lifecycle transitions operational in degraded mode.
 * Inputs/outputs: plan id + new status -> updated plan or null.
 * Edge cases: returns null when plan is absent from cache.
 */
function updateCachedPlanStatus(planId: string, status: PlanStatus): ActionPlanRecord | null {
  const existing = planCache.get(planId);
  if (!existing) {
    return null;
  }

  const updated: ActionPlanRecord = {
    ...existing,
    status,
    updatedAt: new Date(),
  };
  cachePlanRecord(updated);
  return updated;
}

/**
 * Cache execution result entries by plan.
 *
 * Purpose: support /results reads without DB connectivity.
 * Inputs/outputs: execution record stored in per-plan result list.
 * Edge cases: keeps insertion order and updates cached plan snapshot when present.
 */
function cacheExecutionResult(record: ExecutionResultRecord): void {
  const existing = executionResultsCache.get(record.planId) ?? [];
  executionResultsCache.set(record.planId, [...existing, record]);

  const cachedPlan = planCache.get(record.planId);
  if (!cachedPlan) {
    return;
  }

  const previousResults = cachedPlan.executionResults ?? [];
  const updatedPlan: ActionPlanRecord = {
    ...cachedPlan,
    executionResults: [...previousResults, record],
    updatedAt: new Date(),
  };
  cachePlanRecord(updatedPlan);
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

  try {
    const db = getPrisma();
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
    cachePlanRecord(record);

    aiLogger.info('ActionPlan created', {
      module: 'actionPlanStore',
      planId: record.id,
      status: record.status,
      clearDecision: clearResult.decision,
      clearOverall: clearResult.overall,
    });

    return record;
  } catch (error) {
    //audit Assumption: DB writes can fail transiently or be unavailable; risk: plan creation outage; invariant: plan creation still returns deterministic record; handling: cache-backed fallback record.
    const existingPlanId = planIdByIdempotencyKey.get(input.idempotency_key);
    if (existingPlanId) {
      const existing = planCache.get(existingPlanId);
      if (existing) {
        return existing;
      }
    }

    const now = new Date();
    const planId = randomUUID();
    const fallbackActions = input.actions.map((action, index) => ({
      id: action.action_id || randomUUID(),
      planId,
      agentId: action.agent_id,
      capability: action.capability,
      params: action.params as object,
      timeoutMs: action.timeout_ms ?? 30000,
      rollbackAction: action.rollback_action ? (action.rollback_action as object) : null,
      sortOrder: index,
    }));
    const fallbackClearScore = {
      id: randomUUID(),
      planId,
      clarity: clearResult.clarity,
      leverage: clearResult.leverage,
      efficiency: clearResult.efficiency,
      alignment: clearResult.alignment,
      resilience: clearResult.resilience,
      overall: clearResult.overall,
      decision: clearResult.decision,
      notes: clearResult.notes ?? null,
      createdAt: now,
    };
    const fallbackRecord: ActionPlanRecord = {
      id: planId,
      createdBy: input.created_by,
      origin: input.origin,
      status: initialStatus,
      confidence: input.confidence ?? 0,
      requiresConfirmation: input.requires_confirmation ?? true,
      idempotencyKey: input.idempotency_key,
      expiresAt: input.expires_at ? new Date(input.expires_at) : null,
      createdAt: now,
      updatedAt: now,
      actions: fallbackActions,
      clearScore: fallbackClearScore,
      executionResults: [],
    };

    cachePlanRecord(fallbackRecord);
    aiLogger.warn('ActionPlan created using cache fallback', {
      module: 'actionPlanStore',
      planId: fallbackRecord.id,
      status: fallbackRecord.status,
      clearDecision: clearResult.decision,
      error: String(error),
    });
    return fallbackRecord;
  }
}

export async function getPlan(planId: string): Promise<ActionPlanRecord | null> {
  // Check cache first
  const cached = planCache.get(planId);
  if (cached) return cached;

  try {
    const db = getPrisma();
    const plan = await db.actionPlan.findUnique({
      where: { id: planId },
      include: { actions: true, clearScore: true, executionResults: true },
    });

    if (!plan) return null;

    const record = plan as unknown as ActionPlanRecord;
    cachePlanRecord(record);
    return record;
  } catch (error) {
    //audit Assumption: DB read failures should not throw for optional fetch paths; risk: route/tool 500s; invariant: get by id returns null when unavailable; handling: log and return null.
    aiLogger.warn('Failed to get plan from DB; falling back to cache', {
      module: 'actionPlanStore',
      planId,
      error: String(error),
    });
    return null;
  }
}

export async function updatePlanStatus(planId: string, status: PlanStatus): Promise<ActionPlanRecord | null> {
  try {
    const db = getPrisma();
    const plan = await db.actionPlan.update({
      where: { id: planId },
      data: { status },
      include: { actions: true, clearScore: true, executionResults: true },
    });

    const record = plan as unknown as ActionPlanRecord;
    cachePlanRecord(record);

    aiLogger.info('ActionPlan status updated', {
      module: 'actionPlanStore',
      planId,
      status,
    });

    return record;
  } catch (error) {
    //audit Assumption: status transitions should proceed in degraded mode for cached plans; risk: divergence from DB once restored; invariant: cached plan state is internally consistent; handling: update cache and warn.
    const fallback = updateCachedPlanStatus(planId, status);
    if (!fallback) {
      return null;
    }

    aiLogger.warn('ActionPlan status updated via cache fallback', {
      module: 'actionPlanStore',
      planId,
      status,
      error: String(error),
    });
    return fallback;
  }
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
  try {
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
      cachePlanRecord(record);
    }

    return plans as unknown as ActionPlanRecord[];
  } catch (error) {
    //audit Assumption: listing plans should remain available without DB; risk: stale results; invariant: response shape remains stable; handling: return filtered cache.
    aiLogger.warn('Failed to list plans from DB; returning cached plans', {
      module: 'actionPlanStore',
      error: String(error),
      cacheSize: planCache.size,
    });
    return listCachedPlans(filters);
  }
}

export async function expireStalePlans(): Promise<number> {
  const now = new Date();
  const expirableStatuses = ['planned', 'awaiting_confirmation', 'approved'] as const;

  try {
    const db = getPrisma();
    const result = await db.actionPlan.updateMany({
      where: {
        expiresAt: { lte: now },
        status: { in: expirableStatuses as unknown as string[] },
      },
      data: { status: 'expired' },
    });

    if (result.count > 0) {
      // Invalidate cache for expired plans
      for (const [id, plan] of planCache) {
        if (plan.expiresAt && plan.expiresAt <= now && expirableStatuses.includes(plan.status as any)) {
          planCache.set(id, { ...plan, status: 'expired', updatedAt: now });
        }
      }

      aiLogger.info('Expired stale plans', {
        module: 'actionPlanStore',
        count: result.count,
      });
    }

    return result.count;
  } catch (error) {
    //audit Assumption: expiry should still progress for cached plans when DB is unavailable; risk: stale long-lived plans; invariant: cached eligible plans transition to expired; handling: local cache sweep.
    let count = 0;
    for (const [id, plan] of planCache) {
      if (plan.expiresAt && plan.expiresAt <= now && expirableStatuses.includes(plan.status as any)) {
        planCache.set(id, { ...plan, status: 'expired', updatedAt: now });
        count += 1;
      }
    }

    if (count > 0) {
      aiLogger.warn('Expired stale plans via cache fallback', {
        module: 'actionPlanStore',
        count,
        error: String(error),
      });
    }
    return count;
  }
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
): Promise<ExecutionResultRecord> {
  try {
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

    const record = result as unknown as ExecutionResultRecord;
    cacheExecutionResult(record);

    aiLogger.info('ExecutionResult created', {
      module: 'actionPlanStore',
      planId,
      actionId,
      status,
      clearDecision,
    });

    return record;
  } catch (dbError) {
    //audit Assumption: duplicate action execution should be idempotent in fallback mode; risk: duplicate result rows; invariant: one result per plan/action in cache fallback; handling: reuse existing record when present.
    const existingResults = executionResultsCache.get(planId) ?? [];
    const existing = existingResults.find(result => result.actionId === actionId);
    if (existing) {
      return existing;
    }

    const fallbackRecord: ExecutionResultRecord = {
      id: randomUUID(),
      planId,
      actionId,
      agentId,
      status,
      output: (output as object | null) ?? null,
      error: (error as object | null) ?? null,
      signature: signature ?? null,
      clearDecision,
      createdAt: new Date(),
    };
    cacheExecutionResult(fallbackRecord);
    aiLogger.warn('ExecutionResult created using cache fallback', {
      module: 'actionPlanStore',
      planId,
      actionId,
      status,
      clearDecision,
      error: String(dbError),
    });
    return fallbackRecord;
  }
}

export async function getExecutionResults(planId: string): Promise<ExecutionResultRecord[]> {
  try {
    const db = getPrisma();
    const results = await db.executionResult.findMany({
      where: { planId },
      orderBy: { createdAt: 'asc' },
    });
    const records = results as unknown as ExecutionResultRecord[];
    executionResultsCache.set(planId, records);
    return records;
  } catch (error) {
    //audit Assumption: result reads should stay available in degraded mode; risk: missing historical DB rows; invariant: return best-effort cached results; handling: plan-scoped cache fallback.
    const cached = executionResultsCache.get(planId);
    if (cached) {
      return cached;
    }
    const fromPlan = planCache.get(planId)?.executionResults;
    if (fromPlan) {
      return fromPlan;
    }
    aiLogger.warn('Failed to list execution results from DB; returning empty list', {
      module: 'actionPlanStore',
      planId,
      error: String(error),
    });
    return [];
  }
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
      cachePlanRecord(plan as unknown as ActionPlanRecord);
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
