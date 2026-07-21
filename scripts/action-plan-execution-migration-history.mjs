#!/usr/bin/env node

import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  MigrationError,
  REVIEWED_MIGRATION_CHECKSUM,
  REVIEWED_MIGRATION_VERSION,
  applyMigrationWithClient,
  compensateMigrationWithClient,
  extractCheckDefinitions,
  loadMigrationManifest,
  parseCatalogJsonTextArray,
  checkDefinitionHash,
  validateMigrationArtifacts,
} from './action-plan-execution-migration.mjs';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
export const MIGRATION_HISTORY_DIRECTORY = resolve(
  SCRIPT_DIR,
  '..',
  'migrations',
  '20260718_action_plan_execution_migration_history_v1',
);
export const MIGRATION_HISTORY_MANIFEST_PATH = join(
  MIGRATION_HISTORY_DIRECTORY,
  'manifest.json',
);
export const REVIEWED_MIGRATION_HISTORY_VERSION =
  '20260718_action_plan_execution_migration_history_v1';
export const REVIEWED_MIGRATION_HISTORY_CHECKSUM =
  '1e08d934d28546a9b3ae642b6bd0c85baecbe797c2c4f5bc19cc1131208c2f8a';

const HISTORY_TABLES = [
  'ActionPlanExecutionSchemaMigrationAttempt',
  'ActionPlanExecutionSchemaMigrationAttemptEvent',
];

const HISTORY_COLUMNS = {
  ActionPlanExecutionSchemaMigrationAttempt: {
    id: { type: 'text', nullable: false, defaultKind: 'none' },
    migrationVersion: { type: 'text', nullable: false, defaultKind: 'none' },
    migrationChecksum: { type: 'text', nullable: false, defaultKind: 'none' },
    operation: { type: 'text', nullable: false, defaultKind: 'none' },
    startedAt: { type: 'timestamptz', nullable: false, defaultKind: 'current_timestamp' },
  },
  ActionPlanExecutionSchemaMigrationAttemptEvent: {
    id: { type: 'text', nullable: false, defaultKind: 'none' },
    attemptId: { type: 'text', nullable: false, defaultKind: 'none' },
    eventSequence: { type: 'int8', nullable: false, defaultKind: 'none' },
    eventType: { type: 'text', nullable: false, defaultKind: 'none' },
    phase: { type: 'text', nullable: true, defaultKind: 'none' },
    reasonCode: { type: 'text', nullable: false, defaultKind: 'none' },
    createdAt: { type: 'timestamptz', nullable: false, defaultKind: 'current_timestamp' },
  },
};

const HISTORY_CONSTRAINTS = {
  ActionPlanExecutionSchemaMigrationAttempt_pkey: {
    table: 'ActionPlanExecutionSchemaMigrationAttempt', type: 'p', columns: ['id'],
  },
  ActionPlanExecutionSchemaMigrationAttemptEvent_pkey: {
    table: 'ActionPlanExecutionSchemaMigrationAttemptEvent', type: 'p', columns: ['id'],
  },
  ck_ap_exec_migration_attempt_identity: {
    table: 'ActionPlanExecutionSchemaMigrationAttempt', type: 'c', columns: ['id', 'migrationVersion', 'migrationChecksum'],
  },
  ck_ap_exec_migration_attempt_operation: {
    table: 'ActionPlanExecutionSchemaMigrationAttempt', type: 'c', columns: ['operation'],
  },
  ck_ap_exec_migration_attempt_event_identity: {
    table: 'ActionPlanExecutionSchemaMigrationAttemptEvent', type: 'c', columns: ['id', 'attemptId'],
  },
  ck_ap_exec_migration_attempt_event_sequence: {
    table: 'ActionPlanExecutionSchemaMigrationAttemptEvent', type: 'c', columns: ['eventSequence'],
  },
  ck_ap_exec_migration_attempt_event_type: {
    table: 'ActionPlanExecutionSchemaMigrationAttemptEvent', type: 'c', columns: ['eventType'],
  },
  ck_ap_exec_migration_attempt_event_phase: {
    table: 'ActionPlanExecutionSchemaMigrationAttemptEvent', type: 'c', columns: ['phase'],
  },
  ck_ap_exec_migration_attempt_event_reason: {
    table: 'ActionPlanExecutionSchemaMigrationAttemptEvent', type: 'c', columns: ['reasonCode'],
  },
  uq_ap_exec_migration_attempt_event_sequence: {
    table: 'ActionPlanExecutionSchemaMigrationAttemptEvent', type: 'u', columns: ['attemptId', 'eventSequence'],
  },
  fk_ap_exec_migration_attempt_event_attempt: {
    table: 'ActionPlanExecutionSchemaMigrationAttemptEvent',
    type: 'f',
    columns: ['attemptId'],
    referencedTable: 'ActionPlanExecutionSchemaMigrationAttempt',
    referencedColumns: ['id'],
    updateAction: 'r',
    deleteAction: 'r',
  },
};

const HISTORY_INDEXES = {
  ix_ap_exec_migration_attempt_version_started: {
    table: 'ActionPlanExecutionSchemaMigrationAttempt',
    unique: false,
    columns: ['migrationVersion', 'startedAt', 'id'],
    predicateEventTypes: [],
  },
  uq_ap_exec_migration_attempt_terminal: {
    table: 'ActionPlanExecutionSchemaMigrationAttemptEvent',
    unique: true,
    columns: ['attemptId'],
    predicateEventTypes: ['ATTEMPT_FAILED', 'ATTEMPT_REFUSED', 'ATTEMPT_SUCCEEDED'],
  },
};

export const MIGRATION_HISTORY_SCHEMA_REQUIREMENTS = Object.freeze({
  tables: [...HISTORY_TABLES],
  columns: HISTORY_COLUMNS,
  constraints: HISTORY_CONSTRAINTS,
  indexes: HISTORY_INDEXES,
});

const RECORDER_OPERATIONS = new Set(['APPLY', 'COMPENSATE']);
const EVENT_TYPES = new Set([
  'PHASE_COMPLETED',
  'RECOVERY_STARTED',
  'ATTEMPT_REFUSED',
  'ATTEMPT_FAILED',
  'ATTEMPT_SUCCEEDED',
]);
const TERMINAL_EVENT_TYPES = new Set([
  'ATTEMPT_REFUSED',
  'ATTEMPT_FAILED',
  'ATTEMPT_SUCCEEDED',
]);
const EVENTS_BY_OPERATION = {
  HISTORY_SCHEMA_INSTALL: new Set(['PHASE_COMPLETED', 'ATTEMPT_FAILED', 'ATTEMPT_SUCCEEDED']),
  APPLY: new Set(['RECOVERY_STARTED', 'ATTEMPT_REFUSED', 'ATTEMPT_FAILED', 'ATTEMPT_SUCCEEDED']),
  COMPENSATE: new Set(['ATTEMPT_REFUSED', 'ATTEMPT_FAILED', 'ATTEMPT_SUCCEEDED']),
};
const REFUSAL_CODES = new Set([
  'MIGRATION_ADVISORY_LOCK_UNAVAILABLE',
  'MIGRATION_ARTIFACT_VALIDATION_FAILED',
  'MIGRATION_LEDGER_CHECKSUM_CONFLICT',
  'MIGRATION_LEDGER_PHASE_UNKNOWN',
  'MIGRATION_LEDGER_RECOVERY_PHASE_INVALID',
  'MIGRATION_HISTORY_ARTIFACT_VALIDATION_FAILED',
  'MIGRATION_HISTORY_SCHEMA_INVALID',
  'MIGRATION_HISTORY_INSTALL_MARKER_MISSING',
]);
const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const REASON_CODE_PATTERN = /^[A-Z][A-Z0-9_]{0,127}$/u;

function normalizeSql(text) {
  return text.replace(/\r\n/gu, '\n');
}

function defaultMatches(actual, kind) {
  if (kind === 'none') return actual == null;
  if (typeof actual !== 'string') return false;
  let normalized = actual.trim();
  while (normalized.startsWith('(') && normalized.endsWith(')')) {
    normalized = normalized.slice(1, -1).trim();
  }
  return /^(?:CURRENT_TIMESTAMP|now\(\))(?:\s*::\s*(?:timestamptz|timestamp with time zone))?$/iu
    .test(normalized);
}

function validIdentifier(value) {
  return typeof value === 'string' && IDENTIFIER_PATTERN.test(value);
}

function validReasonCode(value) {
  return typeof value === 'string' && REASON_CODE_PATTERN.test(value);
}

function validateRecorderInput(condition, code) {
  if (!condition) throw new MigrationError(code);
}

function stripPredicateParentheses(value) {
  let normalized = value.trim();
  let changed = true;
  while (changed && normalized.startsWith('(') && normalized.endsWith(')')) {
    changed = false;
    let depth = 0;
    let quoted = false;
    for (let index = 0; index < normalized.length; index += 1) {
      const character = normalized[index];
      if (character === "'") quoted = !quoted;
      if (quoted) continue;
      if (character === '(') depth += 1;
      if (character === ')') depth -= 1;
      if (depth === 0 && index < normalized.length - 1) break;
      if (index === normalized.length - 1 && depth === 0) {
        normalized = normalized.slice(1, -1).trim();
        changed = true;
      }
    }
  }
  return normalized;
}

function parsePredicateLiteralList(value) {
  const parts = value.split(',').map((part) => part.trim());
  if (parts.length === 0) return null;
  const parsed = [];
  for (const part of parts) {
    const match = part.match(/^'([A-Z_]+)'(?:\s*::\s*text)?$/u);
    if (!match) return null;
    parsed.push(match[1]);
  }
  if (new Set(parsed).size !== parsed.length) return null;
  return parsed.sort();
}

function terminalPredicateMatches(value, expectedEventTypes) {
  if (expectedEventTypes.length === 0) return value == null;
  if (typeof value !== 'string') return false;
  const normalized = stripPredicateParentheses(value);
  const inMatch = normalized.match(/^"eventType"\s+[Ii][Nn]\s*\(([\s\S]+)\)$/u);
  const anyMatch = normalized.match(
    /^"eventType"\s*=\s*[Aa][Nn][Yy]\s*\(\s*[Aa][Rr][Rr][Aa][Yy]\s*\[([\s\S]+)\](?:\s*::\s*text\[\])?\s*\)$/u,
  );
  const parsed = parsePredicateLiteralList((inMatch ?? anyMatch)?.[1] ?? '');
  return JSON.stringify(parsed) === JSON.stringify([...expectedEventTypes].sort());
}

export function loadMigrationHistoryManifest(path = MIGRATION_HISTORY_MANIFEST_PATH) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

export function calculateMigrationHistoryChecksum(
  manifest = loadMigrationHistoryManifest(),
  directory = MIGRATION_HISTORY_DIRECTORY,
) {
  const hash = createHash('sha256');
  hash.update(`${manifest.version}\n`);
  for (const phase of manifest.phases) {
    hash.update(`${phase.id}\n${normalizeSql(readFileSync(join(directory, phase.path), 'utf8'))}\n`);
  }
  return hash.digest('hex');
}

export function validateMigrationHistoryArtifacts({
  manifest = loadMigrationHistoryManifest(),
  directory = MIGRATION_HISTORY_DIRECTORY,
} = {}) {
  const issues = [];
  const calculatedChecksum = calculateMigrationHistoryChecksum(manifest, directory);
  if (manifest.version !== REVIEWED_MIGRATION_HISTORY_VERSION) {
    issues.push('MIGRATION_HISTORY_VERSION_MISMATCH');
  }
  if (
    manifest.checksum !== REVIEWED_MIGRATION_HISTORY_CHECKSUM
    || calculatedChecksum !== manifest.checksum
  ) {
    issues.push('MIGRATION_HISTORY_CHECKSUM_MISMATCH');
  }
  if (manifest.advisoryLockKey !== loadMigrationManifest().advisoryLockKey) {
    issues.push('MIGRATION_HISTORY_ADVISORY_LOCK_MISMATCH');
  }
  if (
    manifest.phases.length !== 1
    || manifest.phases[0]?.id !== '01_attempt_history'
    || manifest.phases[0]?.path !== '01_attempt_history.sql'
    || manifest.phases[0]?.transactional !== true
  ) {
    issues.push('MIGRATION_HISTORY_PHASES_INVALID');
  }
  const sql = normalizeSql(readFileSync(join(directory, '01_attempt_history.sql'), 'utf8'));
  if (/(?:^|;)\s*(?:DROP\b|TRUNCATE\b|DELETE\s+FROM\b|UPDATE\b)/imu.test(sql)) {
    issues.push('MIGRATION_HISTORY_DESTRUCTIVE_SQL');
  }
  return {
    ok: issues.length === 0,
    version: manifest.version,
    checksum: manifest.checksum,
    calculatedChecksum,
    issues: issues.sort(),
    databaseConnected: false,
    databaseMutated: false,
  };
}

async function relationState(client) {
  const result = await client.query(
    `SELECT to_regclass($1::text) IS NOT NULL AS attempt_exists,
            to_regclass($2::text) IS NOT NULL AS event_exists`,
    [`"${HISTORY_TABLES[0]}"`, `"${HISTORY_TABLES[1]}"`],
  );
  return {
    attempt: result.rows[0]?.attempt_exists === true,
    event: result.rows[0]?.event_exists === true,
  };
}

function loadReviewedHistoryChecks(directory = MIGRATION_HISTORY_DIRECTORY) {
  const sql = readFileSync(join(directory, '01_attempt_history.sql'), 'utf8');
  return extractCheckDefinitions(sql);
}

export async function verifyMigrationAttemptHistoryWithClient(
  client,
  {
    manifest = loadMigrationHistoryManifest(),
    directory = MIGRATION_HISTORY_DIRECTORY,
    requireInstallMarker = true,
  } = {},
) {
  const issues = [];
  const state = await relationState(client);
  if (!state.attempt) issues.push(`MIGRATION_HISTORY_TABLE_MISSING:${HISTORY_TABLES[0]}`);
  if (!state.event) issues.push(`MIGRATION_HISTORY_TABLE_MISSING:${HISTORY_TABLES[1]}`);
  if (!state.attempt || !state.event) {
    return { ready: false, issues: issues.sort(), version: manifest.version, checksum: manifest.checksum };
  }

  const columnResult = await client.query(
    `SELECT table_name, column_name, udt_name, is_nullable, column_default
     FROM information_schema.columns
     WHERE table_schema = current_schema()
       AND table_name = ANY($1::text[])`,
    [HISTORY_TABLES],
  );
  const actualColumns = new Map(
    columnResult.rows.map((row) => [`${row.table_name}.${row.column_name}`, row]),
  );
  for (const [table, columns] of Object.entries(HISTORY_COLUMNS)) {
    for (const [name, expected] of Object.entries(columns)) {
      const actual = actualColumns.get(`${table}.${name}`);
      if (!actual) {
        issues.push(`MIGRATION_HISTORY_COLUMN_MISSING:${table}.${name}`);
      } else if (
        actual.udt_name !== expected.type
        || (actual.is_nullable === 'YES') !== expected.nullable
        || !defaultMatches(actual.column_default, expected.defaultKind)
      ) {
        issues.push(`MIGRATION_HISTORY_COLUMN_INVALID:${table}.${name}`);
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
            constraint_data.confupdtype AS update_action,
            constraint_data.confdeltype AS delete_action
     FROM pg_constraint AS constraint_data
     JOIN pg_class AS table_relation ON table_relation.oid = constraint_data.conrelid
     JOIN pg_namespace AS namespace ON namespace.oid = table_relation.relnamespace
     LEFT JOIN pg_class AS referenced_relation
       ON referenced_relation.oid = constraint_data.confrelid
     WHERE namespace.nspname = current_schema()
       AND constraint_data.conname = ANY($1::text[])`,
    [Object.keys(HISTORY_CONSTRAINTS)],
  );
  const constraints = new Map(constraintResult.rows.map((row) => [row.name, row]));
  const reviewedChecks = loadReviewedHistoryChecks(directory);
  for (const [name, expected] of Object.entries(HISTORY_CONSTRAINTS)) {
    const actual = constraints.get(name);
    const columns = parseCatalogJsonTextArray(actual?.columns_json);
    if (!actual) {
      issues.push(`MIGRATION_HISTORY_CONSTRAINT_MISSING:${name}`);
      continue;
    }
    if (
      actual.table_name !== expected.table
      || actual.type !== expected.type
      || actual.validated !== true
      || actual.deferrable !== false
      || actual.initially_deferred !== false
      || JSON.stringify(columns) !== JSON.stringify(expected.columns)
    ) {
      issues.push(`MIGRATION_HISTORY_CONSTRAINT_INVALID:${name}`);
      continue;
    }
    if (expected.type === 'c') {
      const reviewed = reviewedChecks.get(name);
      if (!reviewed || checkDefinitionHash(actual.definition) !== checkDefinitionHash(reviewed)) {
        issues.push(`MIGRATION_HISTORY_CONSTRAINT_DEFINITION_INVALID:${name}`);
      }
    }
    if (expected.type === 'f') {
      if (
        actual.referenced_table_name !== expected.referencedTable
        || JSON.stringify(parseCatalogJsonTextArray(actual.referenced_columns_json))
          !== JSON.stringify(expected.referencedColumns)
        || actual.update_action !== expected.updateAction
        || actual.delete_action !== expected.deleteAction
      ) {
        issues.push(`MIGRATION_HISTORY_CONSTRAINT_DEFINITION_INVALID:${name}`);
      }
    }
  }

  const indexResult = await client.query(
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
            ))::text AS columns_json,
            pg_get_expr(index_data.indpred, index_data.indrelid, true) AS predicate
     FROM pg_class AS index_relation
     JOIN pg_index AS index_data ON index_data.indexrelid = index_relation.oid
     JOIN pg_class AS table_relation ON table_relation.oid = index_data.indrelid
     JOIN pg_am AS access_method ON access_method.oid = index_relation.relam
     JOIN pg_namespace AS namespace ON namespace.oid = index_relation.relnamespace
     WHERE namespace.nspname = current_schema()
       AND index_relation.relname = ANY($1::text[])`,
    [Object.keys(HISTORY_INDEXES)],
  );
  const indexes = new Map(indexResult.rows.map((row) => [row.name, row]));
  for (const [name, expected] of Object.entries(HISTORY_INDEXES)) {
    const actual = indexes.get(name);
    if (!actual) {
      issues.push(`MIGRATION_HISTORY_INDEX_MISSING:${name}`);
      continue;
    }
    if (
      actual.table_name !== expected.table
      || actual.unique !== expected.unique
      || actual.valid !== true
      || actual.ready !== true
      || actual.schema_matches !== true
      || actual.access_method !== 'btree'
      || actual.key_count !== expected.columns.length
      || actual.attribute_count !== expected.columns.length
      || actual.expressions_absent !== true
      || actual.sort_options_default !== true
      || actual.opclasses_default !== true
      || actual.collations_default !== true
      || JSON.stringify(parseCatalogJsonTextArray(actual.columns_json))
        !== JSON.stringify(expected.columns)
      || !terminalPredicateMatches(actual.predicate, expected.predicateEventTypes)
    ) {
      issues.push(`MIGRATION_HISTORY_INDEX_INVALID:${name}`);
    }
  }

  if (requireInstallMarker) {
    const marker = await client.query(
      `SELECT attempt."id"
       FROM "ActionPlanExecutionSchemaMigrationAttempt" AS attempt
       JOIN "ActionPlanExecutionSchemaMigrationAttemptEvent" AS event
         ON event."attemptId" = attempt."id"
       WHERE attempt."migrationVersion" = $1
         AND attempt."migrationChecksum" = $2
         AND attempt."operation" = 'HISTORY_SCHEMA_INSTALL'
         AND event."eventType" = 'ATTEMPT_SUCCEEDED'
         AND event."reasonCode" = 'MIGRATION_HISTORY_SCHEMA_INSTALLED'
       LIMIT 1`,
      [manifest.version, manifest.checksum],
    );
    if (marker.rowCount !== 1) issues.push('MIGRATION_HISTORY_INSTALL_MARKER_MISSING');
  }

  return {
    ready: issues.length === 0,
    code: issues.length === 0 ? 'MIGRATION_HISTORY_SCHEMA_READY' : 'MIGRATION_HISTORY_SCHEMA_INVALID',
    version: manifest.version,
    checksum: manifest.checksum,
    issues: issues.sort(),
  };
}

async function acquireHistoryLock(client, manifest) {
  const result = await client.query(
    'SELECT pg_try_advisory_lock($1::bigint) AS locked',
    [manifest.advisoryLockKey],
  );
  if (result.rows[0]?.locked !== true) {
    throw new MigrationError('MIGRATION_ADVISORY_LOCK_UNAVAILABLE');
  }
}

async function releaseHistoryLock(client, manifest) {
  const result = await client.query(
    'SELECT pg_advisory_unlock($1::bigint) AS unlocked',
    [manifest.advisoryLockKey],
  );
  if (result.rows[0]?.unlocked !== true) {
    throw new MigrationError('MIGRATION_ADVISORY_UNLOCK_FAILED');
  }
}

async function insertAttempt(client, attempt) {
  await client.query(
    `INSERT INTO "ActionPlanExecutionSchemaMigrationAttempt"
       ("id", "migrationVersion", "migrationChecksum", "operation")
     VALUES ($1, $2, $3, $4)`,
    [attempt.id, attempt.migrationVersion, attempt.migrationChecksum, attempt.operation],
  );
}

async function insertEvent(client, event) {
  await client.query(
    `INSERT INTO "ActionPlanExecutionSchemaMigrationAttemptEvent"
       ("id", "attemptId", "eventSequence", "eventType", "phase", "reasonCode")
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [event.id, event.attemptId, event.eventSequence, event.eventType, event.phase, event.reasonCode],
  );
}

export async function installMigrationAttemptHistoryWithClient(
  client,
  {
    manifest = loadMigrationHistoryManifest(),
    directory = MIGRATION_HISTORY_DIRECTORY,
    idFactory = randomUUID,
  } = {},
) {
  const artifacts = validateMigrationHistoryArtifacts({ manifest, directory });
  if (!artifacts.ok) throw new MigrationError('MIGRATION_HISTORY_ARTIFACT_VALIDATION_FAILED');

  const initialState = await relationState(client);
  if (initialState.attempt || initialState.event) {
    const verification = await verifyMigrationAttemptHistoryWithClient(
      client,
      { manifest, directory },
    );
    if (!verification.ready) throw new MigrationError('MIGRATION_HISTORY_SCHEMA_INVALID');
    return { ...verification, installed: false, equivalentRerun: true, historyAppended: false };
  }

  await acquireHistoryLock(client, manifest);
  let primaryError = null;
  try {
    const state = await relationState(client);
    if (state.attempt || state.event) {
      const verification = await verifyMigrationAttemptHistoryWithClient(
        client,
        { manifest, directory },
      );
      if (!verification.ready) throw new MigrationError('MIGRATION_HISTORY_SCHEMA_INVALID');
      return { ...verification, installed: false, equivalentRerun: true, historyAppended: false };
    }

    const attemptId = idFactory();
    const phaseId = manifest.phases[0].id;
    await client.query('BEGIN');
    try {
      await client.query("SET LOCAL lock_timeout TO '5s'");
      await client.query("SET LOCAL statement_timeout TO '60s'");
      await client.query(normalizeSql(readFileSync(join(directory, manifest.phases[0].path), 'utf8')));
      await insertAttempt(client, {
        id: attemptId,
        migrationVersion: manifest.version,
        migrationChecksum: manifest.checksum,
        operation: 'HISTORY_SCHEMA_INSTALL',
      });
      await insertEvent(client, {
        id: idFactory(), attemptId, eventSequence: 1,
        eventType: 'PHASE_COMPLETED', phase: phaseId,
        reasonCode: 'MIGRATION_HISTORY_SCHEMA_CREATED',
      });
      await insertEvent(client, {
        id: idFactory(), attemptId, eventSequence: 2,
        eventType: 'ATTEMPT_SUCCEEDED', phase: null,
        reasonCode: 'MIGRATION_HISTORY_SCHEMA_INSTALLED',
      });
      const verification = await verifyMigrationAttemptHistoryWithClient(
        client,
        { manifest, directory },
      );
      if (!verification.ready) throw new MigrationError('MIGRATION_HISTORY_SCHEMA_INVALID');
      await client.query('COMMIT');
      return {
        ...verification,
        installed: true,
        equivalentRerun: false,
        historyAppended: true,
        attemptId,
      };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    try {
      await releaseHistoryLock(client, manifest);
    } catch (unlockError) {
      if (!primaryError) throw unlockError;
    }
  }
}

export async function createMigrationAttemptWithClient(
  client,
  {
    operation,
    migrationVersion = REVIEWED_MIGRATION_VERSION,
    migrationChecksum = REVIEWED_MIGRATION_CHECKSUM,
    attemptId = randomUUID(),
  },
) {
  validateRecorderInput(
    RECORDER_OPERATIONS.has(operation),
    'MIGRATION_HISTORY_OPERATION_INVALID',
  );
  validateRecorderInput(validIdentifier(attemptId), 'MIGRATION_HISTORY_ATTEMPT_ID_INVALID');
  validateRecorderInput(validIdentifier(migrationVersion), 'MIGRATION_HISTORY_VERSION_INVALID');
  validateRecorderInput(/^[0-9a-f]{64}$/u.test(migrationChecksum), 'MIGRATION_HISTORY_CHECKSUM_INVALID');
  const verification = await verifyMigrationAttemptHistoryWithClient(client);
  if (!verification.ready) throw new MigrationError('MIGRATION_HISTORY_SCHEMA_INVALID');

  await client.query('BEGIN');
  try {
    await insertAttempt(client, {
      id: attemptId,
      migrationVersion,
      migrationChecksum,
      operation,
    });
    await client.query('COMMIT');
    return { attemptId, historyAppended: true };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}

export async function appendMigrationAttemptEventWithClient(
  client,
  {
    attemptId,
    eventType,
    phase = null,
    reasonCode,
    eventId = randomUUID(),
  },
) {
  validateRecorderInput(validIdentifier(attemptId), 'MIGRATION_HISTORY_ATTEMPT_ID_INVALID');
  validateRecorderInput(validIdentifier(eventId), 'MIGRATION_HISTORY_EVENT_ID_INVALID');
  validateRecorderInput(EVENT_TYPES.has(eventType), 'MIGRATION_HISTORY_EVENT_TYPE_INVALID');
  validateRecorderInput(phase === null || validIdentifier(phase), 'MIGRATION_HISTORY_PHASE_INVALID');
  validateRecorderInput(validReasonCode(reasonCode), 'MIGRATION_HISTORY_REASON_CODE_INVALID');
  const phaseRequired = eventType === 'PHASE_COMPLETED' || eventType === 'RECOVERY_STARTED';
  validateRecorderInput(
    phaseRequired ? phase !== null : phase === null,
    'MIGRATION_HISTORY_EVENT_PHASE_INVALID',
  );

  await client.query('BEGIN');
  try {
    const attempt = await client.query(
      `SELECT "id", "operation"
       FROM "ActionPlanExecutionSchemaMigrationAttempt"
       WHERE "id" = $1
       FOR UPDATE`,
      [attemptId],
    );
    if (attempt.rowCount !== 1) throw new MigrationError('MIGRATION_HISTORY_ATTEMPT_NOT_FOUND');
    const operation = attempt.rows[0]?.operation;
    if (!EVENTS_BY_OPERATION[operation]?.has(eventType)) {
      throw new MigrationError('MIGRATION_HISTORY_EVENT_OPERATION_INVALID');
    }
    const sequence = await client.query(
      `SELECT COALESCE(MAX("eventSequence"), 0)::bigint + 1 AS next_sequence,
              COALESCE(
                BOOL_OR("eventType" = ANY($2::text[])),
                false
              ) AS terminal_exists
       FROM "ActionPlanExecutionSchemaMigrationAttemptEvent"
       WHERE "attemptId" = $1`,
      [attemptId, [...TERMINAL_EVENT_TYPES]],
    );
    if (sequence.rows[0]?.terminal_exists === true) {
      throw new MigrationError('MIGRATION_HISTORY_ATTEMPT_TERMINAL');
    }
    const eventSequence = Number(sequence.rows[0]?.next_sequence);
    if (!Number.isSafeInteger(eventSequence) || eventSequence < 1) {
      throw new MigrationError('MIGRATION_HISTORY_SEQUENCE_INVALID');
    }
    await insertEvent(client, {
      id: eventId,
      attemptId,
      eventSequence,
      eventType,
      phase,
      reasonCode,
    });
    await client.query('COMMIT');
    return { attemptId, eventSequence, eventType, terminal: TERMINAL_EVENT_TYPES.has(eventType) };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}

async function readCanonicalLedger(client, manifest) {
  const exists = await client.query(
    'SELECT to_regclass($1::text) IS NOT NULL AS exists',
    ['"ActionPlanExecutionSchemaMigration"'],
  );
  if (exists.rows[0]?.exists !== true) return null;
  const result = await client.query(
    `SELECT "checksum", "completedPhase", "validityState", "appliedAt"
     FROM "ActionPlanExecutionSchemaMigration"
     WHERE "version" = $1`,
    [manifest.version],
  );
  return result.rows[0] ?? null;
}

function safeFailureReason(error) {
  return error
    && typeof error === 'object'
    && validReasonCode(error.code)
    && String(error.code).startsWith('MIGRATION_')
    ? error.code
    : 'MIGRATION_OPERATION_FAILED';
}

async function recordTerminalOrFail(client, attemptId, eventType, reasonCode) {
  try {
    await appendMigrationAttemptEventWithClient(client, { attemptId, eventType, reasonCode });
  } catch {
    const failure = new MigrationError('MIGRATION_HISTORY_TERMINAL_WRITE_FAILED');
    annotateFailure(failure, true);
    throw failure;
  }
}

function annotateFailure(error, historyAppended) {
  if (error && typeof error === 'object') {
    try {
      Object.defineProperties(error, {
        historyAppended: { value: historyAppended, enumerable: false, configurable: true },
        databaseMutated: { value: null, enumerable: false, configurable: true },
      });
    } catch {
      // A frozen dependency error remains authoritative; annotation is best-effort only.
    }
  }
}

function assertSuccessfulApplyResult(result) {
  const validBooleans = typeof result?.applied === 'boolean'
    && typeof result?.equivalentRerun === 'boolean'
    && (result.recoveredFinalVerification === undefined
      || typeof result.recoveredFinalVerification === 'boolean');
  const exactlyOneOutcome = result?.applied !== result?.equivalentRerun;
  const validRecovery = result?.recoveredFinalVerification !== true
    || (result.applied === false && result.equivalentRerun === true);
  if (result?.ready !== true || !validBooleans || !exactlyOneOutcome || !validRecovery) {
    throw new MigrationError('MIGRATION_RESULT_INVALID');
  }
}

function assertSuccessfulCompensationResult(result) {
  if (result?.ok !== true || result?.compensated !== true) {
    throw new MigrationError('MIGRATION_COMPENSATION_RESULT_INVALID');
  }
}

export async function applyMigrationWithDurableHistoryWithClient(
  client,
  {
    manifest = loadMigrationManifest(),
    directory,
    attemptId,
    applyImplementation = applyMigrationWithClient,
  } = {},
) {
  const canonicalArtifacts = validateMigrationArtifacts(
    directory ? { manifest, directory } : { manifest },
  );
  if (!canonicalArtifacts.ok) throw new MigrationError('MIGRATION_ARTIFACT_VALIDATION_FAILED');

  const historyInstallation = await installMigrationAttemptHistoryWithClient(client);
  const created = await createMigrationAttemptWithClient(client, {
    operation: 'APPLY',
    migrationVersion: manifest.version,
    migrationChecksum: manifest.checksum,
    ...(attemptId ? { attemptId } : {}),
  });
  try {
    const ledger = await readCanonicalLedger(client, manifest);
    const knownLedgerPhase = ledger?.completedPhase === 'complete'
      || manifest.phases.some((phase) => phase.id === ledger?.completedPhase);
    if (
      ledger
      && ledger.checksum === manifest.checksum
      && knownLedgerPhase
      && (ledger.completedPhase !== 'complete' || ledger.validityState !== 'VALID' || !ledger.appliedAt)
    ) {
      await appendMigrationAttemptEventWithClient(client, {
        attemptId: created.attemptId,
        eventType: 'RECOVERY_STARTED',
        phase: ledger.completedPhase,
        reasonCode: 'MIGRATION_RECOVERY_STARTED',
      });
    }

    const result = await applyImplementation(
      client,
      directory ? { manifest, directory } : { manifest },
    );
    assertSuccessfulApplyResult(result);
    const reasonCode = result.recoveredFinalVerification === true
      ? 'MIGRATION_RECOVERY_SUCCEEDED'
      : result.equivalentRerun === true
        ? 'MIGRATION_EQUIVALENT_RERUN_SUCCEEDED'
        : 'MIGRATION_APPLY_SUCCEEDED';
    await recordTerminalOrFail(client, created.attemptId, 'ATTEMPT_SUCCEEDED', reasonCode);
    return {
      ...result,
      attemptId: created.attemptId,
      historySchemaInstalled: historyInstallation.installed === true,
      historyAppended: true,
      migrationSchemaMutated:
        result.applied === true || result.recoveredFinalVerification === true,
      databaseMutated: true,
    };
  } catch (error) {
    const reasonCode = safeFailureReason(error);
    const eventType = REFUSAL_CODES.has(reasonCode) ? 'ATTEMPT_REFUSED' : 'ATTEMPT_FAILED';
    await recordTerminalOrFail(client, created.attemptId, eventType, reasonCode);
    annotateFailure(error, true);
    throw error;
  }
}

export async function compensateMigrationWithDurableHistoryWithClient(
  client,
  {
    manifest = loadMigrationManifest(),
    directory,
    attemptId,
    compensateImplementation = compensateMigrationWithClient,
  } = {},
) {
  const canonicalArtifacts = validateMigrationArtifacts(
    directory ? { manifest, directory } : { manifest },
  );
  if (!canonicalArtifacts.ok) throw new MigrationError('MIGRATION_ARTIFACT_VALIDATION_FAILED');

  const historyInstallation = await installMigrationAttemptHistoryWithClient(client);
  const created = await createMigrationAttemptWithClient(client, {
    operation: 'COMPENSATE',
    migrationVersion: manifest.version,
    migrationChecksum: manifest.checksum,
    ...(attemptId ? { attemptId } : {}),
  });
  try {
    const result = await compensateImplementation(
      client,
      directory ? { manifest, directory } : { manifest },
    );
    assertSuccessfulCompensationResult(result);
    await recordTerminalOrFail(
      client,
      created.attemptId,
      'ATTEMPT_SUCCEEDED',
      'MIGRATION_COMPENSATION_SUCCEEDED',
    );
    return {
      ...result,
      attemptId: created.attemptId,
      historySchemaInstalled: historyInstallation.installed === true,
      historyAppended: true,
      migrationSchemaMutated: result.compensated === true,
      databaseMutated: true,
    };
  } catch (error) {
    const reasonCode = safeFailureReason(error);
    const eventType = REFUSAL_CODES.has(reasonCode) ? 'ATTEMPT_REFUSED' : 'ATTEMPT_FAILED';
    await recordTerminalOrFail(client, created.attemptId, eventType, reasonCode);
    annotateFailure(error, true);
    throw error;
  }
}
