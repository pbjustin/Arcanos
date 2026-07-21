import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { jest } from '@jest/globals';

const repositoryRoot = process.cwd();
const historyScriptPath = join(
  repositoryRoot,
  'scripts',
  'action-plan-execution-migration-history.mjs',
);
const migrationScriptPath = join(
  repositoryRoot,
  'scripts',
  'action-plan-execution-migration.mjs',
);
const historySqlPath = join(
  repositoryRoot,
  'migrations',
  '20260718_action_plan_execution_migration_history_v1',
  '01_attempt_history.sql',
);

type QueryResult = { rows: Array<Record<string, any>>; rowCount: number };

interface Attempt {
  id: string;
  migrationVersion: string;
  migrationChecksum: string;
  operation: string;
}

interface AttemptEvent {
  id: string;
  attemptId: string;
  eventSequence: number;
  eventType: string;
  phase: string | null;
  reasonCode: string;
}

class FakeHistoryClient {
  readonly calls: Array<{ text: string; values: unknown[] }> = [];
  readonly attempts = new Map<string, Attempt>();
  readonly events = new Map<string, AttemptEvent>();
  readonly requirements: any;
  readonly reviewedChecks: Map<string, string>;
  tables = { attempt: false, event: false };
  lockAvailable = true;
  unlockSucceeds = true;
  canonicalLedger: Record<string, unknown> | null = null;
  columnTypeOverride: { table: string; column: string; type: string } | null = null;
  readonly columnDefaultOverrides = new Map<string, unknown>();
  indexAccessMethodOverride: string | null = null;
  readonly indexPredicateOverrides = new Map<string, string | null>();
  omitInstallMarker = false;
  failNextEventInsert = false;
  failCanonicalLedgerRead = false;
  private snapshot: {
    tables: FakeHistoryClient['tables'];
    attempts: Array<[string, Attempt]>;
    events: Array<[string, AttemptEvent]>;
  } | null = null;

  constructor(history: any, main: any) {
    this.requirements = history.MIGRATION_HISTORY_SCHEMA_REQUIREMENTS;
    this.reviewedChecks = main.extractCheckDefinitions(readFileSync(historySqlPath, 'utf8'));
  }

  private columnRows(): Array<Record<string, unknown>> {
    return Object.entries(this.requirements.columns).flatMap(([table, definitions]: [string, any]) =>
      Object.entries(definitions).map(([column, spec]: [string, any]) => ({
        table_name: table,
        column_name: column,
        udt_name:
          this.columnTypeOverride?.table === table && this.columnTypeOverride.column === column
            ? this.columnTypeOverride.type
            : spec.type,
        is_nullable: spec.nullable ? 'YES' : 'NO',
        column_default: this.columnDefaultOverrides.has(`${table}.${column}`)
          ? this.columnDefaultOverrides.get(`${table}.${column}`)
          : spec.defaultKind === 'current_timestamp' ? 'CURRENT_TIMESTAMP' : null,
      })),
    );
  }

  private constraintRows(): Array<Record<string, unknown>> {
    return Object.entries(this.requirements.constraints).map(([name, spec]: [string, any]) => ({
      name,
      table_name: spec.table,
      type: spec.type,
      validated: true,
      deferrable: false,
      initially_deferred: false,
      definition: spec.type === 'c' ? this.reviewedChecks.get(name) : '',
      columns_json: JSON.stringify(spec.columns),
      referenced_table_name: spec.referencedTable ?? null,
      referenced_columns_json: JSON.stringify(spec.referencedColumns ?? []),
      update_action: spec.updateAction ?? ' ',
      delete_action: spec.deleteAction ?? ' ',
    }));
  }

  private indexRows(): Array<Record<string, unknown>> {
    return Object.entries(this.requirements.indexes).map(([name, spec]: [string, any]) => ({
      name,
      table_name: spec.table,
      unique: spec.unique,
      valid: true,
      ready: true,
      schema_matches: true,
      access_method: this.indexAccessMethodOverride ?? 'btree',
      key_count: spec.columns.length,
      attribute_count: spec.columns.length,
      expressions_absent: true,
      sort_options_default: true,
      opclasses_default: true,
      collations_default: true,
      columns_json: JSON.stringify(spec.columns),
      predicate: this.indexPredicateOverrides.has(name)
        ? this.indexPredicateOverrides.get(name)
        : spec.predicateEventTypes.length === 0
          ? null
          : `"eventType" IN (${spec.predicateEventTypes.map((value: string) => `'${value}'`).join(', ')})`,
    }));
  }

  async query(text: string, values: unknown[] = []): Promise<QueryResult> {
    this.calls.push({ text, values });
    if (text === 'BEGIN') {
      this.snapshot = {
        tables: { ...this.tables },
        attempts: [...this.attempts.entries()].map(([key, value]) => [key, { ...value }]),
        events: [...this.events.entries()].map(([key, value]) => [key, { ...value }]),
      };
      return { rows: [], rowCount: 0 };
    }
    if (text === 'COMMIT') {
      this.snapshot = null;
      return { rows: [], rowCount: 0 };
    }
    if (text === 'ROLLBACK') {
      if (this.snapshot) {
        this.tables = { ...this.snapshot.tables };
        this.attempts.clear();
        this.events.clear();
        for (const [key, value] of this.snapshot.attempts) this.attempts.set(key, value);
        for (const [key, value] of this.snapshot.events) this.events.set(key, value);
      }
      this.snapshot = null;
      return { rows: [], rowCount: 0 };
    }
    if (text.includes('pg_try_advisory_lock')) {
      return { rows: [{ locked: this.lockAvailable }], rowCount: 1 };
    }
    if (text.includes('pg_advisory_unlock')) {
      return { rows: [{ unlocked: this.unlockSucceeds }], rowCount: 1 };
    }
    if (text.includes('AS attempt_exists')) {
      return {
        rows: [{ attempt_exists: this.tables.attempt, event_exists: this.tables.event }],
        rowCount: 1,
      };
    }
    if (text.includes('to_regclass($1::text) IS NOT NULL AS exists')) {
      return { rows: [{ exists: this.canonicalLedger !== null }], rowCount: 1 };
    }
    if (
      text.includes('CREATE TABLE "ActionPlanExecutionSchemaMigrationAttempt"')
      && text.includes('CREATE TABLE "ActionPlanExecutionSchemaMigrationAttemptEvent"')
    ) {
      this.tables = { attempt: true, event: true };
      return { rows: [], rowCount: 0 };
    }
    if (text.includes('INSERT INTO "ActionPlanExecutionSchemaMigrationAttempt"')
      && !text.includes('AttemptEvent')) {
      const attempt: Attempt = {
        id: String(values[0]),
        migrationVersion: String(values[1]),
        migrationChecksum: String(values[2]),
        operation: String(values[3]),
      };
      if (this.attempts.has(attempt.id)) throw new Error('duplicate attempt');
      this.attempts.set(attempt.id, attempt);
      return { rows: [], rowCount: 1 };
    }
    if (text.includes('INSERT INTO "ActionPlanExecutionSchemaMigrationAttemptEvent"')) {
      if (this.failNextEventInsert) {
        this.failNextEventInsert = false;
        throw new Error('credential=HISTORY_SECRET path=C:\\sensitive SQL=SELECT secret');
      }
      const event: AttemptEvent = {
        id: String(values[0]),
        attemptId: String(values[1]),
        eventSequence: Number(values[2]),
        eventType: String(values[3]),
        phase: values[4] == null ? null : String(values[4]),
        reasonCode: String(values[5]),
      };
      const terminal = ['ATTEMPT_REFUSED', 'ATTEMPT_FAILED', 'ATTEMPT_SUCCEEDED'];
      if (
        terminal.includes(event.eventType)
        && [...this.events.values()].some(
          candidate => candidate.attemptId === event.attemptId && terminal.includes(candidate.eventType),
        )
      ) {
        throw new Error('duplicate terminal');
      }
      this.events.set(event.id, event);
      return { rows: [], rowCount: 1 };
    }
    if (text.includes('FROM information_schema.columns')) {
      const rows = this.columnRows();
      return { rows, rowCount: rows.length };
    }
    if (text.includes('FROM pg_constraint')) {
      const rows = this.constraintRows();
      return { rows, rowCount: rows.length };
    }
    if (text.includes('index_relation.relname = ANY')) {
      const rows = this.indexRows();
      return { rows, rowCount: rows.length };
    }
    if (text.includes("attempt.\"operation\" = 'HISTORY_SCHEMA_INSTALL'")) {
      const installedAttemptIds = [...this.attempts.values()]
        .filter(attempt => attempt.operation === 'HISTORY_SCHEMA_INSTALL')
        .map(attempt => attempt.id);
      const found = !this.omitInstallMarker && [...this.events.values()].some(event =>
        installedAttemptIds.includes(event.attemptId)
        && event.eventType === 'ATTEMPT_SUCCEEDED'
        && event.reasonCode === 'MIGRATION_HISTORY_SCHEMA_INSTALLED',
      );
      return { rows: found ? [{ id: installedAttemptIds[0] }] : [], rowCount: found ? 1 : 0 };
    }
    if (text.includes('FOR UPDATE') && text.includes('MigrationAttempt')) {
      const attempt = this.attempts.get(String(values[0]));
      return {
        rows: attempt ? [{ id: attempt.id, operation: attempt.operation }] : [],
        rowCount: attempt ? 1 : 0,
      };
    }
    if (text.includes('MAX("eventSequence")')) {
      const attemptId = String(values[0]);
      const maximum = Math.max(
        0,
        ...[...this.events.values()]
          .filter(event => event.attemptId === attemptId)
          .map(event => event.eventSequence),
      );
      const terminal = new Set(['ATTEMPT_REFUSED', 'ATTEMPT_FAILED', 'ATTEMPT_SUCCEEDED']);
      const terminalExists = [...this.events.values()].some(
        event => event.attemptId === attemptId && terminal.has(event.eventType),
      );
      return {
        rows: [{ next_sequence: maximum + 1, terminal_exists: terminalExists }],
        rowCount: 1,
      };
    }
    if (text.includes('FROM "ActionPlanExecutionSchemaMigration"')) {
      if (this.failCanonicalLedgerRead) {
        this.failCanonicalLedgerRead = false;
        throw new Error('credential=LEDGER_SECRET path=C:\\private SQL=SELECT ledger');
      }
      return {
        rows: this.canonicalLedger ? [{ ...this.canonicalLedger }] : [],
        rowCount: this.canonicalLedger ? 1 : 0,
      };
    }
    return { rows: [], rowCount: 0 };
  }
}

describe('Phase 2E durable migration-attempt history', () => {
  let history: any;
  let main: any;

  beforeAll(async () => {
    history = await import(pathToFileURL(historyScriptPath).href);
    main = await import(pathToFileURL(migrationScriptPath).href);
  });

  function fake(): FakeHistoryClient {
    return new FakeHistoryClient(history, main);
  }

  it('binds the separate additive artifact without changing the canonical migration identity', () => {
    expect(history.validateMigrationHistoryArtifacts()).toMatchObject({
      ok: true,
      version: '20260718_action_plan_execution_migration_history_v1',
      checksum: '1e08d934d28546a9b3ae642b6bd0c85baecbe797c2c4f5bc19cc1131208c2f8a',
      issues: [],
      databaseMutated: false,
    });
    expect(history.calculateMigrationHistoryChecksum()).toBe(
      history.REVIEWED_MIGRATION_HISTORY_CHECKSUM,
    );
    expect(main.validateMigrationArtifacts()).toMatchObject({
      ok: true,
      checksum: 'cfa339af4282ce47a955acd08fa3f16e617b4a943111890f1e5b4bd5ba929533',
    });

    const historySql = readFileSync(historySqlPath, 'utf8');
    expect(historySql).not.toMatch(/(?:^|;)\s*(?:DROP|TRUNCATE|DELETE\s+FROM|UPDATE)\b/imu);
    expect(historySql).toContain('ON DELETE RESTRICT');
    expect(historySql).toContain('ON UPDATE RESTRICT');
    expect(historySql).not.toContain('ON UPDATE CASCADE');
    expect(historySql).not.toContain('JSONB');

    const plan = spawnSync(process.execPath, [migrationScriptPath, '--plan'], {
      cwd: repositoryRoot,
      encoding: 'utf8',
    });
    expect(plan.status).toBe(0);
    expect(JSON.parse(plan.stdout)).toMatchObject({
      ok: true,
      checksum: main.REVIEWED_MIGRATION_CHECKSUM,
      history: {
        version: history.REVIEWED_MIGRATION_HISTORY_VERSION,
        checksum: history.REVIEWED_MIGRATION_HISTORY_CHECKSUM,
        issues: [],
      },
    });
  });

  it('installs schema and install evidence atomically, then makes a matching repeat read-only', async () => {
    const client = fake();
    let sequence = 0;
    const idFactory = () => `history-id-${++sequence}`;

    await expect(history.installMigrationAttemptHistoryWithClient(client, { idFactory }))
      .resolves.toMatchObject({
        ready: true,
        installed: true,
        equivalentRerun: false,
        historyAppended: true,
        attemptId: 'history-id-1',
      });
    expect(client.attempts.size).toBe(1);
    expect(client.events.size).toBe(2);
    expect([...client.events.values()].map(event => event.eventType)).toEqual([
      'PHASE_COMPLETED',
      'ATTEMPT_SUCCEEDED',
    ]);
    const callsAfterInstall = client.calls.length;

    await expect(history.installMigrationAttemptHistoryWithClient(client, { idFactory }))
      .resolves.toMatchObject({
        ready: true,
        installed: false,
        equivalentRerun: true,
        historyAppended: false,
      });
    expect(client.attempts.size).toBe(1);
    expect(client.events.size).toBe(2);
    expect(client.calls.slice(callsAfterInstall).some(call => call.text === 'BEGIN')).toBe(false);
    expect(client.calls.filter(call => call.text.includes('pg_try_advisory_lock'))).toHaveLength(1);
  });

  it('fails closed for artifact mismatch, partial schema, malformed schema, or missing install marker', async () => {
    const client = fake();
    const manifest = history.loadMigrationHistoryManifest();
    const altered = { ...manifest, checksum: 'f'.repeat(64) };
    expect(history.validateMigrationHistoryArtifacts({ manifest: altered })).toMatchObject({
      ok: false,
      issues: ['MIGRATION_HISTORY_CHECKSUM_MISMATCH'],
    });
    await expect(history.installMigrationAttemptHistoryWithClient(client, { manifest: altered }))
      .rejects.toThrow('MIGRATION_HISTORY_ARTIFACT_VALIDATION_FAILED');
    expect(client.calls).toHaveLength(0);

    client.tables.attempt = true;
    await expect(history.installMigrationAttemptHistoryWithClient(client))
      .rejects.toThrow('MIGRATION_HISTORY_SCHEMA_INVALID');

    const failedInstall = fake();
    failedInstall.columnTypeOverride = {
      table: 'ActionPlanExecutionSchemaMigrationAttempt',
      column: 'migrationChecksum',
      type: 'varchar',
    };
    await expect(history.installMigrationAttemptHistoryWithClient(failedInstall))
      .rejects.toThrow('MIGRATION_HISTORY_SCHEMA_INVALID');
    expect(failedInstall.tables).toEqual({ attempt: false, event: false });
    expect(failedInstall.attempts.size).toBe(0);
    expect(failedInstall.events.size).toBe(0);
    expect(failedInstall.calls.some(call => call.text === 'ROLLBACK')).toBe(true);

    const malformed = fake();
    await history.installMigrationAttemptHistoryWithClient(malformed);
    malformed.columnTypeOverride = {
      table: 'ActionPlanExecutionSchemaMigrationAttemptEvent',
      column: 'eventSequence',
      type: 'int4',
    };
    await expect(history.verifyMigrationAttemptHistoryWithClient(malformed)).resolves.toMatchObject({
      ready: false,
      issues: [
        'MIGRATION_HISTORY_COLUMN_INVALID:ActionPlanExecutionSchemaMigrationAttemptEvent.eventSequence',
      ],
    });
    malformed.columnTypeOverride = null;
    malformed.indexAccessMethodOverride = 'hash';
    await expect(history.verifyMigrationAttemptHistoryWithClient(malformed)).resolves.toMatchObject({
      ready: false,
      issues: expect.arrayContaining([
        'MIGRATION_HISTORY_INDEX_INVALID:ix_ap_exec_migration_attempt_version_started',
        'MIGRATION_HISTORY_INDEX_INVALID:uq_ap_exec_migration_attempt_terminal',
      ]),
    });
    malformed.indexAccessMethodOverride = null;
    malformed.indexPredicateOverrides.set(
      'ix_ap_exec_migration_attempt_version_started',
      'true',
    );
    await expect(history.verifyMigrationAttemptHistoryWithClient(malformed)).resolves.toMatchObject({
      ready: false,
      issues: expect.arrayContaining([
        'MIGRATION_HISTORY_INDEX_INVALID:ix_ap_exec_migration_attempt_version_started',
      ]),
    });
    malformed.indexPredicateOverrides.clear();
    malformed.indexPredicateOverrides.set(
      'uq_ap_exec_migration_attempt_terminal',
      `("eventType" IN ('ATTEMPT_FAILED', 'ATTEMPT_REFUSED', 'ATTEMPT_SUCCEEDED')) AND false`,
    );
    await expect(history.verifyMigrationAttemptHistoryWithClient(malformed)).resolves.toMatchObject({
      ready: false,
      issues: expect.arrayContaining([
        'MIGRATION_HISTORY_INDEX_INVALID:uq_ap_exec_migration_attempt_terminal',
      ]),
    });
    malformed.indexPredicateOverrides.set(
      'uq_ap_exec_migration_attempt_terminal',
      `("eventType" = ANY (ARRAY['ATTEMPT_SUCCEEDED'::text, 'ATTEMPT_FAILED'::text, 'ATTEMPT_REFUSED'::text]))`,
    );
    await expect(history.verifyMigrationAttemptHistoryWithClient(malformed)).resolves.toMatchObject({
      ready: true,
      issues: [],
    });
    malformed.indexPredicateOverrides.clear();
    malformed.columnDefaultOverrides.set(
      'ActionPlanExecutionSchemaMigrationAttempt.startedAt',
      `CURRENT_TIMESTAMP + interval '1 second'`,
    );
    await expect(history.verifyMigrationAttemptHistoryWithClient(malformed)).resolves.toMatchObject({
      ready: false,
      issues: [
        'MIGRATION_HISTORY_COLUMN_INVALID:ActionPlanExecutionSchemaMigrationAttempt.startedAt',
      ],
    });
    malformed.columnDefaultOverrides.set(
      'ActionPlanExecutionSchemaMigrationAttempt.startedAt',
      'now()',
    );
    await expect(history.verifyMigrationAttemptHistoryWithClient(malformed)).resolves.toMatchObject({
      ready: true,
      issues: [],
    });
    malformed.columnDefaultOverrides.clear();
    malformed.omitInstallMarker = true;
    await expect(history.verifyMigrationAttemptHistoryWithClient(malformed)).resolves.toMatchObject({
      ready: false,
      issues: ['MIGRATION_HISTORY_INSTALL_MARKER_MISSING'],
    });
  });

  it('records only validated, parameterized safe fields and permits one terminal event', async () => {
    const client = fake();
    await history.installMigrationAttemptHistoryWithClient(client);
    await history.createMigrationAttemptWithClient(client, {
      operation: 'APPLY',
      attemptId: 'apply-attempt-1',
    });
    await expect(history.appendMigrationAttemptEventWithClient(client, {
      attemptId: 'apply-attempt-1',
      eventId: 'event-recovery-1',
      eventType: 'RECOVERY_STARTED',
      phase: '02a_action_plan_realm_index',
      reasonCode: 'MIGRATION_RECOVERY_STARTED',
    })).resolves.toMatchObject({ eventSequence: 1, terminal: false });
    await expect(history.appendMigrationAttemptEventWithClient(client, {
      attemptId: 'apply-attempt-1',
      eventId: 'event-terminal-1',
      eventType: 'ATTEMPT_SUCCEEDED',
      reasonCode: 'MIGRATION_APPLY_SUCCEEDED',
    })).resolves.toMatchObject({ eventSequence: 2, terminal: true });
    await expect(history.appendMigrationAttemptEventWithClient(client, {
      attemptId: 'apply-attempt-1',
      eventId: 'event-terminal-2',
      eventType: 'ATTEMPT_FAILED',
      reasonCode: 'MIGRATION_OPERATION_FAILED',
    })).rejects.toThrow('MIGRATION_HISTORY_ATTEMPT_TERMINAL');
    await expect(history.appendMigrationAttemptEventWithClient(client, {
      attemptId: 'apply-attempt-1',
      eventId: 'event-after-terminal',
      eventType: 'RECOVERY_STARTED',
      phase: '03_execution_protocol_tables',
      reasonCode: 'MIGRATION_RECOVERY_STARTED',
    })).rejects.toThrow('MIGRATION_HISTORY_ATTEMPT_TERMINAL');
    expect([...client.events.values()].filter(
      event => event.attemptId === 'apply-attempt-1',
    )).toHaveLength(2);

    const finalCalls = client.calls.slice(-5).map(call => call.text);
    expect(finalCalls.some(text => text.includes('FOR UPDATE'))).toBe(true);
    expect(finalCalls.some(text => text.includes('terminal_exists'))).toBe(true);
    expect(finalCalls.at(-1)).toBe('ROLLBACK');

    expect(client.calls.some(
      call => /^(?:UPDATE|DELETE|TRUNCATE)\b/iu.test(call.text.trim()),
    )).toBe(false);
    await expect(history.appendMigrationAttemptEventWithClient(client, {
      attemptId: 'apply-attempt-1',
      eventType: 'ATTEMPT_FAILED',
      reasonCode: 'credential=HISTORY_SECRET path=C:\\secret SQL=SELECT',
    })).rejects.toThrow('MIGRATION_HISTORY_REASON_CODE_INVALID');
    expect(JSON.stringify(client.calls)).not.toContain('HISTORY_SECRET');
  });

  it('enforces event ordering, phase shape, and operation-specific event vocabulary', async () => {
    const client = fake();
    await history.installMigrationAttemptHistoryWithClient(client);
    await expect(history.createMigrationAttemptWithClient(client, {
      operation: 'HISTORY_SCHEMA_INSTALL',
      attemptId: 'fabricated-install-attempt',
    })).rejects.toThrow('MIGRATION_HISTORY_OPERATION_INVALID');
    expect(client.attempts.has('fabricated-install-attempt')).toBe(false);
    await history.createMigrationAttemptWithClient(client, {
      operation: 'APPLY',
      attemptId: 'operation-apply',
    });
    await history.createMigrationAttemptWithClient(client, {
      operation: 'COMPENSATE',
      attemptId: 'operation-compensate',
    });

    await expect(history.appendMigrationAttemptEventWithClient(client, {
      attemptId: 'operation-apply',
      eventType: 'RECOVERY_STARTED',
      reasonCode: 'MIGRATION_RECOVERY_STARTED',
    })).rejects.toThrow('MIGRATION_HISTORY_EVENT_PHASE_INVALID');
    await expect(history.appendMigrationAttemptEventWithClient(client, {
      attemptId: 'operation-apply',
      eventType: 'ATTEMPT_FAILED',
      phase: 'unexpected-phase',
      reasonCode: 'MIGRATION_OPERATION_FAILED',
    })).rejects.toThrow('MIGRATION_HISTORY_EVENT_PHASE_INVALID');
    await expect(history.appendMigrationAttemptEventWithClient(client, {
      attemptId: 'operation-apply',
      eventType: 'PHASE_COMPLETED',
      phase: '01_attempt_history',
      reasonCode: 'MIGRATION_HISTORY_SCHEMA_CREATED',
    })).rejects.toThrow('MIGRATION_HISTORY_EVENT_OPERATION_INVALID');
    await expect(history.appendMigrationAttemptEventWithClient(client, {
      attemptId: 'operation-compensate',
      eventType: 'RECOVERY_STARTED',
      phase: 'complete',
      reasonCode: 'MIGRATION_RECOVERY_STARTED',
    })).rejects.toThrow('MIGRATION_HISTORY_EVENT_OPERATION_INVALID');
    expect([...client.events.values()].filter(
      event => ['operation-apply', 'operation-compensate'].includes(event.attemptId),
    )).toHaveLength(0);
  });

  it('rolls back an event append atomically when persistence fails', async () => {
    const client = fake();
    await history.installMigrationAttemptHistoryWithClient(client);
    await history.createMigrationAttemptWithClient(client, {
      operation: 'APPLY',
      attemptId: 'atomic-attempt',
    });
    const before = client.events.size;
    client.failNextEventInsert = true;
    await expect(history.appendMigrationAttemptEventWithClient(client, {
      attemptId: 'atomic-attempt',
      eventType: 'ATTEMPT_FAILED',
      reasonCode: 'MIGRATION_OPERATION_FAILED',
    })).rejects.toThrow('HISTORY_SECRET');
    expect(client.events.size).toBe(before);
    expect(client.calls.at(-1)?.text).toBe('ROLLBACK');
  });

  it('records successful, equivalent, recovery, refused, and failed apply attempts independently', async () => {
    const successClient = fake();
    await expect(history.applyMigrationWithDurableHistoryWithClient(successClient, {
      attemptId: 'apply-success',
      applyImplementation: async () => ({
        ready: true, applied: true, equivalentRerun: false,
      }),
    })).resolves.toMatchObject({
      ready: true,
      applied: true,
      attemptId: 'apply-success',
      historyAppended: true,
      historySchemaInstalled: true,
      migrationSchemaMutated: true,
      databaseMutated: true,
    });
    expect([...successClient.events.values()].find(
      event => event.attemptId === 'apply-success' && event.eventType === 'ATTEMPT_SUCCEEDED',
    )?.reasonCode).toBe('MIGRATION_APPLY_SUCCEEDED');

    const equivalentClient = fake();
    await history.installMigrationAttemptHistoryWithClient(equivalentClient);
    await history.applyMigrationWithDurableHistoryWithClient(equivalentClient, {
      attemptId: 'apply-equivalent',
      applyImplementation: async () => ({
        ready: true, applied: false, equivalentRerun: true,
      }),
    });
    expect([...equivalentClient.events.values()].find(
      event => event.attemptId === 'apply-equivalent' && event.eventType === 'ATTEMPT_SUCCEEDED',
    )?.reasonCode).toBe('MIGRATION_EQUIVALENT_RERUN_SUCCEEDED');
    await expect(history.applyMigrationWithDurableHistoryWithClient(equivalentClient, {
      attemptId: 'apply-equivalent-reporting',
      applyImplementation: async () => ({
        ready: true, applied: false, equivalentRerun: true,
      }),
    })).resolves.toMatchObject({
      migrationSchemaMutated: false,
      historyAppended: true,
      databaseMutated: true,
    });

    const recoveryClient = fake();
    await history.installMigrationAttemptHistoryWithClient(recoveryClient);
    recoveryClient.canonicalLedger = {
      checksum: main.REVIEWED_MIGRATION_CHECKSUM,
      completedPhase: '02a_action_plan_realm_index',
      validityState: 'FAILED',
      appliedAt: null,
    };
    await expect(history.applyMigrationWithDurableHistoryWithClient(recoveryClient, {
      attemptId: 'apply-recovery',
      applyImplementation: async () => ({
        ready: true,
        applied: false,
        equivalentRerun: true,
        recoveredFinalVerification: true,
      }),
    })).resolves.toMatchObject({
      migrationSchemaMutated: true,
      historyAppended: true,
      databaseMutated: true,
    });
    expect([...recoveryClient.events.values()].filter(
      event => event.attemptId === 'apply-recovery',
    ).map(event => [event.eventType, event.reasonCode])).toEqual([
      ['RECOVERY_STARTED', 'MIGRATION_RECOVERY_STARTED'],
      ['ATTEMPT_SUCCEEDED', 'MIGRATION_RECOVERY_SUCCEEDED'],
    ]);

    const refusedClient = fake();
    await expect(history.applyMigrationWithDurableHistoryWithClient(refusedClient, {
      attemptId: 'apply-refused',
      applyImplementation: async () => {
        throw new main.MigrationError('MIGRATION_ADVISORY_LOCK_UNAVAILABLE');
      },
    })).rejects.toThrow('MIGRATION_ADVISORY_LOCK_UNAVAILABLE');
    expect([...refusedClient.events.values()].find(
      event => event.attemptId === 'apply-refused',
    )).toMatchObject({
      eventType: 'ATTEMPT_REFUSED',
      reasonCode: 'MIGRATION_ADVISORY_LOCK_UNAVAILABLE',
    });

    const failedClient = fake();
    await expect(history.applyMigrationWithDurableHistoryWithClient(failedClient, {
      attemptId: 'apply-failed',
      applyImplementation: async () => {
        throw new Error('credential=HISTORY_SECRET path=C:\\secret SQL=SELECT secret');
      },
    })).rejects.toThrow('HISTORY_SECRET');
    expect([...failedClient.events.values()].find(
      event => event.attemptId === 'apply-failed',
    )).toMatchObject({
      eventType: 'ATTEMPT_FAILED',
      reasonCode: 'MIGRATION_OPERATION_FAILED',
    });
    expect(JSON.stringify([...failedClient.events.values()])).not.toContain('HISTORY_SECRET');

    const frozenClient = fake();
    const frozenError = Object.freeze(new Error('frozen dependency failure'));
    await expect(history.applyMigrationWithDurableHistoryWithClient(frozenClient, {
      attemptId: 'apply-frozen-error',
      applyImplementation: async () => {
        throw frozenError;
      },
    })).rejects.toBe(frozenError);
    expect([...frozenClient.events.values()].find(
      event => event.attemptId === 'apply-frozen-error',
    )).toMatchObject({
      eventType: 'ATTEMPT_FAILED',
      reasonCode: 'MIGRATION_OPERATION_FAILED',
    });
  });

  it('terminally records ledger-read and recovery-event failures after attempt creation', async () => {
    const ledgerClient = fake();
    await history.installMigrationAttemptHistoryWithClient(ledgerClient);
    ledgerClient.canonicalLedger = {
      checksum: main.REVIEWED_MIGRATION_CHECKSUM,
      completedPhase: 'complete',
      validityState: 'VALID',
      appliedAt: new Date('2026-07-18T00:00:00.000Z'),
    };
    ledgerClient.failCanonicalLedgerRead = true;
    const apply = jest.fn(async () => ({
      ready: true, applied: true, equivalentRerun: false,
    }));
    let ledgerError: any;
    try {
      await history.applyMigrationWithDurableHistoryWithClient(ledgerClient, {
        attemptId: 'ledger-read-failure',
        applyImplementation: apply,
      });
    } catch (error) {
      ledgerError = error;
    }
    expect(apply).not.toHaveBeenCalled();
    expect(ledgerError).toBeInstanceOf(Error);
    expect(ledgerError.historyAppended).toBe(true);
    expect([...ledgerClient.events.values()].find(
      event => event.attemptId === 'ledger-read-failure',
    )).toMatchObject({
      eventType: 'ATTEMPT_FAILED',
      reasonCode: 'MIGRATION_OPERATION_FAILED',
    });
    expect(JSON.stringify([...ledgerClient.events.values()])).not.toContain('LEDGER_SECRET');

    const recoveryClient = fake();
    await history.installMigrationAttemptHistoryWithClient(recoveryClient);
    recoveryClient.canonicalLedger = {
      checksum: main.REVIEWED_MIGRATION_CHECKSUM,
      completedPhase: '02a_action_plan_realm_index',
      validityState: 'FAILED',
      appliedAt: null,
    };
    recoveryClient.failNextEventInsert = true;
    let recoveryError: any;
    try {
      await history.applyMigrationWithDurableHistoryWithClient(recoveryClient, {
        attemptId: 'recovery-event-failure',
        applyImplementation: apply,
      });
    } catch (error) {
      recoveryError = error;
    }
    expect(recoveryError).toBeInstanceOf(Error);
    expect(recoveryError.historyAppended).toBe(true);
    expect([...recoveryClient.events.values()].find(
      event => event.attemptId === 'recovery-event-failure',
    )).toMatchObject({
      eventType: 'ATTEMPT_FAILED',
      reasonCode: 'MIGRATION_OPERATION_FAILED',
    });
    expect(JSON.stringify([...recoveryClient.events.values()])).not.toContain('HISTORY_SECRET');
  });

  it('does not append success for malformed apply or compensation result shapes', async () => {
    for (const [name, result] of [
      ['not-ready', { ready: false, applied: true, equivalentRerun: false }],
      ['ambiguous', { ready: true, applied: true, equivalentRerun: true }],
      ['missing-outcome', { ready: true }],
      ['invalid-recovery', {
        ready: true,
        applied: true,
        equivalentRerun: false,
        recoveredFinalVerification: true,
      }],
    ] as const) {
      const client = fake();
      await expect(history.applyMigrationWithDurableHistoryWithClient(client, {
        attemptId: `invalid-apply-${name}`,
        applyImplementation: async () => result,
      })).rejects.toThrow('MIGRATION_RESULT_INVALID');
      expect([...client.events.values()].find(
        event => event.attemptId === `invalid-apply-${name}`,
      )).toMatchObject({
        eventType: 'ATTEMPT_FAILED',
        reasonCode: 'MIGRATION_RESULT_INVALID',
      });
    }

    for (const [name, result] of [
      ['not-ok', { ok: false, compensated: true }],
      ['not-compensated', { ok: true, compensated: false }],
      ['missing', {}],
    ] as const) {
      const client = fake();
      await expect(history.compensateMigrationWithDurableHistoryWithClient(client, {
        attemptId: `invalid-compensation-${name}`,
        compensateImplementation: async () => result,
      })).rejects.toThrow('MIGRATION_COMPENSATION_RESULT_INVALID');
      expect([...client.events.values()].find(
        event => event.attemptId === `invalid-compensation-${name}`,
      )).toMatchObject({
        eventType: 'ATTEMPT_FAILED',
        reasonCode: 'MIGRATION_COMPENSATION_RESULT_INVALID',
      });
    }
  });

  it('makes the history bootstrap limitation explicit when the advisory lock is unavailable', async () => {
    const client = fake();
    client.lockAvailable = false;
    await expect(history.installMigrationAttemptHistoryWithClient(client))
      .rejects.toThrow('MIGRATION_ADVISORY_LOCK_UNAVAILABLE');
    expect(client.tables).toEqual({ attempt: false, event: false });
    expect(client.attempts.size).toBe(0);
    expect(client.events.size).toBe(0);
  });

  it('does not mutate the database when canonical artifact validation fails before bootstrap', async () => {
    const client = fake();
    const canonical = main.loadMigrationManifest();
    await expect(history.applyMigrationWithDurableHistoryWithClient(client, {
      manifest: { ...canonical, checksum: 'f'.repeat(64) },
      applyImplementation: async () => {
        throw new Error('apply must not run');
      },
    })).rejects.toThrow('MIGRATION_ARTIFACT_VALIDATION_FAILED');
    expect(client.calls).toHaveLength(0);
    expect(client.tables).toEqual({ attempt: false, event: false });
    expect(client.attempts.size).toBe(0);

    const installed = fake();
    await history.installMigrationAttemptHistoryWithClient(installed);
    const callsBeforeRefusal = installed.calls.length;
    const attemptsBeforeRefusal = installed.attempts.size;
    await expect(history.applyMigrationWithDurableHistoryWithClient(installed, {
      manifest: { ...canonical, checksum: 'e'.repeat(64) },
    })).rejects.toThrow('MIGRATION_ARTIFACT_VALIDATION_FAILED');
    expect(installed.calls).toHaveLength(callsBeforeRefusal);
    expect(installed.attempts.size).toBe(attemptsBeforeRefusal);
  });

  it('keeps durable history after protocol compensation and wires real operational apply paths', async () => {
    const client = fake();
    await history.compensateMigrationWithDurableHistoryWithClient(client, {
      attemptId: 'compensate-success',
      compensateImplementation: async () => ({
        ok: true, compensated: true, databaseMutated: true,
      }),
    });
    expect(client.tables).toEqual({ attempt: true, event: true });
    expect(client.attempts.get('compensate-success')?.operation).toBe('COMPENSATE');
    expect([...client.events.values()].find(
      event => event.attemptId === 'compensate-success',
    )).toMatchObject({
      eventType: 'ATTEMPT_SUCCEEDED',
      reasonCode: 'MIGRATION_COMPENSATION_SUCCEEDED',
    });

    const migrationSource = readFileSync(migrationScriptPath, 'utf8');
    const validatorSource = readFileSync(
      join(repositoryRoot, 'scripts', 'phase2e-migration-validator.mjs'),
      'utf8',
    );
    expect(migrationSource).toContain('applyMigrationWithDurableHistoryWithClient(client)');
    expect(migrationSource).toContain('compensateMigrationWithDurableHistoryWithClient(client)');
    expect(validatorSource).toContain('applyMigrationWithDurableHistoryWithClient(client)');
    expect(validatorSource).toContain('verifyMigrationAttemptHistoryWithClient(client)');

    const compensationSql = readFileSync(
      join(
        repositoryRoot,
        'migrations',
        '20260717_action_plan_execution_v2',
        'compensate_local_ephemeral.sql',
      ),
      'utf8',
    );
    expect(compensationSql).not.toContain('ActionPlanExecutionSchemaMigrationAttempt');
    for (const dockerfile of [
      'Dockerfile.phase2e-validator',
      'Dockerfile.phase2e-postgres18-integration',
    ]) {
      const source = readFileSync(join(repositoryRoot, dockerfile), 'utf8');
      expect(source).toContain('scripts/action-plan-execution-migration-history.mjs');
      expect(source).toContain('20260718_action_plan_execution_migration_history_v1');
    }
    const prisma = readFileSync(join(repositoryRoot, 'prisma', 'schema.prisma'), 'utf8');
    expect(prisma).toContain('model ActionPlanExecutionSchemaMigrationAttempt {');
    expect(prisma).toContain('model ActionPlanExecutionSchemaMigrationAttemptEvent {');
    expect(prisma).toContain('onDelete: Restrict, onUpdate: Restrict');
  });
});
