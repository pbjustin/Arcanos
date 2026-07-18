import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  ACTION_PLAN_EXECUTION_SCHEMA_CHECKSUM,
  ACTION_PLAN_EXECUTION_SCHEMA_REQUIREMENTS,
  parseCatalogStringArray,
  verifyActionPlanExecutionSchema,
  type ActionPlanExecutionSchemaQueryable
} from '../src/core/db/actionPlanExecutionSchema.js';

type CatalogArrayEncoding = 'decoded' | 'json-text' | 'postgres-text';
type CatalogRow = Record<string, unknown>;

const migrationScriptPath = join(process.cwd(), 'scripts', 'action-plan-execution-migration.mjs');
let reviewedCheckDefinitions = new Map<string, string>();

function postgres18CheckDefinition(definition: string): string {
  return definition.replace(
    /(char_length\([^)]*\))\s+BETWEEN\s+(-?[0-9]+)\s+AND\s+(-?[0-9]+)/giu,
    '(($1 >= $2) AND ($1 <= $3))'
  );
}

function referencedQuotedIdentifiers(definition: string): string[] {
  const identifiers = new Set<string>();
  let index = 0;
  while (index < definition.length) {
    if (definition[index] === "'") {
      index += 1;
      while (index < definition.length) {
        if (definition[index] !== "'") {
          index += 1;
          continue;
        }
        if (definition[index + 1] === "'") {
          index += 2;
          continue;
        }
        index += 1;
        break;
      }
      continue;
    }
    if (definition[index] !== '"') {
      index += 1;
      continue;
    }
    index += 1;
    let identifier = '';
    while (index < definition.length) {
      if (definition[index] !== '"') {
        identifier += definition[index];
        index += 1;
        continue;
      }
      if (definition[index + 1] === '"') {
        identifier += '"';
        index += 2;
        continue;
      }
      index += 1;
      break;
    }
    identifiers.add(identifier);
  }
  return [...identifiers].sort();
}

class PostgreSql18Catalog implements ActionPlanExecutionSchemaQueryable {
  readonly calls: string[] = [];
  readonly constraintOverrides = new Map<string, CatalogRow>();
  readonly indexOverrides = new Map<string, CatalogRow>();

  constructor(private readonly arrayEncoding: CatalogArrayEncoding = 'json-text') {}

  private encodeArray(values: string[]): string[] | string {
    if (this.arrayEncoding === 'decoded') return [...values];
    if (this.arrayEncoding === 'postgres-text') return `{${values.join(',')}}`;
    return JSON.stringify(values);
  }

  private constraintRow(name: string): CatalogRow {
    const spec = ACTION_PLAN_EXECUTION_SCHEMA_REQUIREMENTS.constraintSpecs[name];
    const relational = ACTION_PLAN_EXECUTION_SCHEMA_REQUIREMENTS.relationalConstraintSpecs[name];
    const checkColumns = ACTION_PLAN_EXECUTION_SCHEMA_REQUIREMENTS.checkColumnSets[name];
    return {
      name,
      table_name: spec.table,
      type: spec.type,
      validated: true,
      deferrable: false,
      initially_deferred: false,
      definition: spec.type === 'c'
        ? postgres18CheckDefinition(reviewedCheckDefinitions.get(name) ?? '')
        : spec.requiredFragments.join(' AND '),
      columns_json: this.encodeArray(spec.type === 'c' ? checkColumns ?? [] : relational?.columns ?? []),
      referenced_table_name: relational?.referencedTable ?? null,
      referenced_schema_matches: relational?.referencedTable ? true : null,
      referenced_columns_json: this.encodeArray(relational?.referencedColumns ?? []),
      update_action: relational?.updateAction ?? ' ',
      delete_action: relational?.deleteAction ?? ' ',
      ...this.constraintOverrides.get(name)
    };
  }

  private indexRow(name: string): CatalogRow {
    const spec = ACTION_PLAN_EXECUTION_SCHEMA_REQUIREMENTS.indexSpecs[name];
    const predicate = spec.predicateStates.length === 0
      ? null
      : spec.predicateStates.length === 1
        ? `("state" = '${spec.predicateStates[0]}'::text)`
        : `("state" = ANY (ARRAY[${spec.predicateStates
          .map(state => `'${state}'::text`)
          .join(', ')}]))`;
    return {
      name,
      table_name: spec.table,
      unique: spec.unique,
      valid: true,
      ready: true,
      schema_matches: true,
      access_method: 'btree',
      columns_json: this.encodeArray(spec.columns),
      predicate,
      key_count: spec.columns.length,
      attribute_count: spec.columns.length,
      expressions_absent: true,
      sort_options_default: true,
      opclasses_default: true,
      collations_default: true,
      ...this.indexOverrides.get(name)
    };
  }

  async query<Row extends Record<string, unknown> = Record<string, unknown>>(
    text: string
  ): Promise<{ rows: Row[] }> {
    this.calls.push(text);
    let rows: CatalogRow[];
    if (text.includes('to_regclass($1::text)')) {
      rows = [{ exists: true }];
    } else if (text.includes('FROM "ActionPlanExecutionSchemaMigration"')) {
      rows = [{
        checksum: ACTION_PLAN_EXECUTION_SCHEMA_CHECKSUM,
        completedPhase: 'complete',
        validityState: 'VALID',
        appliedAt: new Date('2026-07-18T00:00:00.000Z')
      }];
    } else if (text.includes('FROM information_schema.tables')) {
      rows = ACTION_PLAN_EXECUTION_SCHEMA_REQUIREMENTS.tables.map(table_name => ({ table_name }));
    } else if (text.includes('FROM information_schema.columns')) {
      const defaults: Record<string, string | null> = {
        none: null,
        current_timestamp: 'CURRENT_TIMESTAMP',
        zero: '0',
        empty_json_object: "'{}'::jsonb"
      };
      rows = Object.entries(ACTION_PLAN_EXECUTION_SCHEMA_REQUIREMENTS.columns).flatMap(
        ([table_name, columns]) => columns.map(column_name => {
          const spec = ACTION_PLAN_EXECUTION_SCHEMA_REQUIREMENTS.columnSpecs[table_name][column_name];
          return {
            table_name,
            column_name,
            udt_name: spec.type,
            is_nullable: spec.nullable ? 'YES' : 'NO',
            column_default: defaults[spec.defaultKind]
          };
        })
      );
    } else if (text.includes('FROM pg_constraint AS constraint_data')) {
      rows = ACTION_PLAN_EXECUTION_SCHEMA_REQUIREMENTS.constraints.map(name => this.constraintRow(name));
    } else if (text.includes('FROM pg_class AS index_relation')) {
      rows = ACTION_PLAN_EXECUTION_SCHEMA_REQUIREMENTS.indexes.map(name => this.indexRow(name));
    } else {
      throw new Error('UNEXPECTED_RUNTIME_SCHEMA_QUERY');
    }
    return { rows: rows as Row[] };
  }
}

beforeAll(async () => {
  const migration = await import(pathToFileURL(migrationScriptPath).href) as {
    loadReviewedCheckDefinitions: () => Map<string, string>;
  };
  reviewedCheckDefinitions = migration.loadReviewedCheckDefinitions();
});

describe('PostgreSQL 18 ActionPlan runtime schema verification', () => {
  it('binds every reviewed CHECK to its exact case-sensitive referenced-column set', () => {
    expect(reviewedCheckDefinitions.size).toBe(36);
    for (const [name, definition] of reviewedCheckDefinitions) {
      expect(ACTION_PLAN_EXECUTION_SCHEMA_REQUIREMENTS.checkColumnSets[name]).toEqual(
        referencedQuotedIdentifiers(definition)
      );
    }
  });

  it('accepts decoded, deterministic JSON-text, and strict PostgreSQL-text catalog arrays', async () => {
    const decoded = new PostgreSql18Catalog('decoded');
    const jsonText = new PostgreSql18Catalog('json-text');
    const postgresText = new PostgreSql18Catalog('postgres-text');

    const [decodedResult, jsonTextResult, postgresTextResult] = await Promise.all([
      verifyActionPlanExecutionSchema(decoded),
      verifyActionPlanExecutionSchema(jsonText),
      verifyActionPlanExecutionSchema(postgresText)
    ]);

    expect(decodedResult).toMatchObject({
      ready: true,
      code: 'ACTION_PLAN_EXECUTION_SCHEMA_READY',
      issues: []
    });
    expect(jsonTextResult).toEqual(decodedResult);
    expect(postgresTextResult).toEqual(decodedResult);

    const constraintQuery = jsonText.calls.find(text => text.includes('FROM pg_constraint')) ?? '';
    expect(constraintQuery).toContain('attribute.attname::text');
    expect(constraintQuery).toContain('to_json(ARRAY(');
    expect(constraintQuery).toContain('constraint_data.condeferrable AS deferrable');
    expect(constraintQuery).toContain('constraint_data.condeferred AS initially_deferred');
    expect(constraintQuery).toContain('referenced_namespace.nspname = current_schema()');

    const indexQuery = jsonText.calls.find(text => text.includes('FROM pg_class AS index_relation')) ?? '';
    expect(indexQuery).toContain('index_data.indnkeyatts::integer AS key_count');
    expect(indexQuery).toContain('index_data.indnatts::integer AS attribute_count');
    expect(indexQuery).toContain('index_data.indexprs IS NULL AS expressions_absent');
    expect(indexQuery).toContain('AS sort_options_default');
    expect(indexQuery).toContain('AS opclasses_default');
    expect(indexQuery).toContain('AS collations_default');
    expect(indexQuery).toContain('operator_class.opcmethod IS DISTINCT FROM index_relation.relam');
    expect(indexQuery).toContain('operator_class.opcintype IS DISTINCT FROM opclass_attribute.atttypid');
    expect(indexQuery).toContain('attribute.attname::text');
    expect(indexQuery).not.toContain('pg_get_indexdef(index_data.indexrelid) AS definition');
  });

  it.each([
    ['quoted comma', '{"plan,Id"}', ['plan,Id']],
    ['escaped quote and backslash', String.raw`{"quote\"id","slash\\id"}`, ['quote"id', 'slash\\id']],
    ['mixed-case entries', '{planId,ActionId}', ['planId', 'ActionId']],
    ['long identifier', `{${'identifier'.repeat(32)}}`, ['identifier'.repeat(32)]],
    ['empty array', '{}', []]
  ])('decodes a strict PostgreSQL array literal with %s', (_label, value, expected) => {
    expect(parseCatalogStringArray(value)).toEqual(expected);
  });

  it.each([
    ['bounded dimensions', '[1:2]={planId,actionId}'],
    ['nested arrays', '{{planId},{actionId}}'],
    ['NULL entry', '{NULL}'],
    ['mixed string and NULL entries', '{planId,NULL}'],
    ['malformed quoted suffix', '{"planId"suffix}'],
    ['leading empty entry', '{,planId}'],
    ['trailing empty entry', '{planId,}'],
    ['interior empty entry', '{planId,,actionId}'],
    ['unterminated quote', '{"planId}'],
    ['unterminated escape', String.raw`{"planId\}`]
  ])('rejects a PostgreSQL array literal with %s', (_label, value) => {
    expect(parseCatalogStringArray(value)).toBeNull();
  });

  it('keeps decoded arrays and JSON text authoritative', () => {
    expect(parseCatalogStringArray(['planId', 'actionId'])).toEqual(['planId', 'actionId']);
    expect(parseCatalogStringArray('["planId","actionId"]')).toEqual(['planId', 'actionId']);
    expect(parseCatalogStringArray('"{planId,actionId}"')).toBeNull();
  });

  it.each([
    ['null', null],
    ['malformed JSON', '["id"'],
    ['JSON scalar', '"id"'],
    ['mixed JSON array', '["id",42]'],
    ['unexpected object', { id: true }]
  ])('fails closed for %s ordered constraint columns', async (_label, columns) => {
    const catalog = new PostgreSql18Catalog();
    catalog.constraintOverrides.set('ActionPlanExecutionCommand_pkey', { columns_json: columns });

    await expect(verifyActionPlanExecutionSchema(catalog)).resolves.toMatchObject({
      ready: false,
      code: 'ACTION_PLAN_EXECUTION_SCHEMA_INVALID',
      issues: ['SCHEMA_CONSTRAINT_DEFINITION_INVALID:ActionPlanExecutionCommand_pkey']
    });
  });

  it('fails closed for malformed referenced and index key arrays', async () => {
    const referencedCatalog = new PostgreSql18Catalog();
    referencedCatalog.constraintOverrides.set('fk_ap_exec_run_action', {
      referenced_columns_json: '["planId",null]'
    });
    await expect(verifyActionPlanExecutionSchema(referencedCatalog)).resolves.toMatchObject({
      ready: false,
      issues: ['SCHEMA_CONSTRAINT_DEFINITION_INVALID:fk_ap_exec_run_action']
    });

    const indexCatalog = new PostgreSql18Catalog();
    indexCatalog.indexOverrides.set('ix_ap_exec_run_claim_next', { columns_json: '{{executionRealm}}' });
    await expect(verifyActionPlanExecutionSchema(indexCatalog)).resolves.toMatchObject({
      ready: false,
      issues: ['SCHEMA_INDEX_DEFINITION_INVALID:ix_ap_exec_run_claim_next']
    });
  });

  it('compares relational constraint attname keys with exact case', async () => {
    const catalog = new PostgreSql18Catalog();
    catalog.constraintOverrides.set('ActionPlanExecutionCommand_pkey', {
      columns_json: '["ID"]'
    });

    await expect(verifyActionPlanExecutionSchema(catalog)).resolves.toMatchObject({
      ready: false,
      issues: ['SCHEMA_CONSTRAINT_DEFINITION_INVALID:ActionPlanExecutionCommand_pkey']
    });
  });

  it.each([
    ['missing referenced column', []],
    ['extra referenced column', ['version', 'checksum']],
    ['wrong-case referenced column', ['Version']]
  ])('rejects a CHECK with a %s', async (_label, columns) => {
    const catalog = new PostgreSql18Catalog();
    catalog.constraintOverrides.set('ck_ap_exec_migration_version', {
      columns_json: JSON.stringify(columns)
    });

    await expect(verifyActionPlanExecutionSchema(catalog)).resolves.toMatchObject({
      ready: false,
      issues: ['SCHEMA_CONSTRAINT_DEFINITION_INVALID:ck_ap_exec_migration_version']
    });
  });

  it('compares CHECK referenced columns as an exact order-independent set', async () => {
    const catalog = new PostgreSql18Catalog();
    catalog.constraintOverrides.set('ck_ap_exec_command_id', {
      columns_json: JSON.stringify(['planId', 'id'])
    });

    await expect(verifyActionPlanExecutionSchema(catalog)).resolves.toMatchObject({
      ready: true,
      issues: []
    });
  });

  it('rejects a foreign key whose referenced relation resolves outside the current schema', async () => {
    const catalog = new PostgreSql18Catalog();
    catalog.constraintOverrides.set('fk_ap_exec_run_action', {
      referenced_schema_matches: false
    });

    await expect(verifyActionPlanExecutionSchema(catalog)).resolves.toMatchObject({
      ready: false,
      issues: ['SCHEMA_CONSTRAINT_DEFINITION_INVALID:fk_ap_exec_run_action']
    });
  });

  it.each([
    ['deferrable', { deferrable: true }],
    ['initially deferred', { initially_deferred: true }]
  ])('rejects a %s reviewed constraint', async (_label, override) => {
    const catalog = new PostgreSql18Catalog();
    catalog.constraintOverrides.set('ActionPlanExecutionCommand_pkey', override);

    await expect(verifyActionPlanExecutionSchema(catalog)).resolves.toMatchObject({
      ready: false,
      issues: ['SCHEMA_CONSTRAINT_DEFINITION_INVALID:ActionPlanExecutionCommand_pkey']
    });
  });

  it.each([
    ['wrong threshold', 'CHECK ((char_length("version") >= 1) AND (char_length("version") <= 65))'],
    ['wrong operator', 'CHECK ((char_length("version") > 1) AND (char_length("version") <= 64))'],
    [
      'permissive disjunction',
      'CHECK (((char_length("version") >= 1) AND (char_length("version") <= 64)) OR TRUE)'
    ]
  ])('rejects a PostgreSQL 18 CHECK with a %s', async (_label, definition) => {
    const catalog = new PostgreSql18Catalog();
    catalog.constraintOverrides.set('ck_ap_exec_migration_version', { definition });

    await expect(verifyActionPlanExecutionSchema(catalog)).resolves.toMatchObject({
      ready: false,
      issues: ['SCHEMA_CONSTRAINT_DEFINITION_INVALID:ck_ap_exec_migration_version']
    });
  });

  it('allows benign dequoting of a safe lowercase identifier', async () => {
    const catalog = new PostgreSql18Catalog();
    catalog.constraintOverrides.set('ck_ap_exec_migration_version', {
      definition: 'CHECK ((char_length(version) >= 1) AND (char_length(version) <= 64))'
    });

    await expect(verifyActionPlanExecutionSchema(catalog)).resolves.toMatchObject({
      ready: true,
      issues: []
    });
  });

  it.each([
    ['lowercase state literal', 'ck_ap_exec_run_state', "'REQUESTED'", "'requested'"],
    ['mixed-case quoted identifier', 'ck_ap_exec_command_realm', '"executionRealm"', '"ExecutionRealm"'],
    ['literal trailing whitespace', 'ck_ap_exec_run_executor', "'python-daemon'", "'python-daemon '"],
    ['cast-like literal text', 'ck_ap_exec_run_executor', "'python-daemon'", "'python-daemon::text'"]
  ])('rejects a CHECK with changed %s', async (_label, name, from, to) => {
    const catalog = new PostgreSql18Catalog();
    const reviewedDefinition = reviewedCheckDefinitions.get(name);
    expect(reviewedDefinition).toBeDefined();
    catalog.constraintOverrides.set(name, {
      definition: reviewedDefinition!.replace(from, to)
    });

    await expect(verifyActionPlanExecutionSchema(catalog)).resolves.toMatchObject({
      ready: false,
      issues: [`SCHEMA_CONSTRAINT_DEFINITION_INVALID:${name}`]
    });
  });

  it.each([
    ['wrong schema', { schema_matches: false }],
    ['wrong table', { table_name: 'ActionPlanExecutionEvent' }],
    ['wrong access method', { access_method: 'hash' }],
    ['wrong uniqueness', { unique: false }],
    ['reordered keys', { columns_json: '["actionId","planId"]' }],
    ['wrong-case key', { columns_json: '["planId","ActionId"]' }],
    ['missing key', { key_count: 1 }],
    ['included attribute', { attribute_count: 3 }],
    ['expression key', { expressions_absent: false }],
    ['nondefault sort or null options', { sort_options_default: false }],
    ['nondefault operator class', { opclasses_default: false }],
    ['nondefault collation', { collations_default: false }],
    ['lowercase state literal', { predicate: '"state" IN (\'requested\', \'CLAIMED\', \'RUNNING\')' }],
    [
      'conjunctive predicate',
      { predicate: '"state" = \'REQUESTED\' AND "state" = \'CLAIMED\' AND "state" = \'RUNNING\'' }
    ],
    ['extra predicate state', { predicate: '"state" IN (\'REQUESTED\', \'CLAIMED\', \'RUNNING\', \'SUCCEEDED\')' }]
  ])('rejects a partial index with a %s', async (_label, override) => {
    const catalog = new PostgreSql18Catalog();
    catalog.indexOverrides.set('uq_ap_exec_run_active_action', override);

    await expect(verifyActionPlanExecutionSchema(catalog)).resolves.toMatchObject({
      ready: false,
      issues: ['SCHEMA_INDEX_DEFINITION_INVALID:uq_ap_exec_run_active_action']
    });
  });

  it.each([
    ['invalid', { valid: false }],
    ['not ready', { ready: false }]
  ])('distinguishes a structurally correct but %s index', async (_label, override) => {
    const catalog = new PostgreSql18Catalog();
    catalog.indexOverrides.set('uq_ap_exec_run_active_action', override);

    await expect(verifyActionPlanExecutionSchema(catalog)).resolves.toMatchObject({
      ready: false,
      issues: ['SCHEMA_INDEX_INVALID:uq_ap_exec_run_active_action']
    });
  });

  it('returns only the stable unavailable error when catalog access fails', async () => {
    const result = await verifyActionPlanExecutionSchema({
      query: async () => {
        throw new Error('credential=sentinel path=C:\\private SQL=SELECT secret');
      }
    });

    expect(result).toMatchObject({
      ready: false,
      code: 'ACTION_PLAN_EXECUTION_SCHEMA_UNAVAILABLE',
      issues: ['SCHEMA_QUERY_FAILED']
    });
    expect(JSON.stringify(result)).not.toContain('sentinel');
    expect(JSON.stringify(result)).not.toContain('SELECT secret');
  });
});
