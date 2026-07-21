import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  ACTION_PLAN_EXECUTION_PROTOCOL_VERSION,
  ACTION_PLAN_EXECUTION_SCHEMA_CHECKSUM,
  ACTION_PLAN_EXECUTION_SCHEMA_LABEL,
  ACTION_PLAN_EXECUTION_SCHEMA_REQUIREMENTS,
  ACTION_PLAN_EXECUTION_SCHEMA_VERSION,
  ACTION_PLAN_EXECUTION_SNAPSHOT_SCHEMA_VERSION,
  parseCatalogStringArray,
  verifyActionPlanExecutionSchema
} from '../src/core/db/actionPlanExecutionSchema.js';
import { TABLE_DEFINITIONS } from '../src/core/db/schema.js';

const migrationScriptPath = join(process.cwd(), 'scripts', 'action-plan-execution-migration.mjs');
const migrationDirectory = join(
  process.cwd(),
  'migrations',
  '20260717_action_plan_execution_v2'
);
const manifestPath = join(migrationDirectory, 'manifest.json');

interface MigrationModule {
  ACTION_PLAN_EXECUTION_SCHEMA_REQUIREMENTS: {
    tables: string[];
    columns: Record<string, string[]>;
    columnSpecs: Record<string, Record<string, {
      type: string;
      nullable: boolean;
      defaultKind: string;
    }>>;
    constraints: string[];
    constraintSpecs: Record<string, {
      table: string;
      type: string;
      requiredFragments: string[];
      deferrable: boolean;
      initiallyDeferred: boolean;
    }>;
    checkColumnSets: Record<string, string[]>;
    relationalConstraintSpecs: Record<string, {
      columns: string[];
      referencedTable?: string;
      referencedColumns?: string[];
      updateAction?: string;
      deleteAction?: string;
    }>;
    indexes: string[];
    indexSpecs: Record<string, {
      table: string;
      unique: boolean;
      columns: string[];
      predicateStates: string[];
    }>;
  };
  applyMigrationWithClient: (client: FakeMigrationClient) => Promise<{
    ready: boolean;
    applied: boolean;
    equivalentRerun: boolean;
    recoveredFinalVerification?: boolean;
  }>;
  assertLocalEphemeralConnectionString: (value: string) => {
    hostname: string;
    databaseName: string;
  };
  calculateMigrationChecksum: () => string;
  checkDefinitionHash: (value: string) => string;
  compensateMigrationWithClient: (client: FakeMigrationClient) => Promise<{
    ok: boolean;
    compensated: boolean;
  }>;
  inspectMigrationDrainStateWithClient: (client: {
    query: (text: string, values?: unknown[]) => Promise<{
      rows: Array<Record<string, unknown>>;
      rowCount: number;
    }>;
  }) => Promise<{
    canDisableAssignment: boolean;
    canRevertApplication: boolean;
    canCompensateEmptySchema: boolean;
    counts: Record<string, number>;
  }>;
  loadMigrationManifest: () => {
    version: string;
    checksum: string;
    phases: Array<{ id: string; transactional: boolean; concurrentIndex?: string }>;
  };
  parseCatalogJsonTextArray: (value: unknown) => string[] | null;
  loadReviewedCheckDefinitions: () => Map<string, string>;
  validateMigrationArtifacts: () => {
    ok: boolean;
    checksum: string;
    issues: string[];
    databaseConnected: boolean;
    databaseMutated: boolean;
  };
  verifyActionPlanExecutionSchemaWithClient: (
    client: FakeMigrationClient,
    manifest?: ReturnType<MigrationModule['loadMigrationManifest']>,
    options?: { ignoreLedgerCompletion?: boolean }
  ) => Promise<{ ready: boolean; issues: string[] }>;
}

let reviewedCheckDefinitions = new Map<string, string>();

async function loadMigrationModule(): Promise<MigrationModule> {
  const migration = await import(pathToFileURL(migrationScriptPath).href) as MigrationModule;
  reviewedCheckDefinitions = migration.loadReviewedCheckDefinitions();
  return migration;
}

class FakeMigrationClient {
  readonly calls: Array<{ text: string; values: unknown[] }> = [];
  readonly indexes = new Map<string, { valid: boolean; ready: boolean }>();
  readonly columnOverrides = new Map<string, Partial<Record<string, unknown>>>();
  readonly constraintOverrides = new Map<string, Partial<Record<string, unknown>>>();
  readonly indexOverrides = new Map<string, Partial<Record<string, unknown>>>();
  ledgerExists = false;
  lockAvailable = true;
  unlockSucceeds = true;
  failOnSql: string | null = null;
  failWith = 'MIGRATION_TEST_PRIMARY_FAILURE';
  invalidateSchemaWhenLedgerValid = false;
  private transactionLedger: FakeMigrationClient['ledger'] | undefined;
  ledger: {
    checksum: string;
    completedPhase: string;
    validityState: string;
    appliedAt: Date | null;
  } | null = null;

  constructor(private readonly requirements: MigrationModule['ACTION_PLAN_EXECUTION_SCHEMA_REQUIREMENTS']) {}

  private columnRow(table_name: string, column_name: string): Record<string, unknown> {
    const spec = this.requirements.columnSpecs[table_name][column_name];
    const defaults: Record<string, string | null> = {
      none: null,
      current_timestamp: 'CURRENT_TIMESTAMP',
      zero: '0',
      empty_json_object: "'{}'::jsonb"
    };
    return {
      table_name,
      column_name,
      udt_name: spec.type,
      is_nullable: spec.nullable ? 'YES' : 'NO',
      column_default: defaults[spec.defaultKind],
      ...this.columnOverrides.get(`${table_name}.${column_name}`)
    };
  }

  private constraintRow(name: string): Record<string, unknown> {
    const spec = this.requirements.constraintSpecs[name];
    const relational = this.requirements.relationalConstraintSpecs[name];
    return {
      name,
      table_name: spec.table,
      type: spec.type,
      validated: true,
      deferrable: spec.deferrable,
      initially_deferred: spec.initiallyDeferred,
      definition: spec.type === 'c'
        ? reviewedCheckDefinitions.get(name)
        : spec.requiredFragments.join(' AND '),
      columns_json: JSON.stringify(
        spec.type === 'c' ? this.requirements.checkColumnSets[name] : relational?.columns ?? []
      ),
      referenced_table_name: relational?.referencedTable ?? null,
      referenced_schema_matches: relational?.referencedTable ? true : null,
      referenced_columns_json: JSON.stringify(relational?.referencedColumns ?? []),
      update_action: relational?.updateAction ?? ' ',
      delete_action: relational?.deleteAction ?? ' ',
      ...this.constraintOverrides.get(name)
    };
  }

  private indexRow(name: string): Record<string, unknown> {
    const spec = this.requirements.indexSpecs[name];
    const stored = this.indexes.get(name);
    return {
      name,
      table_name: spec.table,
      unique: spec.unique,
      valid: stored?.valid ?? true,
      ready: stored?.ready ?? true,
      schema_matches: true,
      key_count: spec.columns.length,
      attribute_count: spec.columns.length,
      expressions_absent: true,
      sort_options_default: true,
      opclasses_default: true,
      collations_default: true,
      access_method: 'btree',
      columns_json: JSON.stringify(spec.columns),
      predicate: spec.predicateStates.length > 0
        ? `"state" IN (${spec.predicateStates.map(state => `'${state}'`).join(', ')})`
        : null,
      ...this.indexOverrides.get(name)
    };
  }

  async query(text: string, values: unknown[] = []): Promise<{
    rows: Array<Record<string, unknown>>;
    rowCount: number;
  }> {
    this.calls.push({ text, values });

    if (text === 'BEGIN') {
      this.transactionLedger = this.ledger ? { ...this.ledger } : this.ledger;
      return { rows: [], rowCount: 0 };
    }
    if (text === 'COMMIT') {
      this.transactionLedger = undefined;
      return { rows: [], rowCount: 0 };
    }
    if (text === 'ROLLBACK') {
      if (this.transactionLedger !== undefined) {
        this.ledger = this.transactionLedger ? { ...this.transactionLedger } : null;
      }
      this.transactionLedger = undefined;
      return { rows: [], rowCount: 0 };
    }

    if (text.includes('pg_try_advisory_lock')) {
      return { rows: [{ locked: this.lockAvailable }], rowCount: 1 };
    }
    if (text.includes('pg_advisory_unlock')) {
      return { rows: [{ unlocked: this.unlockSucceeds }], rowCount: 1 };
    }
    if (this.failOnSql && text.includes(this.failOnSql)) {
      throw new Error(this.failWith);
    }
    if (text.includes('to_regclass($1::text)')) {
      return { rows: [{ exists: this.ledgerExists }], rowCount: 1 };
    }
    if (text.includes('FROM "ActionPlanExecutionSchemaMigration"') && text.includes('WHERE "version"')) {
      return { rows: this.ledger ? [{ ...this.ledger }] : [], rowCount: this.ledger ? 1 : 0 };
    }
    if (text.includes('INSERT INTO "ActionPlanExecutionSchemaMigration"')) {
      this.ledgerExists = true;
      this.ledger = {
        checksum: String(values[1]),
        completedPhase: String(values[2]),
        validityState: String(values[3]),
        appliedAt: values[3] === 'FAILED'
          ? null
          : values[4] === true
            ? new Date('2026-07-17T00:00:00.000Z')
            : this.ledger?.appliedAt ?? null
      };
      return { rows: [{ version: String(values[0]) }], rowCount: 1 };
    }
    if (text.includes('CREATE TABLE IF NOT EXISTS "ActionPlanExecutionSchemaMigration"')) {
      this.ledgerExists = true;
      return { rows: [], rowCount: 0 };
    }
    if (text.includes('index_relation.relname = $1')) {
      const name = String(values[0]);
      const index = this.indexes.get(name);
      return {
        rows: index ? [this.indexRow(name)] : [],
        rowCount: index ? 1 : 0
      };
    }
    if (text.includes('CREATE UNIQUE INDEX CONCURRENTLY')) {
      const match = text.match(/CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "([^"]+)"/);
      if (match) this.indexes.set(match[1], { valid: true, ready: true });
      return { rows: [], rowCount: 0 };
    }
    if (text.includes('REINDEX INDEX CONCURRENTLY')) {
      const match = text.match(/REINDEX INDEX CONCURRENTLY "([^"]+)"/);
      if (match) this.indexes.set(match[1], { valid: true, ready: true });
      return { rows: [], rowCount: 0 };
    }
    if (text.includes('FROM information_schema.tables')) {
      return {
        rows: this.requirements.tables.map(table_name => ({ table_name })),
        rowCount: this.requirements.tables.length
      };
    }
    if (text.includes('FROM information_schema.columns')) {
      const rows = Object.entries(this.requirements.columns).flatMap(([table_name, columns]) =>
        columns.map(column_name => this.columnRow(table_name, column_name))
      );
      if (this.invalidateSchemaWhenLedgerValid && this.ledger?.validityState === 'VALID') {
        const target = rows.find(row =>
          row.table_name === 'ActionPlanExecutionRun' && row.column_name === 'eventSequence'
        );
        if (target) target.udt_name = 'int4';
      }
      return { rows, rowCount: rows.length };
    }
    if (text.includes('FROM pg_constraint')) {
      const rows = this.requirements.constraints.map(name => this.constraintRow(name));
      return {
        rows,
        rowCount: rows.length
      };
    }
    if (text.includes('index_relation.relname = ANY')) {
      const rows = this.requirements.indexes.map(name => this.indexRow(name));
      return {
        rows,
        rowCount: rows.length
      };
    }
    return { rows: [], rowCount: 0 };
  }
}

describe('Phase 2E additive execution schema', () => {
  it('binds the reviewed SQL files to a deterministic checksum and version mapping', async () => {
    const migration = await loadMigrationModule();
    const manifest = migration.loadMigrationManifest();
    const validation = migration.validateMigrationArtifacts();

    expect(validation).toMatchObject({
      ok: true,
      checksum: ACTION_PLAN_EXECUTION_SCHEMA_CHECKSUM,
      issues: [],
      databaseConnected: false,
      databaseMutated: false
    });
    expect(migration.calculateMigrationChecksum()).toBe(manifest.checksum);
    expect(manifest.version).toBe(ACTION_PLAN_EXECUTION_SCHEMA_VERSION);
    expect(migration.ACTION_PLAN_EXECUTION_SCHEMA_REQUIREMENTS).toEqual(
      ACTION_PLAN_EXECUTION_SCHEMA_REQUIREMENTS
    );
    expect(ACTION_PLAN_EXECUTION_SCHEMA_LABEL).toBe('action-plan-execution-v1');
    expect(ACTION_PLAN_EXECUTION_PROTOCOL_VERSION).toBe(2);
    expect(ACTION_PLAN_EXECUTION_SNAPSHOT_SCHEMA_VERSION).toBe(1);
  });

  it('accepts decoded string arrays or strict JSON text arrays from catalog queries', async () => {
    const migration = await loadMigrationModule();

    expect(migration.parseCatalogJsonTextArray(['MixedCase', 'comma,value']))
      .toEqual(['MixedCase', 'comma,value']);
    expect(migration.parseCatalogJsonTextArray('["MixedCase","comma,value","quote\\\"value","slash\\\\value"]'))
      .toEqual(['MixedCase', 'comma,value', 'quote"value', 'slash\\value']);
    expect(migration.parseCatalogJsonTextArray('[]')).toEqual([]);
    for (const malformed of [
      null,
      ['id', null],
      ['id', 1],
      '"id"',
      '["id",null]',
      '["id",1]',
      '["id"',
    ]) {
      expect(migration.parseCatalogJsonTextArray(malformed)).toBeNull();
    }
  });

  it('accepts strict flat PostgreSQL text-array literals through the pg array parser', async () => {
    const migration = await loadMigrationModule();
    const longIdentifier = `LongIdentifier${'x'.repeat(512)}`;
    const literal = String.raw`{"comma,value","quote\"value","slash\\value",MixedCase,"${longIdentifier}"}`;

    expect(migration.parseCatalogJsonTextArray('{}')).toEqual([]);
    expect(migration.parseCatalogJsonTextArray('{id,planId}')).toEqual(['id', 'planId']);
    expect(migration.parseCatalogJsonTextArray(literal)).toEqual([
      'comma,value',
      'quote"value',
      'slash\\value',
      'MixedCase',
      longIdentifier,
    ]);
  });

  it('fails closed for malformed, bounded, nested, null, mixed, or empty PostgreSQL arrays', async () => {
    const migration = await loadMigrationModule();
    for (const malformed of [
      '[1:2]={id,planId}',
      '{{id},{planId}}',
      '{id,{planId}}',
      '{NULL}',
      '{null}',
      '{NuLl}',
      '{id,NULL}',
      '{id,"value",NULL}',
      '{id, planId}',
      '{id ,planId}',
      '{id,plan Id}',
      String.raw`{id,plan\Id}`,
      String.raw`{\id,planId}`,
      '{,id}',
      '{id,}',
      '{id,,planId}',
      String.raw`{"unterminated}`,
      String.raw`{"unterminated\"}`,
      String.raw`{unterminated\}`,
      '{"id"suffix}',
      '{id"suffix"}',
      ' {id}',
      '{id} ',
    ]) {
      expect(migration.parseCatalogJsonTextArray(malformed)).toBeNull();
    }
  });

  it('matches the runtime parser for accepted and rejected PostgreSQL array literals', async () => {
    const migration = await loadMigrationModule();
    const inputs: unknown[] = [
      [],
      ['MixedCase', 'comma,value'],
      '[]',
      '["MixedCase","comma,value"]',
      '{}',
      '{id,planId}',
      String.raw`{"comma,value","quote\"value","slash\\value",MixedCase}`,
      '[1:2]={id,planId}',
      '{{id},{planId}}',
      '{NULL}',
      '{null}',
      '{id, planId}',
      '{id ,planId}',
      String.raw`{id,plan\Id}`,
      String.raw`{\id,planId}`,
      '{,id}',
      '{id,}',
      String.raw`{"unterminated}`,
      String.raw`{unterminated\}`,
    ];

    for (const input of inputs) {
      expect(migration.parseCatalogJsonTextArray(input)).toEqual(parseCatalogStringArray(input));
    }
  });

  it('canonicalizes PostgreSQL 18 expanded BETWEEN checks without weakening boolean structure', async () => {
    const migration = await loadMigrationModule();
    const reviewed = 'CHECK (char_length("version") BETWEEN 1 AND 64)';
    const postgresql18 = 'CHECK ((char_length(version) >= 1) AND (char_length(version) <= 64))';
    const weakened = 'CHECK ((char_length(version) >= 1) OR (char_length(version) <= 64))';

    expect(migration.checkDefinitionHash(postgresql18)).toBe(
      migration.checkDefinitionHash(reviewed)
    );
    expect(migration.checkDefinitionHash(weakened)).not.toBe(
      migration.checkDefinitionHash(reviewed)
    );
  });

  it('preserves literal bytes and mixed-case quoted identifiers during CHECK canonicalization', async () => {
    const migration = await loadMigrationModule();

    expect(migration.checkDefinitionHash('CHECK ("state" = \'REQUESTED\')')).toBe(
      migration.checkDefinitionHash('CHECK (state=\'REQUESTED\'::text)')
    );
    for (const [reviewed, mutation] of [
      ['CHECK ("state" = \'REQUESTED\')', 'CHECK ("state" = \'requested\')'],
      ['CHECK ("executorKind" = \'python-daemon\')', 'CHECK ("executorKind" = \'Python-daemon\')'],
      ['CHECK ("executionRealm" IS NOT NULL)', 'CHECK ("executionrealm" IS NOT NULL)'],
      ['CHECK ("value" = \'it\'\'s\')', 'CHECK ("value" = \'its\')'],
      ['CHECK ("value" = \'comma,value\')', 'CHECK ("value" = \'comma, value\')'],
      ['CHECK ("value" = \'with space\')', 'CHECK ("value" = \'with  space\')'],
      ['CHECK ("value" = \'literal::text\')', 'CHECK ("value" = \'literal\'::text)']
    ]) {
      expect(migration.checkDefinitionHash(mutation)).not.toBe(
        migration.checkDefinitionHash(reviewed)
      );
    }

    const reviewedDefinitions = migration.loadReviewedCheckDefinitions();
    for (const [name, from, to] of [
      ['ck_ap_exec_run_snapshot_shape', '::NUMERIC', '::INTEGER'],
      ['ck_ap_exec_run_result_bounds', '"resultOutput"::TEXT', '"resultOutput"::VARCHAR'],
    ]) {
      const reviewed = reviewedDefinitions.get(name);
      expect(reviewed).toBeDefined();
      const mutation = reviewed!.replace(from, to);
      expect(mutation).not.toBe(reviewed);
      expect(migration.checkDefinitionHash(mutation)).not.toBe(
        migration.checkDefinitionHash(reviewed),
      );
    }
  });

  it('keeps Phase 2E DDL out of ordinary runtime table initialization', () => {
    const runtimeBootstrapSql = TABLE_DEFINITIONS.join('\n');

    expect(runtimeBootstrapSql).not.toContain('ActionPlanExecutionSchemaMigration');
    expect(runtimeBootstrapSql).not.toContain('ActionPlanExecutionCommand');
    expect(runtimeBootstrapSql).not.toContain('ActionPlanExecutionRun');
    expect(runtimeBootstrapSql).not.toContain('ActionPlanExecutionEvent');
  });

  it('keeps the forward phases additive and isolates destructive compensation', () => {
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
      phases: Array<{ path: string }>;
      compensationPath: string;
    };
    const forwardSql = manifest.phases
      .map(phase => readFileSync(join(migrationDirectory, phase.path), 'utf8'))
      .join('\n');
    const compensationSql = readFileSync(
      join(migrationDirectory, manifest.compensationPath),
      'utf8'
    );

    expect(forwardSql).not.toMatch(/(?:^|;)\s*(?:DROP\b|TRUNCATE\b|DELETE\s+FROM\b)/im);
    expect(forwardSql).not.toContain('UPDATE "ActionPlan"');
    expect(forwardSql).not.toContain('INSERT INTO "ActionPlan"');
    expect(forwardSql).toMatch(
      /"resultIdempotencyKeyHash" IS NULL[\s\S]*?"resultOutput" IS NULL[\s\S]*?"resultError" IS NULL[\s\S]*?"completedAt" IS NULL/u
    );
    expect(forwardSql).toContain('CONSTRAINT "ck_ap_exec_run_snapshot_shape" CHECK');
    expect(forwardSql).toContain('"actionSnapshot"->>\'snapshot_version\' = \'action-execution-snapshot-v1\'');
    expect(forwardSql).toContain('"actionSnapshot" ? \'params\'');
    expect(forwardSql).toContain('"actionSnapshot"->>\'agent_capability_fingerprint\' ~ \'^[0-9a-f]{64}$\'');
    const stateCoherence = forwardSql.match(
      /CONSTRAINT "ck_ap_exec_run_state_coherence" CHECK \(([\s\S]*?)\r?\n  \),\r?\n  CONSTRAINT "uq_ap_exec_run_command_action"/u
    )?.[1] ?? '';
    for (const state of ['REQUESTED', 'CLAIMED', 'RUNNING']) {
      const branch = stateCoherence.match(
        new RegExp(`"state" = '${state}'([\\s\\S]*?)\\r?\\n    \\)\\r?\\n    OR`, 'u')
      )?.[1] ?? '';
      for (const field of [
        'resultIdempotencyKeyHash',
        'resultFingerprint',
        'acceptanceReceipt',
        'resultOutput',
        'resultError',
        'completedAt',
        'terminalCategory'
      ]) {
        expect(branch).toContain(`"${field}" IS NULL`);
      }
    }
    expect(compensationSql).toContain('LOCAL-EPHEMERAL COMPENSATING ROLLBACK ONLY');
    expect(compensationSql).toContain('phase2e_compensation_requires_empty_protocol_tables');
    expect(compensationSql).toContain('phase2e_compensation_requires_unpopulated_provenance');
  });

  it('rejects non-loopback and non-explicitly-ephemeral database targets', async () => {
    const migration = await loadMigrationModule();

    expect(() => migration.assertLocalEphemeralConnectionString(
      'postgresql://user:sentinel@db.example.test:5432/arcanos_phase2e_test'
    )).toThrow('MIGRATION_DATABASE_NOT_LOOPBACK');
    expect(() => migration.assertLocalEphemeralConnectionString(
      'postgresql://user:sentinel@127.0.0.1:5432/arcanos'
    )).toThrow('MIGRATION_DATABASE_NOT_EXPLICIT_EPHEMERAL');
    expect(migration.assertLocalEphemeralConnectionString(
      'postgresql://user:sentinel@127.0.0.1:5432/arcanos_phase2e_test'
    )).toEqual({ hostname: 'loopback', databaseName: 'arcanos_phase2e_test' });
  });

  it('rejects connection options that could override the validated local target', async () => {
    const migration = await loadMigrationModule();
    const base = 'postgresql://user:sentinel@127.0.0.1:5432/arcanos_phase2e_test';

    for (const suffix of [
      '?host=db.example.test',
      '?hostaddr=203.0.113.10',
      '?port=6543',
      '?socket=%2Fvar%2Frun%2Fpostgresql',
      '?sslmode=disable',
      '#connection-options',
    ]) {
      expect(() => migration.assertLocalEphemeralConnectionString(`${base}${suffix}`))
        .toThrow('MIGRATION_DATABASE_OPTIONS_FORBIDDEN');
    }
  });

  it('fails closed before opening a connection without both local confirmation and the dedicated env', () => {
    const env = { ...process.env };
    delete env.ACTION_PLAN_EXECUTION_MIGRATION_DATABASE_URL;

    const withoutConfirmation = spawnSync(process.execPath, [migrationScriptPath, '--apply'], {
      cwd: process.cwd(),
      encoding: 'utf8',
      env
    });
    const withoutEnvironment = spawnSync(
      process.execPath,
      [migrationScriptPath, '--apply', '--confirm-local-ephemeral'],
      { cwd: process.cwd(), encoding: 'utf8', env }
    );

    expect(JSON.parse(withoutConfirmation.stdout)).toEqual({
      ok: false,
      code: 'MIGRATION_LOCAL_CONFIRMATION_REQUIRED',
      databaseMutated: false
    });
    expect(JSON.parse(withoutEnvironment.stdout)).toEqual({
      ok: false,
      code: 'MIGRATION_DATABASE_ENV_MISSING',
      databaseMutated: false
    });
    expect(`${withoutConfirmation.stdout}${withoutEnvironment.stdout}`).not.toContain('sentinel');
  });

  it('holds one advisory lock across phased application and makes a matching rerun read-only', async () => {
    const migration = await loadMigrationModule();
    const client = new FakeMigrationClient(migration.ACTION_PLAN_EXECUTION_SCHEMA_REQUIREMENTS);

    const first = await migration.applyMigrationWithClient(client);
    const mutationCallsAfterFirst = client.calls.length;
    const second = await migration.applyMigrationWithClient(client);

    expect(first).toMatchObject({ ready: true, applied: true, equivalentRerun: false });
    expect(second).toMatchObject({ ready: true, applied: false, equivalentRerun: true });
    expect(client.ledger).toMatchObject({
      checksum: ACTION_PLAN_EXECUTION_SCHEMA_CHECKSUM,
      completedPhase: 'complete',
      validityState: 'VALID'
    });
    expect(client.calls.filter(call => call.text.includes('pg_try_advisory_lock'))).toHaveLength(2);
    expect(client.calls.filter(call => call.text.includes('pg_advisory_unlock'))).toHaveLength(2);
    expect(client.calls.slice(mutationCallsAfterFirst).some(call =>
      call.text.includes('CREATE TABLE') || call.text.includes('CREATE UNIQUE INDEX')
    )).toBe(false);
  });

  it('recovers a fully applied FAILED ledger only after exact schema verification', async () => {
    const migration = await loadMigrationModule();
    const manifest = migration.loadMigrationManifest();
    const client = new FakeMigrationClient(migration.ACTION_PLAN_EXECUTION_SCHEMA_REQUIREMENTS);
    client.ledgerExists = true;
    client.ledger = {
      checksum: manifest.checksum,
      completedPhase: 'complete',
      validityState: 'FAILED',
      appliedAt: null
    };

    await expect(migration.applyMigrationWithClient(client)).resolves.toMatchObject({
      ready: true,
      applied: false,
      equivalentRerun: true,
      recoveredFinalVerification: true
    });
    expect(client.ledger).toMatchObject({
      completedPhase: 'complete',
      validityState: 'VALID'
    });
    expect(client.ledger?.appliedAt).toBeInstanceOf(Date);
    expect(client.calls.some(call =>
      call.text.includes('CREATE TABLE')
      || call.text.includes('ALTER TABLE')
      || call.text.includes('CREATE UNIQUE INDEX')
      || call.text.includes('REINDEX INDEX')
    )).toBe(false);
  });

  it('does not recover a complete FAILED ledger when exact schema verification fails', async () => {
    const migration = await loadMigrationModule();
    const manifest = migration.loadMigrationManifest();
    const client = new FakeMigrationClient(migration.ACTION_PLAN_EXECUTION_SCHEMA_REQUIREMENTS);
    client.ledgerExists = true;
    client.ledger = {
      checksum: manifest.checksum,
      completedPhase: 'complete',
      validityState: 'FAILED',
      appliedAt: null
    };
    client.columnOverrides.set('ActionPlanExecutionRun.eventSequence', { udt_name: 'int4' });

    await expect(migration.applyMigrationWithClient(client)).rejects.toThrow(
      'MIGRATION_SCHEMA_VERIFICATION_FAILED'
    );
    expect(client.ledger).toMatchObject({
      completedPhase: 'complete',
      validityState: 'FAILED',
      appliedAt: null
    });
    expect(client.calls.some(call =>
      call.text.includes('CREATE TABLE')
      || call.text.includes('ALTER TABLE')
      || call.text.includes('CREATE UNIQUE INDEX')
      || call.text.includes('REINDEX INDEX')
    )).toBe(false);
  });

  it('recovers a first-apply verification failure without replaying DDL', async () => {
    const migration = await loadMigrationModule();
    const client = new FakeMigrationClient(migration.ACTION_PLAN_EXECUTION_SCHEMA_REQUIREMENTS);
    client.columnOverrides.set('ActionPlanExecutionRun.eventSequence', { udt_name: 'int4' });

    await expect(migration.applyMigrationWithClient(client)).rejects.toThrow(
      'MIGRATION_SCHEMA_VERIFICATION_FAILED'
    );
    expect(client.ledger).toMatchObject({
      completedPhase: 'complete',
      validityState: 'FAILED',
      appliedAt: null
    });

    client.columnOverrides.clear();
    const callsBeforeRecovery = client.calls.length;
    await expect(migration.applyMigrationWithClient(client)).resolves.toMatchObject({
      ready: true,
      applied: false,
      equivalentRerun: true,
      recoveredFinalVerification: true
    });
    expect(client.ledger).toMatchObject({
      completedPhase: 'complete',
      validityState: 'VALID'
    });
    expect(client.ledger?.appliedAt).toBeInstanceOf(Date);
    expect(client.calls.slice(callsBeforeRecovery).some(call =>
      call.text.includes('CREATE TABLE')
      || call.text.includes('ALTER TABLE')
      || call.text.includes('CREATE UNIQUE INDEX')
      || call.text.includes('REINDEX INDEX')
    )).toBe(false);
  });

  it('rolls back provisional appliedAt when final ledger verification fails', async () => {
    const migration = await loadMigrationModule();
    const client = new FakeMigrationClient(migration.ACTION_PLAN_EXECUTION_SCHEMA_REQUIREMENTS);
    client.invalidateSchemaWhenLedgerValid = true;

    await expect(migration.applyMigrationWithClient(client)).rejects.toThrow(
      'MIGRATION_SCHEMA_VERIFICATION_FAILED'
    );
    expect(client.ledger).toMatchObject({
      completedPhase: 'complete',
      validityState: 'FAILED',
      appliedAt: null
    });
    expect(client.calls.some(call => call.text === 'ROLLBACK')).toBe(true);
  });

  it('resumes the exact allowlisted concurrent-index phase after a recovery crash', async () => {
    const migration = await loadMigrationModule();
    const manifest = migration.loadMigrationManifest();
    const recoveringPhase = manifest.phases.find(phase => phase.concurrentIndex);
    expect(recoveringPhase).toBeDefined();
    const client = new FakeMigrationClient(migration.ACTION_PLAN_EXECUTION_SCHEMA_REQUIREMENTS);
    client.ledgerExists = true;
    client.ledger = {
      checksum: manifest.checksum,
      completedPhase: recoveringPhase!.id,
      validityState: 'RECOVERING_INVALID_INDEX',
      appliedAt: null
    };
    client.indexes.set(recoveringPhase!.concurrentIndex!, { valid: false, ready: false });

    await expect(migration.applyMigrationWithClient(client)).resolves.toMatchObject({
      ready: true,
      applied: true
    });
    expect(client.calls.some(call =>
      call.text === `REINDEX INDEX CONCURRENTLY "${recoveringPhase!.concurrentIndex}"`
    )).toBe(true);
  });

  it('preserves concurrent-index recovery state across a repeated repair failure', async () => {
    const migration = await loadMigrationModule();
    const manifest = migration.loadMigrationManifest();
    const recoveringPhase = manifest.phases.find(phase => phase.concurrentIndex);
    expect(recoveringPhase).toBeDefined();
    const client = new FakeMigrationClient(migration.ACTION_PLAN_EXECUTION_SCHEMA_REQUIREMENTS);
    client.ledgerExists = true;
    client.ledger = {
      checksum: manifest.checksum,
      completedPhase: recoveringPhase!.id,
      validityState: 'RECOVERING_INVALID_INDEX',
      appliedAt: null
    };
    client.indexes.set(recoveringPhase!.concurrentIndex!, { valid: false, ready: false });
    client.failOnSql = `REINDEX INDEX CONCURRENTLY "${recoveringPhase!.concurrentIndex}"`;

    await expect(migration.applyMigrationWithClient(client)).rejects.toThrow(
      'MIGRATION_TEST_PRIMARY_FAILURE'
    );
    expect(client.ledger).toEqual({
      checksum: manifest.checksum,
      completedPhase: recoveringPhase!.id,
      validityState: 'RECOVERING_INVALID_INDEX',
      appliedAt: null
    });

    client.failOnSql = null;
    const callsBeforeRetry = client.calls.length;
    await expect(migration.applyMigrationWithClient(client)).resolves.toMatchObject({
      ready: true,
      applied: true
    });
    expect(client.calls.slice(callsBeforeRetry).some(call =>
      call.text === `REINDEX INDEX CONCURRENTLY "${recoveringPhase!.concurrentIndex}"`
    )).toBe(true);
    expect(client.ledger).toMatchObject({
      completedPhase: 'complete',
      validityState: 'VALID'
    });
  });

  it('rejects RECOVERING_INVALID_INDEX on a transactional phase without mutation', async () => {
    const migration = await loadMigrationModule();
    const manifest = migration.loadMigrationManifest();
    const transactionalPhase = manifest.phases.find(phase => phase.transactional);
    expect(transactionalPhase).toBeDefined();
    const client = new FakeMigrationClient(migration.ACTION_PLAN_EXECUTION_SCHEMA_REQUIREMENTS);
    client.ledgerExists = true;
    client.ledger = {
      checksum: manifest.checksum,
      completedPhase: transactionalPhase!.id,
      validityState: 'RECOVERING_INVALID_INDEX',
      appliedAt: null
    };

    await expect(migration.applyMigrationWithClient(client)).rejects.toThrow(
      'MIGRATION_LEDGER_RECOVERY_PHASE_INVALID'
    );
    expect(client.calls.some(call =>
      call.text.includes('CREATE TABLE')
      || call.text.includes('ALTER TABLE')
      || call.text.includes('CREATE UNIQUE INDEX')
      || call.text.includes('REINDEX INDEX')
    )).toBe(false);
  });

  it('surfaces advisory unlock failure when migration otherwise succeeds', async () => {
    const migration = await loadMigrationModule();
    const client = new FakeMigrationClient(migration.ACTION_PLAN_EXECUTION_SCHEMA_REQUIREMENTS);
    client.unlockSucceeds = false;

    await expect(migration.applyMigrationWithClient(client)).rejects.toThrow(
      'MIGRATION_ADVISORY_UNLOCK_FAILED'
    );
    expect(client.ledger).toMatchObject({
      completedPhase: 'complete',
      validityState: 'VALID'
    });
  });

  it('preserves the primary apply failure when advisory unlock also fails', async () => {
    const migration = await loadMigrationModule();
    const client = new FakeMigrationClient(migration.ACTION_PLAN_EXECUTION_SCHEMA_REQUIREMENTS);
    client.unlockSucceeds = false;
    client.failOnSql = 'ARCANOS Phase 2E: additive plan provenance';

    await expect(migration.applyMigrationWithClient(client)).rejects.toThrow(
      'MIGRATION_TEST_PRIMARY_FAILURE'
    );
    expect(client.calls.some(call => call.text.includes('pg_advisory_unlock'))).toBe(true);
  });

  it('preserves the primary compensation failure when advisory unlock also fails', async () => {
    const migration = await loadMigrationModule();
    const client = new FakeMigrationClient(migration.ACTION_PLAN_EXECUTION_SCHEMA_REQUIREMENTS);
    client.unlockSucceeds = false;
    client.failOnSql = 'LOCAL-EPHEMERAL COMPENSATING ROLLBACK ONLY';

    await expect(migration.compensateMigrationWithClient(client)).rejects.toThrow(
      'MIGRATION_TEST_PRIMARY_FAILURE'
    );
    expect(client.calls.some(call => call.text === 'ROLLBACK')).toBe(true);
    expect(client.calls.some(call => call.text.includes('pg_advisory_unlock'))).toBe(true);
  });

  it('refuses migration when another session holds the advisory lock', async () => {
    const migration = await loadMigrationModule();
    const client = new FakeMigrationClient(migration.ACTION_PLAN_EXECUTION_SCHEMA_REQUIREMENTS);
    client.lockAvailable = false;

    await expect(migration.applyMigrationWithClient(client)).rejects.toThrow(
      'MIGRATION_ADVISORY_LOCK_UNAVAILABLE'
    );
    expect(client.calls.some(call => call.text.includes('CREATE TABLE'))).toBe(false);
  });

  it('recovers an allowlisted invalid concurrent index before continuing', async () => {
    const migration = await loadMigrationModule();
    const manifest = migration.loadMigrationManifest();
    const client = new FakeMigrationClient(migration.ACTION_PLAN_EXECUTION_SCHEMA_REQUIREMENTS);
    client.ledgerExists = true;
    client.ledger = {
      checksum: manifest.checksum,
      completedPhase: manifest.phases[0].id,
      validityState: 'FAILED',
      appliedAt: null
    };
    client.indexes.set('uq_action_plan_id_execution_realm_v2', {
      valid: false,
      ready: false
    });

    await expect(migration.applyMigrationWithClient(client)).resolves.toMatchObject({
      ready: true,
      applied: true
    });
    expect(client.calls.some(call =>
      call.text === 'REINDEX INDEX CONCURRENTLY "uq_action_plan_id_execution_realm_v2"'
    )).toBe(true);
    expect(client.ledger).toMatchObject({
      completedPhase: 'complete',
      validityState: 'VALID'
    });
  });

  it('never advances a ledger with a different reviewed checksum', async () => {
    const migration = await loadMigrationModule();
    const client = new FakeMigrationClient(migration.ACTION_PLAN_EXECUTION_SCHEMA_REQUIREMENTS);
    client.ledgerExists = true;
    client.ledger = {
      checksum: '0'.repeat(64),
      completedPhase: '01_additive_provenance',
      validityState: 'FAILED',
      appliedAt: null
    };

    await expect(migration.applyMigrationWithClient(client)).rejects.toThrow(
      'MIGRATION_LEDGER_CHECKSUM_CONFLICT'
    );
    expect(client.calls.some(call => call.text.includes('CREATE TABLE'))).toBe(false);
  });

  it('reports assignment, application rollback, and empty-schema drain gates independently', async () => {
    const migration = await loadMigrationModule();
    const counts: Record<string, number> = {
      ActionPlanExecutionRun: 3,
      ActionPlanExecutionCommand: 1,
      ActionPlanExecutionEvent: 4,
      ActionPlan: 1
    };
    const client = {
      query: async (text: string) => {
        if (text.includes('to_regclass')) {
          return { rows: [{ exists: true }], rowCount: 1 };
        }
        if (text.includes('GROUP BY "state"')) {
          return {
            rows: [
              { state: 'CLAIMED', count: '1' },
              { state: 'RUNNING', count: '1' }
            ],
            rowCount: 2
          };
        }
        const table = Object.keys(counts).find(name => text.includes(`FROM "${name}"`));
        return {
          rows: [{ count: String(table ? counts[table] : 0) }],
          rowCount: 1
        };
      }
    };

    const state = await migration.inspectMigrationDrainStateWithClient(client);
    expect(state).toMatchObject({
      canDisableAssignment: true,
      canRevertApplication: false,
      canCompensateEmptySchema: false,
      counts: {
        requested: 0,
        claimed: 1,
        running: 1,
        runs: 3,
        commands: 1,
        events: 4,
        populatedProvenancePlans: 1
      }
    });
  });

  it('performs read-only startup verification and returns only stable failure evidence', async () => {
    const migration = await loadMigrationModule();
    const requirements = migration.ACTION_PLAN_EXECUTION_SCHEMA_REQUIREMENTS;
    const client = new FakeMigrationClient(requirements);
    client.ledgerExists = true;
    client.ledger = {
      checksum: ACTION_PLAN_EXECUTION_SCHEMA_CHECKSUM,
      completedPhase: 'complete',
      validityState: 'VALID',
      appliedAt: new Date('2026-07-17T00:00:00.000Z')
    };

    await expect(verifyActionPlanExecutionSchema(client)).resolves.toMatchObject({
      ready: true,
      code: 'ACTION_PLAN_EXECUTION_SCHEMA_READY',
      issues: []
    });

    const unavailable = await verifyActionPlanExecutionSchema({
      query: async () => {
        throw new Error('credential=sentinel path=C:\\private SQL=SELECT secret');
      }
    });
    expect(unavailable).toMatchObject({
      ready: false,
      code: 'ACTION_PLAN_EXECUTION_SCHEMA_UNAVAILABLE',
      issues: ['SCHEMA_QUERY_FAILED']
    });
    expect(JSON.stringify(unavailable)).not.toContain('sentinel');
    expect(JSON.stringify(unavailable)).not.toContain('SELECT secret');

    const missing = await verifyActionPlanExecutionSchema(
      new FakeMigrationClient(requirements)
    );
    expect(missing).toMatchObject({
      ready: false,
      code: 'ACTION_PLAN_EXECUTION_SCHEMA_MISSING',
      issues: ['SCHEMA_LEDGER_MISSING']
    });
  });

  it('rejects a critical column with the right name but wrong type, nullability, or default', async () => {
    const migration = await loadMigrationModule();
    for (const override of [
      { udt_name: 'int4' },
      { is_nullable: 'YES' },
      { column_default: null }
    ]) {
      const client = new FakeMigrationClient(migration.ACTION_PLAN_EXECUTION_SCHEMA_REQUIREMENTS);
      client.ledgerExists = true;
      client.ledger = {
        checksum: ACTION_PLAN_EXECUTION_SCHEMA_CHECKSUM,
        completedPhase: 'complete',
        validityState: 'VALID',
        appliedAt: new Date('2026-07-17T00:00:00.000Z')
      };
      client.columnOverrides.set('ActionPlanExecutionRun.eventSequence', override);

      await expect(migration.verifyActionPlanExecutionSchemaWithClient(client)).resolves.toMatchObject({
        ready: false,
        issues: ['SCHEMA_COLUMN_DEFINITION_INVALID:ActionPlanExecutionRun.eventSequence']
      });
      await expect(verifyActionPlanExecutionSchema(client)).resolves.toMatchObject({
        ready: false,
        code: 'ACTION_PLAN_EXECUTION_SCHEMA_INVALID',
        issues: ['SCHEMA_COLUMN_DEFINITION_INVALID:ActionPlanExecutionRun.eventSequence']
      });
    }
  });

  it('rejects a same-name relational constraint on the wrong relation or column identity', async () => {
    const migration = await loadMigrationModule();
    for (const override of [
      { table_name: 'ActionPlanExecutionEvent' },
      { columns_json: JSON.stringify(['planId', 'actionId']) },
      { columns_json: JSON.stringify(['planId', 'actionId', 'Attempt']) },
      { columns_json: '{planId,actionId}' },
      { referenced_columns_json: 'not-json' },
      { deferrable: true },
      { initially_deferred: true }
    ]) {
      const client = new FakeMigrationClient(migration.ACTION_PLAN_EXECUTION_SCHEMA_REQUIREMENTS);
      client.ledgerExists = true;
      client.ledger = {
        checksum: ACTION_PLAN_EXECUTION_SCHEMA_CHECKSUM,
        completedPhase: 'complete',
        validityState: 'VALID',
        appliedAt: new Date('2026-07-17T00:00:00.000Z')
      };
      client.constraintOverrides.set('uq_ap_exec_run_plan_action_attempt', override);

      await expect(migration.verifyActionPlanExecutionSchemaWithClient(client)).resolves.toMatchObject({
        ready: false,
        issues: ['SCHEMA_CONSTRAINT_DEFINITION_INVALID:uq_ap_exec_run_plan_action_attempt']
      });
      await expect(verifyActionPlanExecutionSchema(client)).resolves.toMatchObject({
        ready: false,
        issues: ['SCHEMA_CONSTRAINT_DEFINITION_INVALID:uq_ap_exec_run_plan_action_attempt']
      });
    }
  });

  it('rejects CHECK referenced-column collisions and foreign keys targeting another schema', async () => {
    const migration = await loadMigrationModule();
    for (const [constraint, override] of [
      [
        'ck_ap_exec_run_executor',
        { columns_json: JSON.stringify(['executorkind']) }
      ],
      [
        'ck_ap_exec_run_executor',
        { columns_json: JSON.stringify(['executorKind', 'state']) }
      ],
      [
        'fk_ap_exec_run_action',
        { referenced_schema_matches: false }
      ],
      [
        'fk_ap_exec_run_action',
        { referenced_table_name: 'action' }
      ]
    ] as const) {
      const client = new FakeMigrationClient(migration.ACTION_PLAN_EXECUTION_SCHEMA_REQUIREMENTS);
      client.ledgerExists = true;
      client.ledger = {
        checksum: ACTION_PLAN_EXECUTION_SCHEMA_CHECKSUM,
        completedPhase: 'complete',
        validityState: 'VALID',
        appliedAt: new Date('2026-07-17T00:00:00.000Z')
      };
      client.constraintOverrides.set(constraint, override);

      await expect(migration.verifyActionPlanExecutionSchemaWithClient(client)).resolves.toMatchObject({
        ready: false,
        issues: [`SCHEMA_CONSTRAINT_DEFINITION_INVALID:${constraint}`]
      });
      await expect(verifyActionPlanExecutionSchema(client)).resolves.toMatchObject({
        ready: false,
        issues: [`SCHEMA_CONSTRAINT_DEFINITION_INVALID:${constraint}`]
      });
    }
  });

  it('rejects a snapshot-shape constraint that omits an established provenance field', async () => {
    const migration = await loadMigrationModule();
    const client = new FakeMigrationClient(migration.ACTION_PLAN_EXECUTION_SCHEMA_REQUIREMENTS);
    client.ledgerExists = true;
    client.ledger = {
      checksum: ACTION_PLAN_EXECUTION_SCHEMA_CHECKSUM,
      completedPhase: 'complete',
      validityState: 'VALID',
      appliedAt: new Date('2026-07-17T00:00:00.000Z')
    };
    const spec = migration.ACTION_PLAN_EXECUTION_SCHEMA_REQUIREMENTS
      .constraintSpecs.ck_ap_exec_run_snapshot_shape;
    client.constraintOverrides.set('ck_ap_exec_run_snapshot_shape', {
      definition: spec.requiredFragments
        .filter(fragment => !fragment.includes('agent_capability_fingerprint'))
        .join(' AND ')
    });

    await expect(migration.verifyActionPlanExecutionSchemaWithClient(client)).resolves.toMatchObject({
      ready: false,
      issues: ['SCHEMA_CONSTRAINT_DEFINITION_INVALID:ck_ap_exec_run_snapshot_shape']
    });
    await expect(verifyActionPlanExecutionSchema(client)).resolves.toMatchObject({
      ready: false,
      issues: ['SCHEMA_CONSTRAINT_DEFINITION_INVALID:ck_ap_exec_run_snapshot_shape']
    });
  });

  it('rejects a valid same-name CHECK weakened by an extra permissive branch', async () => {
    const migration = await loadMigrationModule();
    const client = new FakeMigrationClient(migration.ACTION_PLAN_EXECUTION_SCHEMA_REQUIREMENTS);
    client.ledgerExists = true;
    client.ledger = {
      checksum: ACTION_PLAN_EXECUTION_SCHEMA_CHECKSUM,
      completedPhase: 'complete',
      validityState: 'VALID',
      appliedAt: new Date('2026-07-17T00:00:00.000Z')
    };
    client.constraintOverrides.set('ck_ap_exec_run_attempt', {
      definition: `${reviewedCheckDefinitions.get('ck_ap_exec_run_attempt')} OR TRUE`
    });

    await expect(migration.verifyActionPlanExecutionSchemaWithClient(client)).resolves.toMatchObject({
      ready: false,
      issues: ['SCHEMA_CONSTRAINT_DEFINITION_INVALID:ck_ap_exec_run_attempt']
    });
    await expect(verifyActionPlanExecutionSchema(client)).resolves.toMatchObject({
      ready: false,
      issues: ['SCHEMA_CONSTRAINT_DEFINITION_INVALID:ck_ap_exec_run_attempt']
    });
  });

  it('rejects CHECK logic with identical token order but weakened boolean association', async () => {
    const migration = await loadMigrationModule();
    const client = new FakeMigrationClient(migration.ACTION_PLAN_EXECUTION_SCHEMA_REQUIREMENTS);
    client.ledgerExists = true;
    client.ledger = {
      checksum: ACTION_PLAN_EXECUTION_SCHEMA_CHECKSUM,
      completedPhase: 'complete',
      validityState: 'VALID',
      appliedAt: new Date('2026-07-17T00:00:00.000Z')
    };
    const reassociated = `CHECK (
      (("resultOutput" IS NULL OR octet_length("resultOutput"::TEXT) <= 65536)
       AND "resultError" IS NULL)
      OR (octet_length("resultError"::TEXT) <= 8192
       AND ("acceptanceReceipt" IS NULL OR char_length("acceptanceReceipt") BETWEEN 1 AND 256))
    )`;
    const reviewed = reviewedCheckDefinitions.get('ck_ap_exec_run_result_bounds') ?? '';
    expect(reassociated.replace(/[()\s]/gu, '')).toContain(
      reviewed.replace(/[()\s]/gu, '').replace(/^CHECK/iu, '')
    );
    expect(migration.checkDefinitionHash(reassociated)).not.toBe(
      migration.checkDefinitionHash(reviewed)
    );
    client.constraintOverrides.set('ck_ap_exec_run_result_bounds', {
      definition: reassociated
    });

    await expect(migration.verifyActionPlanExecutionSchemaWithClient(client)).resolves.toMatchObject({
      ready: false,
      issues: ['SCHEMA_CONSTRAINT_DEFINITION_INVALID:ck_ap_exec_run_result_bounds']
    });
    await expect(verifyActionPlanExecutionSchema(client)).resolves.toMatchObject({
      ready: false,
      issues: ['SCHEMA_CONSTRAINT_DEFINITION_INVALID:ck_ap_exec_run_result_bounds']
    });
  });

  it('accepts exact PostgreSQL partial-index predicate forms from structured catalog fields', async () => {
    const migration = await loadMigrationModule();
    const client = new FakeMigrationClient(migration.ACTION_PLAN_EXECUTION_SCHEMA_REQUIREMENTS);
    client.ledgerExists = true;
    client.ledger = {
      checksum: ACTION_PLAN_EXECUTION_SCHEMA_CHECKSUM,
      completedPhase: 'complete',
      validityState: 'VALID',
      appliedAt: new Date('2026-07-17T00:00:00.000Z')
    };
    client.indexOverrides.set('uq_ap_exec_run_active_action', {
      predicate: '("state" = ANY (ARRAY[\'REQUESTED\'::text, \'CLAIMED\'::text, \'RUNNING\'::text]))'
    });
    client.indexOverrides.set('ix_ap_exec_run_claim_next', {
      predicate: '("state" = \'REQUESTED\'::text)'
    });

    await expect(migration.verifyActionPlanExecutionSchemaWithClient(client)).resolves.toMatchObject({
      ready: true,
      issues: []
    });
  });

  it('rejects same-name indexes with altered ownership, uniqueness, columns, or predicate', async () => {
    const migration = await loadMigrationModule();
    for (const override of [
      { table_name: 'ActionPlanExecutionEvent' },
      { unique: false },
      { schema_matches: false },
      { columns_json: JSON.stringify(['actionId', 'planId']) },
      { columns_json: JSON.stringify(['planId', 'ActionId']) },
      { predicate: '"state" = \'REQUESTED\'' },
      { predicate: '"state" IN (\'requested\', \'claimed\', \'running\')' },
      { predicate: '"state" = ANY (ARRAY[\'REQUESTED\')' },
      { predicate: '"state" = ANY (ARRAY[\'REQUESTED\', \'CLAIMED\', \'RUNNING\', \'REQUESTED\'])' },
      { access_method: 'hash' },
      { key_count: 1 },
      { attribute_count: 3 },
      { expressions_absent: false },
      { sort_options_default: false },
      { opclasses_default: false },
      { collations_default: false }
    ]) {
      const client = new FakeMigrationClient(migration.ACTION_PLAN_EXECUTION_SCHEMA_REQUIREMENTS);
      client.ledgerExists = true;
      client.ledger = {
        checksum: ACTION_PLAN_EXECUTION_SCHEMA_CHECKSUM,
        completedPhase: 'complete',
        validityState: 'VALID',
        appliedAt: new Date('2026-07-17T00:00:00.000Z')
      };
      client.indexOverrides.set('uq_ap_exec_run_active_action', override);

      await expect(migration.verifyActionPlanExecutionSchemaWithClient(client)).resolves.toMatchObject({
        ready: false,
        issues: ['SCHEMA_INDEX_DEFINITION_INVALID:uq_ap_exec_run_active_action']
      });
      await expect(verifyActionPlanExecutionSchema(client)).resolves.toMatchObject({
        ready: false,
        issues: ['SCHEMA_INDEX_DEFINITION_INVALID:uq_ap_exec_run_active_action']
      });
    }

    for (const override of [{ valid: false }, { ready: false }]) {
      const client = new FakeMigrationClient(migration.ACTION_PLAN_EXECUTION_SCHEMA_REQUIREMENTS);
      client.ledgerExists = true;
      client.ledger = {
        checksum: ACTION_PLAN_EXECUTION_SCHEMA_CHECKSUM,
        completedPhase: 'complete',
        validityState: 'VALID',
        appliedAt: new Date('2026-07-17T00:00:00.000Z')
      };
      client.indexOverrides.set('uq_ap_exec_run_active_action', override);
      await expect(migration.verifyActionPlanExecutionSchemaWithClient(client)).resolves.toMatchObject({
        ready: false,
        issues: ['SCHEMA_INDEX_INVALID:uq_ap_exec_run_active_action']
      });
    }
  });

  it('refuses to repair a same-name concurrent index whose structure is not reviewed', async () => {
    const migration = await loadMigrationModule();
    const manifest = migration.loadMigrationManifest();
    const client = new FakeMigrationClient(migration.ACTION_PLAN_EXECUTION_SCHEMA_REQUIREMENTS);
    client.ledgerExists = true;
    client.ledger = {
      checksum: manifest.checksum,
      completedPhase: manifest.phases[0].id,
      validityState: 'FAILED',
      appliedAt: null
    };
    client.indexes.set('uq_action_plan_id_execution_realm_v2', { valid: false, ready: false });
    client.indexOverrides.set('uq_action_plan_id_execution_realm_v2', {
      table_name: 'Action',
      columns_json: JSON.stringify(['"id"', '"executionRealm"'])
    });

    await expect(migration.applyMigrationWithClient(client)).rejects.toThrow(
      'MIGRATION_CONCURRENT_INDEX_DEFINITION_INVALID'
    );
    expect(client.calls.some(call => call.text.includes('REINDEX INDEX CONCURRENTLY'))).toBe(false);
  });

  it('represents every additive table and relation in Prisma without touching legacy ExecutionResult', () => {
    const prismaSchema = readFileSync(join(process.cwd(), 'prisma', 'schema.prisma'), 'utf8');

    expect(prismaSchema).toContain('model ActionPlanExecutionSchemaMigration');
    expect(prismaSchema).toContain('model ActionPlanExecutionCommand');
    expect(prismaSchema).toContain('model ActionPlanExecutionRun');
    expect(prismaSchema).toContain('model ActionPlanExecutionEvent');
    expect(prismaSchema).toContain('executionGeneration      BigInt?');
    expect(prismaSchema).toContain('@@unique([planId, id], map: "uq_action_plan_action_plan_id_id_v2")');
    expect(prismaSchema).toContain('@@unique([planId, actionId])');
  });
});
