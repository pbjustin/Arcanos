import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { getPool } from '../client.js';
import type { ActionRecord, ClearDecision, PlanStatus } from '@shared/types/actionPlan.js';
import {
  ACTION_PLAN_COMMAND_IDEMPOTENCY_SCOPE,
  ACTION_PLAN_CLAIM_IDEMPOTENCY_SCOPE,
  ACTION_PLAN_RESULT_IDEMPOTENCY_SCOPE,
  ACTION_PLAN_START_IDEMPOTENCY_SCOPE,
  canonicalizeJson,
  fingerprintCanonicalValue,
  hashScopedOpaqueValue,
  type CanonicalJsonValue,
} from '@services/actionPlanExecution/canonical.js';
import {
  ACTION_PLAN_EXECUTION_ERRORS,
  ActionPlanExecutionError,
  isActionPlanExecutionError,
} from '@services/actionPlanExecution/errors.js';
import {
  ACTION_PLAN_SNAPSHOT_SCHEMA_VERSION,
  actionExecutionSnapshotMatches,
  buildActionExecutionSnapshot,
  type ActionExecutionSnapshot,
} from '@services/actionPlanExecution/snapshot.js';

export const ACTION_PLAN_EXECUTION_PERSISTED_PROTOCOL_VERSION = 2;
const ACTION_PLAN_EXECUTION_CLAIM_SCAN_LIMIT = 16;
const ACTION_PLAN_EXECUTION_LOCK_TIMEOUT = '5s';
const ACTION_PLAN_EXECUTION_STATEMENT_TIMEOUT = '30s';
const ACTION_PLAN_TERMINAL_COMMAND_MAX_CHARACTERS = 16_384;

export type ActionPlanExecutionRunState =
  | 'REQUESTED'
  | 'CLAIMED'
  | 'RUNNING'
  | 'SUCCEEDED'
  | 'FAILED'
  | 'CANCELLED'
  | 'EXPIRED'
  | 'SUPERSEDED';

export interface ActionPlanExecutionActor {
  role: 'requester' | 'operator' | 'executor';
  principalId: string;
  executorInstanceId?: string;
  executorAgentId?: string;
}

export interface ActionPlanExecutorBinding {
  kind: 'python-daemon';
  principalId: string;
  instanceId: string;
  agentId: string;
}

export interface ActionPlanExecutionRequestContext {
  requestId?: string;
  traceId?: string;
  sourceService: 'web' | 'mcp' | 'python-daemon';
}

interface PlanRow {
  id: string;
  ownerPrincipalId: string | null;
  executionRealm: string | null;
  executionProtocolVersion: number | null;
  executionGeneration: string | number | null;
  status: PlanStatus;
  expiresAt: Date | string | null;
  requiresConfirmation: boolean;
}

interface AgentRow {
  id: string;
  capabilities: string[];
}

export interface ActionPlanExecutionRunRecord {
  id: string;
  commandId: string;
  planId: string;
  actionId: string;
  attempt: number;
  state: ActionPlanExecutionRunState;
  executorKind: 'python-daemon';
  assignedAgentId: string;
  assignedExecutorPrincipalId: string;
  assignedExecutorInstanceId: string;
  claimedExecutorPrincipalId: string | null;
  claimedExecutorInstanceId: string | null;
  executionRealm: string;
  actionSnapshotId: string;
  actionSnapshotSchemaVersion: number;
  actionSnapshot: ActionExecutionSnapshot;
  claimIdempotencyKeyHash: string | null;
  claimFingerprint: string | null;
  startIdempotencyKeyHash: string | null;
  startFingerprint: string | null;
  resultIdempotencyKeyHash: string | null;
  resultFingerprint: string | null;
  policyCategory: 'ALLOW' | 'CONFIRM';
  policyEvidenceId: string;
  policyEvaluatedAt: Date | string;
  acceptanceReceipt: string | null;
  terminalCategory: ActionPlanExecutionRunState | null;
  resultOutput: CanonicalJsonValue | null;
  resultError: CanonicalJsonValue | null;
  eventSequence: string | number;
  version: string | number;
  requestedAt: Date | string;
  claimedAt: Date | string | null;
  startedAt: Date | string | null;
  completedAt: Date | string | null;
  cancelledAt: Date | string | null;
  expiredAt: Date | string | null;
  supersededAt: Date | string | null;
  updatedAt: Date | string;
}

interface CommandRow {
  id: string;
  planId: string;
  executionRealm: string;
  requesterPrincipalId: string;
  commandIdempotencyKeyHash: string;
  commandFingerprint: string;
  lockedPlanExecutionGeneration: string | number;
  protocolVersion: number;
  createdAt: Date | string;
}

class CommitThenThrowExecutionError extends Error {
  constructor(readonly publicError: ActionPlanExecutionError) {
    super(publicError.message);
  }
}

export interface RequestActionPlanExecutionInput {
  planId: string;
  realm: string;
  actor: ActionPlanExecutionActor;
  executor: ActionPlanExecutorBinding;
  idempotencyKey: string;
  policyExpectation: {
    decision: Exclude<ClearDecision, 'block'>;
    overall: number | null;
    planExecutionGeneration: number;
  };
  sensitiveValues?: readonly string[];
  context: ActionPlanExecutionRequestContext;
}

export type ReplayActionPlanExecutionInput = Omit<
  RequestActionPlanExecutionInput,
  'policyExpectation'
>;

export interface ActionPlanExecutionCommandResult {
  disposition: 'created' | 'idempotent-replay';
  commandId: string;
  planId: string;
  runs: ActionPlanExecutionRunRecord[];
}

export interface ClaimActionPlanExecutionInput {
  realm: string;
  actor: ActionPlanExecutionActor;
  idempotencyKey: string;
  runId?: string;
  planId?: string;
  recoveryOnly?: boolean;
  context: ActionPlanExecutionRequestContext;
}

export interface ActionPlanExecutionClaimResult {
  disposition: 'claimed' | 'idempotent-replay' | 'recovery-status';
  run: ActionPlanExecutionRunRecord;
  assignmentAvailable: boolean;
  planExecutionGeneration: number;
  lifecycleStatus: PlanStatus;
  expiresAt: Date | string | null;
}

export interface StartActionPlanExecutionInput {
  realm: string;
  planId: string;
  runId: string;
  actor: ActionPlanExecutionActor;
  idempotencyKey: string;
  context: ActionPlanExecutionRequestContext;
}

export interface SubmitActionPlanExecutionResultInput {
  realm: string;
  planId: string;
  runId: string;
  actionId: string;
  snapshotId: string;
  actor: ActionPlanExecutionActor;
  idempotencyKey: string;
  outcome: 'succeeded' | 'failed';
  output?: CanonicalJsonValue;
  error?: CanonicalJsonValue;
  context: ActionPlanExecutionRequestContext;
}

export interface ActionPlanExecutionMutationResult {
  disposition: 'accepted' | 'idempotent-replay';
  run: ActionPlanExecutionRunRecord;
}

export interface ReadActionPlanExecutionInput {
  realm: string;
  planId: string;
  runId: string;
  actor: ActionPlanExecutionActor;
}

function numberValue(value: string | number | null): number | null {
  if (value === null) return null;
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function asDate(value: Date | string | null): Date | null {
  if (value === null) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
}

function actorCategory(actor: ActionPlanExecutionActor): 'requester' | 'operator_override' | 'executor' {
  if (actor.role === 'operator') return 'operator_override';
  return actor.role;
}

function assertExecutorActor(actor: ActionPlanExecutionActor): asserts actor is ActionPlanExecutionActor & {
  role: 'executor'; executorInstanceId: string; executorAgentId: string;
} {
  if (actor.role !== 'executor' || !actor.executorInstanceId || !actor.executorAgentId) {
    throw new ActionPlanExecutionError(ACTION_PLAN_EXECUTION_ERRORS.claimConflict);
  }
}

function assertPlanCommandAccess(
  plan: PlanRow,
  input: Pick<RequestActionPlanExecutionInput, 'realm' | 'actor'>,
): number {
  const generation = numberValue(plan.executionGeneration);
  if (
    plan.executionRealm !== input.realm
    || plan.executionProtocolVersion !== ACTION_PLAN_EXECUTION_PERSISTED_PROTOCOL_VERSION
    || generation === null
    || plan.ownerPrincipalId === null
  ) {
    throw new ActionPlanExecutionError(ACTION_PLAN_EXECUTION_ERRORS.provenanceUnavailable);
  }
  if (input.actor.role === 'requester' && plan.ownerPrincipalId !== input.actor.principalId) {
    throw new ActionPlanExecutionError(ACTION_PLAN_EXECUTION_ERRORS.notFound);
  }
  if (input.actor.role === 'executor') {
    throw new ActionPlanExecutionError(ACTION_PLAN_EXECUTION_ERRORS.notFound);
  }
  return generation;
}

function assertPlanCanCreateCommand(plan: PlanRow, generation: number): number {
  if (plan.status !== 'approved') {
    throw new ActionPlanExecutionError(ACTION_PLAN_EXECUTION_ERRORS.stateConflict);
  }
  const expiresAt = asDate(plan.expiresAt);
  if (expiresAt && expiresAt.getTime() <= Date.now()) {
    throw new ActionPlanExecutionError(ACTION_PLAN_EXECUTION_ERRORS.stateConflict);
  }
  return generation;
}

function assertActionSupportedByExecutor(
  action: ActionRecord,
  executor: ActionPlanExecutorBinding,
): void {
  const params = action.params;
  const command = params !== null && typeof params === 'object' && !Array.isArray(params)
    ? (params as Record<string, unknown>).command
    : undefined;
  if (
    action.capability !== 'terminal.run'
    || action.agentId !== executor.agentId
    || executor.kind !== 'python-daemon'
    || typeof command !== 'string'
    || command.trim().length === 0
    || Array.from(command).length > ACTION_PLAN_TERMINAL_COMMAND_MAX_CHARACTERS
  ) {
    throw new ActionPlanExecutionError(ACTION_PLAN_EXECUTION_ERRORS.executorUnavailable);
  }
}

function signedInt32(hex: string): number {
  const value = Number.parseInt(hex, 16);
  return value > 0x7fffffff ? value - 0x100000000 : value;
}

async function acquireScopedTransactionLock(
  client: PoolClient,
  scope: string,
  value: CanonicalJsonValue,
): Promise<void> {
  const digest = fingerprintCanonicalValue(scope, value);
  await client.query(
    'SELECT pg_advisory_xact_lock($1::integer, $2::integer)',
    [signedInt32(digest.slice(0, 8)), signedInt32(digest.slice(8, 16))],
  );
}

function assertCurrentPolicyEvidence(
  planId: string,
  generation: number,
  policy: RequestActionPlanExecutionInput['policyExpectation'],
): { category: 'ALLOW' | 'CONFIRM'; evidenceId: string; evaluatedAt: Date } {
  const score = policy.overall;
  const expected = score === null
    ? policy.decision
    : score >= 0.7
      ? 'allow'
      : score >= 0.4
        ? 'confirm'
        : 'block';
  if (
    (policy.decision !== 'allow' && policy.decision !== 'confirm')
    || !Number.isInteger(policy.planExecutionGeneration)
    || policy.planExecutionGeneration < 1
    || policy.planExecutionGeneration !== generation
    || (score !== null && (!Number.isFinite(score) || score < 0 || score > 1))
    || expected !== policy.decision
  ) {
    throw new ActionPlanExecutionError(ACTION_PLAN_EXECUTION_ERRORS.provenanceUnavailable);
  }
  return {
    category: policy.decision === 'allow' ? 'ALLOW' : 'CONFIRM',
    evidenceId: `clear-recheck-v1:${fingerprintCanonicalValue('action-plan-clear-recheck-v1', {
      plan_id: planId,
      plan_execution_generation: generation,
      decision: policy.decision,
      overall: score,
    })}`,
    evaluatedAt: new Date(),
  };
}

function coherentCommandPolicyEvidence(runs: readonly ActionPlanExecutionRunRecord[]): boolean {
  const first = runs[0];
  const evaluatedAt = first ? asDate(first.policyEvaluatedAt) : null;
  if (
    !first
    || (first.policyCategory !== 'ALLOW' && first.policyCategory !== 'CONFIRM')
    || !/^clear-recheck-v1:[a-f0-9]{64}$/u.test(first.policyEvidenceId)
    || !evaluatedAt
  ) {
    return false;
  }
  return runs.every(run =>
    run.policyCategory === first.policyCategory
    && run.policyEvidenceId === first.policyEvidenceId
    && asDate(run.policyEvaluatedAt)?.getTime() === evaluatedAt.getTime(),
  );
}

function buildCommandFingerprint(
  input: Pick<RequestActionPlanExecutionInput, 'realm' | 'actor' | 'planId' | 'executor'>,
  generation: number,
  snapshots: readonly { action: ActionRecord; snapshot: ActionExecutionSnapshot }[],
): string {
  return fingerprintCanonicalValue('action-plan-command-fingerprint-v1', {
    protocol_version: ACTION_PLAN_EXECUTION_PERSISTED_PROTOCOL_VERSION,
    operation: 'request-execution',
    execution_realm: input.realm,
    requester_principal_id: input.actor.principalId,
    plan_id: input.planId,
    plan_execution_generation: generation,
    actions: snapshots.map(item => ({
      action_id: item.action.id,
      sort_order: item.action.sortOrder,
      snapshot_version: ACTION_PLAN_SNAPSHOT_SCHEMA_VERSION,
      executor_kind: input.executor.kind,
      assigned_executor_principal_id: input.executor.principalId,
      assigned_executor_instance_id: input.executor.instanceId,
    })),
  });
}

function mapActionRow(row: Record<string, unknown>): ActionRecord {
  return {
    id: String(row.id),
    planId: String(row.planId),
    agentId: String(row.agentId),
    capability: String(row.capability),
    params: row.params,
    timeoutMs: Number(row.timeoutMs),
    rollbackAction: row.rollbackAction ?? null,
    sortOrder: Number(row.sortOrder),
  };
}

async function appendEvent(
  client: PoolClient,
  run: ActionPlanExecutionRunRecord,
  eventType: string,
  reasonCode: string,
  actor: ActionPlanExecutionActor,
  context: ActionPlanExecutionRequestContext,
  safeMetadata: Record<string, string | number | boolean | null> = {},
): Promise<number> {
  const nextSequence = Number(run.eventSequence) + 1;
  await client.query(
    `INSERT INTO "ActionPlanExecutionEvent" (
      "id", "runId", "eventSequence", "eventType", "actorCategory", "sourceService",
      "executionRealm", "reasonCode", "requestId", "traceId", "safeMetadata"
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb)`,
    [
      randomUUID(), run.id, nextSequence, eventType, actorCategory(actor), context.sourceService,
      run.executionRealm, reasonCode, context.requestId ?? null, context.traceId ?? null,
      JSON.stringify(safeMetadata),
    ],
  );
  run.eventSequence = nextSequence;
  return nextSequence;
}

async function lockCommandGraph(
  client: PoolClient,
  commandId: string,
): Promise<{ command: CommandRow; runs: ActionPlanExecutionRunRecord[]; plan: PlanRow; actions: ActionRecord[] }> {
  const commandResult = await client.query<CommandRow>(
    'SELECT * FROM "ActionPlanExecutionCommand" WHERE "id" = $1 FOR UPDATE',
    [commandId],
  );
  const command = commandResult.rows[0];
  if (!command) throw new ActionPlanExecutionError(ACTION_PLAN_EXECUTION_ERRORS.notFound);

  const runResult = await client.query<ActionPlanExecutionRunRecord>(
    `SELECT * FROM "ActionPlanExecutionRun" WHERE "commandId" = $1
     ORDER BY ("actionSnapshot"->>'sort_order')::integer, "actionId", "id" FOR UPDATE`,
    [commandId],
  );
  const planResult = await client.query<PlanRow>(
    'SELECT * FROM "ActionPlan" WHERE "id" = $1 AND "executionRealm" = $2 FOR UPDATE',
    [command.planId, command.executionRealm],
  );
  const plan = planResult.rows[0];
  if (!plan) throw new ActionPlanExecutionError(ACTION_PLAN_EXECUTION_ERRORS.notFound);
  const actionResult = await client.query<Record<string, unknown>>(
    'SELECT * FROM "Action" WHERE "planId" = $1 ORDER BY "sortOrder", "id" FOR UPDATE',
    [command.planId],
  );
  return { command, runs: runResult.rows, plan, actions: actionResult.rows.map(mapActionRow) };
}

function authorizeRunRead(
  command: CommandRow,
  run: ActionPlanExecutionRunRecord,
  actor: ActionPlanExecutionActor,
): void {
  if (actor.role === 'operator') return;
  if (actor.role === 'requester' && command.requesterPrincipalId === actor.principalId) return;
  if (
    actor.role === 'executor'
    && actor.executorInstanceId
    && actor.executorAgentId
    && run.assignedExecutorPrincipalId === actor.principalId
    && run.assignedExecutorInstanceId === actor.executorInstanceId
    && run.assignedAgentId === actor.executorAgentId
  ) return;
  throw new ActionPlanExecutionError(ACTION_PLAN_EXECUTION_ERRORS.notFound);
}

export class ActionPlanExecutionRepository {
  constructor(private readonly pool: Pool) {}

  private async transact<T>(operation: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `SELECT set_config('lock_timeout',$1,true), set_config('statement_timeout',$2,true)`,
        [ACTION_PLAN_EXECUTION_LOCK_TIMEOUT, ACTION_PLAN_EXECUTION_STATEMENT_TIMEOUT],
      );
      const result = await operation(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      if (error instanceof CommitThenThrowExecutionError) {
        try {
          await client.query('COMMIT');
        } catch (commitError) {
          try { await client.query('ROLLBACK'); } catch { /* preserve commit failure */ }
          throw new ActionPlanExecutionError(ACTION_PLAN_EXECUTION_ERRORS.persistenceFailed, {
            retryable: true,
            cause: commitError,
          });
        }
        throw error.publicError;
      }
      try { await client.query('ROLLBACK'); } catch { /* the original error remains authoritative */ }
      if (isActionPlanExecutionError(error)) throw error;
      throw new ActionPlanExecutionError(ACTION_PLAN_EXECUTION_ERRORS.persistenceFailed, {
        retryable: true,
        cause: error,
      });
    } finally {
      client.release();
    }
  }

  async requestExecution(input: RequestActionPlanExecutionInput): Promise<ActionPlanExecutionCommandResult> {
    return this.resolveExecutionCommand(input);
  }

  /**
   * Resolve a previously committed command without creating runs. This is used
   * before lifecycle re-evaluation so a lost response remains replayable after
   * the plan advances to in-progress or a terminal state.
   */
  async replayExecution(input: ReplayActionPlanExecutionInput): Promise<ActionPlanExecutionCommandResult | null> {
    return this.transact(async client => {
      const keyHash = hashScopedOpaqueValue(ACTION_PLAN_COMMAND_IDEMPOTENCY_SCOPE, input.idempotencyKey);
      await acquireScopedTransactionLock(client, 'action-plan-command-lock-v1', {
        execution_realm: input.realm,
        requester_principal_id: input.actor.principalId,
        plan_id: input.planId,
        key_hash: keyHash,
      });
      const planResult = await client.query<PlanRow>(
        'SELECT * FROM "ActionPlan" WHERE "id"=$1 AND "executionRealm"=$2 FOR UPDATE',
        [input.planId, input.realm],
      );
      const plan = planResult.rows[0];
      if (!plan) throw new ActionPlanExecutionError(ACTION_PLAN_EXECUTION_ERRORS.notFound);
      const generation = assertPlanCommandAccess(plan, input);
      const existingResult = await client.query<CommandRow>(
        `SELECT * FROM "ActionPlanExecutionCommand"
         WHERE "executionRealm"=$1 AND "requesterPrincipalId"=$2 AND "planId"=$3
           AND "commandIdempotencyKeyHash"=$4`,
        [input.realm, input.actor.principalId, input.planId, keyHash],
      );
      const existing = existingResult.rows[0];
      if (!existing) return null;
      if (
        existing.protocolVersion !== ACTION_PLAN_EXECUTION_PERSISTED_PROTOCOL_VERSION
        || numberValue(existing.lockedPlanExecutionGeneration) !== generation
      ) {
        throw new ActionPlanExecutionError(ACTION_PLAN_EXECUTION_ERRORS.commandIdempotencyConflict);
      }
      const runs = await client.query<ActionPlanExecutionRunRecord>(
        `SELECT * FROM "ActionPlanExecutionRun" WHERE "commandId"=$1
         ORDER BY ("actionSnapshot"->>'sort_order')::integer, "actionId", "id"`,
        [existing.id],
      );
      if (runs.rows.length === 0) {
        throw new ActionPlanExecutionError(ACTION_PLAN_EXECUTION_ERRORS.persistenceFailed, { retryable: true });
      }
      const actionResult = await client.query<Record<string, unknown>>(
        'SELECT * FROM "Action" WHERE "planId"=$1 ORDER BY "sortOrder", "id" FOR UPDATE',
        [input.planId],
      );
      const actions = actionResult.rows.map(mapActionRow);
      if (actions.length !== runs.rows.length) {
        throw new ActionPlanExecutionError(ACTION_PLAN_EXECUTION_ERRORS.commandIdempotencyConflict);
      }
      const snapshots: Array<{ action: ActionRecord; snapshot: ActionExecutionSnapshot }> = [];
      for (const action of actions) {
        assertActionSupportedByExecutor(action, input.executor);
        const agentResult = await client.query<AgentRow>(
          'SELECT "id", "capabilities" FROM "Agent" WHERE "id"=$1 FOR SHARE',
          [action.agentId],
        );
        const agent = agentResult.rows[0];
        if (!agent || !Array.isArray(agent.capabilities) || !agent.capabilities.includes(action.capability)) {
          throw new ActionPlanExecutionError(ACTION_PLAN_EXECUTION_ERRORS.commandIdempotencyConflict);
        }
        snapshots.push({
          action,
          snapshot: buildActionExecutionSnapshot(action, {
            planExecutionGeneration: generation,
            executorKind: input.executor.kind,
            assignedExecutorPrincipalId: input.executor.principalId,
            agentCapabilities: agent.capabilities,
            sensitiveValues: input.sensitiveValues,
          }),
        });
      }
      const snapshotsStillMatch = runs.rows.every((run, index) =>
        run.actionId === actions[index]?.id
        && Number(run.actionSnapshotSchemaVersion) === ACTION_PLAN_SNAPSHOT_SCHEMA_VERSION
        && run.executorKind === input.executor.kind
        && run.assignedExecutorPrincipalId === input.executor.principalId
        && run.assignedExecutorInstanceId === input.executor.instanceId
        && canonicalizeJson(run.actionSnapshot as unknown as CanonicalJsonValue)
          === canonicalizeJson(snapshots[index]?.snapshot as unknown as CanonicalJsonValue),
      );
      if (
        !snapshotsStillMatch
        || !coherentCommandPolicyEvidence(runs.rows)
        || existing.commandFingerprint !== buildCommandFingerprint(input, generation, snapshots)
      ) {
        throw new ActionPlanExecutionError(ACTION_PLAN_EXECUTION_ERRORS.commandIdempotencyConflict);
      }
      return { disposition: 'idempotent-replay', commandId: existing.id, planId: input.planId, runs: runs.rows };
    });
  }

  private async resolveExecutionCommand(
    input: RequestActionPlanExecutionInput,
  ): Promise<ActionPlanExecutionCommandResult> {
    return this.transact(async client => {
      const keyHash = hashScopedOpaqueValue(ACTION_PLAN_COMMAND_IDEMPOTENCY_SCOPE, input.idempotencyKey);
      await acquireScopedTransactionLock(client, 'action-plan-command-lock-v1', {
        execution_realm: input.realm,
        requester_principal_id: input.actor.principalId,
        plan_id: input.planId,
        key_hash: keyHash,
      });

      const planResult = await client.query<PlanRow>(
        'SELECT * FROM "ActionPlan" WHERE "id"=$1 AND "executionRealm"=$2 FOR UPDATE',
        [input.planId, input.realm],
      );
      const plan = planResult.rows[0];
      if (!plan) throw new ActionPlanExecutionError(ACTION_PLAN_EXECUTION_ERRORS.notFound);
      const generation = assertPlanCommandAccess(plan, input);

      const existingResult = await client.query<CommandRow>(
        `SELECT * FROM "ActionPlanExecutionCommand"
         WHERE "executionRealm"=$1 AND "requesterPrincipalId"=$2 AND "planId"=$3
           AND "commandIdempotencyKeyHash"=$4`,
        [input.realm, input.actor.principalId, input.planId, keyHash],
      );
      const existing = existingResult.rows[0];
      if (existing) {
        if (
          existing.protocolVersion !== ACTION_PLAN_EXECUTION_PERSISTED_PROTOCOL_VERSION
          || numberValue(existing.lockedPlanExecutionGeneration) !== generation
        ) {
          throw new ActionPlanExecutionError(ACTION_PLAN_EXECUTION_ERRORS.commandIdempotencyConflict);
        }
      }

      if (!existing) assertPlanCanCreateCommand(plan, generation);

      const actionResult = await client.query<Record<string, unknown>>(
        'SELECT * FROM "Action" WHERE "planId"=$1 ORDER BY "sortOrder", "id" FOR UPDATE',
        [input.planId],
      );
      const actions = actionResult.rows.map(mapActionRow);
      if (actions.length === 0) {
        throw new ActionPlanExecutionError(
          existing
            ? ACTION_PLAN_EXECUTION_ERRORS.commandIdempotencyConflict
            : ACTION_PLAN_EXECUTION_ERRORS.requestInvalid,
        );
      }

      let policy: ReturnType<typeof assertCurrentPolicyEvidence>;
      try {
        policy = assertCurrentPolicyEvidence(input.planId, generation, input.policyExpectation);
      } catch (error) {
        if (existing) {
          throw new ActionPlanExecutionError(ACTION_PLAN_EXECUTION_ERRORS.commandIdempotencyConflict);
        }
        throw error;
      }
      const snapshots = [] as Array<{ action: ActionRecord; snapshot: ActionExecutionSnapshot; snapshotId: string }>;
      try {
        for (const action of actions) {
          assertActionSupportedByExecutor(action, input.executor);
          const agentResult = await client.query<AgentRow>(
            'SELECT "id", "capabilities" FROM "Agent" WHERE "id"=$1 FOR SHARE',
            [action.agentId],
          );
          const agent = agentResult.rows[0];
          if (!agent || !Array.isArray(agent.capabilities) || !agent.capabilities.includes(action.capability)) {
            throw new ActionPlanExecutionError(ACTION_PLAN_EXECUTION_ERRORS.executorUnavailable);
          }
          snapshots.push({
            action,
            snapshot: buildActionExecutionSnapshot(action, {
              planExecutionGeneration: generation,
              executorKind: input.executor.kind,
              assignedExecutorPrincipalId: input.executor.principalId,
              agentCapabilities: agent.capabilities,
              sensitiveValues: input.sensitiveValues,
            }),
            snapshotId: randomUUID(),
          });
        }
      } catch (error) {
        if (existing) {
          throw new ActionPlanExecutionError(ACTION_PLAN_EXECUTION_ERRORS.commandIdempotencyConflict);
        }
        throw error;
      }

      const fingerprint = buildCommandFingerprint(input, generation, snapshots);

      if (existing) {
        if (existing.commandFingerprint !== fingerprint) {
          throw new ActionPlanExecutionError(ACTION_PLAN_EXECUTION_ERRORS.commandIdempotencyConflict);
        }
        const runs = await client.query<ActionPlanExecutionRunRecord>(
          `SELECT * FROM "ActionPlanExecutionRun" WHERE "commandId"=$1
           ORDER BY ("actionSnapshot"->>'sort_order')::integer, "actionId", "id"`,
          [existing.id],
        );
        if (runs.rows.length === 0) {
          throw new ActionPlanExecutionError(ACTION_PLAN_EXECUTION_ERRORS.persistenceFailed, { retryable: true });
        }
        const snapshotsStillMatch = runs.rows.length === snapshots.length
          && runs.rows.every((run, index) => {
            const expected = snapshots[index];
            return run.actionId === expected.action.id
              && Number(run.actionSnapshotSchemaVersion) === ACTION_PLAN_SNAPSHOT_SCHEMA_VERSION
              && run.executorKind === input.executor.kind
              && run.assignedExecutorPrincipalId === input.executor.principalId
              && run.assignedExecutorInstanceId === input.executor.instanceId
              && canonicalizeJson(run.actionSnapshot as unknown as CanonicalJsonValue)
                === canonicalizeJson(expected.snapshot as unknown as CanonicalJsonValue);
          });
        if (!snapshotsStillMatch) {
          throw new ActionPlanExecutionError(ACTION_PLAN_EXECUTION_ERRORS.commandIdempotencyConflict);
        }
        const policyStillMatches = runs.rows.every(run =>
          run.policyCategory === policy.category
          && run.policyEvidenceId === policy.evidenceId,
        );
        if (!policyStillMatches) {
          throw new ActionPlanExecutionError(ACTION_PLAN_EXECUTION_ERRORS.commandIdempotencyConflict);
        }
        return { disposition: 'idempotent-replay', commandId: existing.id, planId: input.planId, runs: runs.rows };
      }

      const legacyResult = await client.query(
        'SELECT 1 FROM "ExecutionResult" WHERE "planId"=$1 LIMIT 1',
        [input.planId],
      );
      if (legacyResult.rowCount) {
        throw new ActionPlanExecutionError(ACTION_PLAN_EXECUTION_ERRORS.legacyStateUnresolved);
      }

      const activeResult = await client.query(
        `SELECT 1 FROM "ActionPlanExecutionRun"
         WHERE "planId"=$1 AND "state" IN ('REQUESTED','CLAIMED','RUNNING') LIMIT 1`,
        [input.planId],
      );

      if (activeResult.rowCount) {
        throw new ActionPlanExecutionError(ACTION_PLAN_EXECUTION_ERRORS.active);
      }

      const commandId = randomUUID();
      await client.query(
        `INSERT INTO "ActionPlanExecutionCommand" (
          "id","planId","executionRealm","requesterPrincipalId","commandIdempotencyKeyHash",
          "commandFingerprint","lockedPlanExecutionGeneration","protocolVersion"
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [commandId, input.planId, input.realm, input.actor.principalId, keyHash, fingerprint, generation,
          ACTION_PLAN_EXECUTION_PERSISTED_PROTOCOL_VERSION],
      );

      const runs: ActionPlanExecutionRunRecord[] = [];
      for (const item of snapshots) {
        const runId = randomUUID();
        const inserted = await client.query<ActionPlanExecutionRunRecord>(
          `INSERT INTO "ActionPlanExecutionRun" (
            "id","commandId","planId","actionId","attempt","state","executorKind","assignedAgentId",
            "assignedExecutorPrincipalId","assignedExecutorInstanceId","executionRealm","actionSnapshotId",
            "actionSnapshotSchemaVersion","actionSnapshot","policyCategory","policyEvidenceId","policyEvaluatedAt",
            "eventSequence","version"
          ) VALUES ($1,$2,$3,$4,1,'REQUESTED',$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13,$14,$15,0,0)
          RETURNING *`,
          [runId, commandId, input.planId, item.action.id, input.executor.kind, input.executor.agentId,
            input.executor.principalId, input.executor.instanceId, input.realm, item.snapshotId,
            ACTION_PLAN_SNAPSHOT_SCHEMA_VERSION, JSON.stringify(item.snapshot), policy.category,
            policy.evidenceId, policy.evaluatedAt],
        );
        const run = inserted.rows[0];
        await appendEvent(client, run, 'EXECUTION_REQUESTED', 'execution_requested', input.actor, input.context, {
          commandId,
          actionId: item.action.id,
        });
        await client.query(
          'UPDATE "ActionPlanExecutionRun" SET "eventSequence"=$2,"version"="version"+1,"updatedAt"=CURRENT_TIMESTAMP WHERE "id"=$1',
          [run.id, run.eventSequence],
        );
        run.version = Number(run.version) + 1;
        runs.push(run);
      }
      return { disposition: 'created', commandId, planId: input.planId, runs };
    });
  }

  private async resolveCommandId(
    client: PoolClient,
    realm: string,
    planId: string,
    runId: string,
  ): Promise<string> {
    const result = await client.query<{ commandId: string }>(
      `SELECT "commandId" FROM "ActionPlanExecutionRun"
       WHERE "id"=$1 AND "planId"=$2 AND "executionRealm"=$3`,
      [runId, planId, realm],
    );
    const commandId = result.rows[0]?.commandId;
    if (!commandId) throw new ActionPlanExecutionError(ACTION_PLAN_EXECUTION_ERRORS.notFound);
    return commandId;
  }

  private async supersedeUnstartedRuns(
    client: PoolClient,
    graph: Awaited<ReturnType<typeof lockCommandGraph>>,
    actor: ActionPlanExecutionActor,
    context: ActionPlanExecutionRequestContext,
    reasonCode: string,
  ): Promise<void> {
    for (const run of graph.runs) {
      if (run.state !== 'REQUESTED' && run.state !== 'CLAIMED') continue;
      await client.query(
        `UPDATE "ActionPlanExecutionRun" SET
          "state"='SUPERSEDED',"terminalCategory"='SUPERSEDED',"supersededAt"=CURRENT_TIMESTAMP,
          "version"="version"+1,"updatedAt"=CURRENT_TIMESTAMP
         WHERE "id"=$1 AND "state" IN ('REQUESTED','CLAIMED')`,
        [run.id],
      );
      run.state = 'SUPERSEDED';
      run.terminalCategory = 'SUPERSEDED';
      run.supersededAt = new Date();
      await appendEvent(client, run, 'RUN_SUPERSEDED', reasonCode, actor, context, {
        commandId: graph.command.id,
        actionId: run.actionId,
      });
      await client.query(
        'UPDATE "ActionPlanExecutionRun" SET "eventSequence"=$2,"version"="version"+1,"updatedAt"=CURRENT_TIMESTAMP WHERE "id"=$1',
        [run.id, run.eventSequence],
      );
    }
  }

  private async validateClaimOrStartGraph(
    client: PoolClient,
    graph: Awaited<ReturnType<typeof lockCommandGraph>>,
    run: ActionPlanExecutionRunRecord,
    actor: ActionPlanExecutionActor,
    context: ActionPlanExecutionRequestContext,
  ): Promise<ActionPlanExecutionError | null> {
    assertExecutorActor(actor);
    const generation = numberValue(graph.plan.executionGeneration);
    const commandGeneration = numberValue(graph.command.lockedPlanExecutionGeneration);
    const statusCompatible = graph.plan.status === 'approved'
      || (
        graph.plan.status === 'in_progress'
        && graph.runs.some(item => item.state === 'RUNNING' || item.state === 'SUCCEEDED' || item.state === 'FAILED')
      );
    const executorCompatible =
      run.assignedExecutorPrincipalId === actor.principalId
      && run.assignedExecutorInstanceId === actor.executorInstanceId
      && run.assignedAgentId === actor.executorAgentId;
    const provenanceCompatible =
      graph.plan.executionRealm === run.executionRealm
      && run.executionRealm === graph.command.executionRealm
      && graph.plan.executionProtocolVersion === ACTION_PLAN_EXECUTION_PERSISTED_PROTOCOL_VERSION;
    const expiresAt = asDate(graph.plan.expiresAt);
    const currentAction = graph.actions.find(action => action.id === run.actionId);

    const policyCompatible = coherentCommandPolicyEvidence(graph.runs);

    const agentResult = await client.query<AgentRow>(
      'SELECT "id", "capabilities" FROM "Agent" WHERE "id"=$1 FOR SHARE',
      [run.assignedAgentId],
    );
    const agent = agentResult.rows[0];
    const capabilityCompatible = Boolean(
      agent && Array.isArray(agent.capabilities) && agent.capabilities.includes('terminal.run'),
    );
    const actionCompatible = Boolean(
      currentAction
      && currentAction.agentId === actor.executorAgentId
      && currentAction.capability === 'terminal.run'
      && generation !== null
      && agent
      && actionExecutionSnapshotMatches(currentAction, run.actionSnapshot, {
        planExecutionGeneration: generation,
        executorKind: run.executorKind,
        assignedExecutorPrincipalId: run.assignedExecutorPrincipalId,
        agentCapabilities: agent.capabilities,
      }),
    );

    if (
      generation === null
      || commandGeneration === null
      || generation !== commandGeneration
      || !statusCompatible
      || !executorCompatible
      || !provenanceCompatible
      || Boolean(expiresAt && expiresAt.getTime() <= Date.now())
      || !actionCompatible
      || !policyCompatible
      || !capabilityCompatible
    ) {
      await this.supersedeUnstartedRuns(client, graph, actor, context, 'execution_evidence_stale');
      return new ActionPlanExecutionError(
        generation !== commandGeneration
          ? ACTION_PLAN_EXECUTION_ERRORS.generationConflict
          : !actionCompatible
            ? ACTION_PLAN_EXECUTION_ERRORS.snapshotConflict
            : ACTION_PLAN_EXECUTION_ERRORS.stateConflict,
      );
    }
    return null;
  }

  private async rejectOwnedResult(
    client: PoolClient,
    run: ActionPlanExecutionRunRecord,
    actor: ActionPlanExecutionActor,
    context: ActionPlanExecutionRequestContext,
    reasonCode: string,
    publicError: ActionPlanExecutionError,
  ): Promise<never> {
    const existing = await client.query(
      `SELECT 1 FROM "ActionPlanExecutionEvent"
       WHERE "runId"=$1 AND "eventType"='RESULT_REJECTED' AND "reasonCode"=$2 LIMIT 1`,
      [run.id, reasonCode],
    );
    if (!existing.rowCount) {
      await appendEvent(client, run, 'RESULT_REJECTED', reasonCode, actor, context, {
        commandId: run.commandId,
        actionId: run.actionId,
      });
      await client.query(
        'UPDATE "ActionPlanExecutionRun" SET "eventSequence"=$2,"version"="version"+1,"updatedAt"=CURRENT_TIMESTAMP WHERE "id"=$1',
        [run.id, run.eventSequence],
      );
    }
    throw new CommitThenThrowExecutionError(publicError);
  }

  async claimExecution(input: ClaimActionPlanExecutionInput): Promise<ActionPlanExecutionClaimResult | null> {
    return this.transact(async client => {
      assertExecutorActor(input.actor);
      if ((input.runId === undefined) !== (input.planId === undefined)) {
        throw new ActionPlanExecutionError(ACTION_PLAN_EXECUTION_ERRORS.requestInvalid);
      }
      const keyHash = hashScopedOpaqueValue(ACTION_PLAN_CLAIM_IDEMPOTENCY_SCOPE, input.idempotencyKey);
      await acquireScopedTransactionLock(client, 'action-plan-claim-lock-v1', {
        execution_realm: input.realm,
        executor_principal_id: input.actor.principalId,
        executor_instance_id: input.actor.executorInstanceId,
        key_hash: keyHash,
      });
      const existingResult = await client.query<ActionPlanExecutionRunRecord>(
        `SELECT * FROM "ActionPlanExecutionRun"
         WHERE "executionRealm"=$1 AND "assignedExecutorPrincipalId"=$2
           AND "assignedExecutorInstanceId"=$3 AND "claimIdempotencyKeyHash"=$4`,
        [input.realm, input.actor.principalId, input.actor.executorInstanceId, keyHash],
      );
      const existing = existingResult.rows[0];
      if (existing) {
        if (existing.assignedAgentId !== input.actor.executorAgentId) {
          throw new ActionPlanExecutionError(ACTION_PLAN_EXECUTION_ERRORS.notFound);
        }
        if (input.runId && input.runId !== existing.id) {
          throw new ActionPlanExecutionError(ACTION_PLAN_EXECUTION_ERRORS.claimConflict);
        }
        if (input.planId && input.planId !== existing.planId) {
          throw new ActionPlanExecutionError(ACTION_PLAN_EXECUTION_ERRORS.notFound);
        }
        const expectedFingerprint = fingerprintCanonicalValue('action-plan-claim-fingerprint-v1', {
          execution_realm: input.realm,
          principal_id: input.actor.principalId,
          instance_id: input.actor.executorInstanceId,
          run_id: existing.id,
        });
        if (existing.claimFingerprint !== expectedFingerprint) {
          throw new ActionPlanExecutionError(ACTION_PLAN_EXECUTION_ERRORS.claimConflict);
        }
        const graph = await lockCommandGraph(client, existing.commandId);
        const lockedExisting = graph.runs.find(run => run.id === existing.id);
        const generation = numberValue(graph.plan.executionGeneration);
        if (!lockedExisting || generation === null) {
          throw new ActionPlanExecutionError(ACTION_PLAN_EXECUTION_ERRORS.notFound);
        }
        return {
          disposition: lockedExisting.state === 'CLAIMED' ? 'idempotent-replay' : 'recovery-status',
          run: lockedExisting,
          assignmentAvailable: lockedExisting.state === 'CLAIMED',
          planExecutionGeneration: generation,
          lifecycleStatus: graph.plan.status,
          expiresAt: graph.plan.expiresAt,
        };
      }

      if (input.recoveryOnly) {
        throw new ActionPlanExecutionError(ACTION_PLAN_EXECUTION_ERRORS.stateConflict);
      }

      const exactClaim = input.runId !== undefined && input.planId !== undefined;
      for (let scan = 0; scan < (exactClaim ? 1 : ACTION_PLAN_EXECUTION_CLAIM_SCAN_LIMIT); scan += 1) {
        let commandId: string;
        if (exactClaim) {
          commandId = await this.resolveCommandId(client, input.realm, input.planId!, input.runId!);
        } else {
          const candidate = await client.query<{ id: string }>(
            `SELECT c."id"
             FROM "ActionPlanExecutionCommand" c
             WHERE c."executionRealm"=$1
               AND EXISTS (
                 SELECT 1 FROM "ActionPlanExecutionRun" r
                 WHERE r."commandId"=c."id" AND r."state"='REQUESTED'
                   AND r."assignedExecutorPrincipalId"=$2 AND r."assignedExecutorInstanceId"=$3
                   AND r."assignedAgentId"=$4
               )
             ORDER BY (
               SELECT MIN(r2."requestedAt") FROM "ActionPlanExecutionRun" r2
               WHERE r2."commandId"=c."id" AND r2."state"='REQUESTED'
                 AND r2."assignedExecutorPrincipalId"=$2 AND r2."assignedExecutorInstanceId"=$3
                 AND r2."assignedAgentId"=$4
             ), c."id"
             FOR UPDATE OF c SKIP LOCKED LIMIT 1`,
            [input.realm, input.actor.principalId, input.actor.executorInstanceId, input.actor.executorAgentId],
          );
          if (!candidate.rows[0]) return null;
          commandId = candidate.rows[0].id;
        }

        const graph = await lockCommandGraph(client, commandId);
        const run = input.runId
          ? graph.runs.find(item => item.id === input.runId)
          : graph.runs.find(item =>
            item.state === 'REQUESTED'
            && item.assignedExecutorPrincipalId === input.actor.principalId
            && item.assignedExecutorInstanceId === input.actor.executorInstanceId
            && item.assignedAgentId === input.actor.executorAgentId,
          );
        if (!run || run.executionRealm !== input.realm || run.state !== 'REQUESTED') {
          if (exactClaim) throw new ActionPlanExecutionError(ACTION_PLAN_EXECUTION_ERRORS.notFound);
          continue;
        }
        if (
          run.assignedExecutorPrincipalId !== input.actor.principalId
          || run.assignedExecutorInstanceId !== input.actor.executorInstanceId
          || run.assignedAgentId !== input.actor.executorAgentId
        ) {
          throw new ActionPlanExecutionError(ACTION_PLAN_EXECUTION_ERRORS.notFound);
        }
        const validationError = await this.validateClaimOrStartGraph(
          client,
          graph,
          run,
          input.actor,
          input.context,
        );
        if (validationError) {
          if (exactClaim) throw new CommitThenThrowExecutionError(validationError);
          continue;
        }

        const claimFingerprint = fingerprintCanonicalValue('action-plan-claim-fingerprint-v1', {
          execution_realm: input.realm,
          principal_id: input.actor.principalId,
          instance_id: input.actor.executorInstanceId,
          run_id: run.id,
        });
        const updated = await client.query<ActionPlanExecutionRunRecord>(
          `UPDATE "ActionPlanExecutionRun" SET
            "state"='CLAIMED',"claimedExecutorPrincipalId"=$2,"claimedExecutorInstanceId"=$3,
            "claimIdempotencyKeyHash"=$4,"claimFingerprint"=$5,"claimedAt"=CURRENT_TIMESTAMP,
            "version"="version"+1,"updatedAt"=CURRENT_TIMESTAMP
           WHERE "id"=$1 AND "state"='REQUESTED' RETURNING *`,
          [run.id, input.actor.principalId, input.actor.executorInstanceId, keyHash, claimFingerprint],
        );
        const claimed = updated.rows[0];
        if (!claimed) throw new ActionPlanExecutionError(ACTION_PLAN_EXECUTION_ERRORS.claimConflict);
        await appendEvent(client, claimed, 'EXECUTION_CLAIMED', 'execution_claimed', input.actor, input.context, {
          commandId: claimed.commandId,
          actionId: claimed.actionId,
        });
        await client.query(
          'UPDATE "ActionPlanExecutionRun" SET "eventSequence"=$2,"version"="version"+1,"updatedAt"=CURRENT_TIMESTAMP WHERE "id"=$1',
          [claimed.id, claimed.eventSequence],
        );
        const generation = numberValue(graph.plan.executionGeneration);
        if (generation === null) throw new ActionPlanExecutionError(ACTION_PLAN_EXECUTION_ERRORS.provenanceUnavailable);
        return {
          disposition: 'claimed',
          run: claimed,
          assignmentAvailable: true,
          planExecutionGeneration: generation,
          lifecycleStatus: graph.plan.status,
          expiresAt: graph.plan.expiresAt,
        };
      }
      return null;
    });
  }

  async startExecution(input: StartActionPlanExecutionInput): Promise<ActionPlanExecutionMutationResult> {
    return this.transact(async client => {
      assertExecutorActor(input.actor);
      const commandId = await this.resolveCommandId(client, input.realm, input.planId, input.runId);
      const graph = await lockCommandGraph(client, commandId);
      const run = graph.runs.find(item => item.id === input.runId);
      if (!run || run.executionRealm !== input.realm) {
        throw new ActionPlanExecutionError(ACTION_PLAN_EXECUTION_ERRORS.notFound);
      }
      if (
        run.claimedExecutorPrincipalId !== input.actor.principalId
        || run.claimedExecutorInstanceId !== input.actor.executorInstanceId
        || run.assignedExecutorPrincipalId !== input.actor.principalId
        || run.assignedExecutorInstanceId !== input.actor.executorInstanceId
        || run.assignedAgentId !== input.actor.executorAgentId
      ) {
        throw new ActionPlanExecutionError(ACTION_PLAN_EXECUTION_ERRORS.notFound);
      }
      const keyHash = hashScopedOpaqueValue(ACTION_PLAN_START_IDEMPOTENCY_SCOPE, input.idempotencyKey);
      const fingerprint = fingerprintCanonicalValue('action-plan-start-fingerprint-v1', {
        execution_realm: input.realm,
        run_id: run.id,
        principal_id: input.actor.principalId,
        instance_id: input.actor.executorInstanceId,
      });
      if (run.state === 'RUNNING' && run.startIdempotencyKeyHash === keyHash && run.startFingerprint === fingerprint) {
        return { disposition: 'idempotent-replay', run };
      }
      if (run.state !== 'CLAIMED') {
        throw new ActionPlanExecutionError(ACTION_PLAN_EXECUTION_ERRORS.stateConflict);
      }
      const validationError = await this.validateClaimOrStartGraph(
        client,
        graph,
        run,
        input.actor,
        input.context,
      );
      if (validationError) throw new CommitThenThrowExecutionError(validationError);

      const updated = await client.query<ActionPlanExecutionRunRecord>(
        `UPDATE "ActionPlanExecutionRun" SET
          "state"='RUNNING',"startIdempotencyKeyHash"=$2,"startFingerprint"=$3,
          "startedAt"=CURRENT_TIMESTAMP,"version"="version"+1,"updatedAt"=CURRENT_TIMESTAMP
         WHERE "id"=$1 AND "state"='CLAIMED' RETURNING *`,
        [run.id, keyHash, fingerprint],
      );
      const running = updated.rows[0];
      if (!running) throw new ActionPlanExecutionError(ACTION_PLAN_EXECUTION_ERRORS.stateConflict);

      if (graph.plan.status === 'approved') {
        const planUpdate = await client.query(
          `UPDATE "ActionPlan" SET "status"='in_progress',"updatedAt"=CURRENT_TIMESTAMP
           WHERE "id"=$1 AND "executionRealm"=$2 AND "executionGeneration"=$3 AND "status"='approved'`,
          [graph.plan.id, input.realm, graph.command.lockedPlanExecutionGeneration],
        );
        if (planUpdate.rowCount !== 1) {
          throw new ActionPlanExecutionError(ACTION_PLAN_EXECUTION_ERRORS.generationConflict);
        }
      }
      await appendEvent(client, running, 'EXECUTION_STARTED', 'execution_started', input.actor, input.context, {
        commandId: running.commandId,
        actionId: running.actionId,
      });
      await client.query(
        'UPDATE "ActionPlanExecutionRun" SET "eventSequence"=$2,"version"="version"+1,"updatedAt"=CURRENT_TIMESTAMP WHERE "id"=$1',
        [running.id, running.eventSequence],
      );
      return { disposition: 'accepted', run: running };
    });
  }

  async submitResult(input: SubmitActionPlanExecutionResultInput): Promise<ActionPlanExecutionMutationResult> {
    return this.transact(async client => {
      assertExecutorActor(input.actor);
      const commandId = await this.resolveCommandId(client, input.realm, input.planId, input.runId);
      const graph = await lockCommandGraph(client, commandId);
      const run = graph.runs.find(item => item.id === input.runId);
      if (!run || run.executionRealm !== input.realm) {
        throw new ActionPlanExecutionError(ACTION_PLAN_EXECUTION_ERRORS.notFound);
      }
      if (
        run.claimedExecutorPrincipalId !== input.actor.principalId
        || run.claimedExecutorInstanceId !== input.actor.executorInstanceId
        || run.assignedExecutorPrincipalId !== input.actor.principalId
        || run.assignedExecutorInstanceId !== input.actor.executorInstanceId
        || run.assignedAgentId !== input.actor.executorAgentId
      ) {
        throw new ActionPlanExecutionError(ACTION_PLAN_EXECUTION_ERRORS.notFound);
      }
      if (run.actionId !== input.actionId) {
        return this.rejectOwnedResult(
          client,
          run,
          input.actor,
          input.context,
          'result_identity_conflict',
          new ActionPlanExecutionError(ACTION_PLAN_EXECUTION_ERRORS.notFound),
        );
      }
      if (run.actionSnapshotId !== input.snapshotId) {
        return this.rejectOwnedResult(
          client,
          run,
          input.actor,
          input.context,
          'result_snapshot_conflict',
          new ActionPlanExecutionError(ACTION_PLAN_EXECUTION_ERRORS.snapshotConflict),
        );
      }

      const keyHash = hashScopedOpaqueValue(ACTION_PLAN_RESULT_IDEMPOTENCY_SCOPE, input.idempotencyKey);
      const fingerprint = fingerprintCanonicalValue('action-plan-result-fingerprint-v1', {
        protocol_version: ACTION_PLAN_EXECUTION_PERSISTED_PROTOCOL_VERSION,
        run_id: input.runId,
        action_id: input.actionId,
        snapshot_id: input.snapshotId,
        outcome: input.outcome,
        output_present: input.output !== undefined,
        output: input.output ?? null,
        error_present: input.error !== undefined,
        error: input.error ?? null,
      });
      if (run.state === 'SUCCEEDED' || run.state === 'FAILED') {
        if (run.resultFingerprint === fingerprint) {
          return { disposition: 'idempotent-replay', run };
        }
        return this.rejectOwnedResult(
          client,
          run,
          input.actor,
          input.context,
          'result_terminal_conflict',
          new ActionPlanExecutionError(ACTION_PLAN_EXECUTION_ERRORS.resultIdempotencyConflict),
        );
      }
      if (run.state !== 'RUNNING') {
        return this.rejectOwnedResult(
          client,
          run,
          input.actor,
          input.context,
          'result_state_conflict',
          new ActionPlanExecutionError(ACTION_PLAN_EXECUTION_ERRORS.stateConflict),
        );
      }

      const state = input.outcome === 'succeeded' ? 'SUCCEEDED' : 'FAILED';
      const acceptanceReceipt = randomUUID();
      const updated = await client.query<ActionPlanExecutionRunRecord>(
        `UPDATE "ActionPlanExecutionRun" SET
          "state"=$2,"terminalCategory"=$2,"resultIdempotencyKeyHash"=$3,"resultFingerprint"=$4,
          "resultOutput"=$5::jsonb,"resultError"=$6::jsonb,"acceptanceReceipt"=$7,
          "completedAt"=CURRENT_TIMESTAMP,"version"="version"+1,"updatedAt"=CURRENT_TIMESTAMP
         WHERE "id"=$1 AND "state"='RUNNING' RETURNING *`,
        [
          run.id, state, keyHash, fingerprint,
          state === 'SUCCEEDED' && input.output !== undefined ? JSON.stringify(input.output) : null,
          state === 'FAILED' && input.error !== undefined ? JSON.stringify(input.error) : null,
          acceptanceReceipt,
        ],
      );
      const terminal = updated.rows[0];
      if (!terminal) throw new ActionPlanExecutionError(ACTION_PLAN_EXECUTION_ERRORS.stateConflict);
      const generationMatches = numberValue(graph.plan.executionGeneration)
        === numberValue(graph.command.lockedPlanExecutionGeneration);
      const agentIds = [...new Set(graph.runs.map(candidate => candidate.assignedAgentId))].sort();
      const agentResult = await client.query<AgentRow>(
        'SELECT "id", "capabilities" FROM "Agent" WHERE "id" = ANY($1::text[]) ORDER BY "id" FOR SHARE',
        [agentIds],
      );
      const agents = new Map(agentResult.rows.map(agent => [agent.id, agent]));
      const currentGeneration = numberValue(graph.plan.executionGeneration);
      const allActionSnapshotsMatch = graph.runs.every(candidate => {
        const currentAction = graph.actions.find(action => action.id === candidate.actionId);
        const currentAgent = agents.get(candidate.assignedAgentId);
        return Boolean(
          currentAction
          && currentAgent
          && currentGeneration !== null
          && actionExecutionSnapshotMatches(currentAction, candidate.actionSnapshot, {
            planExecutionGeneration: currentGeneration,
            executorKind: candidate.executorKind,
            assignedExecutorPrincipalId: candidate.assignedExecutorPrincipalId,
            agentCapabilities: currentAgent.capabilities,
          })
        );
      });
      const aggregationEvidenceCurrent = generationMatches && allActionSnapshotsMatch;
      await appendEvent(client, terminal, 'RESULT_ACCEPTED', 'result_accepted', input.actor, input.context, {
        commandId: terminal.commandId,
        actionId: terminal.actionId,
        terminalCategory: state,
        aggregationEvidenceCurrent,
      });
      await appendEvent(
        client,
        terminal,
        state === 'SUCCEEDED' ? 'RUN_SUCCEEDED' : 'RUN_FAILED',
        state === 'SUCCEEDED' ? 'run_succeeded' : 'run_failed',
        input.actor,
        input.context,
        { commandId: terminal.commandId, actionId: terminal.actionId },
      );
      await client.query(
        'UPDATE "ActionPlanExecutionRun" SET "eventSequence"=$2,"version"="version"+1,"updatedAt"=CURRENT_TIMESTAMP WHERE "id"=$1',
        [terminal.id, terminal.eventSequence],
      );

      const postStates = graph.runs.map(item => item.id === terminal.id ? terminal : item);
      const active = postStates.some(item => ['REQUESTED', 'CLAIMED', 'RUNNING'].includes(item.state));
      if (!active && aggregationEvidenceCurrent && graph.plan.status === 'in_progress') {
        const targetStatus = postStates.every(item => item.state === 'SUCCEEDED') ? 'completed' : 'failed';
        const planUpdate = await client.query(
          `UPDATE "ActionPlan" SET "status"=$4,"updatedAt"=CURRENT_TIMESTAMP
           WHERE "id"=$1 AND "executionRealm"=$2 AND "executionGeneration"=$3 AND "status"='in_progress'`,
          [graph.plan.id, input.realm, graph.command.lockedPlanExecutionGeneration, targetStatus],
        );
        if (planUpdate.rowCount !== 1) {
          throw new ActionPlanExecutionError(ACTION_PLAN_EXECUTION_ERRORS.persistenceFailed, { retryable: true });
        }
      }
      return { disposition: 'accepted', run: terminal };
    });
  }

  async readExecution(input: ReadActionPlanExecutionInput): Promise<{
    command: CommandRow;
    run: ActionPlanExecutionRunRecord;
  }> {
    const result = await this.pool.query<ActionPlanExecutionRunRecord & { requesterPrincipalId: string }>(
      `SELECT r.*, c."requesterPrincipalId"
       FROM "ActionPlanExecutionRun" r
       JOIN "ActionPlanExecutionCommand" c ON c."id"=r."commandId"
       WHERE r."id"=$1 AND r."planId"=$2 AND r."executionRealm"=$3`,
      [input.runId, input.planId, input.realm],
    );
    const row = result.rows[0];
    if (!row) throw new ActionPlanExecutionError(ACTION_PLAN_EXECUTION_ERRORS.notFound);
    const command: CommandRow = {
      id: row.commandId,
      planId: row.planId,
      executionRealm: row.executionRealm,
      requesterPrincipalId: row.requesterPrincipalId,
      commandIdempotencyKeyHash: '',
      commandFingerprint: '',
      lockedPlanExecutionGeneration: 0,
      protocolVersion: ACTION_PLAN_EXECUTION_PERSISTED_PROTOCOL_VERSION,
      createdAt: row.requestedAt,
    };
    authorizeRunRead(command, row, input.actor);
    return { command, run: row };
  }
}

export function getActionPlanExecutionRepository(): ActionPlanExecutionRepository {
  const pool = getPool();
  if (!pool) {
    throw new ActionPlanExecutionError(ACTION_PLAN_EXECUTION_ERRORS.persistenceFailed, { retryable: true });
  }
  return new ActionPlanExecutionRepository(pool);
}
