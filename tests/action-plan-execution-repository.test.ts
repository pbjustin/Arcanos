import { describe, expect, it } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Pool } from 'pg';
import {
  ActionPlanExecutionRepository,
  type ActionPlanExecutionActor,
  type ActionPlanExecutionRunRecord,
} from '../src/core/db/repositories/actionPlanExecutionRepository.js';
import {
  ACTION_PLAN_RESULT_IDEMPOTENCY_SCOPE,
  fingerprintCanonicalValue,
  hashScopedOpaqueValue,
} from '../src/services/actionPlanExecution/canonical.js';

type QueryCall = { sql: string; values: unknown[] };

const requester: ActionPlanExecutionActor = { role: 'requester', principalId: 'requester-1' };
const executor: ActionPlanExecutionActor = {
  role: 'executor',
  principalId: 'executor-1',
  executorInstanceId: 'instance-1',
  executorAgentId: 'agent-1',
};
const operationContext = { sourceService: 'web' as const, requestId: 'request-1', traceId: 'trace-1' };

function normalize(sql: string): string {
  return sql.replace(/\s+/gu, ' ').trim();
}

function basePlan() {
  return {
    id: 'plan-1',
    ownerPrincipalId: 'requester-1',
    executionRealm: 'local-test',
    executionProtocolVersion: 2,
    executionGeneration: 1,
    status: 'approved',
    expiresAt: null,
    requiresConfirmation: false,
  };
}

function baseActions() {
  return [
    {
      id: 'action-1', planId: 'plan-1', agentId: 'agent-1', capability: 'terminal.run',
      params: { command: 'noop-one' }, timeoutMs: 1000, rollbackAction: null, sortOrder: 0,
    },
    {
      id: 'action-2', planId: 'plan-1', agentId: 'agent-1', capability: 'terminal.run',
      params: { command: 'noop-two' }, timeoutMs: 1000, rollbackAction: null, sortOrder: 1,
    },
  ];
}

function requestedRun(overrides: Partial<ActionPlanExecutionRunRecord> = {}): ActionPlanExecutionRunRecord {
  const now = '2026-07-17T12:00:00.000Z';
  return {
    id: 'run-1', commandId: 'command-1', planId: 'plan-1', actionId: 'action-1', attempt: 1,
    state: 'REQUESTED', executorKind: 'python-daemon', assignedAgentId: 'agent-1',
    assignedExecutorPrincipalId: 'executor-1', assignedExecutorInstanceId: 'instance-1',
    claimedExecutorPrincipalId: null, claimedExecutorInstanceId: null, executionRealm: 'local-test',
    actionSnapshotId: 'snapshot-1', actionSnapshotSchemaVersion: 1,
    actionSnapshot: {
      snapshot_version: 'action-execution-snapshot-v1', plan_id: 'plan-1', action_id: 'action-1', agent_id: 'agent-1',
      capability: 'terminal.run', params: { command: 'noop-one' }, timeout_ms: 1000,
      sort_order: 0, plan_execution_generation: 1, executor_kind: 'python-daemon',
      assigned_executor_principal_id: 'executor-1',
      agent_capability_fingerprint: fingerprintCanonicalValue('action-plan-agent-capability-v1', {
        agent_id: 'agent-1', capabilities: ['terminal.run'],
      }),
    },
    claimIdempotencyKeyHash: null, claimFingerprint: null, startIdempotencyKeyHash: null,
    startFingerprint: null, resultIdempotencyKeyHash: null, resultFingerprint: null,
    policyCategory: 'ALLOW', policyEvidenceId: `clear-recheck-v1:${'a'.repeat(64)}`, policyEvaluatedAt: now,
    acceptanceReceipt: null, terminalCategory: null, resultOutput: null, resultError: null,
    eventSequence: 0, version: 0, requestedAt: now, claimedAt: null, startedAt: null,
    completedAt: null, cancelledAt: null, expiredAt: null, supersededAt: null, updatedAt: now,
    ...overrides,
  };
}

class RequestHarness {
  readonly calls: QueryCall[] = [];
  readonly commands: Array<Record<string, unknown>> = [];
  readonly runs: ActionPlanExecutionRunRecord[] = [];
  readonly events: Array<Record<string, unknown>> = [];
  actions = baseActions();
  plan = basePlan();
  failEventInsert = false;
  released = false;
  private snapshot: { commands: number; runs: number; events: number } | null = null;

  readonly pool = {
    connect: async () => ({
      query: async (text: string, values: unknown[] = []) => this.query(text, values),
      release: () => { this.released = true; },
    }),
  } as unknown as Pool;

  private result(rows: unknown[] = [], rowCount = rows.length) {
    return { rows, rowCount };
  }

  async query(text: string, values: unknown[] = []) {
    const sql = normalize(text);
    this.calls.push({ sql, values });
    if (sql === 'BEGIN') {
      this.snapshot = { commands: this.commands.length, runs: this.runs.length, events: this.events.length };
      return this.result();
    }
    if (sql === 'COMMIT') {
      this.snapshot = null;
      return this.result();
    }
    if (sql === 'ROLLBACK') {
      if (this.snapshot) {
        this.commands.splice(this.snapshot.commands);
        this.runs.splice(this.snapshot.runs);
        this.events.splice(this.snapshot.events);
      }
      this.snapshot = null;
      return this.result();
    }
    if (sql.startsWith("SELECT set_config('lock_timeout'")) return this.result([{}]);
    if (sql.startsWith('SELECT pg_advisory_xact_lock(')) return this.result([{}]);
    if (sql.startsWith('SELECT * FROM "ActionPlanExecutionCommand" WHERE "executionRealm"=')) {
      return this.result(this.commands.filter(row =>
        row.executionRealm === values[0]
        && row.requesterPrincipalId === values[1]
        && row.planId === values[2]
        && row.commandIdempotencyKeyHash === values[3]));
    }
    if (sql.startsWith('SELECT * FROM "ActionPlan" WHERE "id"=$1')) return this.result([this.plan]);
    if (sql.startsWith('SELECT * FROM "Action" WHERE "planId"=$1')) return this.result(this.actions);
    if (sql.startsWith('SELECT "id", "decision", "overall", "createdAt" FROM "ClearScore"')) {
      return this.result([{ id: 'clear-1', decision: 'allow', overall: 0.9, createdAt: '2026-07-17T11:59:00.000Z' }]);
    }
    if (sql.startsWith('SELECT 1 FROM "ExecutionResult"')) return this.result([]);
    if (sql.startsWith('SELECT 1 FROM "ActionPlanExecutionRun"')) {
      const active = this.runs.filter(run => ['REQUESTED', 'CLAIMED', 'RUNNING'].includes(run.state));
      return this.result(active.length > 0 ? [{}] : []);
    }
    if (sql.startsWith('SELECT "id", "capabilities" FROM "Agent"')) {
      return this.result([{ id: 'agent-1', capabilities: ['terminal.run'] }]);
    }
    if (sql.startsWith('INSERT INTO "ActionPlanExecutionCommand"')) {
      this.commands.push({
        id: values[0], planId: values[1], executionRealm: values[2], requesterPrincipalId: values[3],
        commandIdempotencyKeyHash: values[4], commandFingerprint: values[5],
        lockedPlanExecutionGeneration: values[6], protocolVersion: values[7],
        createdAt: '2026-07-17T12:00:00.000Z',
      });
      return this.result();
    }
    if (sql.startsWith('INSERT INTO "ActionPlanExecutionRun"')) {
      const snapshot = JSON.parse(String(values[11]));
      const row = requestedRun({
        id: String(values[0]), commandId: String(values[1]), planId: String(values[2]),
        actionId: String(values[3]), executorKind: 'python-daemon', assignedAgentId: String(values[5]),
        assignedExecutorPrincipalId: String(values[6]), assignedExecutorInstanceId: String(values[7]),
        executionRealm: String(values[8]), actionSnapshotId: String(values[9]),
        actionSnapshotSchemaVersion: Number(values[10]), actionSnapshot: snapshot,
        policyCategory: values[12] as 'ALLOW' | 'CONFIRM', policyEvidenceId: String(values[13]),
        policyEvaluatedAt: values[14] as string,
      });
      this.runs.push(row);
      return this.result([row]);
    }
    if (sql.startsWith('INSERT INTO "ActionPlanExecutionEvent"')) {
      if (this.failEventInsert) throw new Error('SENTINEL_SQL_EVENT_FAILURE');
      this.events.push({ runId: values[1], eventSequence: values[2], eventType: values[3], safeMetadata: values[10] });
      return this.result();
    }
    if (sql.startsWith('UPDATE "ActionPlanExecutionRun" SET "eventSequence"=')) {
      const run = this.runs.find(item => item.id === values[0]);
      if (run) {
        run.eventSequence = Number(values[1]);
        run.version = Number(run.version) + 1;
      }
      return this.result([], run ? 1 : 0);
    }
    if (sql.includes('FROM "ActionPlanExecutionRun" WHERE "commandId"') && sql.includes('ORDER BY')) {
      return this.result(this.runs.filter(run => run.commandId === values[0]));
    }
    throw new Error(`Unhandled test SQL: ${sql}`);
  }
}

function requestInput(idempotencyKey = 'command-key-1') {
  return {
    planId: 'plan-1', realm: 'local-test', actor: requester,
    executor: { kind: 'python-daemon' as const, principalId: 'executor-1', instanceId: 'instance-1', agentId: 'agent-1' },
    idempotencyKey,
    policyExpectation: { decision: 'allow' as const, overall: 0.9, planExecutionGeneration: 1 },
    context: operationContext,
  };
}

class RunScenarioHarness {
  readonly calls: QueryCall[] = [];
  readonly events: Array<{ runId: unknown; eventType: unknown; reasonCode: unknown; safeMetadata?: unknown }> = [];
  failEventInsert = false;
  planUpdateRowCount = 1;
  run: ActionPlanExecutionRunRecord;
  readonly otherRuns: ActionPlanExecutionRunRecord[];
  readonly actions = baseActions();
  plan = { ...basePlan(), status: 'in_progress' };
  private transactionSnapshot: {
    run: ActionPlanExecutionRunRecord;
    events: Array<{ runId: unknown; eventType: unknown; reasonCode: unknown; safeMetadata?: unknown }>;
    plan: ReturnType<typeof basePlan> & { status: string };
  } | null = null;

  constructor(run: ActionPlanExecutionRunRecord, otherRuns: ActionPlanExecutionRunRecord[] = []) {
    this.run = run;
    this.otherRuns = otherRuns;
  }

  readonly pool = {
    connect: async () => ({
      query: async (text: string, values: unknown[] = []) => this.query(text, values),
      release: () => undefined,
    }),
  } as unknown as Pool;

  private result(rows: unknown[] = [], rowCount = rows.length) {
    return { rows, rowCount };
  }

  async query(text: string, values: unknown[] = []) {
    const sql = normalize(text);
    this.calls.push({ sql, values });
    if (sql === 'BEGIN') {
      this.transactionSnapshot = structuredClone({ run: this.run, events: this.events, plan: this.plan });
      return this.result();
    }
    if (sql === 'COMMIT') {
      this.transactionSnapshot = null;
      return this.result();
    }
    if (sql === 'ROLLBACK') {
      if (this.transactionSnapshot) {
        this.run = this.transactionSnapshot.run;
        this.events.splice(0, this.events.length, ...this.transactionSnapshot.events);
        this.plan = this.transactionSnapshot.plan;
      }
      this.transactionSnapshot = null;
      return this.result();
    }
    if (sql.startsWith("SELECT set_config('lock_timeout'")) return this.result([{}]);
    if (sql.startsWith('SELECT pg_advisory_xact_lock(')) return this.result([{}]);
    if (sql.startsWith('SELECT * FROM "ActionPlanExecutionRun" WHERE "executionRealm"=')) return this.result([]);
    if (sql.startsWith('SELECT "commandId" FROM "ActionPlanExecutionRun"')) {
      const matches = this.run.id === values[0] && this.run.planId === values[1] && this.run.executionRealm === values[2];
      return this.result(matches ? [{ commandId: this.run.commandId }] : []);
    }
    if (sql.startsWith('SELECT * FROM "ActionPlanExecutionCommand" WHERE "id" = $1')) {
      return this.result([{
        id: this.run.commandId, planId: this.run.planId, executionRealm: this.run.executionRealm,
        requesterPrincipalId: 'requester-1', commandIdempotencyKeyHash: 'a'.repeat(64),
        commandFingerprint: 'b'.repeat(64), lockedPlanExecutionGeneration: 1, protocolVersion: 2,
        createdAt: this.run.requestedAt,
      }]);
    }
    if (sql.includes('FROM "ActionPlanExecutionRun" WHERE "commandId"') && sql.includes('ORDER BY')) {
      return this.result([this.run, ...this.otherRuns]);
    }
    if (sql.startsWith('SELECT * FROM "ActionPlan" WHERE "id" = $1')) return this.result([this.plan]);
    if (sql.startsWith('SELECT * FROM "Action" WHERE "planId" = $1')) return this.result(this.actions);
    if (sql.startsWith('SELECT "id", "decision", "overall", "createdAt" FROM "ClearScore"')) {
      return this.result([{ id: 'clear-1', decision: 'allow', overall: 0.9, createdAt: '2026-07-17T11:59:00.000Z' }]);
    }
    if (sql.startsWith('SELECT "id", "capabilities" FROM "Agent"')) {
      return this.result([{ id: 'agent-1', capabilities: ['terminal.run'] }]);
    }
    if (sql.startsWith('SELECT 1 FROM "ActionPlanExecutionEvent"')) {
      const matching = this.events.filter(event => event.runId === values[0] && event.reasonCode === values[1]);
      return this.result(matching.length > 0 ? [{}] : []);
    }
    if (sql.startsWith('UPDATE "ActionPlanExecutionRun" SET "state"=$2')) {
      const terminalState = values[1] as 'SUCCEEDED' | 'FAILED';
      this.run = {
        ...this.run,
        state: terminalState,
        terminalCategory: terminalState,
        resultIdempotencyKeyHash: String(values[2]),
        resultFingerprint: String(values[3]),
        resultOutput: values[4] === null ? null : JSON.parse(String(values[4])),
        resultError: values[5] === null ? null : JSON.parse(String(values[5])),
        acceptanceReceipt: String(values[6]),
        completedAt: '2026-07-17T12:01:00.000Z',
      };
      return this.result([this.run]);
    }
    if (sql.startsWith('UPDATE "ActionPlanExecutionRun" SET "state"=\'CLAIMED\'')) {
      if (this.run.id !== values[0] || this.run.state !== 'REQUESTED') return this.result([]);
      this.run = {
        ...this.run,
        state: 'CLAIMED',
        claimedExecutorPrincipalId: String(values[1]),
        claimedExecutorInstanceId: String(values[2]),
        claimIdempotencyKeyHash: String(values[3]),
        claimFingerprint: String(values[4]),
        claimedAt: '2026-07-17T12:00:10.000Z',
      };
      return this.result([this.run]);
    }
    if (sql.startsWith('INSERT INTO "ActionPlanExecutionEvent"')) {
      if (this.failEventInsert) throw new Error('SENTINEL_EVENT_WRITE_FAILURE');
      this.events.push({
        runId: values[1],
        eventType: values[3],
        reasonCode: values[7],
        safeMetadata: JSON.parse(String(values[10])),
      });
      return this.result();
    }
    if (sql.startsWith('UPDATE "ActionPlanExecutionRun" SET "eventSequence"=')) return this.result([], 1);
    if (sql.startsWith('UPDATE "ActionPlan" SET "status"=')) {
      if (this.planUpdateRowCount === 1) this.plan.status = String(values[3]);
      return this.result([], this.planUpdateRowCount);
    }
    throw new Error(`Unhandled test SQL: ${sql}`);
  }
}

function runningRun(overrides: Partial<ActionPlanExecutionRunRecord> = {}): ActionPlanExecutionRunRecord {
  return requestedRun({
    state: 'RUNNING', claimedExecutorPrincipalId: 'executor-1', claimedExecutorInstanceId: 'instance-1',
    claimIdempotencyKeyHash: 'c'.repeat(64), claimFingerprint: 'd'.repeat(64),
    startIdempotencyKeyHash: 'e'.repeat(64), startFingerprint: 'f'.repeat(64),
    claimedAt: '2026-07-17T12:00:10.000Z', startedAt: '2026-07-17T12:00:20.000Z',
    ...overrides,
  });
}

function succeededSecondRun(overrides: Partial<ActionPlanExecutionRunRecord> = {}): ActionPlanExecutionRunRecord {
  return runningRun({
    id: 'run-2',
    actionId: 'action-2',
    actionSnapshotId: 'snapshot-2',
    actionSnapshot: {
      snapshot_version: 'action-execution-snapshot-v1',
      plan_id: 'plan-1',
      action_id: 'action-2',
      agent_id: 'agent-1',
      capability: 'terminal.run',
      params: { command: 'noop-two' },
      timeout_ms: 1000,
      sort_order: 1,
      plan_execution_generation: 1,
      executor_kind: 'python-daemon',
      assigned_executor_principal_id: 'executor-1',
      agent_capability_fingerprint: fingerprintCanonicalValue('action-plan-agent-capability-v1', {
        agent_id: 'agent-1', capabilities: ['terminal.run'],
      }),
    },
    state: 'SUCCEEDED',
    terminalCategory: 'SUCCEEDED',
    resultFingerprint: 'a'.repeat(64),
    acceptanceReceipt: 'receipt-second',
    completedAt: '2026-07-17T12:00:50.000Z',
    ...overrides,
  });
}

function submitInput(overrides: Record<string, unknown> = {}) {
  return {
    realm: 'local-test', planId: 'plan-1', runId: 'run-1', actionId: 'action-1', snapshotId: 'snapshot-1',
    actor: executor, idempotencyKey: 'result-key-1', outcome: 'succeeded' as const,
    output: { value: 1 }, context: operationContext, ...overrides,
  };
}

describe('Phase 2E authoritative repository behavior without an external database', () => {
  it('records static database enforcement for command replay, active-run uniqueness, owner claim, and terminal coherence', () => {
    const sql = readFileSync(join(
      process.cwd(), 'migrations', '20260717_action_plan_execution_v2', '03_execution_protocol_tables.sql',
    ), 'utf8');
    expect(sql).toContain('CONSTRAINT "uq_ap_exec_command_idempotency" UNIQUE');
    expect(sql).toContain('CREATE UNIQUE INDEX IF NOT EXISTS "uq_ap_exec_run_active_action"');
    expect(sql).toContain('WHERE "state" IN (\'REQUESTED\', \'CLAIMED\', \'RUNNING\')');
    expect(sql).toContain('"claimedExecutorPrincipalId" = "assignedExecutorPrincipalId"');
    expect(sql).toContain('"claimedExecutorInstanceId" = "assignedExecutorInstanceId"');
    expect(sql).toContain('CONSTRAINT "ck_ap_exec_run_state_coherence" CHECK');
    expect(sql).toContain('"state" IN (\'SUCCEEDED\', \'FAILED\')');
    expect(sql).toContain('"policyEvidenceId" ~ \'^clear-recheck-v1:[0-9a-f]{64}$\'');
    expect(sql).toContain('CONSTRAINT "uq_ap_exec_event_run_sequence" UNIQUE');
    expect(sql).not.toMatch(/CREATE\s+(?:OR\s+REPLACE\s+)?TRIGGER/iu);
  });

  it('keeps retry unsupported instead of silently reusing attempt one or overwriting a terminal run', () => {
    const openapi = JSON.parse(readFileSync(join(
      process.cwd(), 'contracts', 'action_plan_execution.openapi.v1.json',
    ), 'utf8')) as { paths: Record<string, unknown> };
    const routeNames = Object.keys(openapi.paths);
    expect(routeNames.some(path => path.endsWith('/retry'))).toBe(false);
    expect(routeNames.some(path => path.includes('administrative-retry'))).toBe(false);

    const source = readFileSync(join(
      process.cwd(), 'src', 'core', 'db', 'repositories', 'actionPlanExecutionRepository.ts',
    ), 'utf8');
    expect(source).not.toMatch(/\b(?:retryExecution|createRetryAttempt|administrativeRetry)\b/u);
    expect(source).toContain('VALUES ($1,$2,$3,$4,1,\'REQUESTED\'');
  });

  it('creates exactly one run per action and never writes a legacy ExecutionResult', async () => {
    const harness = new RequestHarness();
    const repository = new ActionPlanExecutionRepository(harness.pool);

    const result = await repository.requestExecution(requestInput());

    expect(result.disposition).toBe('created');
    expect(result.runs.map(run => run.actionId).sort()).toEqual(['action-1', 'action-2']);
    expect(new Set(result.runs.map(run => run.id)).size).toBe(2);
    expect(harness.commands).toHaveLength(1);
    expect(harness.runs).toHaveLength(2);
    expect(harness.events).toHaveLength(2);
    expect(harness.calls.filter(call => call.sql.startsWith('INSERT INTO "ActionPlanExecutionRun"'))).toHaveLength(2);
    expect(harness.calls.some(call => call.sql.startsWith('INSERT INTO "ExecutionResult"'))).toBe(false);
    expect(harness.calls.at(-1)?.sql).toBe('COMMIT');
    expect(harness.released).toBe(true);
  });

  it.each([
    ['missing command', {}],
    ['null command', { command: null }],
    ['blank command', { command: '   ' }],
    ['non-string command', { command: 42 }],
    ['oversized command', { command: 'x'.repeat(16_385) }],
  ])('creates no run when terminal.run has %s', async (_name, params) => {
    const harness = new RequestHarness();
    harness.actions[0] = { ...harness.actions[0], params };
    const repository = new ActionPlanExecutionRepository(harness.pool);

    await expect(repository.requestExecution(requestInput())).rejects.toMatchObject({
      code: 'ACTION_PLAN_EXECUTOR_UNAVAILABLE',
    });
    expect(harness.commands).toHaveLength(0);
    expect(harness.runs).toHaveLength(0);
    expect(harness.events).toHaveLength(0);
    expect(harness.calls.at(-1)?.sql).toBe('ROLLBACK');
  });

  it('creates and returns runs in authoritative sort order rather than action-id order', async () => {
    const harness = new RequestHarness();
    harness.actions = [
      { ...baseActions()[0], id: 'z-first', sortOrder: 0 },
      { ...baseActions()[1], id: 'a-second', sortOrder: 1 },
    ];
    const repository = new ActionPlanExecutionRepository(harness.pool);

    const result = await repository.requestExecution(requestInput());

    expect(result.runs.map(run => run.actionId)).toEqual(['z-first', 'a-second']);
    expect(result.runs.map(run => run.actionSnapshot.sort_order)).toEqual([0, 1]);
    expect(result.runs.map(run => run.actionSnapshot.action_id)).toEqual(['z-first', 'a-second']);
  });

  it('returns the original runs for same-key/same-request replay and rejects a changed generation', async () => {
    const harness = new RequestHarness();
    const repository = new ActionPlanExecutionRepository(harness.pool);
    const original = await repository.requestExecution(requestInput());
    const replay = await repository.requestExecution(requestInput());
    expect(replay).toMatchObject({ disposition: 'idempotent-replay', commandId: original.commandId });
    expect(replay.runs.map(run => run.id)).toEqual(original.runs.map(run => run.id));
    expect(harness.commands).toHaveLength(1);
    expect(harness.runs).toHaveLength(2);

    harness.commands[0].lockedPlanExecutionGeneration = 0;
    await expect(repository.requestExecution(requestInput())).rejects.toMatchObject({
      code: 'ACTION_PLAN_EXECUTION_IDEMPOTENCY_CONFLICT',
    });
    expect(harness.calls.at(-1)?.sql).toBe('ROLLBACK');
  });

  it.each(['in_progress', 'completed', 'failed'] as const)(
    'replay-only lookup returns committed runs after the plan advances to %s',
    async status => {
      const harness = new RequestHarness();
      const repository = new ActionPlanExecutionRepository(harness.pool);
      const created = await repository.requestExecution(requestInput());
      harness.plan.status = status;

      await expect(repository.replayExecution(requestInput())).resolves.toMatchObject({
        disposition: 'idempotent-replay',
        commandId: created.commandId,
      });
      expect(harness.commands).toHaveLength(1);
      expect(harness.runs).toHaveLength(2);
    },
  );

  it('replay-only lookup returns null for an unknown key without creating a command or run', async () => {
    const harness = new RequestHarness();
    harness.plan.status = 'completed';
    const repository = new ActionPlanExecutionRepository(harness.pool);

    await expect(repository.replayExecution(requestInput('unknown-key'))).resolves.toBeNull();
    expect(harness.commands).toHaveLength(0);
    expect(harness.runs).toHaveLength(0);
    expect(harness.events).toHaveLength(0);
  });

  it('rejects same-key replay when locked action evidence changes without a generation bump', async () => {
    const harness = new RequestHarness();
    const repository = new ActionPlanExecutionRepository(harness.pool);
    await repository.requestExecution(requestInput());
    harness.actions[0] = {
      ...harness.actions[0],
      params: { command: 'changed-without-generation-bump' },
    };

    await expect(repository.requestExecution(requestInput())).rejects.toMatchObject({
      code: 'ACTION_PLAN_EXECUTION_IDEMPOTENCY_CONFLICT',
    });
    expect(harness.commands).toHaveLength(1);
    expect(harness.runs).toHaveLength(2);
    expect(harness.calls.at(-1)?.sql).toBe('ROLLBACK');
  });

  it('rolls back command and run creation when append-only event persistence fails', async () => {
    const harness = new RequestHarness();
    harness.failEventInsert = true;
    const repository = new ActionPlanExecutionRepository(harness.pool);

    await expect(repository.requestExecution(requestInput())).rejects.toMatchObject({
      code: 'ACTION_PLAN_EXECUTION_PERSISTENCE_FAILED',
      retryable: true,
    });
    expect(harness.commands).toHaveLength(0);
    expect(harness.runs).toHaveLength(0);
    expect(harness.events).toHaveLength(0);
    expect(harness.calls.at(-1)?.sql).toBe('ROLLBACK');
  });

  it('binds the current CLEAR recheck instead of stale stored score evidence and supports a null score', async () => {
    const harness = new RequestHarness();
    const repository = new ActionPlanExecutionRepository(harness.pool);

    const result = await repository.requestExecution({
      ...requestInput(),
      policyExpectation: { decision: 'allow', overall: null, planExecutionGeneration: 1 },
    });

    expect(result.runs).toHaveLength(2);
    expect(result.runs.every(run => run.policyCategory === 'ALLOW')).toBe(true);
    expect(result.runs.every(run => /^clear-recheck-v1:[a-f0-9]{64}$/u.test(run.policyEvidenceId))).toBe(true);
    expect(harness.calls.some(call => call.sql.includes('FROM "ClearScore"'))).toBe(false);
    expect(harness.calls.at(-1)?.sql).toBe('COMMIT');
  });

  it('creates zero runs when the plan generation changes after CLEAR evaluation', async () => {
    const harness = new RequestHarness();
    harness.plan.executionGeneration = 2;
    const repository = new ActionPlanExecutionRepository(harness.pool);

    await expect(repository.requestExecution(requestInput())).rejects.toMatchObject({
      code: 'ACTION_PLAN_PROVENANCE_UNAVAILABLE',
    });
    expect(harness.commands).toHaveLength(0);
    expect(harness.runs).toHaveLength(0);
    expect(harness.events).toHaveLength(0);
    expect(harness.calls.at(-1)?.sql).toBe('ROLLBACK');
  });

  it('commits distinct policy evidence for null, numeric, and decision changes', async () => {
    const evidenceFor = async (decision: 'allow' | 'confirm', overall: number | null) => {
      const harness = new RequestHarness();
      const result = await new ActionPlanExecutionRepository(harness.pool).requestExecution({
        ...requestInput(),
        policyExpectation: { decision, overall, planExecutionGeneration: 1 },
      });
      return result.runs[0].policyEvidenceId;
    };

    const evidence = await Promise.all([
      evidenceFor('allow', null),
      evidenceFor('allow', 0.9),
      evidenceFor('confirm', null),
      evidenceFor('confirm', 0.5),
    ]);
    expect(new Set(evidence).size).toBe(4);
    expect(evidence.every(value => /^clear-recheck-v1:[a-f0-9]{64}$/u.test(value))).toBe(true);
  });

  it('rejects replay when the stored command fingerprint or sibling policy evidence is tampered', async () => {
    const fingerprintHarness = new RequestHarness();
    const fingerprintRepository = new ActionPlanExecutionRepository(fingerprintHarness.pool);
    await fingerprintRepository.requestExecution(requestInput());
    fingerprintHarness.commands[0].commandFingerprint = 'f'.repeat(64);
    await expect(fingerprintRepository.replayExecution(requestInput()))
      .rejects.toMatchObject({ code: 'ACTION_PLAN_EXECUTION_IDEMPOTENCY_CONFLICT' });

    const evidenceHarness = new RequestHarness();
    const evidenceRepository = new ActionPlanExecutionRepository(evidenceHarness.pool);
    await evidenceRepository.requestExecution(requestInput());
    evidenceHarness.runs[1].policyEvidenceId = `clear-recheck-v1:${'b'.repeat(64)}`;
    await expect(evidenceRepository.replayExecution(requestInput()))
      .rejects.toMatchObject({ code: 'ACTION_PLAN_EXECUTION_IDEMPOTENCY_CONFLICT' });
  });

  it('rejects a wrong executor claim with zero run update and zero event append', async () => {
    const harness = new RunScenarioHarness(requestedRun());
    harness.plan.status = 'approved';
    const repository = new ActionPlanExecutionRepository(harness.pool);
    const wrongExecutor = {
      role: 'executor' as const,
      principalId: 'executor-other',
      executorInstanceId: 'instance-other',
      executorAgentId: 'agent-other',
    };

    await expect(repository.claimExecution({
      realm: 'local-test', planId: 'plan-1', runId: 'run-1', actor: wrongExecutor,
      idempotencyKey: 'claim-key-1', context: operationContext,
    })).rejects.toMatchObject({ code: 'ACTION_PLAN_EXECUTION_NOT_FOUND' });

    expect(harness.run.state).toBe('REQUESTED');
    expect(harness.calls.some(call => call.sql.startsWith('UPDATE "ActionPlanExecutionRun"'))).toBe(false);
    expect(harness.calls.some(call => call.sql.startsWith('INSERT INTO "ActionPlanExecutionEvent"'))).toBe(false);
    expect(harness.calls.at(-1)?.sql).toBe('ROLLBACK');
  });

  it('binds an accepted claim to the assigned principal, instance, and agent', async () => {
    const harness = new RunScenarioHarness(requestedRun());
    harness.plan.status = 'approved';
    const repository = new ActionPlanExecutionRepository(harness.pool);
    const claimed = await repository.claimExecution({
      realm: 'local-test', planId: 'plan-1', runId: 'run-1', actor: executor,
      idempotencyKey: 'claim-key-1', context: operationContext,
    });
    expect(claimed).toMatchObject({
      disposition: 'claimed',
      assignmentAvailable: true,
      run: {
        state: 'CLAIMED',
        claimedExecutorPrincipalId: 'executor-1',
        claimedExecutorInstanceId: 'instance-1',
        assignedAgentId: 'agent-1',
      },
    });
    expect(harness.events).toEqual([
      expect.objectContaining({ eventType: 'EXECUTION_CLAIMED', reasonCode: 'execution_claimed' }),
    ]);
  });

  it('recovery-only exact claim cannot claim previously unclaimed work', async () => {
    const harness = new RunScenarioHarness(requestedRun());
    harness.plan.status = 'approved';
    const repository = new ActionPlanExecutionRepository(harness.pool);

    await expect(repository.claimExecution({
      realm: 'local-test', planId: 'plan-1', runId: 'run-1', actor: executor,
      idempotencyKey: 'new-recovery-key', recoveryOnly: true, context: operationContext,
    })).rejects.toMatchObject({ code: 'ACTION_PLAN_EXECUTION_STATE_CONFLICT' });
    expect(harness.run.state).toBe('REQUESTED');
    expect(harness.events).toHaveLength(0);
    expect(harness.calls.some(call => call.sql.startsWith('UPDATE "ActionPlanExecutionRun"'))).toBe(false);
  });

  it('rejects start-before-claim with no run update, event, or plan transition', async () => {
    const harness = new RunScenarioHarness(requestedRun());
    const repository = new ActionPlanExecutionRepository(harness.pool);
    await expect(repository.startExecution({
      realm: 'local-test', planId: 'plan-1', runId: 'run-1', actor: executor,
      idempotencyKey: 'start-key-1', context: operationContext,
    })).rejects.toMatchObject({ code: 'ACTION_PLAN_EXECUTION_NOT_FOUND' });
    expect(harness.run.state).toBe('REQUESTED');
    expect(harness.events).toHaveLength(0);
    expect(harness.calls.some(call => call.sql.startsWith('UPDATE "ActionPlan" SET "status"='))).toBe(false);
  });

  it.each([
    ['wrong plan', { planId: 'plan-other' }, 'ACTION_PLAN_EXECUTION_NOT_FOUND', false],
    ['wrong action', { actionId: 'action-other' }, 'ACTION_PLAN_EXECUTION_NOT_FOUND', true],
    ['wrong realm', { realm: 'realm-other' }, 'ACTION_PLAN_EXECUTION_NOT_FOUND', false],
    ['wrong snapshot', { snapshotId: 'snapshot-other' }, 'ACTION_PLAN_ACTION_SNAPSHOT_CONFLICT', true],
    ['wrong owner', { actor: { ...executor, principalId: 'executor-other' } }, 'ACTION_PLAN_EXECUTION_NOT_FOUND', false],
  ] as const)('rejects %s result evidence without a terminal mutation', async (_name, overrides, code, audited) => {
    const harness = new RunScenarioHarness(runningRun());
    const repository = new ActionPlanExecutionRepository(harness.pool);
    let observed: unknown;
    try {
      await repository.submitResult(submitInput(overrides));
    } catch (error) {
      observed = error;
    }
    expect((observed as { code?: string })?.code).toBe(code);
    expect(harness.run.state).toBe('RUNNING');
    expect(harness.calls.some(call => call.sql.startsWith('UPDATE "ActionPlanExecutionRun" SET "state"=$2'))).toBe(false);
    expect(harness.events).toHaveLength(audited ? 1 : 0);
    if (audited) expect(harness.events[0]).toMatchObject({ eventType: 'RESULT_REJECTED' });
  });

  it.each(['CANCELLED', 'EXPIRED', 'SUPERSEDED'] as const)(
    'keeps terminal %s monotonic and rejects a normal result',
    async state => {
      const terminal = runningRun({
        state,
        terminalCategory: state,
        cancelledAt: state === 'CANCELLED' ? '2026-07-17T12:01:00.000Z' : null,
        expiredAt: state === 'EXPIRED' ? '2026-07-17T12:01:00.000Z' : null,
        supersededAt: state === 'SUPERSEDED' ? '2026-07-17T12:01:00.000Z' : null,
      });
      const harness = new RunScenarioHarness(terminal);
      const repository = new ActionPlanExecutionRepository(harness.pool);
      await expect(repository.submitResult(submitInput())).rejects.toMatchObject({
        code: 'ACTION_PLAN_EXECUTION_STATE_CONFLICT',
      });
      expect(harness.run.state).toBe(state);
      expect(harness.calls.some(call => call.sql.startsWith('UPDATE "ActionPlanExecutionRun" SET "state"=$2'))).toBe(false);
      expect(harness.events).toEqual([
        expect.objectContaining({ eventType: 'RESULT_REJECTED', reasonCode: 'result_state_conflict' }),
      ]);
    },
  );

  it('accepts a failure as FAILED, updates only its bound run, and cannot overwrite it with success', async () => {
    const sibling = succeededSecondRun({
      state: 'RUNNING',
      terminalCategory: null,
      resultFingerprint: null,
      acceptanceReceipt: null,
      completedAt: null,
    });
    const harness = new RunScenarioHarness(runningRun(), [sibling]);
    const repository = new ActionPlanExecutionRepository(harness.pool);
    const accepted = await repository.submitResult(submitInput({
      outcome: 'failed', output: undefined, error: { code: 'SYNTHETIC_FAILURE' },
    }));
    expect(accepted.run.state).toBe('FAILED');
    expect(accepted.run.resultError).toEqual({ code: 'SYNTHETIC_FAILURE' });
    expect(harness.otherRuns).toEqual([expect.objectContaining({ id: 'run-2', state: 'RUNNING' })]);

    for (const idempotencyKey of ['result-key-1', 'other-key']) {
      await expect(repository.submitResult(submitInput({
        idempotencyKey, outcome: 'succeeded', output: { impossible: true },
      }))).rejects.toMatchObject({ code: 'ACTION_PLAN_RESULT_IDEMPOTENCY_CONFLICT' });
    }
    expect(harness.run.state).toBe('FAILED');
    expect(harness.events.filter(event => event.eventType === 'RESULT_REJECTED')).toHaveLength(1);
  });

  it('aggregates completion only after every action snapshot remains current', async () => {
    const harness = new RunScenarioHarness(runningRun(), [succeededSecondRun()]);
    const repository = new ActionPlanExecutionRepository(harness.pool);

    await repository.submitResult(submitInput());

    expect(harness.plan.status).toBe('completed');
    expect(harness.calls.filter(call => call.sql.startsWith('UPDATE "ActionPlan" SET "status"='))).toHaveLength(1);
    expect(harness.events.find(event => event.eventType === 'RESULT_ACCEPTED')).toMatchObject({
      safeMetadata: expect.objectContaining({ aggregationEvidenceCurrent: true }),
    });
  });

  it('rejects terminal evidence when any sibling snapshot no longer matches current action evidence', async () => {
    const staleSibling = succeededSecondRun({
      actionSnapshot: {
        snapshot_version: 'action-execution-snapshot-v1',
        plan_id: 'plan-1',
        action_id: 'action-2',
        agent_id: 'agent-1',
        capability: 'terminal.run',
        params: { command: 'stale-command' },
        timeout_ms: 1000,
        sort_order: 1,
        plan_execution_generation: 1,
        executor_kind: 'python-daemon',
        assigned_executor_principal_id: 'executor-1',
        agent_capability_fingerprint: fingerprintCanonicalValue('action-plan-agent-capability-v1', {
          agent_id: 'agent-1', capabilities: ['terminal.run'],
        }),
      },
    });
    const harness = new RunScenarioHarness(runningRun(), [staleSibling]);
    const repository = new ActionPlanExecutionRepository(harness.pool);

    await expect(repository.submitResult(submitInput())).rejects.toMatchObject({
      code: 'ACTION_PLAN_ACTION_SNAPSHOT_CONFLICT',
    });
    expect(harness.run.state).toBe('RUNNING');
    expect(harness.plan.status).toBe('in_progress');
    expect(harness.calls.some(call => call.sql.startsWith('UPDATE "ActionPlanExecutionRun" SET "state"=$2'))).toBe(false);
    expect(harness.calls.some(call => call.sql.startsWith('UPDATE "ActionPlan" SET "status"='))).toBe(false);
    expect(harness.events).toEqual([expect.objectContaining({
      eventType: 'RESULT_REJECTED',
      reasonCode: 'result_snapshot_conflict',
    })]);
  });

  it('rejects terminal evidence when the plan generation changed after execution started', async () => {
    const harness = new RunScenarioHarness(runningRun(), [succeededSecondRun()]);
    harness.plan.executionGeneration = 2;
    const repository = new ActionPlanExecutionRepository(harness.pool);

    await expect(repository.submitResult(submitInput())).rejects.toMatchObject({
      code: 'ACTION_PLAN_EXECUTION_GENERATION_CONFLICT',
    });
    expect(harness.run.state).toBe('RUNNING');
    expect(harness.plan.status).toBe('in_progress');
    expect(harness.calls.some(call => call.sql.startsWith('UPDATE "ActionPlanExecutionRun" SET "state"=$2'))).toBe(false);
    expect(harness.events).toEqual([expect.objectContaining({
      eventType: 'RESULT_REJECTED',
      reasonCode: 'result_generation_conflict',
    })]);
  });

  it('rolls back result acceptance when an expected plan aggregation CAS updates no row', async () => {
    const harness = new RunScenarioHarness(runningRun(), [succeededSecondRun()]);
    harness.planUpdateRowCount = 0;
    const repository = new ActionPlanExecutionRepository(harness.pool);

    await expect(repository.submitResult(submitInput())).rejects.toMatchObject({
      code: 'ACTION_PLAN_EXECUTION_PERSISTENCE_FAILED',
      retryable: true,
    });
    expect(harness.run.state).toBe('RUNNING');
    expect(harness.events).toHaveLength(0);
    expect(harness.calls.at(-1)?.sql).toBe('ROLLBACK');
  });

  it('replays an accepted result after response loss without another UPDATE or event', async () => {
    const input = submitInput({ outcome: 'failed', output: undefined, error: { code: 'SYNTHETIC_FAILURE' } });
    const fingerprint = fingerprintCanonicalValue('action-plan-result-fingerprint-v1', {
      protocol_version: 2,
      run_id: input.runId,
      action_id: input.actionId,
      snapshot_id: input.snapshotId,
      outcome: input.outcome,
      output_present: false,
      output: null,
      error_present: true,
      error: input.error,
    });
    const terminal = runningRun({
      state: 'FAILED', terminalCategory: 'FAILED', resultFingerprint: fingerprint,
      resultIdempotencyKeyHash: hashScopedOpaqueValue(ACTION_PLAN_RESULT_IDEMPOTENCY_SCOPE, input.idempotencyKey),
      resultError: input.error, acceptanceReceipt: 'receipt-original',
      completedAt: '2026-07-17T12:01:00.000Z',
    });
    const harness = new RunScenarioHarness(terminal);
    const repository = new ActionPlanExecutionRepository(harness.pool);
    const replay = await repository.submitResult(input);
    expect(replay).toMatchObject({ disposition: 'idempotent-replay', run: { acceptanceReceipt: 'receipt-original' } });
    expect(harness.calls.some(call => call.sql.startsWith('UPDATE "ActionPlanExecutionRun" SET "state"=$2'))).toBe(false);
    expect(harness.calls.some(call => call.sql.startsWith('INSERT INTO "ActionPlanExecutionEvent"'))).toBe(false);
  });

  it('returns the accepted terminal result for a different key with the identical fingerprint', async () => {
    const original = submitInput({ outcome: 'failed', output: undefined, error: { code: 'SYNTHETIC_FAILURE' } });
    const fingerprint = fingerprintCanonicalValue('action-plan-result-fingerprint-v1', {
      protocol_version: 2,
      run_id: original.runId,
      action_id: original.actionId,
      snapshot_id: original.snapshotId,
      outcome: original.outcome,
      output_present: false,
      output: null,
      error_present: true,
      error: original.error,
    });
    const harness = new RunScenarioHarness(runningRun({
      state: 'FAILED', terminalCategory: 'FAILED', resultFingerprint: fingerprint,
      resultIdempotencyKeyHash: hashScopedOpaqueValue(ACTION_PLAN_RESULT_IDEMPOTENCY_SCOPE, 'original-key'),
      resultError: original.error, acceptanceReceipt: 'receipt-original',
      completedAt: '2026-07-17T12:01:00.000Z',
    }));
    const repository = new ActionPlanExecutionRepository(harness.pool);
    await expect(repository.submitResult({ ...original, idempotencyKey: 'different-retry-key' }))
      .resolves.toMatchObject({ disposition: 'idempotent-replay', run: { acceptanceReceipt: 'receipt-original' } });
    expect(harness.events).toHaveLength(0);
  });

  it('rolls back a terminal transition when event persistence fails', async () => {
    const harness = new RunScenarioHarness(runningRun());
    harness.failEventInsert = true;
    const repository = new ActionPlanExecutionRepository(harness.pool);
    await expect(repository.submitResult(submitInput())).rejects.toMatchObject({
      code: 'ACTION_PLAN_EXECUTION_PERSISTENCE_FAILED', retryable: true,
    });
    expect(harness.calls.some(call => call.sql === 'ROLLBACK')).toBe(true);
    expect(harness.calls.some(call => call.sql === 'COMMIT')).toBe(false);
    expect(harness.run.state).toBe('RUNNING');
    expect(harness.events).toHaveLength(0);
  });
});
