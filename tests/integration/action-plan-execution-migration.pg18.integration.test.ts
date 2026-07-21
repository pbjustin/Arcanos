import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { jest } from '@jest/globals';
import { verifyActionPlanExecutionSchema } from '../../src/core/db/actionPlanExecutionSchema.js';

const railwayValidation = process.env.ACTION_PLAN_EXECUTION_PG18_RAILWAY_VALIDATION === '1';
const connectionString = railwayValidation
  ? process.env.DATABASE_URL
  : process.env.ACTION_PLAN_EXECUTION_MIGRATION_DATABASE_URL;
const explicitlyEnabled = process.env.ACTION_PLAN_EXECUTION_PG18_INTEGRATION === '1';
const migrationScriptPath = join(process.cwd(), 'scripts', 'action-plan-execution-migration.mjs');

interface QueryClient {
  connect(): Promise<void>;
  end(): Promise<void>;
  query(text: string, values?: unknown[]): Promise<{
    rows: Array<Record<string, unknown>>;
    rowCount: number | null;
  }>;
}

interface MigrationModule {
  applyMigrationWithClient(client: QueryClient): Promise<{
    ready: boolean;
    applied: boolean;
    equivalentRerun: boolean;
    recoveredFinalVerification?: boolean;
  }>;
  compensateMigrationWithClient(client: QueryClient): Promise<{ compensated: boolean }>;
  inspectMigrationDrainStateWithClient(client: QueryClient): Promise<{
    canDisableAssignment: boolean;
    canRevertApplication: boolean;
    canCompensateEmptySchema: boolean;
  }>;
  loadMigrationManifest(): {
    version: string;
    checksum: string;
    advisoryLockKey: string;
  };
  verifyActionPlanExecutionSchemaWithClient(client: QueryClient): Promise<{
    ready: boolean;
    issues: string[];
  }>;
}

type RunState =
  | 'REQUESTED'
  | 'CLAIMED'
  | 'RUNNING'
  | 'SUCCEEDED'
  | 'FAILED'
  | 'CANCELLED'
  | 'EXPIRED'
  | 'SUPERSEDED';

interface ProbePlan {
  planId: string;
  actionId: string;
  agentId: string;
  realm: string;
  executorPrincipalId: string;
  executorInstanceId: string;
}

let probeSequence = 0;

function nextProbeHash(): string {
  probeSequence += 1;
  return probeSequence.toString(16).padStart(64, '0');
}

async function withRollback(
  client: QueryClient,
  probe: () => Promise<void>
): Promise<void> {
  await client.query('BEGIN');
  try {
    await probe();
  } finally {
    await client.query('ROLLBACK');
  }
}

async function withSavepoint(
  client: QueryClient,
  label: string,
  probe: () => Promise<void>
): Promise<void> {
  const savepoint = `probe_${label.replace(/[^a-z0-9_]/giu, '_')}_${++probeSequence}`;
  await client.query(`SAVEPOINT "${savepoint}"`);
  try {
    await probe();
  } finally {
    await client.query(`ROLLBACK TO SAVEPOINT "${savepoint}"`);
    await client.query(`RELEASE SAVEPOINT "${savepoint}"`);
  }
}

async function expectDatabaseError(
  client: QueryClient,
  expected: Record<string, unknown>,
  text: string,
  values: unknown[] = []
): Promise<void> {
  let caught: unknown;
  try {
    await client.query(text, values);
  } catch (error) {
    caught = error;
  }
  expect(caught).toMatchObject(expected);
}

async function expectCheckViolation(
  client: QueryClient,
  constraint: string,
  text: string,
  values: unknown[] = []
): Promise<void> {
  await expectDatabaseError(client, { code: '23514', constraint }, text, values);
}

async function createProbePlan(
  client: QueryClient,
  label: string,
  realm = 'preview:pg18-probe'
): Promise<ProbePlan> {
  const plan: ProbePlan = {
    planId: `plan-${label}`,
    actionId: `action-${label}`,
    agentId: `agent-${label}`,
    realm,
    executorPrincipalId: `executor-${label}`,
    executorInstanceId: `instance-${label}`
  };
  await client.query(
    `INSERT INTO "ActionPlan" (
       "id", "createdBy", "origin", "status", "confidence", "requiresConfirmation",
       "idempotencyKey", "executionRealm", "ownerPrincipalId",
       "executionProtocolVersion", "executionGeneration"
     ) VALUES ($1, 'pg18-probe', 'integration', 'planned', 1, false, $2, $3, $4, 2, 1)`,
    [plan.planId, `idem-${label}`, plan.realm, `owner-${label}`]
  );
  await client.query(
    `INSERT INTO "Action" (
       "id", "planId", "agentId", "capability", "params", "timeoutMs", "sortOrder"
     ) VALUES ($1, $2, $3, 'pg18.probe', '{}'::jsonb, 30000, 0)`,
    [plan.actionId, plan.planId, plan.agentId]
  );
  return plan;
}

async function createProbeCommand(
  client: QueryClient,
  plan: ProbePlan,
  label: string,
  requesterPrincipalId = 'requester-probe'
): Promise<string> {
  const commandId = `command-${label}`;
  await client.query(
    `INSERT INTO "ActionPlanExecutionCommand" (
       "id", "planId", "executionRealm", "requesterPrincipalId",
       "commandIdempotencyKeyHash", "commandFingerprint",
       "lockedPlanExecutionGeneration", "protocolVersion"
     ) VALUES ($1, $2, $3, $4, $5, $6, 1, 2)`,
    [commandId, plan.planId, plan.realm, requesterPrincipalId, nextProbeHash(), nextProbeHash()]
  );
  return commandId;
}

function stateFields(state: RunState): Record<string, unknown> {
  const instant = '2026-07-18T12:00:00.000Z';
  const claimed = {
    claimedExecutorPrincipalId: 'assigned',
    claimedExecutorInstanceId: 'assigned',
    claimIdempotencyKeyHash: nextProbeHash(),
    claimFingerprint: nextProbeHash(),
    claimedAt: instant
  };
  const started = {
    ...claimed,
    startIdempotencyKeyHash: nextProbeHash(),
    startFingerprint: nextProbeHash(),
    startedAt: instant
  };
  if (state === 'CLAIMED') return claimed;
  if (state === 'RUNNING') return started;
  if (state === 'SUCCEEDED' || state === 'FAILED') {
    return {
      ...started,
      resultIdempotencyKeyHash: nextProbeHash(),
      resultFingerprint: nextProbeHash(),
      acceptanceReceipt: 'receipt',
      terminalCategory: state,
      completedAt: instant
    };
  }
  if (state === 'CANCELLED') return { terminalCategory: state, cancelledAt: instant };
  if (state === 'EXPIRED') return { terminalCategory: state, expiredAt: instant };
  if (state === 'SUPERSEDED') return { terminalCategory: state, supersededAt: instant };
  return {};
}

async function createProbeRun(
  client: QueryClient,
  plan: ProbePlan,
  commandId: string,
  label: string,
  attempt: number,
  state: RunState
): Promise<string> {
  const runId = `run-${label}`;
  const snapshot = {
    snapshot_version: 'action-execution-snapshot-v1',
    plan_id: plan.planId,
    action_id: plan.actionId,
    agent_id: plan.agentId,
    capability: 'pg18.probe',
    params: {},
    timeout_ms: 30000,
    sort_order: 0,
    plan_execution_generation: 1,
    executor_kind: 'python-daemon',
    assigned_executor_principal_id: plan.executorPrincipalId,
    agent_capability_fingerprint: nextProbeHash()
  };
  const row: Record<string, unknown> = {
    id: runId,
    commandId,
    planId: plan.planId,
    actionId: plan.actionId,
    attempt,
    state,
    executorKind: 'python-daemon',
    assignedAgentId: plan.agentId,
    assignedExecutorPrincipalId: plan.executorPrincipalId,
    assignedExecutorInstanceId: plan.executorInstanceId,
    executionRealm: plan.realm,
    actionSnapshotId: `snapshot-${label}`,
    actionSnapshotSchemaVersion: 1,
    actionSnapshot: JSON.stringify(snapshot),
    policyCategory: 'ALLOW',
    policyEvidenceId: `clear-recheck-v1:${nextProbeHash()}`,
    policyEvaluatedAt: '2026-07-18T12:00:00.000Z',
    ...stateFields(state)
  };
  if (row.claimedExecutorPrincipalId === 'assigned') {
    row.claimedExecutorPrincipalId = plan.executorPrincipalId;
    row.claimedExecutorInstanceId = plan.executorInstanceId;
  }
  const entries = Object.entries(row);
  const columns = entries.map(([column]) => `"${column}"`).join(', ');
  const values = entries.map(([, value]) => value);
  const placeholders = entries.map(([column], index) => (
    column === 'actionSnapshot' ? `$${index + 1}::jsonb` : `$${index + 1}`
  )).join(', ');
  await client.query(
    `INSERT INTO "ActionPlanExecutionRun" (${columns}) VALUES (${placeholders})`,
    values
  );
  return runId;
}

function containsIndexName(value: unknown, indexName: string): boolean {
  if (Array.isArray(value)) return value.some(entry => containsIndexName(entry, indexName));
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  if (record['Index Name'] === indexName) return true;
  return Object.values(record).some(entry => containsIndexName(entry, indexName));
}

async function expectSemanticVerificationFailure(
  client: QueryClient,
  migration: MigrationModule,
  issue: string
): Promise<void> {
  await expect(migration.verifyActionPlanExecutionSchemaWithClient(client)).resolves.toEqual(
    expect.objectContaining({ ready: false, issues: expect.arrayContaining([issue]) })
  );
  await expect(verifyActionPlanExecutionSchema(
    client as unknown as Parameters<typeof verifyActionPlanExecutionSchema>[0]
  )).resolves.toEqual(
    expect.objectContaining({ ready: false, issues: expect.arrayContaining([issue]) })
  );
}

async function probePostgresql18CheckConstraints(
  client: QueryClient,
  migration: MigrationModule
): Promise<void> {
  const checkColumns: Record<string, { table: string; columns: string[] }> = {
    ck_ap_exec_migration_version: {
      table: 'ActionPlanExecutionSchemaMigration', columns: ['version']
    },
    ck_ap_exec_command_realm: {
      table: 'ActionPlanExecutionCommand', columns: ['executionRealm']
    },
    ck_ap_exec_command_requester: {
      table: 'ActionPlanExecutionCommand', columns: ['requesterPrincipalId']
    },
    ck_ap_exec_run_realm: {
      table: 'ActionPlanExecutionRun', columns: ['executionRealm']
    },
    ck_ap_exec_run_snapshot_id: {
      table: 'ActionPlanExecutionRun', columns: ['actionSnapshotId']
    },
    ck_ap_exec_run_result_bounds: {
      table: 'ActionPlanExecutionRun',
      columns: ['acceptanceReceipt', 'resultOutput', 'resultError']
    },
    ck_ap_exec_event_identifiers: {
      table: 'ActionPlanExecutionEvent',
      columns: ['executionRealm', 'reasonCode', 'requestId', 'traceId']
    }
  };
  const checkNames = Object.keys(checkColumns).sort();
  expect(checkNames).toHaveLength(7);
  const catalog = await client.query(
    `SELECT constraint_data.conname AS name,
            relation.relname AS table_name,
            constraint_data.contype AS type,
            constraint_data.convalidated AS validated,
            constraint_data.condeferrable AS deferrable,
            constraint_data.condeferred AS initially_deferred,
            to_json(ARRAY(
              SELECT attribute.attname::text
              FROM unnest(constraint_data.conkey) WITH ORDINALITY AS key_column(attnum, position)
              JOIN pg_attribute AS attribute
                ON attribute.attrelid = constraint_data.conrelid
               AND attribute.attnum = key_column.attnum
              ORDER BY key_column.position
            )::text[])::text AS columns_json
     FROM pg_constraint AS constraint_data
     JOIN pg_class AS relation ON relation.oid = constraint_data.conrelid
     JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
     WHERE namespace.nspname = current_schema()
       AND constraint_data.conname = ANY($1::text[])
     ORDER BY constraint_data.conname`,
    [checkNames]
  );
  expect(catalog.rows).toHaveLength(7);
  for (const row of catalog.rows) {
    const expected = checkColumns[String(row.name)];
    expect(row).toMatchObject({
      table_name: expected.table,
      type: 'c',
      validated: true,
      deferrable: false,
      initially_deferred: false
    });
    expect((JSON.parse(String(row.columns_json)) as string[]).sort()).toEqual(
      [...expected.columns].sort()
    );
  }

  await withRollback(client, async () => {
    const checksum = 'a'.repeat(64);
    await client.query(
      `INSERT INTO "ActionPlanExecutionSchemaMigration"
       ("version", "checksum", "completedPhase", "validityState")
       VALUES ($1, $3, 'probe', 'FAILED'), ($2, $3, 'probe', 'FAILED')`,
      ['v', 'v'.repeat(64), checksum]
    );
    for (const [label, version] of [['empty', ''], ['too_long', 'v'.repeat(65)]]) {
      await withSavepoint(client, `migration_version_${label}`, async () => {
        await expectCheckViolation(
          client,
          'ck_ap_exec_migration_version',
          `INSERT INTO "ActionPlanExecutionSchemaMigration"
           ("version", "checksum", "completedPhase", "validityState")
           VALUES ($1, $2, 'probe', 'FAILED')`,
          [version, checksum]
        );
      });
    }
    await withSavepoint(client, 'migration_version_null', async () => {
      await expectDatabaseError(
        client,
        { code: '23502', column: 'version' },
        `INSERT INTO "ActionPlanExecutionSchemaMigration"
         ("version", "checksum", "completedPhase", "validityState")
         VALUES (NULL, $1, 'probe', 'FAILED')`,
        [checksum]
      );
    });

    const plan = await createProbePlan(client, 'checks');
    const commandId = await createProbeCommand(client, plan, 'checks');
    const requestedRunId = await createProbeRun(
      client, plan, commandId, 'checks-requested', 1, 'REQUESTED'
    );
    for (const [label, realm] of [['min', 'r'], ['max', 'r'.repeat(256)]]) {
      const boundaryPlan = await createProbePlan(client, `realm-${label}`, realm);
      const boundaryCommand = await createProbeCommand(
        client, boundaryPlan, `realm-${label}`, 'r'
      );
      const boundaryRun = await createProbeRun(
        client, boundaryPlan, boundaryCommand, `realm-${label}`, 1, 'REQUESTED'
      );
      await client.query(
        `INSERT INTO "ActionPlanExecutionEvent" (
           "id", "runId", "eventSequence", "eventType", "actorCategory", "sourceService",
           "executionRealm", "reasonCode", "requestId", "traceId", "safeMetadata"
         ) VALUES ($1, $2, 1, 'EXECUTION_REQUESTED', 'system', 'system', $3, 'r', 'r', 'r', '{}')`,
        [`event-realm-${label}`, boundaryRun, realm]
      );
    }

    for (const [label, value] of [['empty', ''], ['too_long', 'r'.repeat(257)]]) {
      await withSavepoint(client, `command_realm_${label}`, async () => {
        await expectCheckViolation(
          client,
          'ck_ap_exec_command_realm',
          `UPDATE "ActionPlanExecutionCommand" SET "executionRealm"=$1 WHERE "id"=$2`,
          [value, commandId]
        );
      });
      await withSavepoint(client, `run_realm_${label}`, async () => {
        await expectCheckViolation(
          client,
          'ck_ap_exec_run_realm',
          `UPDATE "ActionPlanExecutionRun" SET "executionRealm"=$1 WHERE "id"=$2`,
          [value, requestedRunId]
        );
      });
    }
    await withSavepoint(client, 'command_realm_null', async () => {
      await expectDatabaseError(
        client,
        { code: '23502', column: 'executionRealm' },
        `UPDATE "ActionPlanExecutionCommand" SET "executionRealm"=NULL WHERE "id"=$1`,
        [commandId]
      );
    });
    await withSavepoint(client, 'run_realm_null', async () => {
      await expectDatabaseError(
        client,
        { code: '23502', column: 'executionRealm' },
        `UPDATE "ActionPlanExecutionRun" SET "executionRealm"=NULL WHERE "id"=$1`,
        [requestedRunId]
      );
    });

    await client.query(
      `UPDATE "ActionPlanExecutionCommand" SET "requesterPrincipalId"='r' WHERE "id"=$1`,
      [commandId]
    );
    await client.query(
      `UPDATE "ActionPlanExecutionCommand" SET "requesterPrincipalId"=$1 WHERE "id"=$2`,
      ['r'.repeat(256), commandId]
    );
    for (const [label, value] of [['empty', ''], ['too_long', 'r'.repeat(257)]]) {
      await withSavepoint(client, `command_requester_${label}`, async () => {
        await expectCheckViolation(
          client,
          'ck_ap_exec_command_requester',
          `UPDATE "ActionPlanExecutionCommand" SET "requesterPrincipalId"=$1 WHERE "id"=$2`,
          [value, commandId]
        );
      });
    }
    await withSavepoint(client, 'command_requester_null', async () => {
      await expectDatabaseError(
        client,
        { code: '23502', column: 'requesterPrincipalId' },
        `UPDATE "ActionPlanExecutionCommand" SET "requesterPrincipalId"=NULL WHERE "id"=$1`,
        [commandId]
      );
    });

    await client.query(
      `UPDATE "ActionPlanExecutionRun" SET "actionSnapshotId"='s' WHERE "id"=$1`,
      [requestedRunId]
    );
    await client.query(
      `UPDATE "ActionPlanExecutionRun" SET "actionSnapshotId"=$1 WHERE "id"=$2`,
      ['s'.repeat(128), requestedRunId]
    );
    for (const [label, value] of [['empty', ''], ['too_long', 's'.repeat(129)]]) {
      await withSavepoint(client, `run_snapshot_id_${label}`, async () => {
        await expectCheckViolation(
          client,
          'ck_ap_exec_run_snapshot_id',
          `UPDATE "ActionPlanExecutionRun" SET "actionSnapshotId"=$1 WHERE "id"=$2`,
          [value, requestedRunId]
        );
      });
    }
    await withSavepoint(client, 'run_snapshot_id_null', async () => {
      await expectDatabaseError(
        client,
        { code: '23502', column: 'actionSnapshotId' },
        `UPDATE "ActionPlanExecutionRun" SET "actionSnapshotId"=NULL WHERE "id"=$1`,
        [requestedRunId]
      );
    });

    const successCommand = await createProbeCommand(client, plan, 'checks-success');
    const successRunId = await createProbeRun(
      client, plan, successCommand, 'checks-success', 2, 'SUCCEEDED'
    );
    const failedCommand = await createProbeCommand(client, plan, 'checks-failed');
    const failedRunId = await createProbeRun(
      client, plan, failedCommand, 'checks-failed', 3, 'FAILED'
    );
    const outputBoundary = await client.query(
      `SELECT octet_length(to_jsonb(repeat('x', 65534))::text)::integer AS bytes`
    );
    const errorBoundary = await client.query(
      `SELECT octet_length(to_jsonb(repeat('x', 8190))::text)::integer AS bytes`
    );
    expect(outputBoundary.rows[0]?.bytes).toBe(65536);
    expect(errorBoundary.rows[0]?.bytes).toBe(8192);
    await client.query(
      `UPDATE "ActionPlanExecutionRun" SET "acceptanceReceipt"='r' WHERE "id"=$1`,
      [successRunId]
    );
    await client.query(
      `UPDATE "ActionPlanExecutionRun"
       SET "resultOutput"=to_jsonb(repeat('x', 65534)), "acceptanceReceipt"=$1
       WHERE "id"=$2`,
      ['r'.repeat(256), successRunId]
    );
    await client.query(
      `UPDATE "ActionPlanExecutionRun" SET "resultError"=to_jsonb(repeat('x', 8190))
       WHERE "id"=$1`,
      [failedRunId]
    );
    await withSavepoint(client, 'run_output_too_large', async () => {
      await expectCheckViolation(
        client,
        'ck_ap_exec_run_result_bounds',
        `UPDATE "ActionPlanExecutionRun" SET "resultOutput"=to_jsonb(repeat('x', 65535))
         WHERE "id"=$1`,
        [successRunId]
      );
    });
    await withSavepoint(client, 'run_error_too_large', async () => {
      await expectCheckViolation(
        client,
        'ck_ap_exec_run_result_bounds',
        `UPDATE "ActionPlanExecutionRun" SET "resultError"=to_jsonb(repeat('x', 8191))
         WHERE "id"=$1`,
        [failedRunId]
      );
    });
    for (const [label, value] of [['empty', ''], ['too_long', 'r'.repeat(257)]]) {
      await withSavepoint(client, `run_receipt_${label}`, async () => {
        await expectCheckViolation(
          client,
          'ck_ap_exec_run_result_bounds',
          `UPDATE "ActionPlanExecutionRun" SET "acceptanceReceipt"=$1 WHERE "id"=$2`,
          [value, successRunId]
        );
      });
    }
    const requestedNulls = await client.query(
      `SELECT "resultOutput", "resultError", "acceptanceReceipt"
       FROM "ActionPlanExecutionRun" WHERE "id"=$1`,
      [requestedRunId]
    );
    expect(requestedNulls.rows[0]).toEqual({
      resultOutput: null, resultError: null, acceptanceReceipt: null
    });

    const eventId = 'event-checks';
    await client.query(
      `INSERT INTO "ActionPlanExecutionEvent" (
         "id", "runId", "eventSequence", "eventType", "actorCategory", "sourceService",
         "executionRealm", "reasonCode", "requestId", "traceId", "safeMetadata"
       ) VALUES ($1, $2, 1, 'EXECUTION_REQUESTED', 'system', 'system', $3, 'probe', NULL, NULL, '{}')`,
      [eventId, requestedRunId, plan.realm]
    );
    await client.query(
      `UPDATE "ActionPlanExecutionEvent"
       SET "reasonCode"=$1, "requestId"=$2, "traceId"=$3 WHERE "id"=$4`,
      ['r', 'q', 't', eventId]
    );
    await client.query(
      `UPDATE "ActionPlanExecutionEvent"
       SET "reasonCode"=$1, "requestId"=$2, "traceId"=$3 WHERE "id"=$4`,
      ['r'.repeat(128), 'q'.repeat(128), 't'.repeat(128), eventId]
    );
    const eventInvalidValues: Array<[string, string, unknown]> = [
      ['executionRealm', 'empty', ''],
      ['executionRealm', 'too_long', 'r'.repeat(257)],
      ['reasonCode', 'empty', ''],
      ['reasonCode', 'too_long', 'r'.repeat(129)],
      ['requestId', 'empty', ''],
      ['requestId', 'too_long', 'q'.repeat(129)],
      ['traceId', 'empty', ''],
      ['traceId', 'too_long', 't'.repeat(129)]
    ];
    for (const [column, label, value] of eventInvalidValues) {
      await withSavepoint(client, `event_${column}_${label}`, async () => {
        await expectCheckViolation(
          client,
          'ck_ap_exec_event_identifiers',
          `UPDATE "ActionPlanExecutionEvent" SET "${column}"=$1 WHERE "id"=$2`,
          [value, eventId]
        );
      });
    }
    for (const column of ['executionRealm', 'reasonCode']) {
      await withSavepoint(client, `event_${column}_null`, async () => {
        await expectDatabaseError(
          client,
          { code: '23502', column },
          `UPDATE "ActionPlanExecutionEvent" SET "${column}"=NULL WHERE "id"=$1`,
          [eventId]
        );
      });
    }
    await client.query(
      `UPDATE "ActionPlanExecutionEvent" SET "requestId"=NULL, "traceId"=NULL WHERE "id"=$1`,
      [eventId]
    );

    const semanticMutations = [
      {
        name: 'ck_ap_exec_migration_version',
        table: 'ActionPlanExecutionSchemaMigration',
        definition: 'CHECK (char_length("version") BETWEEN 1 AND 65)'
      },
      {
        name: 'ck_ap_exec_command_realm',
        table: 'ActionPlanExecutionCommand',
        definition: 'CHECK (char_length("executionRealm") BETWEEN 1 AND 257)'
      },
      {
        name: 'ck_ap_exec_command_requester',
        table: 'ActionPlanExecutionCommand',
        definition: 'CHECK (char_length("requesterPrincipalId") BETWEEN 1 AND 257)'
      },
      {
        name: 'ck_ap_exec_run_realm',
        table: 'ActionPlanExecutionRun',
        definition: 'CHECK (char_length("executionRealm") BETWEEN 1 AND 257)'
      },
      {
        name: 'ck_ap_exec_run_snapshot_id',
        table: 'ActionPlanExecutionRun',
        definition: 'CHECK (char_length("actionSnapshotId") BETWEEN 1 AND 129)'
      },
      {
        name: 'ck_ap_exec_run_result_bounds',
        table: 'ActionPlanExecutionRun',
        definition: `CHECK (
          ("resultOutput" IS NULL OR octet_length("resultOutput"::TEXT) <= 65537)
          AND ("resultError" IS NULL OR octet_length("resultError"::TEXT) <= 8192)
          AND ("acceptanceReceipt" IS NULL OR char_length("acceptanceReceipt") BETWEEN 1 AND 256)
        )`
      },
      {
        name: 'ck_ap_exec_event_identifiers',
        table: 'ActionPlanExecutionEvent',
        definition: `CHECK (
          char_length("executionRealm") BETWEEN 1 AND 256
          AND char_length("reasonCode") BETWEEN 1 AND 129
          AND ("requestId" IS NULL OR char_length("requestId") BETWEEN 1 AND 128)
          AND ("traceId" IS NULL OR char_length("traceId") BETWEEN 1 AND 128)
        )`
      }
    ];
    expect(semanticMutations).toHaveLength(7);
    for (const mutation of semanticMutations) {
      await withSavepoint(client, `mutate_${mutation.name}`, async () => {
        await client.query(
          `ALTER TABLE "${mutation.table}" DROP CONSTRAINT "${mutation.name}"`
        );
        await client.query(
          `ALTER TABLE "${mutation.table}" ADD CONSTRAINT "${mutation.name}" ${mutation.definition}`
        );
        await expectSemanticVerificationFailure(
          client,
          migration,
          `SCHEMA_CONSTRAINT_DEFINITION_INVALID:${mutation.name}`
        );
      });
    }
  });
}

async function probePartialIndexes(
  client: QueryClient,
  migration: MigrationModule
): Promise<void> {
  const expectedIndexes = {
    uq_ap_exec_run_active_action: {
      table: 'ActionPlanExecutionRun',
      unique: true,
      columns: ['planId', 'actionId']
    },
    ix_ap_exec_run_claim_next: {
      table: 'ActionPlanExecutionRun',
      unique: false,
      columns: [
        'executionRealm',
        'assignedExecutorPrincipalId',
        'assignedExecutorInstanceId',
        'state',
        'requestedAt',
        'id'
      ]
    }
  };
  const indexNames = Object.keys(expectedIndexes).sort();
  const currentSchema = await client.query('SELECT current_schema() AS name');
  const expectedSchemaName = currentSchema.rows[0]?.name;
  const catalog = await client.query(
    `SELECT namespace.nspname AS schema_name,
            table_relation.relname AS table_name,
            index_relation.relname AS index_name,
            access_method.amname AS access_method,
            index_data.indisunique AS is_unique,
            index_data.indisvalid AS is_valid,
            index_data.indisready AS is_ready,
            index_data.indnkeyatts::integer AS key_count,
            index_data.indnatts::integer AS attribute_count,
            index_data.indexprs IS NULL AS expressions_absent,
            to_json(ARRAY(
              SELECT attribute.attname::text
              FROM unnest(index_data.indkey::smallint[]) WITH ORDINALITY AS key_column(attnum, position)
              JOIN pg_attribute AS attribute
                ON attribute.attrelid = index_data.indrelid
               AND attribute.attnum = key_column.attnum
              WHERE key_column.position <= index_data.indnkeyatts
              ORDER BY key_column.position
            )::text[])::text AS columns_json,
            pg_get_expr(index_data.indpred, index_data.indrelid, true) AS predicate
     FROM pg_index AS index_data
     JOIN pg_class AS index_relation ON index_relation.oid = index_data.indexrelid
     JOIN pg_class AS table_relation ON table_relation.oid = index_data.indrelid
     JOIN pg_namespace AS namespace ON namespace.oid = index_relation.relnamespace
     JOIN pg_am AS access_method ON access_method.oid = index_relation.relam
     WHERE namespace.nspname = current_schema()
       AND index_relation.relname = ANY($1::text[])
     ORDER BY index_relation.relname`,
    [indexNames]
  );
  expect(catalog.rows).toHaveLength(2);
  for (const row of catalog.rows) {
    const expected = expectedIndexes[
      String(row.index_name) as keyof typeof expectedIndexes
    ];
    expect(row).toMatchObject({
      schema_name: expectedSchemaName,
      table_name: expected.table,
      access_method: 'btree',
      is_unique: expected.unique,
      is_valid: true,
      is_ready: true,
      key_count: expected.columns.length,
      attribute_count: expected.columns.length,
      expressions_absent: true,
      predicate: expect.any(String)
    });
    expect(row.schema_name).not.toBe('public');
    expect(JSON.parse(String(row.columns_json))).toEqual(expected.columns);
  }

  await withRollback(client, async () => {
    for (const state of ['REQUESTED', 'CLAIMED', 'RUNNING'] as const) {
      await withSavepoint(client, `active_index_${state}`, async () => {
        const label = `active-${state.toLowerCase()}`;
        const plan = await createProbePlan(client, label);
        const firstCommand = await createProbeCommand(client, plan, `${label}-one`);
        await createProbeRun(client, plan, firstCommand, `${label}-one`, 1, state);
        const secondCommand = await createProbeCommand(client, plan, `${label}-two`);
        await expectDatabaseError(
          client,
          { code: '23505', constraint: 'uq_ap_exec_run_active_action' },
          `INSERT INTO "ActionPlanExecutionRun" (
             "id", "commandId", "planId", "actionId", "attempt", "state", "executorKind",
             "assignedAgentId", "assignedExecutorPrincipalId", "assignedExecutorInstanceId",
             "executionRealm", "actionSnapshotId", "actionSnapshotSchemaVersion",
             "actionSnapshot", "policyCategory", "policyEvidenceId", "policyEvaluatedAt"
           )
           SELECT $1, $2, "planId", "actionId", 2, 'REQUESTED', "executorKind",
                  "assignedAgentId", "assignedExecutorPrincipalId", "assignedExecutorInstanceId",
                  "executionRealm", $3, "actionSnapshotSchemaVersion", "actionSnapshot",
                  "policyCategory", "policyEvidenceId", "policyEvaluatedAt"
           FROM "ActionPlanExecutionRun" WHERE "commandId"=$4`,
          [`run-${label}-two`, secondCommand, `snapshot-${label}-two`, firstCommand]
        );
      });
    }

    for (const state of [
      'SUCCEEDED', 'FAILED', 'CANCELLED', 'EXPIRED', 'SUPERSEDED'
    ] as const) {
      await withSavepoint(client, `inactive_index_${state}`, async () => {
        const label = `inactive-${state.toLowerCase()}`;
        const plan = await createProbePlan(client, label);
        for (let attempt = 1; attempt <= 2; attempt += 1) {
          const command = await createProbeCommand(client, plan, `${label}-${attempt}`);
          await createProbeRun(client, plan, command, `${label}-${attempt}`, attempt, state);
        }
        const activeCommand = await createProbeCommand(client, plan, `${label}-active`);
        await createProbeRun(client, plan, activeCommand, `${label}-active`, 3, 'REQUESTED');
        const rows = await client.query(
          `SELECT "state" FROM "ActionPlanExecutionRun" WHERE "planId"=$1 ORDER BY "attempt"`,
          [plan.planId]
        );
        expect(rows.rows.map(row => row.state)).toEqual([state, state, 'REQUESTED']);
      });
    }

    const claimPlan = await createProbePlan(client, 'claim-index');
    const claimCommand = await createProbeCommand(client, claimPlan, 'claim-index');
    const claimRunId = await createProbeRun(
      client, claimPlan, claimCommand, 'claim-index', 1, 'REQUESTED'
    );
    await client.query('SET LOCAL enable_seqscan=off');
    const requestedPlan = await client.query(
      `EXPLAIN (FORMAT JSON, COSTS OFF)
       SELECT "id" FROM "ActionPlanExecutionRun"
       WHERE "executionRealm"=$1
         AND "assignedExecutorPrincipalId"=$2
         AND "assignedExecutorInstanceId"=$3
         AND "state"='REQUESTED'
       ORDER BY "requestedAt", "id" LIMIT 1`,
      [claimPlan.realm, claimPlan.executorPrincipalId, claimPlan.executorInstanceId]
    );
    expect(containsIndexName(requestedPlan.rows, 'ix_ap_exec_run_claim_next')).toBe(true);
    const claimedPlan = await client.query(
      `EXPLAIN (FORMAT JSON, COSTS OFF)
       SELECT "id" FROM "ActionPlanExecutionRun"
       WHERE "executionRealm"=$1
         AND "assignedExecutorPrincipalId"=$2
         AND "assignedExecutorInstanceId"=$3
         AND "state"='CLAIMED'
       ORDER BY "requestedAt", "id" LIMIT 1`,
      [claimPlan.realm, claimPlan.executorPrincipalId, claimPlan.executorInstanceId]
    );
    expect(containsIndexName(claimedPlan.rows, 'ix_ap_exec_run_claim_next')).toBe(false);
    const selected = await client.query(
      `SELECT "id" FROM "ActionPlanExecutionRun"
       WHERE "executionRealm"=$1
         AND "assignedExecutorPrincipalId"=$2
         AND "assignedExecutorInstanceId"=$3
         AND "state"='REQUESTED'
       ORDER BY "requestedAt", "id" LIMIT 1`,
      [claimPlan.realm, claimPlan.executorPrincipalId, claimPlan.executorInstanceId]
    );
    expect(selected.rows).toEqual([{ id: claimRunId }]);
  });

  const indexMutations = [
    {
      label: 'active_predicate',
      name: 'uq_ap_exec_run_active_action',
      sql: `CREATE UNIQUE INDEX "uq_ap_exec_run_active_action"
            ON "ActionPlanExecutionRun" ("planId", "actionId")
            WHERE "state" IN ('REQUESTED', 'CLAIMED')`
    },
    {
      label: 'active_key_order',
      name: 'uq_ap_exec_run_active_action',
      sql: `CREATE UNIQUE INDEX "uq_ap_exec_run_active_action"
            ON "ActionPlanExecutionRun" ("actionId", "planId")
            WHERE "state" IN ('REQUESTED', 'CLAIMED', 'RUNNING')`
    },
    {
      label: 'claim_predicate',
      name: 'ix_ap_exec_run_claim_next',
      sql: `CREATE INDEX "ix_ap_exec_run_claim_next"
            ON "ActionPlanExecutionRun" (
              "executionRealm", "assignedExecutorPrincipalId", "assignedExecutorInstanceId",
              "state", "requestedAt", "id"
            ) WHERE "state" IN ('REQUESTED', 'CLAIMED')`
    },
    {
      label: 'claim_key_order',
      name: 'ix_ap_exec_run_claim_next',
      sql: `CREATE INDEX "ix_ap_exec_run_claim_next"
            ON "ActionPlanExecutionRun" (
              "executionRealm", "assignedExecutorPrincipalId", "assignedExecutorInstanceId",
              "state", "id", "requestedAt"
            ) WHERE "state" = 'REQUESTED'`
    }
  ];
  await withRollback(client, async () => {
    for (const mutation of indexMutations) {
      await withSavepoint(client, mutation.label, async () => {
        await client.query(`DROP INDEX "${mutation.name}"`);
        await client.query(mutation.sql);
        await expectSemanticVerificationFailure(
          client,
          migration,
          `SCHEMA_INDEX_DEFINITION_INVALID:${mutation.name}`
        );
      });
    }
  });

  await expect(migration.verifyActionPlanExecutionSchemaWithClient(client)).resolves.toEqual(
    expect.objectContaining({ ready: true, issues: [] })
  );
}

async function expectAllPhysicalIndexesReady(client: QueryClient): Promise<void> {
  const catalog = await client.query(
    `SELECT COUNT(*)::integer AS index_count,
            BOOL_AND(index_data.indisvalid) AS all_valid,
            BOOL_AND(index_data.indisready) AS all_ready
     FROM pg_index AS index_data
     JOIN pg_class AS index_relation ON index_relation.oid = index_data.indexrelid
     JOIN pg_class AS table_relation ON table_relation.oid = index_data.indrelid
     JOIN pg_namespace AS namespace ON namespace.oid = index_relation.relnamespace
     WHERE namespace.nspname = current_schema()
       AND table_relation.relname = ANY($1::text[])`,
    [[
      'ActionPlan',
      'Action',
      'ExecutionResult',
      'ActionPlanExecutionSchemaMigration',
      'ActionPlanExecutionCommand',
      'ActionPlanExecutionRun',
      'ActionPlanExecutionEvent'
    ]]
  );
  expect(catalog.rows).toEqual([{
    index_count: 22,
    all_valid: true,
    all_ready: true
  }]);
}

function isConfirmedEphemeralTarget(value: string | undefined): boolean {
  if (!value) return false;
  try {
    const parsed = new URL(value);
    const databaseName = decodeURIComponent(parsed.pathname.replace(/^\//u, '')).toLowerCase();
    if (railwayValidation) {
      return (
        process.env.RAILWAY_PROJECT_ID === '7faf44e5-519c-4e73-8d7a-da9f389e6187'
        && process.env.RAILWAY_ENVIRONMENT_ID === 'fb99f47d-5ef5-44c1-96c2-acf7b90fab13'
        && process.env.RAILWAY_ENVIRONMENT_NAME === 'phase2e-validation-20260717'
        && !/production/iu.test(process.env.RAILWAY_ENVIRONMENT_NAME)
        && process.env.RAILWAY_SERVICE_ID === process.env.PHASE2E_VALIDATOR_EXPECTED_SERVICE_ID
        && process.env.RAILWAY_SERVICE_NAME === process.env.PHASE2E_VALIDATOR_EXPECTED_SERVICE_NAME
        && process.env.RAILWAY_GIT_COMMIT_SHA
          === process.env.PHASE2E_VALIDATOR_EXPECTED_SOURCE_COMMIT
        && parsed.hostname === process.env.PHASE2E_VALIDATOR_EXPECTED_DATABASE_HOST
        && databaseName === process.env.PHASE2E_VALIDATOR_EXPECTED_DATABASE_NAME?.toLowerCase()
        && parsed.hostname.endsWith('.railway.internal')
        && parsed.username.length > 0
        && parsed.password.length > 0
        && parsed.search === ''
        && parsed.hash === ''
      );
    }
    return (
      ['localhost', '127.0.0.1', '[::1]', '::1'].includes(parsed.hostname.toLowerCase())
      && /^arcanos_phase2e_[a-z0-9_]+$/u.test(databaseName)
      && parsed.search === ''
      && parsed.hash === ''
    );
  } catch {
    return false;
  }
}

const describePostgresql18 = explicitlyEnabled ? describe : describe.skip;

describePostgresql18('Phase 2E migration against explicitly configured PostgreSQL 18', () => {
  jest.setTimeout(120_000);

  it('applies, verifies, recovers a failed ledger, reruns, locks, drains, and compensates', async () => {
    if (!isConfirmedEphemeralTarget(connectionString)) {
      throw new Error('PG18_INTEGRATION_REQUIRES_CONFIRMED_EPHEMERAL_DATABASE');
    }
    const pg = await import('pg');
    const Client = pg.Client ?? pg.default.Client;
    const client = new Client({ connectionString }) as QueryClient;
    const holder = new Client({ connectionString }) as QueryClient;
    const migration = await import(pathToFileURL(migrationScriptPath).href) as MigrationModule;
    const manifest = migration.loadMigrationManifest();
    const schema = `phase2e_pg18_${process.pid}`;

    await client.connect();
    await holder.connect();
    try {
      const identity = await client.query(
        `SELECT current_database() AS database_name,
                current_schema() AS schema_name,
                current_setting('server_version_num') AS server_version_num`
      );
      expect(identity.rows).toHaveLength(1);
      if (railwayValidation) {
        expect(identity.rows[0]).toMatchObject({
          database_name: process.env.PHASE2E_VALIDATOR_EXPECTED_DATABASE_NAME,
          schema_name: 'public'
        });
      }
      const serverVersionNumber = Number(identity.rows[0]?.server_version_num);
      expect(serverVersionNumber).toBeGreaterThanOrEqual(180000);
      expect(serverVersionNumber).toBeLessThan(190000);
      const safeVersionReportPath = process.env.PHASE2E_PG18_SAFE_VERSION_REPORT_PATH;
      if (railwayValidation) {
        expect(safeVersionReportPath).toBe('/tmp/phase2e-pg18-server-version.json');
        writeFileSync(
          safeVersionReportPath!,
          JSON.stringify({ serverVersionNumber }),
          { encoding: 'utf8', mode: 0o600 }
        );
      }

      await client.query(`CREATE SCHEMA "${schema}"`);
      await client.query(`SET search_path TO "${schema}"`);
      await holder.query(`SET search_path TO "${schema}"`);
      await client.query(`CREATE TABLE "ActionPlan" (
        "id" TEXT PRIMARY KEY,
        "createdBy" TEXT NOT NULL,
        "origin" TEXT NOT NULL,
        "status" TEXT NOT NULL DEFAULT 'planned',
        "confidence" DOUBLE PRECISION NOT NULL DEFAULT 0,
        "requiresConfirmation" BOOLEAN NOT NULL DEFAULT true,
        "idempotencyKey" TEXT NOT NULL UNIQUE,
        "expiresAt" TIMESTAMP(3),
        "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
      )`);
      await client.query(`CREATE TABLE "Action" (
        "id" TEXT PRIMARY KEY,
        "planId" TEXT NOT NULL REFERENCES "ActionPlan"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
        "agentId" TEXT NOT NULL,
        "capability" TEXT NOT NULL,
        "params" JSONB NOT NULL,
        "timeoutMs" INTEGER NOT NULL DEFAULT 30000,
        "rollbackAction" JSONB,
        "sortOrder" INTEGER NOT NULL DEFAULT 0
      )`);
      await client.query(`CREATE TABLE "ExecutionResult" (
        "id" TEXT PRIMARY KEY,
        "planId" TEXT NOT NULL REFERENCES "ActionPlan"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
        "actionId" TEXT NOT NULL,
        "agentId" TEXT NOT NULL,
        "status" TEXT NOT NULL,
        "output" JSONB,
        "error" JSONB,
        "signature" TEXT,
        "clearDecision" TEXT NOT NULL,
        "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE ("planId", "actionId")
      )`);

      const legacyPlanId = 'legacy-plan-preserved';
      const legacyActionId = 'legacy-action-preserved';
      await client.query(
        `INSERT INTO "ActionPlan" (
           "id", "createdBy", "origin", "status", "confidence",
           "requiresConfirmation", "idempotencyKey"
         ) VALUES ($1, 'legacy-owner', 'legacy-fixture', 'planned', 0.75, true, $2)`,
        [legacyPlanId, 'legacy-idempotency-preserved']
      );
      await client.query(
        `INSERT INTO "Action" (
           "id", "planId", "agentId", "capability", "params", "timeoutMs", "sortOrder"
         ) VALUES ($1, $2, 'legacy-agent', 'legacy.capability', '{"legacy":true}', 30000, 0)`,
        [legacyActionId, legacyPlanId]
      );
      await client.query(
        `INSERT INTO "ExecutionResult" (
           "id", "planId", "actionId", "agentId", "status", "output", "clearDecision"
         ) VALUES ('legacy-result-preserved', $1, $2, 'legacy-agent', 'completed',
                   '{"legacy":true}', 'allow')`,
        [legacyPlanId, legacyActionId]
      );
      const readLegacyRows = async () => {
        const [plans, actions, results] = await Promise.all([
          client.query(
            `SELECT "id", "createdBy", "origin", "status", "confidence",
                    "requiresConfirmation", "idempotencyKey"
             FROM "ActionPlan" WHERE "id"=$1`,
            [legacyPlanId]
          ),
          client.query(
            `SELECT "id", "planId", "agentId", "capability", "params", "timeoutMs", "sortOrder"
             FROM "Action" WHERE "id"=$1`,
            [legacyActionId]
          ),
          client.query(
            `SELECT "id", "planId", "actionId", "agentId", "status", "output", "clearDecision"
             FROM "ExecutionResult" WHERE "id"='legacy-result-preserved'`
          )
        ]);
        return {
          plan: plans.rows[0],
          action: actions.rows[0],
          result: results.rows[0]
        };
      };
      const legacyRowsBeforeMigration = await readLegacyRows();

      // A single additive provenance column is a safe partial-object state because the
      // reviewed phase uses ADD COLUMN IF NOT EXISTS and does not rewrite legacy rows.
      await client.query('ALTER TABLE "ActionPlan" ADD COLUMN "executionRealm" TEXT');
      const partialBeforeMigration = await client.query(
        `SELECT COUNT(*)::integer AS provenance_columns
         FROM information_schema.columns
         WHERE table_schema=current_schema()
           AND table_name='ActionPlan'
           AND column_name=ANY($1::text[])`,
        [[
          'executionRealm', 'ownerPrincipalId', 'executionProtocolVersion', 'executionGeneration'
        ]]
      );
      expect(partialBeforeMigration.rows[0]).toMatchObject({ provenance_columns: 1 });

      await expect(migration.applyMigrationWithClient(client)).resolves.toMatchObject({
        ready: true,
        applied: true,
        equivalentRerun: false,
        preflight: {
          rowCounts: {
            actionPlans: 1,
            actions: 1,
            legacyExecutionResults: 1
          }
        }
      });
      await expect(migration.verifyActionPlanExecutionSchemaWithClient(client)).resolves.toEqual(
        expect.objectContaining({ ready: true, issues: [] })
      );
      await expect(verifyActionPlanExecutionSchema(
        client as unknown as Parameters<typeof verifyActionPlanExecutionSchema>[0]
      )).resolves.toEqual(
        expect.objectContaining({ ready: true, issues: [] })
      );

      await probePostgresql18CheckConstraints(client, migration);
      await probePartialIndexes(client, migration);
      await expectAllPhysicalIndexesReady(client);

      expect(await readLegacyRows()).toEqual(legacyRowsBeforeMigration);
      const partialRecovery = await client.query(
        `SELECT COUNT(*)::integer AS provenance_columns
         FROM information_schema.columns
         WHERE table_schema=current_schema()
           AND table_name='ActionPlan'
           AND column_name=ANY($1::text[])`,
        [[
          'executionRealm', 'ownerPrincipalId', 'executionProtocolVersion', 'executionGeneration'
        ]]
      );
      expect(partialRecovery.rows[0]).toMatchObject({ provenance_columns: 4 });

      await client.query('DROP INDEX "uq_ap_exec_run_active_action"');
      await client.query(
        `CREATE UNIQUE INDEX "uq_ap_exec_run_active_action"
         ON "ActionPlanExecutionRun" ("planId", "actionId")
         WHERE "state" IN ('REQUESTED', 'CLAIMED')`
      );
      await expect(migration.applyMigrationWithClient(client)).rejects.toThrow(
        'MIGRATION_SCHEMA_VERIFICATION_FAILED'
      );
      const failedLedger = await client.query(
        `SELECT "checksum", "completedPhase", "validityState", "appliedAt"
         FROM "ActionPlanExecutionSchemaMigration" WHERE "version"=$1`,
        [manifest.version]
      );
      expect(failedLedger.rows).toEqual([expect.objectContaining({
        checksum: manifest.checksum,
        completedPhase: 'complete',
        validityState: 'FAILED',
        appliedAt: null
      })]);

      await client.query('DROP INDEX "uq_ap_exec_run_active_action"');
      await client.query(
        `CREATE UNIQUE INDEX "uq_ap_exec_run_active_action"
         ON "ActionPlanExecutionRun" ("planId", "actionId")
         WHERE "state" IN ('REQUESTED', 'CLAIMED', 'RUNNING')`
      );
      await expect(migration.applyMigrationWithClient(client)).resolves.toMatchObject({
        ready: true,
        applied: false,
        equivalentRerun: true,
        recoveredFinalVerification: true
      });
      const ledger = await client.query(
        `SELECT COUNT(*)::integer AS count,
                MIN("validityState") AS state,
                BOOL_AND("appliedAt" IS NOT NULL) AS applied
         FROM "ActionPlanExecutionSchemaMigration"
         WHERE "version"=$1`,
        [manifest.version]
      );
      expect(ledger.rows[0]).toMatchObject({ count: 1, state: 'VALID', applied: true });

      await expect(migration.applyMigrationWithClient(client)).resolves.toMatchObject({
        ready: true,
        applied: false,
        equivalentRerun: true
      });

      await holder.query('SELECT pg_advisory_lock($1::bigint)', [manifest.advisoryLockKey]);
      await expect(migration.applyMigrationWithClient(client)).rejects.toThrow(
        'MIGRATION_ADVISORY_LOCK_UNAVAILABLE'
      );
      await holder.query('SELECT pg_advisory_unlock($1::bigint)', [manifest.advisoryLockKey]);

      await client.query('BEGIN');
      try {
        await client.query(
          `UPDATE "ActionPlanExecutionSchemaMigration" SET "checksum"=$1 WHERE "version"=$2`,
          ['0'.repeat(64), manifest.version]
        );
        await expect(migration.applyMigrationWithClient(client)).rejects.toThrow(
          'MIGRATION_LEDGER_CHECKSUM_CONFLICT'
        );
      } finally {
        await client.query('ROLLBACK');
      }

      const activePlan = await createProbePlan(client, 'active-drain');
      const activeCommand = await createProbeCommand(client, activePlan, 'active-drain');
      const activeRun = await createProbeRun(
        client, activePlan, activeCommand, 'active-drain', 1, 'REQUESTED'
      );
      await expect(migration.inspectMigrationDrainStateWithClient(client)).resolves.toMatchObject({
        counts: {
          requested: 1,
          claimed: 0,
          running: 0,
          runs: 1,
          commands: 1,
          events: 0,
          populatedProvenancePlans: 1
        },
        canDisableAssignment: false,
        canRevertApplication: false,
        canCompensateEmptySchema: false
      });
      await expect(migration.compensateMigrationWithClient(client)).rejects.toThrow(
        'phase2e_compensation_requires_empty_protocol_tables'
      );

      await client.query('DELETE FROM "ActionPlanExecutionRun" WHERE "id"=$1', [activeRun]);
      await client.query(
        'DELETE FROM "ActionPlanExecutionCommand" WHERE "id"=$1',
        [activeCommand]
      );
      await expect(migration.inspectMigrationDrainStateWithClient(client)).resolves.toMatchObject({
        counts: {
          requested: 0,
          claimed: 0,
          running: 0,
          runs: 0,
          commands: 0,
          events: 0,
          populatedProvenancePlans: 1
        },
        canDisableAssignment: true,
        canRevertApplication: true,
        canCompensateEmptySchema: false
      });
      await expect(migration.compensateMigrationWithClient(client)).rejects.toThrow(
        'phase2e_compensation_requires_unpopulated_provenance'
      );
      await client.query('DELETE FROM "Action" WHERE "planId"=$1', [activePlan.planId]);
      await client.query('DELETE FROM "ActionPlan" WHERE "id"=$1', [activePlan.planId]);

      await expect(migration.inspectMigrationDrainStateWithClient(client)).resolves.toMatchObject({
        canDisableAssignment: true,
        canRevertApplication: true,
        canCompensateEmptySchema: true
      });
      await expect(migration.compensateMigrationWithClient(client)).resolves.toMatchObject({
        compensated: true
      });
      expect(await readLegacyRows()).toEqual(legacyRowsBeforeMigration);

      const compensatedCatalog = await client.query(
        `SELECT to_regclass('"ActionPlanExecutionSchemaMigration"') IS NULL AS ledger_absent,
                to_regclass('"ActionPlanExecutionCommand"') IS NULL AS command_absent,
                to_regclass('"ActionPlanExecutionRun"') IS NULL AS run_absent,
                to_regclass('"ActionPlanExecutionEvent"') IS NULL AS event_absent,
                to_regclass('"uq_ap_exec_run_active_action"') IS NULL AS active_index_absent,
                to_regclass('"ix_ap_exec_run_claim_next"') IS NULL AS claim_index_absent,
                (SELECT COUNT(*)::integer
                 FROM information_schema.columns
                 WHERE table_schema=current_schema()
                   AND table_name='ActionPlan'
                   AND column_name=ANY($1::text[])) AS provenance_columns,
                (SELECT COUNT(*)::integer
                 FROM pg_constraint AS constraint_data
                 JOIN pg_class AS relation ON relation.oid=constraint_data.conrelid
                 JOIN pg_namespace AS namespace ON namespace.oid=relation.relnamespace
                 WHERE namespace.nspname=current_schema()
                   AND constraint_data.conname='ck_action_plan_execution_provenance_v2')
                  AS provenance_constraints`,
        [[
          'executionRealm', 'ownerPrincipalId', 'executionProtocolVersion', 'executionGeneration'
        ]]
      );
      expect(compensatedCatalog.rows[0]).toEqual({
        ledger_absent: true,
        command_absent: true,
        run_absent: true,
        event_absent: true,
        active_index_absent: true,
        claim_index_absent: true,
        provenance_columns: 0,
        provenance_constraints: 0
      });

      await expect(migration.applyMigrationWithClient(client)).resolves.toMatchObject({
        ready: true,
        applied: true,
        equivalentRerun: false
      });
      await expect(migration.verifyActionPlanExecutionSchemaWithClient(client)).resolves.toEqual(
        expect.objectContaining({ ready: true, issues: [] })
      );
      expect(await readLegacyRows()).toEqual(legacyRowsBeforeMigration);
      await expect(migration.compensateMigrationWithClient(client)).resolves.toMatchObject({
        compensated: true
      });
    } finally {
      await holder.end();
      await client.query('RESET search_path').catch(() => undefined);
      await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => undefined);
      await client.end();
    }
  });
});
