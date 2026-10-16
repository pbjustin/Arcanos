import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import type { Pool as PoolType } from 'pg';
import { getPool } from './client.js';
import schemaContract from './actionPlanExecutionSchemaContract.json' with { type: 'json' };

// Inert data shared with the standalone migration runner; no database or CLI lifecycle.
// Literal assertions preserve the existing public TypeScript constant types.
export const ACTION_PLAN_EXECUTION_SCHEMA_VERSION = schemaContract.version as '20260717_action_plan_execution_v2';
export const ACTION_PLAN_EXECUTION_SCHEMA_LABEL = schemaContract.schemaLabel as 'action-plan-execution-v1';
export const ACTION_PLAN_EXECUTION_PROTOCOL_VERSION = schemaContract.protocolVersion as 2;
export const ACTION_PLAN_EXECUTION_SNAPSHOT_SCHEMA_VERSION = schemaContract.snapshotSchemaVersion as 1;
export const ACTION_PLAN_EXECUTION_SCHEMA_CHECKSUM = schemaContract.checksum as 'cfa339af4282ce47a955acd08fa3f16e617b4a943111890f1e5b4bd5ba929533';

type ColumnDefaultKind = 'none' | 'current_timestamp' | 'zero' | 'empty_json_object';

interface ColumnSpec {
  type: 'text' | 'int4' | 'int8' | 'timestamptz' | 'jsonb';
  nullable: boolean;
  defaultKind: ColumnDefaultKind;
}

interface ConstraintSpec {
  table: string;
  type: 'c' | 'f' | 'p' | 'u';
  requiredFragments: string[];
  deferrable: false;
  initiallyDeferred: false;
}

interface RelationalConstraintSpec {
  columns: string[];
  referencedTable?: string;
  referencedColumns?: string[];
  updateAction?: 'c';
  deleteAction?: 'r';
}

interface IndexSpec {
  table: string;
  unique: boolean;
  columns: string[];
  predicateStates: string[];
}

// Preserve independent mutable internals for each consumer and the existing shallow-frozen export.
const {
  tables: REQUIRED_TABLES,
  columns: REQUIRED_COLUMNS,
  columnSpecs: REQUIRED_COLUMN_SPECS,
  constraints: REQUIRED_CONSTRAINTS,
  constraintSpecs: REQUIRED_CONSTRAINT_SPECS,
  checkColumnSets: REQUIRED_CHECK_COLUMN_SETS,
  relationalConstraintSpecs: REQUIRED_RELATIONAL_CONSTRAINT_SPECS,
  indexes: REQUIRED_INDEXES,
  indexSpecs: REQUIRED_INDEX_SPECS
} = structuredClone(schemaContract.requirements) as {
  tables: Array<Exclude<keyof typeof schemaContract.requirements.columnSpecs, 'ActionPlan'>>;
  columns: {
    [Table in keyof typeof schemaContract.requirements.columnSpecs]: Array<
      keyof typeof schemaContract.requirements.columnSpecs[Table]
    >
  };
  columnSpecs: Record<string, Record<string, ColumnSpec>>;
  constraints: Array<keyof typeof schemaContract.requirements.constraintSpecs>;
  constraintSpecs: Record<string, ConstraintSpec>;
  checkColumnSets: Record<string, string[]>;
  relationalConstraintSpecs: Record<string, RelationalConstraintSpec>;
  indexes: Array<keyof typeof schemaContract.requirements.indexSpecs>;
  indexSpecs: Record<string, IndexSpec>;
};
const REQUIRED_CHECK_DEFINITION_HASHES: Record<string, string> = structuredClone(schemaContract.checkDefinitionHashes);

export const ACTION_PLAN_EXECUTION_SCHEMA_REQUIREMENTS = Object.freeze({
  tables: [...REQUIRED_TABLES],
  columns: Object.fromEntries(
    Object.entries(REQUIRED_COLUMNS).map(([table, columns]) => [table, [...columns]])
  ),
  columnSpecs: REQUIRED_COLUMN_SPECS,
  constraints: [...REQUIRED_CONSTRAINTS],
  constraintSpecs: REQUIRED_CONSTRAINT_SPECS,
  checkColumnSets: REQUIRED_CHECK_COLUMN_SETS,
  relationalConstraintSpecs: REQUIRED_RELATIONAL_CONSTRAINT_SPECS,
  indexes: [...REQUIRED_INDEXES],
  indexSpecs: REQUIRED_INDEX_SPECS
});

interface QueryResultLike<Row> {
  rows: Row[];
}

export interface ActionPlanExecutionSchemaQueryable {
  query<Row extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    values?: unknown[]
  ): Promise<QueryResultLike<Row>>;
}

export type ActionPlanExecutionSchemaVerificationCode =
  | 'ACTION_PLAN_EXECUTION_SCHEMA_READY'
  | 'ACTION_PLAN_EXECUTION_SCHEMA_MISSING'
  | 'ACTION_PLAN_EXECUTION_SCHEMA_INVALID'
  | 'ACTION_PLAN_EXECUTION_SCHEMA_UNAVAILABLE';

export interface ActionPlanExecutionSchemaVerification {
  ready: boolean;
  code: ActionPlanExecutionSchemaVerificationCode;
  version: string;
  schemaLabel: string;
  protocolVersion: number;
  snapshotSchemaVersion: number;
  checksum: string;
  issues: string[];
}

function verification(
  code: ActionPlanExecutionSchemaVerificationCode,
  issues: string[]
): ActionPlanExecutionSchemaVerification {
  return {
    ready: code === 'ACTION_PLAN_EXECUTION_SCHEMA_READY',
    code,
    version: ACTION_PLAN_EXECUTION_SCHEMA_VERSION,
    schemaLabel: ACTION_PLAN_EXECUTION_SCHEMA_LABEL,
    protocolVersion: ACTION_PLAN_EXECUTION_PROTOCOL_VERSION,
    snapshotSchemaVersion: ACTION_PLAN_EXECUTION_SNAPSHOT_SCHEMA_VERSION,
    checksum: ACTION_PLAN_EXECUTION_SCHEMA_CHECKSUM,
    issues: [...issues].sort()
  };
}

const RESERVED_SQL_IDENTIFIERS = new Set([
  'all', 'and', 'any', 'array', 'as', 'between', 'check', 'constraint', 'false',
  'foreign', 'from', 'in', 'is', 'key', 'not', 'null', 'or', 'primary',
  'references', 'select', 'true', 'unique', 'where'
]);
const SAFE_DEQUOTED_SQL_IDENTIFIERS: ReadonlySet<string> = new Set<string>(
  Object.values(REQUIRED_COLUMNS)
    .flat()
    .filter(identifier => /^[a-z_][a-z0-9_$]*$/u.test(identifier))
    .filter(identifier => !RESERVED_SQL_IDENTIFIERS.has(identifier))
);

function rewriteSqlSegments(
  value: string,
  rewriteUnquoted: (segment: string) => string,
  rewriteDoubleQuoted: (segment: string, closed: boolean) => string = segment => segment
): string {
  let output = '';
  let unquotedStart = 0;
  let index = 0;
  while (index < value.length) {
    const quote = value[index];
    if (quote !== "'" && quote !== '"') {
      index += 1;
      continue;
    }

    output += rewriteUnquoted(value.slice(unquotedStart, index));
    let end = index + 1;
    let closed = false;
    while (end < value.length) {
      if (value[end] !== quote) {
        end += 1;
        continue;
      }
      if (value[end + 1] === quote) {
        end += 2;
        continue;
      }
      end += 1;
      closed = true;
      break;
    }
    const quotedSegment = value.slice(index, end);
    output += quote === "'"
      ? quotedSegment
      : rewriteDoubleQuoted(quotedSegment, closed);
    index = end;
    unquotedStart = end;
  }
  return output + rewriteUnquoted(value.slice(unquotedStart));
}

function normalizeDefinition(value: unknown): string {
  const normalizedIdentifiers = rewriteSqlSegments(
    String(value ?? ''),
    segment => segment.toLowerCase(),
    (segment, closed) => {
      if (!closed) return segment;
      const identifier = segment.slice(1, -1);
      return SAFE_DEQUOTED_SQL_IDENTIFIERS.has(identifier)
        ? identifier
        : segment;
    }
  );
  const normalizedLiteralCasts = normalizedIdentifiers.replace(
    /('(?:''|[^'])*')::\s*(?:character varying|text)\b/giu,
    '$1'
  );
  return rewriteSqlSegments(
    normalizedLiteralCasts,
    segment => segment
      .replace(/\s+/gu, ' ')
      .replace(/\s*([\[\](),])\s*/gu, '$1')
  ).trim();
}

type BooleanNode =
  | { kind: 'atom'; value: string }
  | { kind: 'between'; left: string; lower: string; upper: string }
  | { kind: 'and' | 'or'; children: BooleanNode[] };

function stripOuterBooleanParentheses(value: string): string {
  let expression = value.trim();
  while (expression.startsWith('(') && expression.endsWith(')')) {
    let depth = 0;
    let activeQuote: "'" | '"' | null = null;
    let enclosesWholeExpression = true;
    for (let index = 0; index < expression.length; index += 1) {
      const character = expression[index];
      if (activeQuote !== null) {
        if (character === activeQuote && expression[index + 1] === activeQuote) {
          index += 1;
          continue;
        }
        if (character === activeQuote) activeQuote = null;
        continue;
      }
      if (character === "'" || character === '"') {
        activeQuote = character;
        continue;
      }
      if (character === '(') depth += 1;
      if (character === ')') {
        depth -= 1;
        if (depth === 0 && index < expression.length - 1) {
          enclosesWholeExpression = false;
          break;
        }
      }
    }
    if (!enclosesWholeExpression || depth !== 0) break;
    expression = expression.slice(1, -1).trim();
  }
  return expression;
}

function splitTopLevelBoolean(value: string, operator: 'and' | 'or'): string[] {
  const parts: string[] = [];
  let start = 0;
  let depth = 0;
  let activeQuote: "'" | '"' | null = null;
  let betweenPending = false;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (activeQuote !== null) {
      if (character === activeQuote && value[index + 1] === activeQuote) {
        index += 1;
        continue;
      }
      if (character === activeQuote) activeQuote = null;
      continue;
    }
    if (character === "'" || character === '"') {
      activeQuote = character;
      continue;
    }
    if (character === '(' || character === '[') {
      depth += 1;
      continue;
    }
    if (character === ')' || character === ']') {
      depth -= 1;
      continue;
    }
    if (depth !== 0 || !/[a-z_]/u.test(character)) continue;
    let end = index + 1;
    while (end < value.length && /[a-z0-9_]/u.test(value[end])) end += 1;
    const word = value.slice(index, end);
    if (word === 'between') {
      betweenPending = true;
    } else if (word === 'and' && betweenPending) {
      betweenPending = false;
    } else if (word === operator) {
      parts.push(value.slice(start, index));
      start = end;
    }
    index = end - 1;
  }
  if (parts.length === 0) return [value];
  parts.push(value.slice(start));
  return parts;
}

function atomicBooleanNode(value: string): BooleanNode {
  const canonical = rewriteSqlSegments(
    value,
    segment => segment.replace(/[()[\]\s]/gu, '')
      // PostgreSQL casts integer bounds when comparing an explicitly numeric expression.
      .replace(/(::numeric(?:>=|<=))([0-9]+)::numeric$/u, '$1$2')
  );
  const between = canonical.match(/^(.+)between(-?[0-9]+)and(-?[0-9]+)$/u);
  if (between) {
    return { kind: 'between', left: between[1], lower: between[2], upper: between[3] };
  }
  return { kind: 'atom', value: canonical };
}

function parseBooleanNode(value: string): BooleanNode {
  const expression = stripOuterBooleanParentheses(value);
  const orParts = splitTopLevelBoolean(expression, 'or');
  if (orParts.length > 1) {
    return { kind: 'or', children: orParts.map(parseBooleanNode) };
  }
  const andParts = splitTopLevelBoolean(expression, 'and');
  if (andParts.length > 1) {
    return { kind: 'and', children: andParts.map(parseBooleanNode) };
  }
  return atomicBooleanNode(expression);
}

function lastIndexOfOutsideQuotes(value: string, needle: string): number {
  let activeQuote: "'" | '"' | null = null;
  let marker = -1;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (activeQuote !== null) {
      if (character === activeQuote && value[index + 1] === activeQuote) {
        index += 1;
        continue;
      }
      if (character === activeQuote) activeQuote = null;
      continue;
    }
    if (character === "'" || character === '"') {
      activeQuote = character;
      continue;
    }
    if (value.startsWith(needle, index)) marker = index;
  }
  return marker;
}

function comparisonParts(
  node: BooleanNode | undefined,
  operator: '>=' | '<='
): { left: string; bound: string } | null {
  if (!node || node.kind !== 'atom') return null;
  const marker = lastIndexOfOutsideQuotes(node.value, operator);
  if (marker <= 0) return null;
  const bound = node.value.slice(marker + operator.length);
  if (!/^-?[0-9]+$/u.test(bound)) return null;
  return { left: node.value.slice(0, marker), bound };
}

function canonicalizeBooleanNode(node: BooleanNode): BooleanNode {
  if (node.kind !== 'and' && node.kind !== 'or') return node;
  const children = node.children
    .map(canonicalizeBooleanNode)
    .flatMap(child => child.kind === node.kind ? child.children : [child]);
  if (node.kind === 'and') {
    const collapsed: BooleanNode[] = [];
    for (let index = 0; index < children.length; index += 1) {
      const lower = comparisonParts(children[index], '>=');
      const upper = comparisonParts(children[index + 1], '<=');
      if (lower && upper && lower.left === upper.left) {
        collapsed.push({
          kind: 'between',
          left: lower.left,
          lower: lower.bound,
          upper: upper.bound
        });
        index += 1;
      } else {
        collapsed.push(children[index]);
      }
    }
    return collapsed.length === 1 ? collapsed[0] : { kind: 'and', children: collapsed };
  }
  return { kind: 'or', children };
}

function renderBooleanNode(node: BooleanNode): string {
  if (node.kind === 'atom') return `atom:${node.value}`;
  if (node.kind === 'between') return `between:${node.left}:${node.lower}:${node.upper}`;
  return `${node.kind}(${node.children.map(renderBooleanNode).join(',')})`;
}

function canonicalCheckDefinition(value: unknown): string {
  const expression = rewriteSqlSegments(
    normalizeDefinition(value),
    segment => segment
      .replace(/^constraint [^ ]+ /u, '')
      .replace(/^check\(/u, '(')
      .replace(/=\s*any\(array\[/gu, 'in(')
      .replace(/\]\)/gu, ')')
  );
  return renderBooleanNode(canonicalizeBooleanNode(parseBooleanNode(expression)));
}

function checkDefinitionHash(value: unknown): string {
  return createHash('sha256').update(canonicalCheckDefinition(value)).digest('hex');
}

function defaultMatches(value: unknown, expected: ColumnDefaultKind): boolean {
  const normalized = normalizeDefinition(value);
  if (expected === 'none') return value === null || value === undefined;
  if (expected === 'current_timestamp') {
    return normalized === 'current_timestamp' || normalized === 'now()';
  }
  if (expected === 'zero') return normalized === '0' || normalized === "'0'";
  return normalized === "'{}'" || normalized === "'{}'::jsonb";
}

interface PostgreSqlArrayParserFactory {
  create(
    source: string,
    transform: (entry: string) => string
  ): { parse(): unknown };
}

let cachedPostgreSqlArrayParser: PostgreSqlArrayParserFactory | null | undefined;

function isStrictFlatPostgreSqlStringArrayLiteral(value: string): boolean {
  if (value.length < 2 || value[0] !== '{' || value[value.length - 1] !== '}') return false;
  if (value === '{}') return true;

  const end = value.length - 1;
  let index = 1;
  while (index < end) {
    if (value[index] === ',') return false;

    if (value[index] === '"') {
      index += 1;
      let closed = false;
      while (index < end) {
        if (value[index] === '\\') {
          index += 1;
          if (index >= end) return false;
          index += 1;
          continue;
        }
        if (value[index] === '"') {
          index += 1;
          closed = true;
          break;
        }
        index += 1;
      }
      if (!closed) return false;
    } else {
      const start = index;
      while (index < end && value[index] !== ',') {
        if (
          value[index] === '{'
          || value[index] === '}'
          || value[index] === '"'
          || value[index] === '\\'
          || /\s/u.test(value[index])
        ) {
          return false;
        }
        index += 1;
      }
      const entry = value.slice(start, index);
      if (entry.length === 0 || entry.toUpperCase() === 'NULL') return false;
    }

    if (index === end) return true;
    if (value[index] !== ',') return false;
    index += 1;
    if (index === end) return false;
  }
  return false;
}

function getPostgreSqlArrayParser(): PostgreSqlArrayParserFactory | null {
  if (cachedPostgreSqlArrayParser !== undefined) return cachedPostgreSqlArrayParser;
  try {
    const pg = createRequire(import.meta.url)('pg') as {
      types?: { arrayParser?: unknown };
    };
    const parser = pg.types?.arrayParser as Partial<PostgreSqlArrayParserFactory> | undefined;
    cachedPostgreSqlArrayParser = typeof parser?.create === 'function'
      ? parser as PostgreSqlArrayParserFactory
      : null;
  } catch {
    cachedPostgreSqlArrayParser = null;
  }
  return cachedPostgreSqlArrayParser;
}

function parsePostgreSqlCatalogStringArray(value: string): string[] | null {
  if (!isStrictFlatPostgreSqlStringArrayLiteral(value)) return null;
  const parser = getPostgreSqlArrayParser();
  if (!parser) return null;
  try {
    const decoded = parser.create(value, entry => entry).parse();
    if (!Array.isArray(decoded) || decoded.some(item => typeof item !== 'string')) return null;
    return [...decoded];
  } catch {
    return null;
  }
}

export function parseCatalogStringArray(value: unknown): string[] | null {
  let decoded: unknown = value;
  if (typeof value === 'string') {
    if (value === '{}') return parsePostgreSqlCatalogStringArray(value);
    try {
      decoded = JSON.parse(value);
    } catch {
      return parsePostgreSqlCatalogStringArray(value);
    }
  }
  if (!Array.isArray(decoded) || decoded.some(item => typeof item !== 'string')) return null;
  return [...decoded];
}

function exactSortedStringSetMatches(actual: string[], expected: string[]): boolean {
  return JSON.stringify([...actual].sort()) === JSON.stringify([...expected].sort());
}

function relationalConstraintMatches(
  row: {
    columns_json: unknown;
    referenced_table_name: string | null;
    referenced_schema_matches: boolean | null;
    referenced_columns_json: unknown;
    update_action: string;
    delete_action: string;
  },
  spec: RelationalConstraintSpec
): boolean {
  const columns = parseCatalogStringArray(row.columns_json);
  const referencedColumns = parseCatalogStringArray(row.referenced_columns_json);
  if (!columns || !referencedColumns) return false;
  if (JSON.stringify(columns) !== JSON.stringify(spec.columns)) return false;
  if (spec.referencedTable === undefined) {
    return row.referenced_table_name === null
      && row.referenced_schema_matches === null
      && referencedColumns.length === 0;
  }
  return row.referenced_table_name === spec.referencedTable
    && row.referenced_schema_matches === true
    && JSON.stringify(referencedColumns) === JSON.stringify(spec.referencedColumns)
    && row.update_action === spec.updateAction
    && row.delete_action === spec.deleteAction;
}

function predicateStates(predicate: unknown): string[] | null {
  if (predicate === null || predicate === undefined || String(predicate).trim() === '') return [];
  const normalized = stripOuterBooleanParentheses(normalizeDefinition(predicate));
  const equality = normalized.match(/^state\s*=\s*'(REQUESTED|CLAIMED|RUNNING)'$/u);
  if (equality) return [equality[1]];

  const membership = normalized.match(/^state in\((.*)\)$/u)
    ?? normalized.match(/^state\s*=\s*any\(array\[(.*)\]\)$/u);
  if (!membership || membership[1].length === 0) return null;
  const values = [...membership[1].matchAll(/'(REQUESTED|CLAIMED|RUNNING)'/gu)]
    .map(match => match[1]);
  if (values.length === 0 || values.map(value => `'${value}'`).join(',') !== membership[1]) {
    return null;
  }
  return values.sort();
}

function indexStructurallyMatches(
  row: {
    table_name: string;
    schema_matches: boolean;
    unique: boolean;
    access_method: string;
    columns_json: unknown;
    predicate: string | null;
    key_count: number;
    attribute_count: number;
    expressions_absent: boolean;
    sort_options_default: boolean;
    opclasses_default: boolean;
    collations_default: boolean;
  },
  spec: IndexSpec
): boolean {
  const columns = parseCatalogStringArray(row.columns_json);
  return Boolean(
    columns
    && row.schema_matches === true
    && row.table_name === spec.table
    && row.unique === spec.unique
    && row.access_method === 'btree'
    && row.key_count === spec.columns.length
    && row.attribute_count === spec.columns.length
    && row.expressions_absent === true
    && row.sort_options_default === true
    && row.opclasses_default === true
    && row.collations_default === true
    && JSON.stringify(columns) === JSON.stringify(spec.columns)
    && JSON.stringify(predicateStates(row.predicate)) === JSON.stringify(spec.predicateStates)
  );
}

/**
 * Read-only verification for the Phase 2E schema contract.
 *
 * This function deliberately performs no DDL and never attempts migration repair.
 * Protocol adapters must fail closed unless it returns `ready: true`.
 */
export async function verifyActionPlanExecutionSchema(
  queryable: ActionPlanExecutionSchemaQueryable
): Promise<ActionPlanExecutionSchemaVerification> {
  try {
    const ledgerRelationResult = await queryable.query<{ exists: boolean }>(
      'SELECT to_regclass($1::text) IS NOT NULL AS exists',
      ['"ActionPlanExecutionSchemaMigration"']
    );
    if (ledgerRelationResult.rows[0]?.exists !== true) {
      return verification('ACTION_PLAN_EXECUTION_SCHEMA_MISSING', ['SCHEMA_LEDGER_MISSING']);
    }

    const ledgerResult = await queryable.query<{
      checksum: string;
      completedPhase: string;
      validityState: string;
      appliedAt: Date | null;
    }>(
      `SELECT "checksum", "completedPhase", "validityState", "appliedAt"
       FROM "ActionPlanExecutionSchemaMigration"
       WHERE "version" = $1`,
      [ACTION_PLAN_EXECUTION_SCHEMA_VERSION]
    );

    if (ledgerResult.rows.length === 0) {
      return verification('ACTION_PLAN_EXECUTION_SCHEMA_MISSING', ['SCHEMA_LEDGER_MISSING']);
    }

    const issues: string[] = [];
    const ledger = ledgerResult.rows[0];
    if (ledger.checksum !== ACTION_PLAN_EXECUTION_SCHEMA_CHECKSUM) {
      issues.push('SCHEMA_CHECKSUM_MISMATCH');
    }
    if (ledger.completedPhase !== 'complete') issues.push('SCHEMA_MIGRATION_INCOMPLETE');
    if (ledger.validityState !== 'VALID') issues.push('SCHEMA_LEDGER_NOT_VALID');
    if (!ledger.appliedAt) issues.push('SCHEMA_APPLIED_AT_MISSING');

    const tableResult = await queryable.query<{ table_name: string }>(
      `SELECT table_name
       FROM information_schema.tables
       WHERE table_schema = current_schema()
         AND table_name = ANY($1::text[])`,
      [[...REQUIRED_TABLES]]
    );
    const tables = new Set(tableResult.rows.map(row => row.table_name));
    for (const table of REQUIRED_TABLES) {
      if (!tables.has(table)) issues.push(`SCHEMA_TABLE_MISSING:${table}`);
    }

    const requiredTableNames = Object.keys(REQUIRED_COLUMNS);
    const columnResult = await queryable.query<{
      table_name: string;
      column_name: string;
      udt_name: string;
      is_nullable: string;
      column_default: string | null;
    }>(
      `SELECT table_name, column_name, udt_name, is_nullable, column_default
       FROM information_schema.columns
       WHERE table_schema = current_schema()
         AND table_name = ANY($1::text[])`,
      [requiredTableNames]
    );
    const columns = new Map(
      columnResult.rows.map(row => [`${row.table_name}.${row.column_name}`, row])
    );
    for (const [table, requiredColumns] of Object.entries(REQUIRED_COLUMNS)) {
      for (const column of requiredColumns) {
        const key = `${table}.${column}`;
        const actual = columns.get(key);
        if (!actual) {
          issues.push(`SCHEMA_COLUMN_MISSING:${table}.${column}`);
          continue;
        }
        const expected = REQUIRED_COLUMN_SPECS[table]?.[column];
        if (
          !expected
          || actual.udt_name !== expected.type
          || (actual.is_nullable === 'YES') !== expected.nullable
          || !defaultMatches(actual.column_default, expected.defaultKind)
        ) {
          issues.push(`SCHEMA_COLUMN_DEFINITION_INVALID:${table}.${column}`);
        }
      }
    }

    const constraintResult = await queryable.query<{
      name: string;
      table_name: string;
      type: string;
      validated: boolean;
      definition: string;
      columns_json: unknown;
      referenced_table_name: string | null;
      referenced_schema_matches: boolean | null;
      referenced_columns_json: unknown;
      update_action: string;
      delete_action: string;
      deferrable: boolean;
      initially_deferred: boolean;
    }>(
      `SELECT constraint_data.conname AS name,
              table_relation.relname AS table_name,
              constraint_data.contype AS type,
              constraint_data.convalidated AS validated,
              constraint_data.condeferrable AS deferrable,
              constraint_data.condeferred AS initially_deferred,
              pg_get_constraintdef(constraint_data.oid, true) AS definition,
              to_json(ARRAY(
                SELECT attribute.attname::text
                FROM unnest(constraint_data.conkey) WITH ORDINALITY AS key_column(attnum, position)
                JOIN pg_attribute AS attribute
                  ON attribute.attrelid = constraint_data.conrelid
                 AND attribute.attnum = key_column.attnum
                ORDER BY key_column.position
              )::text[])::text AS columns_json,
              referenced_relation.relname AS referenced_table_name,
              referenced_namespace.nspname = current_schema() AS referenced_schema_matches,
              to_json(CASE WHEN constraint_data.confrelid = 0 THEN ARRAY[]::text[] ELSE ARRAY(
                SELECT referenced_attribute.attname::text
                FROM unnest(constraint_data.confkey) WITH ORDINALITY AS referenced_key(attnum, position)
                JOIN pg_attribute AS referenced_attribute
                  ON referenced_attribute.attrelid = constraint_data.confrelid
                 AND referenced_attribute.attnum = referenced_key.attnum
                ORDER BY referenced_key.position
              )::text[] END)::text AS referenced_columns_json,
              constraint_data.confupdtype AS update_action,
              constraint_data.confdeltype AS delete_action
       FROM pg_constraint AS constraint_data
       JOIN pg_namespace AS namespace ON namespace.oid = constraint_data.connamespace
       JOIN pg_class AS table_relation ON table_relation.oid = constraint_data.conrelid
       LEFT JOIN pg_class AS referenced_relation ON referenced_relation.oid = constraint_data.confrelid
       LEFT JOIN pg_namespace AS referenced_namespace ON referenced_namespace.oid = referenced_relation.relnamespace
       WHERE namespace.nspname = current_schema()
         AND constraint_data.conname = ANY($1::text[])`,
      [[...REQUIRED_CONSTRAINTS]]
    );
    for (const name of REQUIRED_CONSTRAINTS) {
      const matches = constraintResult.rows.filter(row => row.name === name);
      const expected = REQUIRED_CONSTRAINT_SPECS[name];
      const relationalExpected = REQUIRED_RELATIONAL_CONSTRAINT_SPECS[name];
      const checkColumnsExpected = REQUIRED_CHECK_COLUMN_SETS[name];
      if (matches.length === 0) {
        issues.push(`SCHEMA_CONSTRAINT_MISSING:${name}`);
        continue;
      }
      if (
        matches.length !== 1
        || !expected
        || matches[0].table_name !== expected.table
        || matches[0].type !== expected.type
        || matches[0].deferrable !== expected.deferrable
        || matches[0].initially_deferred !== expected.initiallyDeferred
        || parseCatalogStringArray(matches[0].columns_json) === null
        || parseCatalogStringArray(matches[0].referenced_columns_json) === null
        || (
          expected.type === 'c'
            ? !checkColumnsExpected
              || !exactSortedStringSetMatches(
                parseCatalogStringArray(matches[0].columns_json) ?? [],
                checkColumnsExpected
              )
              || checkDefinitionHash(matches[0].definition) !== REQUIRED_CHECK_DEFINITION_HASHES[name]
            : !relationalExpected || !relationalConstraintMatches(matches[0], relationalExpected)
        )
      ) {
        issues.push(`SCHEMA_CONSTRAINT_DEFINITION_INVALID:${name}`);
      }
      if (matches[0].validated !== true) {
        issues.push(`SCHEMA_CONSTRAINT_NOT_VALID:${name}`);
      }
    }

    const indexResult = await queryable.query<{
      name: string;
      table_name: string;
      unique: boolean;
      valid: boolean;
      ready: boolean;
      schema_matches: boolean;
      access_method: string;
      columns_json: unknown;
      predicate: string | null;
      key_count: number;
      attribute_count: number;
      expressions_absent: boolean;
      sort_options_default: boolean;
      opclasses_default: boolean;
      collations_default: boolean;
    }>(
      `SELECT index_relation.relname AS name,
              table_relation.relname AS table_name,
              index_data.indisunique AS unique,
              index_data.indisvalid AS valid,
              index_data.indisready AS ready,
              namespace.nspname = current_schema() AS schema_matches,
              access_method.amname AS access_method,
              index_data.indnkeyatts::integer AS key_count,
              index_data.indnatts::integer AS attribute_count,
              index_data.indexprs IS NULL AS expressions_absent,
              cardinality(index_data.indoption::smallint[]) >= index_data.indnkeyatts
                AND NOT EXISTS (
                  SELECT 1
                  FROM unnest(index_data.indoption::smallint[]) WITH ORDINALITY
                    AS index_option(option_bits, position)
                  WHERE index_option.position <= index_data.indnkeyatts
                    AND index_option.option_bits <> 0
                ) AS sort_options_default,
              cardinality(index_data.indclass::oid[]) >= index_data.indnkeyatts
                AND NOT EXISTS (
                  SELECT 1
                  FROM unnest(
                    index_data.indclass::oid[],
                    index_data.indkey::smallint[]
                  ) WITH ORDINALITY AS index_opclass(opclass_oid, attnum, position)
                  LEFT JOIN pg_opclass AS operator_class
                    ON operator_class.oid = index_opclass.opclass_oid
                  LEFT JOIN pg_attribute AS opclass_attribute
                    ON opclass_attribute.attrelid = index_data.indrelid
                   AND opclass_attribute.attnum = index_opclass.attnum
                  WHERE index_opclass.position <= index_data.indnkeyatts
                    AND (
                      operator_class.opcdefault IS DISTINCT FROM true
                      OR operator_class.opcmethod IS DISTINCT FROM index_relation.relam
                      OR operator_class.opcintype IS DISTINCT FROM opclass_attribute.atttypid
                    )
                ) AS opclasses_default,
              cardinality(index_data.indcollation::oid[]) >= index_data.indnkeyatts
                AND NOT EXISTS (
                  SELECT 1
                  FROM unnest(
                    index_data.indcollation::oid[],
                    index_data.indkey::smallint[]
                  ) WITH ORDINALITY AS index_collation(collation_oid, attnum, position)
                  LEFT JOIN pg_attribute AS collated_attribute
                    ON collated_attribute.attrelid = index_data.indrelid
                   AND collated_attribute.attnum = index_collation.attnum
                  WHERE index_collation.position <= index_data.indnkeyatts
                    AND index_collation.collation_oid
                      IS DISTINCT FROM collated_attribute.attcollation
                ) AS collations_default,
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
       FROM pg_class AS index_relation
       JOIN pg_index AS index_data ON index_data.indexrelid = index_relation.oid
       JOIN pg_class AS table_relation ON table_relation.oid = index_data.indrelid
       JOIN pg_am AS access_method ON access_method.oid = index_relation.relam
       JOIN pg_namespace AS namespace ON namespace.oid = index_relation.relnamespace
       WHERE namespace.nspname = current_schema()
         AND index_relation.relname = ANY($1::text[])`,
      [[...REQUIRED_INDEXES]]
    );
    for (const name of REQUIRED_INDEXES) {
      const matches = indexResult.rows.filter(row => row.name === name);
      const expected = REQUIRED_INDEX_SPECS[name];
      if (matches.length === 0) {
        issues.push(`SCHEMA_INDEX_MISSING:${name}`);
        continue;
      }
      const actual = matches[0];
      if (
        matches.length !== 1
        || !expected
        || !indexStructurallyMatches(actual, expected)
      ) {
        issues.push(`SCHEMA_INDEX_DEFINITION_INVALID:${name}`);
      }
      if (actual.valid !== true || actual.ready !== true) {
        issues.push(`SCHEMA_INDEX_INVALID:${name}`);
      }
    }

    return verification(
      issues.length === 0
        ? 'ACTION_PLAN_EXECUTION_SCHEMA_READY'
        : 'ACTION_PLAN_EXECUTION_SCHEMA_INVALID',
      issues
    );
  } catch {
    return verification('ACTION_PLAN_EXECUTION_SCHEMA_UNAVAILABLE', ['SCHEMA_QUERY_FAILED']);
  }
}

/** Verify the connected application pool without mutating schema or connection state. */
export async function verifyConfiguredActionPlanExecutionSchema(): Promise<ActionPlanExecutionSchemaVerification> {
  const pool = getPool();
  if (!pool) {
    return verification('ACTION_PLAN_EXECUTION_SCHEMA_UNAVAILABLE', ['SCHEMA_POOL_UNAVAILABLE']);
  }
  return verifyActionPlanExecutionSchema(pool as PoolType);
}
