#!/usr/bin/env node

import { createHash } from 'node:crypto';
import schemaContract from '../src/core/db/actionPlanExecutionSchemaContract.json' with { type: 'json' };
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
export const REPOSITORY_ROOT = resolve(SCRIPT_DIR, '..');
export const MIGRATION_DIRECTORY = join(
  REPOSITORY_ROOT,
  'migrations',
  '20260717_action_plan_execution_v2',
);
export const MIGRATION_MANIFEST_PATH = join(MIGRATION_DIRECTORY, 'manifest.json');
export const MIGRATION_DATABASE_ENV = 'ACTION_PLAN_EXECUTION_MIGRATION_DATABASE_URL';
export const REVIEWED_MIGRATION_VERSION = schemaContract.version;
export const REVIEWED_MIGRATION_CHECKSUM = schemaContract.checksum;

// Consume the same execution-free contract without importing runtime database modules.
// Each consumer retains the previous independent internals and shallow-frozen public export.
const {
  tables: EXPECTED_TABLES,
  columns: EXPECTED_COLUMNS,
  columnSpecs: EXPECTED_COLUMN_SPECS,
  constraints: EXPECTED_CONSTRAINTS,
  constraintSpecs: EXPECTED_CONSTRAINT_SPECS,
  checkColumnSets: EXPECTED_CHECK_COLUMN_SETS,
  relationalConstraintSpecs: EXPECTED_RELATIONAL_CONSTRAINT_SPECS,
  indexes: EXPECTED_INDEXES,
  indexSpecs: EXPECTED_INDEX_SPECS,
} = structuredClone(schemaContract.requirements);
const EXPECTED_CHECK_DEFINITION_HASHES = structuredClone(schemaContract.checkDefinitionHashes);

export const ACTION_PLAN_EXECUTION_SCHEMA_REQUIREMENTS = Object.freeze({
  tables: [...EXPECTED_TABLES],
  columns: Object.fromEntries(
    Object.entries(EXPECTED_COLUMNS).map(([table, columns]) => [table, [...columns]]),
  ),
  columnSpecs: EXPECTED_COLUMN_SPECS,
  constraints: [...EXPECTED_CONSTRAINTS],
  constraintSpecs: EXPECTED_CONSTRAINT_SPECS,
  checkColumnSets: EXPECTED_CHECK_COLUMN_SETS,
  relationalConstraintSpecs: EXPECTED_RELATIONAL_CONSTRAINT_SPECS,
  indexes: [...EXPECTED_INDEXES],
  indexSpecs: EXPECTED_INDEX_SPECS,
});

export class MigrationError extends Error {
  constructor(code) {
    super(code);
    this.name = 'MigrationError';
    this.code = code;
  }
}

function normalizeSql(text) {
  return text.replace(/\r\n/g, '\n');
}

const RESERVED_SQL_IDENTIFIERS = new Set([
  'all', 'and', 'any', 'array', 'as', 'between', 'check', 'constraint', 'false',
  'foreign', 'from', 'in', 'is', 'key', 'not', 'null', 'or', 'primary',
  'references', 'select', 'true', 'unique', 'where',
]);
const SAFE_DEQUOTED_SQL_IDENTIFIERS = new Set(
  Object.values(EXPECTED_COLUMNS)
    .flat()
    // Reviewed lowercase columns in the migration-history schema use this hash too.
    .concat(['operation', 'phase'])
    .filter((identifier) => /^[a-z_][a-z0-9_$]*$/u.test(identifier))
    .filter((identifier) => !RESERVED_SQL_IDENTIFIERS.has(identifier)),
);

function rewriteSqlSegments(value, rewriteUnquoted, rewriteDoubleQuoted = (segment) => segment) {
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

function normalizeDefinition(value) {
  const normalizedIdentifiers = rewriteSqlSegments(
    String(value ?? ''),
    (segment) => segment.toLowerCase(),
    (segment, closed) => {
      if (!closed) return segment;
      const identifier = segment.slice(1, -1);
      return /^[a-z_][a-z0-9_$]*$/u.test(identifier)
        && !RESERVED_SQL_IDENTIFIERS.has(identifier)
        && SAFE_DEQUOTED_SQL_IDENTIFIERS.has(identifier)
        ? identifier
        : segment;
    },
  );
  const normalizedLiteralCasts = normalizedIdentifiers.replace(
    /('(?:''|[^'])*')::\s*(?:character varying|text)\b/giu,
    '$1',
  );
  return rewriteSqlSegments(
    normalizedLiteralCasts,
    (segment) => segment
      .replace(/\s+/gu, ' ')
      .replace(/\s*([\[\](),])\s*/gu, '$1'),
  ).trim();
}

function stripOuterBooleanParentheses(value) {
  let expression = value.trim();
  while (expression.startsWith('(') && expression.endsWith(')')) {
    let depth = 0;
    let activeQuote = null;
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

function splitTopLevelBoolean(value, operator) {
  const parts = [];
  let start = 0;
  let depth = 0;
  let activeQuote = null;
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

/**
 * Turn an already normalized CHECK leaf into a BETWEEN node or opaque hash atom.
 * Quoted text stays intact. Numeric-cast normalization is limited to an unsigned
 * integer bound ending an unquoted segment after `::numeric >=` or `::numeric <=`;
 * other casts, operators, and arithmetic remain distinguishable by the reviewed
 * hash comparison. This helper does not establish general SQL equivalence or readiness.
 */
function atomicBooleanNode(value) {
  const canonical = rewriteSqlSegments(
    value,
    (segment) => segment.replace(/[()[\]\s]/gu, '')
      // PostgreSQL casts integer bounds when comparing an explicitly numeric expression.
      .replace(/(::numeric(?:>=|<=))([0-9]+)::numeric$/u, '$1$2'),
  );
  const between = canonical.match(/^(.+)between(-?[0-9]+)and(-?[0-9]+)$/u);
  if (between) {
    return { kind: 'between', left: between[1], lower: between[2], upper: between[3] };
  }
  return { kind: 'atom', value: canonical };
}

function parseBooleanNode(value) {
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

function lastIndexOfOutsideQuotes(value, needle) {
  let activeQuote = null;
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

function comparisonParts(node, operator) {
  if (!node || node.kind !== 'atom') return null;
  const marker = lastIndexOfOutsideQuotes(node.value, operator);
  if (marker <= 0) return null;
  const bound = node.value.slice(marker + operator.length);
  if (!/^-?[0-9]+$/u.test(bound)) return null;
  return { left: node.value.slice(0, marker), bound };
}

function canonicalizeBooleanNode(node) {
  if (node.kind !== 'and' && node.kind !== 'or') return node;
  const children = node.children
    .map(canonicalizeBooleanNode)
    .flatMap((child) => child.kind === node.kind ? child.children : [child]);
  if (node.kind === 'and') {
    const collapsed = [];
    for (let index = 0; index < children.length; index += 1) {
      const lower = comparisonParts(children[index], '>=');
      const upper = comparisonParts(children[index + 1], '<=');
      if (lower && upper && lower.left === upper.left) {
        collapsed.push({
          kind: 'between',
          left: lower.left,
          lower: lower.bound,
          upper: upper.bound,
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

function renderBooleanNode(node) {
  if (node.kind === 'atom') return `atom:${node.value}`;
  if (node.kind === 'between') return `between:${node.left}:${node.lower}:${node.upper}`;
  return `${node.kind}(${node.children.map(renderBooleanNode).join(',')})`;
}

function canonicalCheckDefinition(value) {
  const expression = rewriteSqlSegments(
    normalizeDefinition(value),
    (segment) => segment
      .replace(/^constraint [^ ]+ /u, '')
      .replace(/^check\(/u, '(')
      .replace(/=\s*any\(array\[/gu, 'in(')
      .replace(/\]\)/gu, ')'),
  );
  return renderBooleanNode(canonicalizeBooleanNode(parseBooleanNode(expression)));
}

export function checkDefinitionHash(value) {
  return createHash('sha256').update(canonicalCheckDefinition(value)).digest('hex');
}

export function extractCheckDefinitions(sql) {
  const definitions = new Map();
  const pattern = /CONSTRAINT\s+"([^"]+)"\s+CHECK\s*\(/giu;
  for (const match of sql.matchAll(pattern)) {
    const name = match[1];
    const start = (match.index ?? 0) + match[0].lastIndexOf('(');
    let depth = 0;
    let inString = false;
    let end = -1;
    for (let index = start; index < sql.length; index += 1) {
      const character = sql[index];
      if (character === "'") {
        if (inString && sql[index + 1] === "'") {
          index += 1;
          continue;
        }
        inString = !inString;
      }
      if (inString) continue;
      if (character === '(') depth += 1;
      if (character === ')') {
        depth -= 1;
        if (depth === 0) {
          end = index;
          break;
        }
      }
    }
    if (end < 0) throw new MigrationError(`MIGRATION_CHECK_DEFINITION_UNCLOSED:${name}`);
    definitions.set(name, `CHECK ${sql.slice(start, end + 1)}`);
  }
  return definitions;
}

export function loadReviewedCheckDefinitions(
  manifest = loadMigrationManifest(),
  directory = MIGRATION_DIRECTORY,
) {
  return extractCheckDefinitions(
    manifest.phases
      .map((phase) => normalizeSql(readFileSync(join(directory, phase.path), 'utf8')))
      .join('\n'),
  );
}

function defaultMatches(value, expected) {
  const normalized = normalizeDefinition(value);
  if (expected === 'none') return value === null || value === undefined;
  if (expected === 'current_timestamp') {
    return normalized === 'current_timestamp' || normalized === 'now()';
  }
  if (expected === 'zero') {
    return normalized === '0' || normalized === normalizeDefinition("'0'");
  }
  return normalized === normalizeDefinition("'{}'")
    || normalized === normalizeDefinition("'{}'::jsonb");
}

let cachedPostgreSqlArrayParser;

function isStrictFlatPostgreSqlStringArrayLiteral(value) {
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

function getPostgreSqlArrayParser() {
  if (cachedPostgreSqlArrayParser !== undefined) return cachedPostgreSqlArrayParser;
  try {
    const pg = createRequire(import.meta.url)('pg');
    const parser = pg?.types?.arrayParser;
    cachedPostgreSqlArrayParser = typeof parser?.create === 'function' ? parser : null;
  } catch {
    cachedPostgreSqlArrayParser = null;
  }
  return cachedPostgreSqlArrayParser;
}

function parsePostgreSqlCatalogStringArray(value) {
  if (!isStrictFlatPostgreSqlStringArrayLiteral(value)) return null;
  const parser = getPostgreSqlArrayParser();
  if (!parser) return null;
  try {
    const decoded = parser.create(value, (entry) => entry).parse();
    if (!Array.isArray(decoded) || decoded.some((item) => typeof item !== 'string')) return null;
    return [...decoded];
  } catch {
    return null;
  }
}

export function parseCatalogJsonTextArray(value) {
  let decoded = value;
  if (typeof value === 'string') {
    if (value === '{}') return parsePostgreSqlCatalogStringArray(value);
    try {
      decoded = JSON.parse(value);
    } catch {
      return parsePostgreSqlCatalogStringArray(value);
    }
  }
  if (!Array.isArray(decoded) || decoded.some((item) => typeof item !== 'string')) return null;
  return [...decoded];
}

function relationalConstraintMatches(row, spec) {
  const columns = parseCatalogJsonTextArray(row.columns_json);
  const referencedColumns = parseCatalogJsonTextArray(row.referenced_columns_json);
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

function checkConstraintColumnsMatch(row, name) {
  const columns = parseCatalogJsonTextArray(row.columns_json);
  const referencedColumns = parseCatalogJsonTextArray(row.referenced_columns_json);
  const expected = EXPECTED_CHECK_COLUMN_SETS[name];
  if (!columns || !referencedColumns || !expected || referencedColumns.length !== 0) return false;
  if (new Set(columns).size !== columns.length) return false;
  return JSON.stringify([...columns].sort()) === JSON.stringify([...expected].sort());
}

function predicateStates(predicate) {
  if (predicate === null || predicate === undefined || String(predicate).trim() === '') return [];
  const normalized = stripOuterBooleanParentheses(normalizeDefinition(predicate));
  const equality = normalized.match(/^state\s*=\s*'(REQUESTED|CLAIMED|RUNNING)'$/u);
  if (equality) return [equality[1]];

  const membership = normalized.match(/^state in\((.*)\)$/u)
    ?? normalized.match(/^state\s*=\s*any\(array\[(.*)\]\)$/u);
  if (!membership || membership[1].length === 0) return null;
  const values = [...membership[1].matchAll(/'(REQUESTED|CLAIMED|RUNNING)'/gu)]
    .map((match) => match[1]);
  if (values.length === 0 || values.map((value) => `'${value}'`).join(',') !== membership[1]) {
    return null;
  }
  return values.sort();
}

function indexStructurallyMatches(row, spec) {
  const columns = parseCatalogJsonTextArray(row?.columns_json);
  return Boolean(
    row
    && spec
    && columns
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

export function loadMigrationManifest(path = MIGRATION_MANIFEST_PATH) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

export function calculateMigrationChecksum(
  manifest = loadMigrationManifest(),
  directory = MIGRATION_DIRECTORY,
) {
  const hash = createHash('sha256');
  hash.update(`${manifest.version}\n`);
  for (const phase of manifest.phases) {
    const sql = normalizeSql(readFileSync(join(directory, phase.path), 'utf8'));
    hash.update(`${phase.id}\n${sql}\n`);
  }
  return hash.digest('hex');
}

/**
 * Check a repository-owned manifest and migration directory against reviewed artifacts.
 * Return the calculated checksum and sorted issues, with `ok: false` on validation
 * failure; checksum input normalizes SQL line endings from CRLF to LF only.
 * File, JSON, and malformed-input errors propagate instead of producing success.
 * No database is contacted: artifact validity establishes neither catalog readiness
 * nor authorization to apply a migration.
 */
export function validateMigrationArtifacts({
  manifest = loadMigrationManifest(),
  directory = MIGRATION_DIRECTORY,
} = {}) {
  const issues = [];
  const calculatedChecksum = calculateMigrationChecksum(manifest, directory);
  if (manifest.version !== REVIEWED_MIGRATION_VERSION) {
    issues.push('MIGRATION_VERSION_MISMATCH');
  }
  if (
    calculatedChecksum !== manifest.checksum
    || manifest.checksum !== REVIEWED_MIGRATION_CHECKSUM
  ) {
    issues.push('MIGRATION_CHECKSUM_MISMATCH');
  }
  if (manifest.schemaLabel !== schemaContract.schemaLabel) {
    issues.push('MIGRATION_SCHEMA_LABEL_INVALID');
  }
  if (manifest.protocolVersion !== schemaContract.protocolVersion
    || manifest.snapshotSchemaVersion !== schemaContract.snapshotSchemaVersion) {
    issues.push('MIGRATION_PROTOCOL_VERSION_INVALID');
  }
  if (!/^[0-9]+$/.test(manifest.advisoryLockKey)) {
    issues.push('MIGRATION_ADVISORY_LOCK_INVALID');
  }

  const seenPhaseIds = new Set();
  const forwardSqlParts = [];
  for (const phase of manifest.phases) {
    if (seenPhaseIds.has(phase.id)) {
      issues.push(`MIGRATION_PHASE_DUPLICATE:${phase.id}`);
    }
    seenPhaseIds.add(phase.id);
    const sql = normalizeSql(readFileSync(join(directory, phase.path), 'utf8'));
    forwardSqlParts.push(sql);
    const sqlWithoutComments = sql.replace(/--[^\n]*/g, '');
    if (/(?:^|;)\s*(?:DROP\b|TRUNCATE\b|DELETE\s+FROM\b)/im.test(sqlWithoutComments)) {
      issues.push(`MIGRATION_FORWARD_DESTRUCTIVE_SQL:${phase.id}`);
    }
    if (phase.transactional === false) {
      if (!/^\s*(?:--[^\n]*\n\s*)*CREATE\s+UNIQUE\s+INDEX\s+CONCURRENTLY\b/i.test(sql)) {
        issues.push(`MIGRATION_NONTRANSACTIONAL_PHASE_INVALID:${phase.id}`);
      }
      const statements = sql
        .split(';')
        .map((value) => value.replace(/--[^\n]*/g, '').trim())
        .filter(Boolean);
      if (statements.length !== 1) {
        issues.push(`MIGRATION_CONCURRENT_PHASE_NOT_SINGLE_STATEMENT:${phase.id}`);
      }
    }
  }

  const reviewedChecks = extractCheckDefinitions(forwardSqlParts.join('\n'));
  for (const [name, expectedHash] of Object.entries(EXPECTED_CHECK_DEFINITION_HASHES)) {
    const definition = reviewedChecks.get(name);
    if (!definition || checkDefinitionHash(definition) !== expectedHash) {
      issues.push(`MIGRATION_CHECK_DEFINITION_MISMATCH:${name}`);
    }
  }
  for (const name of reviewedChecks.keys()) {
    if (!Object.hasOwn(EXPECTED_CHECK_DEFINITION_HASHES, name)) {
      issues.push(`MIGRATION_CHECK_DEFINITION_UNREVIEWED:${name}`);
    }
  }

  const compensationSql = readFileSync(join(directory, manifest.compensationPath), 'utf8');
  if (!compensationSql.includes('LOCAL-EPHEMERAL COMPENSATING ROLLBACK ONLY')) {
    issues.push('MIGRATION_COMPENSATION_GUARD_BANNER_MISSING');
  }

  return {
    ok: issues.length === 0,
    version: manifest.version,
    schemaLabel: manifest.schemaLabel,
    protocolVersion: manifest.protocolVersion,
    snapshotSchemaVersion: manifest.snapshotSchemaVersion,
    checksum: manifest.checksum,
    calculatedChecksum,
    phases: manifest.phases.map(({ id, path, transactional }) => ({ id, path, transactional })),
    compensationPath: manifest.compensationPath,
    issues: issues.sort(),
    databaseConnected: false,
    databaseMutated: false,
  };
}

export function assertLocalEphemeralConnectionString(connectionString) {
  let parsed;
  try {
    parsed = new URL(connectionString);
  } catch {
    throw new MigrationError('MIGRATION_DATABASE_URL_INVALID');
  }
  if (!['postgres:', 'postgresql:'].includes(parsed.protocol)) {
    throw new MigrationError('MIGRATION_DATABASE_PROTOCOL_INVALID');
  }
  if (parsed.search.length > 0 || parsed.hash.length > 0) {
    throw new MigrationError('MIGRATION_DATABASE_OPTIONS_FORBIDDEN');
  }
  const hostname = parsed.hostname.toLowerCase();
  if (!['localhost', '127.0.0.1', '[::1]', '::1'].includes(hostname)) {
    throw new MigrationError('MIGRATION_DATABASE_NOT_LOOPBACK');
  }
  const databaseName = decodeURIComponent(parsed.pathname.replace(/^\//, '')).toLowerCase();
  if (!/^arcanos_phase2e_[a-z0-9_]+$/.test(databaseName)) {
    throw new MigrationError('MIGRATION_DATABASE_NOT_EXPLICIT_EPHEMERAL');
  }
  return { hostname: 'loopback', databaseName };
}

async function relationExists(client, relationName) {
  const result = await client.query(
    'SELECT to_regclass($1::text) IS NOT NULL AS exists',
    [`"${relationName}"`],
  );
  return result.rows[0]?.exists === true;
}

async function readLedger(client, manifest) {
  if (!(await relationExists(client, 'ActionPlanExecutionSchemaMigration'))) {
    return null;
  }
  const result = await client.query(
    `SELECT "checksum", "completedPhase", "validityState", "appliedAt"
     FROM "ActionPlanExecutionSchemaMigration"
     WHERE "version" = $1`,
    [manifest.version],
  );
  return result.rows[0] ?? null;
}

async function writeLedger(client, manifest, completedPhase, validityState, applied = false) {
  const result = await client.query(
    `INSERT INTO "ActionPlanExecutionSchemaMigration"
       ("version", "checksum", "completedPhase", "validityState", "appliedAt", "updatedAt")
     VALUES ($1, $2, $3, $4, CASE WHEN $5::boolean THEN CURRENT_TIMESTAMP ELSE NULL END, CURRENT_TIMESTAMP)
     ON CONFLICT ("version") DO UPDATE SET
       "completedPhase" = EXCLUDED."completedPhase",
       "validityState" = EXCLUDED."validityState",
       "appliedAt" = CASE
         WHEN EXCLUDED."validityState" = 'FAILED' THEN NULL
         WHEN $5::boolean THEN CURRENT_TIMESTAMP
         ELSE "ActionPlanExecutionSchemaMigration"."appliedAt"
       END,
       "updatedAt" = CURRENT_TIMESTAMP
     WHERE "ActionPlanExecutionSchemaMigration"."checksum" = EXCLUDED."checksum"
     RETURNING "version"`,
    [manifest.version, manifest.checksum, completedPhase, validityState, applied],
  );
  if (result.rowCount !== 1) {
    throw new MigrationError('MIGRATION_LEDGER_CHECKSUM_CONFLICT');
  }
}

async function inspectConcurrentIndex(client, name) {
  const result = await client.query(
    `SELECT index_relation.relname AS name,
            table_relation.relname AS table_name,
            index_data.indisunique AS unique,
            index_data.indisvalid AS valid,
            index_data.indisready AS ready,
            namespace.nspname = current_schema() AS schema_matches,
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
            access_method.amname AS access_method,
            to_json(ARRAY(
              SELECT attribute.attname::text
              FROM unnest(index_data.indkey::smallint[]) WITH ORDINALITY AS key_column(attnum, position)
              JOIN pg_attribute AS attribute
                ON attribute.attrelid = index_data.indrelid
               AND attribute.attnum = key_column.attnum
              WHERE key_column.position <= index_data.indnkeyatts
              ORDER BY key_column.position
            ))::text AS columns_json,
            pg_get_expr(index_data.indpred, index_data.indrelid, true) AS predicate
     FROM pg_class AS index_relation
     JOIN pg_index AS index_data ON index_data.indexrelid = index_relation.oid
     JOIN pg_class AS table_relation ON table_relation.oid = index_data.indrelid
     JOIN pg_am AS access_method ON access_method.oid = index_relation.relam
     JOIN pg_namespace AS namespace ON namespace.oid = index_relation.relnamespace
     WHERE namespace.nspname = current_schema()
       AND index_relation.relname = $1`,
    [name],
  );
  return result.rows[0] ?? null;
}

async function runPhase(client, manifest, phase, sql) {
  if (phase.transactional) {
    await client.query('BEGIN');
    try {
      await client.query("SET LOCAL lock_timeout TO '5s'");
      await client.query("SET LOCAL statement_timeout TO '60s'");
      await client.query(sql);
      await writeLedger(client, manifest, phase.id, 'IN_PROGRESS');
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
    return;
  }

  const index = await inspectConcurrentIndex(client, phase.concurrentIndex);
  if (
    index
    && !indexStructurallyMatches(index, EXPECTED_INDEX_SPECS[phase.concurrentIndex])
  ) {
    throw new MigrationError('MIGRATION_CONCURRENT_INDEX_DEFINITION_INVALID');
  }
  if (index && (!index.valid || !index.ready)) {
    await writeLedger(client, manifest, phase.id, 'RECOVERING_INVALID_INDEX');
    const allowedIndex = manifest.phases.some(
      (candidate) => candidate.concurrentIndex === phase.concurrentIndex,
    );
    if (!allowedIndex) {
      throw new MigrationError('MIGRATION_INDEX_RECOVERY_NOT_ALLOWLISTED');
    }
    await client.query(`REINDEX INDEX CONCURRENTLY "${phase.concurrentIndex}"`);
  } else if (!index) {
    await client.query(sql);
  }
  const verifiedIndex = await inspectConcurrentIndex(client, phase.concurrentIndex);
  if (
    !indexStructurallyMatches(verifiedIndex, EXPECTED_INDEX_SPECS[phase.concurrentIndex])
    || !verifiedIndex?.valid
    || !verifiedIndex?.ready
  ) {
    throw new MigrationError('MIGRATION_CONCURRENT_INDEX_INVALID');
  }
  await writeLedger(client, manifest, phase.id, 'IN_PROGRESS');
}

export async function verifyActionPlanExecutionSchemaWithClient(
  client,
  manifest = loadMigrationManifest(),
  { ignoreLedgerCompletion = false } = {},
) {
  const issues = [];
  const ledger = await readLedger(client, manifest);
  if (!ledger) {
    issues.push('SCHEMA_LEDGER_MISSING');
  } else {
    if (ledger.checksum !== manifest.checksum) issues.push('SCHEMA_CHECKSUM_MISMATCH');
    if (!ignoreLedgerCompletion) {
      if (ledger.completedPhase !== 'complete') issues.push('SCHEMA_MIGRATION_INCOMPLETE');
      if (ledger.validityState !== 'VALID') issues.push('SCHEMA_LEDGER_NOT_VALID');
      if (!ledger.appliedAt) issues.push('SCHEMA_APPLIED_AT_MISSING');
    }
  }

  const tableResult = await client.query(
    `SELECT table_name
     FROM information_schema.tables
     WHERE table_schema = current_schema()
       AND table_name = ANY($1::text[])`,
    [EXPECTED_TABLES],
  );
  const tables = new Set(tableResult.rows.map((row) => row.table_name));
  for (const table of EXPECTED_TABLES) {
    if (!tables.has(table)) issues.push(`SCHEMA_TABLE_MISSING:${table}`);
  }

  const expectedTableNames = Object.keys(EXPECTED_COLUMNS);
  const columnResult = await client.query(
    `SELECT table_name, column_name, udt_name, is_nullable, column_default
     FROM information_schema.columns
     WHERE table_schema = current_schema()
       AND table_name = ANY($1::text[])`,
    [expectedTableNames],
  );
  const columns = new Map(
    columnResult.rows.map((row) => [`${row.table_name}.${row.column_name}`, row]),
  );
  for (const [table, expectedColumns] of Object.entries(EXPECTED_COLUMNS)) {
    for (const columnName of expectedColumns) {
      const key = `${table}.${columnName}`;
      const actual = columns.get(key);
      if (!actual) {
        issues.push(`SCHEMA_COLUMN_MISSING:${table}.${columnName}`);
        continue;
      }
      const expected = EXPECTED_COLUMN_SPECS[table]?.[columnName];
      if (
        !expected
        || actual.udt_name !== expected.type
        || (actual.is_nullable === 'YES') !== expected.nullable
        || !defaultMatches(actual.column_default, expected.defaultKind)
      ) {
        issues.push(`SCHEMA_COLUMN_DEFINITION_INVALID:${table}.${columnName}`);
      }
    }
  }

  const constraintResult = await client.query(
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
            to_json(CASE WHEN constraint_data.confrelid = 0 THEN ARRAY[]::text[] ELSE ARRAY(
              SELECT referenced_attribute.attname::text
              FROM unnest(constraint_data.confkey) WITH ORDINALITY AS referenced_key(attnum, position)
              JOIN pg_attribute AS referenced_attribute
                ON referenced_attribute.attrelid = constraint_data.confrelid
               AND referenced_attribute.attnum = referenced_key.attnum
              ORDER BY referenced_key.position
            )::text[] END)::text AS referenced_columns_json,
            CASE WHEN constraint_data.confrelid = 0 THEN NULL
                 ELSE referenced_namespace.nspname = current_schema()
            END AS referenced_schema_matches,
            constraint_data.confupdtype AS update_action,
            constraint_data.confdeltype AS delete_action
     FROM pg_constraint AS constraint_data
     JOIN pg_namespace AS namespace ON namespace.oid = constraint_data.connamespace
     JOIN pg_class AS table_relation ON table_relation.oid = constraint_data.conrelid
     LEFT JOIN pg_class AS referenced_relation ON referenced_relation.oid = constraint_data.confrelid
     LEFT JOIN pg_namespace AS referenced_namespace
       ON referenced_namespace.oid = referenced_relation.relnamespace
     WHERE namespace.nspname = current_schema()
       AND constraint_data.conname = ANY($1::text[])`,
    [EXPECTED_CONSTRAINTS],
  );
  for (const name of EXPECTED_CONSTRAINTS) {
    const matches = constraintResult.rows.filter((row) => row.name === name);
    const expected = EXPECTED_CONSTRAINT_SPECS[name];
    const relationalExpected = EXPECTED_RELATIONAL_CONSTRAINT_SPECS[name];
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
      || (
        expected.type === 'c'
          ? !checkConstraintColumnsMatch(matches[0], name)
            || checkDefinitionHash(matches[0].definition) !== EXPECTED_CHECK_DEFINITION_HASHES[name]
          : !relationalExpected || !relationalConstraintMatches(matches[0], relationalExpected)
      )
    ) {
      issues.push(`SCHEMA_CONSTRAINT_DEFINITION_INVALID:${name}`);
    }
    if (matches[0].validated !== true) {
      issues.push(`SCHEMA_CONSTRAINT_NOT_VALID:${name}`);
    }
  }

  const indexResult = await client.query(
    `SELECT index_relation.relname AS name,
            table_relation.relname AS table_name,
            index_data.indisunique AS unique,
            index_data.indisvalid AS valid,
            index_data.indisready AS ready,
            namespace.nspname = current_schema() AS schema_matches,
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
            access_method.amname AS access_method,
            to_json(ARRAY(
              SELECT attribute.attname::text
              FROM unnest(index_data.indkey::smallint[]) WITH ORDINALITY AS key_column(attnum, position)
              JOIN pg_attribute AS attribute
                ON attribute.attrelid = index_data.indrelid
               AND attribute.attnum = key_column.attnum
              WHERE key_column.position <= index_data.indnkeyatts
              ORDER BY key_column.position
            ))::text AS columns_json,
            pg_get_expr(index_data.indpred, index_data.indrelid, true) AS predicate
     FROM pg_class AS index_relation
     JOIN pg_index AS index_data ON index_data.indexrelid = index_relation.oid
     JOIN pg_class AS table_relation ON table_relation.oid = index_data.indrelid
     JOIN pg_am AS access_method ON access_method.oid = index_relation.relam
     JOIN pg_namespace AS namespace ON namespace.oid = index_relation.relnamespace
     WHERE namespace.nspname = current_schema()
       AND index_relation.relname = ANY($1::text[])`,
    [EXPECTED_INDEXES],
  );
  for (const name of EXPECTED_INDEXES) {
    const matches = indexResult.rows.filter((row) => row.name === name);
    const expected = EXPECTED_INDEX_SPECS[name];
    if (matches.length === 0) {
      issues.push(`SCHEMA_INDEX_MISSING:${name}`);
      continue;
    }
    if (
      matches.length !== 1
      || !indexStructurallyMatches(matches[0], expected)
    ) {
      issues.push(`SCHEMA_INDEX_DEFINITION_INVALID:${name}`);
    }
    if (matches[0].valid !== true || matches[0].ready !== true) {
      issues.push(`SCHEMA_INDEX_INVALID:${name}`);
    }
  }

  return {
    ready: issues.length === 0,
    code: issues.length === 0 ? 'ACTION_PLAN_EXECUTION_SCHEMA_READY' : 'ACTION_PLAN_EXECUTION_SCHEMA_INVALID',
    version: manifest.version,
    schemaLabel: manifest.schemaLabel,
    protocolVersion: manifest.protocolVersion,
    snapshotSchemaVersion: manifest.snapshotSchemaVersion,
    checksum: manifest.checksum,
    issues: issues.sort(),
  };
}

async function acquireMigrationLock(client, manifest) {
  const result = await client.query(
    'SELECT pg_try_advisory_lock($1::bigint) AS locked',
    [manifest.advisoryLockKey],
  );
  if (result.rows[0]?.locked !== true) {
    throw new MigrationError('MIGRATION_ADVISORY_LOCK_UNAVAILABLE');
  }
}

async function releaseMigrationLock(client, manifest) {
  const result = await client.query(
    'SELECT pg_advisory_unlock($1::bigint) AS unlocked',
    [manifest.advisoryLockKey],
  );
  if (result.rows[0]?.unlocked !== true) {
    throw new MigrationError('MIGRATION_ADVISORY_UNLOCK_FAILED');
  }
}

function queryPlanFrom(result) {
  const plan = result.rows[0]?.['QUERY PLAN'];
  return Array.isArray(plan) ? plan : null;
}

export async function inspectMigrationPreflightWithClient(client) {
  const [planCount, actionCount, legacyResultCount, planLookup, actionLookup] = await Promise.all([
    client.query('SELECT COUNT(*)::bigint AS count FROM "ActionPlan"'),
    client.query('SELECT COUNT(*)::bigint AS count FROM "Action"'),
    client.query('SELECT COUNT(*)::bigint AS count FROM "ExecutionResult"'),
    client.query(
      'EXPLAIN (FORMAT JSON, COSTS TRUE) SELECT "id" FROM "ActionPlan" WHERE "id"=$1',
      ['migration-plan-probe'],
    ),
    client.query(
      `EXPLAIN (FORMAT JSON, COSTS TRUE)
       SELECT "id" FROM "Action" WHERE "planId"=$1 ORDER BY "id" LIMIT 1`,
      ['migration-plan-probe'],
    ),
  ]);
  return {
    rowCounts: {
      actionPlans: safeCount(planCount.rows[0]?.count),
      actions: safeCount(actionCount.rows[0]?.count),
      legacyExecutionResults: safeCount(legacyResultCount.rows[0]?.count),
    },
    queryPlans: {
      actionPlanIdentityLookup: queryPlanFrom(planLookup),
      actionIdentityLookup: queryPlanFrom(actionLookup),
    },
  };
}

export async function inspectMigrationPostflightWithClient(client) {
  const claimLookup = await client.query(
    `EXPLAIN (FORMAT JSON, COSTS TRUE)
     SELECT "id"
     FROM "ActionPlanExecutionRun"
     WHERE "executionRealm"=$1
       AND "assignedExecutorPrincipalId"=$2
       AND "assignedExecutorInstanceId"=$3
       AND "assignedAgentId"=$4
       AND "state"='REQUESTED'
     ORDER BY "requestedAt", "id"
     LIMIT 1`,
    [
      'migration-realm-probe',
      'migration-principal-probe',
      'migration-instance-probe',
      'migration-agent-probe',
    ],
  );
  return {
    queryPlans: {
      claimNextLookup: queryPlanFrom(claimLookup),
    },
  };
}

async function finalizeMigrationLedger(client, manifest) {
  await client.query('BEGIN');
  try {
    await writeLedger(client, manifest, 'complete', 'VALID', true);
    const verification = await verifyActionPlanExecutionSchemaWithClient(client, manifest);
    if (!verification.ready) {
      throw new MigrationError('MIGRATION_SCHEMA_VERIFICATION_FAILED');
    }
    await client.query('COMMIT');
    return verification;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}

export async function applyMigrationWithClient(client, {
  manifest = loadMigrationManifest(),
  directory = MIGRATION_DIRECTORY,
} = {}) {
  const artifactValidation = validateMigrationArtifacts({ manifest, directory });
  if (!artifactValidation.ok) {
    throw new MigrationError('MIGRATION_ARTIFACT_VALIDATION_FAILED');
  }

  await client.query("SET application_name TO 'arcanos-phase2e-local-migrator'");
  await client.query("SET lock_timeout TO '5s'");
  await client.query("SET statement_timeout TO '60s'");
  await acquireMigrationLock(client, manifest);
  let lastCompletedPhase = null;
  let primaryError = null;
  try {
    const existingLedger = await readLedger(client, manifest);
    if (existingLedger && existingLedger.checksum !== manifest.checksum) {
      throw new MigrationError('MIGRATION_LEDGER_CHECKSUM_CONFLICT');
    }
    if (
      existingLedger?.completedPhase === 'complete'
      && existingLedger.validityState === 'VALID'
    ) {
      lastCompletedPhase = 'complete';
      const verification = await verifyActionPlanExecutionSchemaWithClient(client, manifest);
      if (!verification.ready) throw new MigrationError('MIGRATION_SCHEMA_VERIFICATION_FAILED');
      return { ...verification, applied: false, equivalentRerun: true };
    }
    if (existingLedger?.completedPhase === 'complete') {
      const recoveryVerification = await verifyActionPlanExecutionSchemaWithClient(
        client,
        manifest,
        { ignoreLedgerCompletion: true },
      );
      if (!recoveryVerification.ready) {
        throw new MigrationError('MIGRATION_SCHEMA_VERIFICATION_FAILED');
      }
      lastCompletedPhase = 'complete';
      const verification = await finalizeMigrationLedger(client, manifest);
      return {
        ...verification,
        applied: false,
        equivalentRerun: true,
        recoveredFinalVerification: true,
      };
    }

    const preflight = await inspectMigrationPreflightWithClient(client);

    let completedIndex = existingLedger
      ? manifest.phases.findIndex((phase) => phase.id === existingLedger.completedPhase)
      : -1;
    if (existingLedger && completedIndex < 0) {
      throw new MigrationError('MIGRATION_LEDGER_PHASE_UNKNOWN');
    }
    if (existingLedger?.validityState === 'RECOVERING_INVALID_INDEX') {
      const recoveringPhase = manifest.phases[completedIndex];
      if (recoveringPhase?.transactional !== false || !recoveringPhase.concurrentIndex) {
        throw new MigrationError('MIGRATION_LEDGER_RECOVERY_PHASE_INVALID');
      }
      completedIndex -= 1;
    }
    lastCompletedPhase = existingLedger?.completedPhase ?? null;

    for (let index = completedIndex + 1; index < manifest.phases.length; index += 1) {
      const phase = manifest.phases[index];
      const sql = normalizeSql(readFileSync(join(directory, phase.path), 'utf8'));
      await runPhase(client, manifest, phase, sql);
      lastCompletedPhase = phase.id;
    }

    const preFinalVerification = await verifyActionPlanExecutionSchemaWithClient(
      client,
      manifest,
      { ignoreLedgerCompletion: true },
    );
    if (!preFinalVerification.ready) {
      lastCompletedPhase = 'complete';
      await writeLedger(client, manifest, 'complete', 'FAILED');
      throw new MigrationError('MIGRATION_SCHEMA_VERIFICATION_FAILED');
    }
    lastCompletedPhase = 'complete';
    const verification = await finalizeMigrationLedger(client, manifest);
    const postflight = await inspectMigrationPostflightWithClient(client);
    return {
      ...verification,
      applied: true,
      equivalentRerun: false,
      preflight,
      postflight,
    };
  } catch (error) {
    primaryError = error;
    if (lastCompletedPhase) {
      try {
        if (await relationExists(client, 'ActionPlanExecutionSchemaMigration')) {
          const failureLedger = await readLedger(client, manifest);
          if (failureLedger?.validityState !== 'RECOVERING_INVALID_INDEX') {
            await writeLedger(client, manifest, lastCompletedPhase, 'FAILED');
          }
        }
      } catch {
        // The original failure remains authoritative; checksum conflicts are not overwritten.
      }
    }
    throw error;
  } finally {
    try {
      await releaseMigrationLock(client, manifest);
    } catch (unlockError) {
      if (!primaryError) throw unlockError;
    }
  }
}

export async function compensateMigrationWithClient(client, {
  manifest = loadMigrationManifest(),
  directory = MIGRATION_DIRECTORY,
} = {}) {
  const artifactValidation = validateMigrationArtifacts({ manifest, directory });
  if (!artifactValidation.ok) {
    throw new MigrationError('MIGRATION_ARTIFACT_VALIDATION_FAILED');
  }
  await client.query("SET application_name TO 'arcanos-phase2e-local-compensator'");
  await client.query("SET lock_timeout TO '5s'");
  await client.query("SET statement_timeout TO '60s'");
  await acquireMigrationLock(client, manifest);
  let primaryError = null;
  try {
    const sql = normalizeSql(
      readFileSync(join(directory, manifest.compensationPath), 'utf8'),
    );
    await client.query('BEGIN');
    try {
      await client.query(sql);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
    return {
      ok: true,
      compensated: true,
      version: manifest.version,
      databaseMutated: true,
    };
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    try {
      await releaseMigrationLock(client, manifest);
    } catch (unlockError) {
      if (!primaryError) throw unlockError;
    }
  }
}

function safeCount(value) {
  const parsed = Number(value ?? 0);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new MigrationError('MIGRATION_DRAIN_COUNT_INVALID');
  }
  return parsed;
}

export async function inspectMigrationDrainStateWithClient(client) {
  const runTablePresent = await relationExists(client, 'ActionPlanExecutionRun');
  if (!runTablePresent) {
    return {
      protocolTablesPresent: false,
      counts: {
        requested: 0,
        claimed: 0,
        running: 0,
        runs: 0,
        commands: 0,
        events: 0,
        populatedProvenancePlans: 0,
      },
      canDisableAssignment: true,
      canRevertApplication: true,
      canCompensateEmptySchema: false,
    };
  }

  const [stateResult, runResult, commandResult, eventResult, provenanceResult] = await Promise.all([
    client.query(
      `SELECT "state", COUNT(*)::bigint AS count
       FROM "ActionPlanExecutionRun"
       WHERE "state" = ANY($1::text[])
       GROUP BY "state"`,
      [['REQUESTED', 'CLAIMED', 'RUNNING']],
    ),
    client.query('SELECT COUNT(*)::bigint AS count FROM "ActionPlanExecutionRun"'),
    client.query('SELECT COUNT(*)::bigint AS count FROM "ActionPlanExecutionCommand"'),
    client.query('SELECT COUNT(*)::bigint AS count FROM "ActionPlanExecutionEvent"'),
    client.query(
      `SELECT COUNT(*)::bigint AS count
       FROM "ActionPlan"
       WHERE "executionRealm" IS NOT NULL
          OR "ownerPrincipalId" IS NOT NULL
          OR "executionProtocolVersion" IS NOT NULL
          OR "executionGeneration" IS NOT NULL`,
    ),
  ]);
  const states = new Map(
    stateResult.rows.map((row) => [String(row.state), safeCount(row.count)]),
  );
  const counts = {
    requested: states.get('REQUESTED') ?? 0,
    claimed: states.get('CLAIMED') ?? 0,
    running: states.get('RUNNING') ?? 0,
    runs: safeCount(runResult.rows[0]?.count),
    commands: safeCount(commandResult.rows[0]?.count),
    events: safeCount(eventResult.rows[0]?.count),
    populatedProvenancePlans: safeCount(provenanceResult.rows[0]?.count),
  };
  return {
    protocolTablesPresent: true,
    counts,
    canDisableAssignment: counts.requested === 0,
    canRevertApplication:
      counts.requested === 0 && counts.claimed === 0 && counts.running === 0,
    canCompensateEmptySchema:
      counts.runs === 0
      && counts.commands === 0
      && counts.events === 0
      && counts.populatedProvenancePlans === 0,
  };
}

function parseArgs(argv) {
  const options = {
    mode: 'plan',
    confirmLocalEphemeral: false,
    confirmEmpty: false,
  };
  for (const arg of argv) {
    if (arg === '--plan') options.mode = 'plan';
    else if (arg === '--apply') options.mode = 'apply';
    else if (arg === '--verify-local') options.mode = 'verify-local';
    else if (arg === '--drain-status-local') options.mode = 'drain-status-local';
    else if (arg === '--compensate-local') options.mode = 'compensate-local';
    else if (arg === '--confirm-local-ephemeral') options.confirmLocalEphemeral = true;
    else if (arg === '--confirm-empty') options.confirmEmpty = true;
    else throw new MigrationError('MIGRATION_ARGUMENT_INVALID');
  }
  return options;
}

async function openConfirmedLocalClient(options) {
  if (options.confirmLocalEphemeral !== true) {
    throw new MigrationError('MIGRATION_LOCAL_CONFIRMATION_REQUIRED');
  }
  const connectionString = process.env[MIGRATION_DATABASE_ENV];
  if (!connectionString) {
    throw new MigrationError('MIGRATION_DATABASE_ENV_MISSING');
  }
  const target = assertLocalEphemeralConnectionString(connectionString);
  const pg = await import('pg');
  const Client = pg.Client ?? pg.default?.Client;
  const client = new Client({ connectionString });
  await client.connect();
  return { client, target };
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.mode === 'plan') {
    const canonical = validateMigrationArtifacts();
    const history = await import('./action-plan-execution-migration-history.mjs');
    const historyArtifacts = history.validateMigrationHistoryArtifacts();
    return {
      ...canonical,
      ok: canonical.ok === true && historyArtifacts.ok === true,
      issues: [
        ...canonical.issues,
        ...historyArtifacts.issues,
      ].sort(),
      history: {
        version: historyArtifacts.version,
        checksum: historyArtifacts.checksum,
        calculatedChecksum: historyArtifacts.calculatedChecksum,
        issues: historyArtifacts.issues,
      },
    };
  }

  if (options.mode === 'compensate-local' && options.confirmEmpty !== true) {
    throw new MigrationError('MIGRATION_EMPTY_COMPENSATION_CONFIRMATION_REQUIRED');
  }

  const { client, target } = await openConfirmedLocalClient(options);
  try {
    if (options.mode === 'apply') {
      const history = await import('./action-plan-execution-migration-history.mjs');
      const result = await history.applyMigrationWithDurableHistoryWithClient(client);
      return {
        ...result,
        target,
        databaseConnected: true,
        migrationSchemaMutated: result.migrationSchemaMutated === true,
        databaseMutated: result.databaseMutated === true,
      };
    }
    if (options.mode === 'verify-local') {
      const history = await import('./action-plan-execution-migration-history.mjs');
      const [result, historyResult] = await Promise.all([
        verifyActionPlanExecutionSchemaWithClient(client),
        history.verifyMigrationAttemptHistoryWithClient(client),
      ]);
      return {
        ...result,
        ready: result.ready === true && historyResult.ready === true,
        issues: [...result.issues, ...historyResult.issues].sort(),
        historyReady: historyResult.ready === true,
        target,
        databaseConnected: true,
        databaseMutated: false,
      };
    }
    if (options.mode === 'drain-status-local') {
      const result = await inspectMigrationDrainStateWithClient(client);
      return {
        ok: true,
        ...result,
        target,
        databaseConnected: true,
        databaseMutated: false,
      };
    }
    const history = await import('./action-plan-execution-migration-history.mjs');
    const result = await history.compensateMigrationWithDurableHistoryWithClient(client);
    return {
      ...result,
      target,
      databaseConnected: true,
      migrationSchemaMutated: result.migrationSchemaMutated === true,
      databaseMutated: result.databaseMutated === true,
    };
  } finally {
    await client.end();
  }
}

function stableFailureCode(error) {
  return error instanceof MigrationError
    ? error.code
    : 'ACTION_PLAN_EXECUTION_MIGRATION_FAILED';
}

const FAILURE_CODES_BEFORE_MUTATION = new Set([
  'MIGRATION_ARGUMENT_INVALID',
  'MIGRATION_LOCAL_CONFIRMATION_REQUIRED',
  'MIGRATION_EMPTY_COMPENSATION_CONFIRMATION_REQUIRED',
  'MIGRATION_DATABASE_ENV_MISSING',
  'MIGRATION_DATABASE_URL_INVALID',
  'MIGRATION_DATABASE_PROTOCOL_INVALID',
  'MIGRATION_DATABASE_OPTIONS_FORBIDDEN',
  'MIGRATION_DATABASE_NOT_LOOPBACK',
  'MIGRATION_DATABASE_NOT_EXPLICIT_EPHEMERAL',
  'MIGRATION_ARTIFACT_VALIDATION_FAILED',
  'MIGRATION_HISTORY_ARTIFACT_VALIDATION_FAILED',
  'MIGRATION_HISTORY_SCHEMA_INVALID',
  'MIGRATION_ADVISORY_LOCK_UNAVAILABLE',
  'MIGRATION_LEDGER_CHECKSUM_CONFLICT',
  'MIGRATION_LEDGER_PHASE_UNKNOWN',
  'MIGRATION_LEDGER_RECOVERY_PHASE_INVALID',
]);

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
    .then((result) => {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      process.exitCode = result.ok === false || result.ready === false ? 1 : 0;
    })
    .catch((error) => {
      const code = stableFailureCode(error);
      const failedBeforeMutation = FAILURE_CODES_BEFORE_MUTATION.has(code);
      const historyAppended = error?.historyAppended === true;
      process.stdout.write(`${JSON.stringify({
        ok: false,
        code,
        databaseMutated: historyAppended ? true : failedBeforeMutation ? false : null,
        ...(historyAppended ? {
          historyAppended: true,
          migrationSchemaMutated: failedBeforeMutation ? false : null,
        } : {}),
        ...(failedBeforeMutation ? {} : { databaseMutationState: 'unknown_or_partial' }),
      }, null, 2)}\n`);
      process.exitCode = 2;
    });
}
