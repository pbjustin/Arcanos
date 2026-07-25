#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SCRIPT_DIRECTORY = dirname(fileURLToPath(import.meta.url));
export const REPOSITORY_ROOT = resolve(SCRIPT_DIRECTORY, '..');
export const MIGRATION_DIRECTORY = join(
  REPOSITORY_ROOT,
  'migrations',
  '20260724_local_agent_job_hardening_v1'
);
export const MIGRATION_MANIFEST_PATH = join(MIGRATION_DIRECTORY, 'manifest.json');
export const MIGRATION_DATABASE_ENV = 'DATABASE_PUBLIC_URL';
export const REVIEWED_MIGRATION_VERSION =
  '20260724_local_agent_job_hardening_v1';
export const REVIEWED_MIGRATION_CHECKSUM =
  '75cf9f3a914fafbd8d1ad453a2f47c5f930e8f2bdf45ac6e61f672c74f775bed';

const FORBIDDEN_TARGET_NAMES = new Set([
  'phase2e-validation-20260717',
  'phase2e-redis-r2-20260718'
]);

const EXPECTED_BINDING_COLUMNS = Object.freeze({
  id: { type: 'uuid', nullable: false, defaultKind: 'uuid' },
  principal_id: { type: 'text', nullable: false, defaultKind: 'none' },
  workspace_id: { type: 'text', nullable: false, defaultKind: 'none' },
  device_id: { type: 'text', nullable: false, defaultKind: 'none' },
  action: { type: 'text', nullable: false, defaultKind: 'none' },
  idempotency_key_hash: { type: 'text', nullable: false, defaultKind: 'none' },
  idempotency_scope_hash: { type: 'text', nullable: false, defaultKind: 'none' },
  request_fingerprint_hash: { type: 'text', nullable: false, defaultKind: 'none' },
  idempotency_origin: {
    type: 'varchar',
    nullable: false,
    defaultKind: 'none',
    maximumLength: 32
  },
  job_id: { type: 'uuid', nullable: false, defaultKind: 'none' },
  idempotency_until: { type: 'timestamptz', nullable: false, defaultKind: 'none' },
  created_at: { type: 'timestamptz', nullable: false, defaultKind: 'now' },
  updated_at: { type: 'timestamptz', nullable: false, defaultKind: 'now' }
});

const EXPECTED_BINDING_CONSTRAINTS = Object.freeze({
  local_agent_job_idempotency_pkey: {
    type: 'p',
    columns: ['id'],
    deferrable: false,
    initiallyDeferred: false
  },
  uq_local_agent_job_idempotency_scope: {
    type: 'u',
    columns: [
      'principal_id',
      'workspace_id',
      'device_id',
      'action',
      'idempotency_key_hash'
    ],
    deferrable: false,
    initiallyDeferred: false
  },
  uq_local_agent_job_idempotency_job: {
    type: 'u',
    columns: ['job_id'],
    deferrable: false,
    initiallyDeferred: false
  },
  fk_local_agent_job_idempotency_job: {
    type: 'f',
    columns: ['job_id'],
    deferrable: true,
    initiallyDeferred: true,
    referencedTable: 'job_data',
    referencedColumns: ['id'],
    updateAction: 'a',
    deleteAction: 'c'
  },
  chk_local_agent_job_idempotency_principal: {
    type: 'c',
    columns: ['principal_id'],
    deferrable: false,
    initiallyDeferred: false,
    definition: 'CHECK (length(btrim(principal_id)) > 0)'
  },
  chk_local_agent_job_idempotency_workspace: {
    type: 'c',
    columns: ['workspace_id'],
    deferrable: false,
    initiallyDeferred: false,
    definition: 'CHECK (length(btrim(workspace_id)) > 0)'
  },
  chk_local_agent_job_idempotency_device: {
    type: 'c',
    columns: ['device_id'],
    deferrable: false,
    initiallyDeferred: false,
    definition: 'CHECK (length(btrim(device_id)) > 0)'
  },
  chk_local_agent_job_idempotency_action: {
    type: 'c',
    columns: ['action'],
    deferrable: false,
    initiallyDeferred: false,
    definition: 'CHECK (length(btrim(action)) > 0)'
  },
  chk_local_agent_job_idempotency_key_hash: {
    type: 'c',
    columns: ['idempotency_key_hash'],
    deferrable: false,
    initiallyDeferred: false,
    definition: "CHECK (idempotency_key_hash ~ '^[0-9a-f]{64}$')"
  },
  chk_local_agent_job_idempotency_scope_hash: {
    type: 'c',
    columns: ['idempotency_scope_hash'],
    deferrable: false,
    initiallyDeferred: false,
    definition: "CHECK (idempotency_scope_hash ~ '^[0-9a-f]{64}$')"
  },
  chk_local_agent_job_idempotency_fingerprint_hash: {
    type: 'c',
    columns: ['request_fingerprint_hash'],
    deferrable: false,
    initiallyDeferred: false,
    definition: "CHECK (request_fingerprint_hash ~ '^[0-9a-f]{64}$')"
  },
  chk_local_agent_job_idempotency_origin: {
    type: 'c',
    columns: ['idempotency_origin'],
    deferrable: false,
    initiallyDeferred: false,
    definition: "CHECK (idempotency_origin IN ('explicit', 'derived'))"
  },
  chk_local_agent_job_idempotency_expiry: {
    type: 'c',
    columns: ['idempotency_until', 'created_at'],
    deferrable: false,
    initiallyDeferred: false,
    definition: 'CHECK (idempotency_until > created_at)'
  }
});

const EXPECTED_BINDING_INDEXES = Object.freeze({
  local_agent_job_idempotency_pkey: {
    unique: true,
    columns: ['id']
  },
  uq_local_agent_job_idempotency_scope: {
    unique: true,
    columns: [
      'principal_id',
      'workspace_id',
      'device_id',
      'action',
      'idempotency_key_hash'
    ]
  },
  uq_local_agent_job_idempotency_job: {
    unique: true,
    columns: ['job_id']
  },
  idx_local_agent_job_idempotency_expiry: {
    unique: false,
    columns: ['idempotency_until']
  }
});

export class LocalAgentHardeningMigrationError extends Error {
  constructor(code) {
    super(code);
    this.name = 'LocalAgentHardeningMigrationError';
    this.code = code;
  }
}

function sha256(value) {
  return createHash('sha256')
    .update(value.replace(/\r\n/gu, '\n'), 'utf8')
    .digest('hex');
}

function normalizeDefinition(value) {
  return String(value ?? '')
    .toLowerCase()
    .replace(/\s+/gu, '')
    .replace(/::character varying/gu, '')
    .replace(/::charactervarying/gu, '')
    .replace(/::varchar/gu, '')
    .replace(/::text\[\]/gu, '')
    .replace(/::text/gu, '')
    .replace(/[\[\]()]/gu, '')
    .replace(/=anyarray/gu, 'in');
}

function defaultMatches(value, expectedKind) {
  if (expectedKind === 'none') {
    return value === null || value === undefined;
  }
  const normalized = normalizeDefinition(value);
  if (expectedKind === 'uuid') {
    return normalized === 'gen_random_uuid';
  }
  return normalized === 'now' || normalized === 'current_timestamp';
}

function exactStringArray(value, expected, orderMatters = true) {
  if (
    !Array.isArray(value)
    || value.some((entry) => typeof entry !== 'string')
  ) {
    return false;
  }
  const actual = orderMatters ? value : [...value].sort();
  const required = orderMatters ? expected : [...expected].sort();
  return JSON.stringify(actual) === JSON.stringify(required);
}

function readManifest() {
  try {
    return JSON.parse(readFileSync(MIGRATION_MANIFEST_PATH, 'utf8'));
  } catch {
    throw new LocalAgentHardeningMigrationError(
      'LOCAL_AGENT_MIGRATION_MANIFEST_INVALID'
    );
  }
}

function readReviewedFile(relativePath) {
  if (
    typeof relativePath !== 'string'
    || relativePath.length === 0
    || relativePath.includes('..')
    || relativePath.includes('/')
    || relativePath.includes('\\')
  ) {
    throw new LocalAgentHardeningMigrationError(
      'LOCAL_AGENT_MIGRATION_PATH_INVALID'
    );
  }
  return readFileSync(join(MIGRATION_DIRECTORY, relativePath), 'utf8');
}

export function validateMigrationArtifacts() {
  const manifest = readManifest();
  const issues = [];
  if (manifest.version !== REVIEWED_MIGRATION_VERSION) {
    issues.push('version_mismatch');
  }
  if (manifest.transactional !== true) {
    issues.push('transaction_required');
  }
  if (!/^-?\d+$/u.test(String(manifest.advisoryLockKey ?? ''))) {
    issues.push('advisory_lock_invalid');
  }

  let forwardSql = '';
  let compensationSql = '';
  try {
    forwardSql = readReviewedFile(manifest.forwardPath);
  } catch {
    issues.push('forward_sql_unavailable');
  }
  try {
    compensationSql = readReviewedFile(manifest.compensationPath);
  } catch {
    issues.push('compensation_sql_unavailable');
  }

  const calculatedChecksum = forwardSql ? sha256(forwardSql) : null;
  if (
    manifest.checksum !== REVIEWED_MIGRATION_CHECKSUM
    || calculatedChecksum !== REVIEWED_MIGRATION_CHECKSUM
  ) {
    issues.push('checksum_mismatch');
  }
  if (!forwardSql.includes('CREATE TABLE IF NOT EXISTS local_agent_job_idempotency')) {
    issues.push('binding_table_missing');
  }
  if (!forwardSql.includes('DEFERRABLE INITIALLY DEFERRED')) {
    issues.push('deferred_job_foreign_key_missing');
  }
  if (!forwardSql.includes('uq_local_agent_job_idempotency_scope')) {
    issues.push('scope_uniqueness_missing');
  }
  if (!compensationSql.includes('DROP TABLE IF EXISTS local_agent_job_idempotency')) {
    issues.push('compensation_missing');
  }

  return {
    ok: issues.length === 0,
    version: manifest.version ?? null,
    schemaLabel: manifest.schemaLabel ?? null,
    checksum: manifest.checksum ?? null,
    calculatedChecksum,
    advisoryLockKey: String(manifest.advisoryLockKey ?? ''),
    forwardPath: manifest.forwardPath ?? null,
    compensationPath: manifest.compensationPath ?? null,
    issues: issues.sort()
  };
}

function readOptionValue(argv, index, option) {
  const value = argv[index + 1];
  if (!value || value.startsWith('--')) {
    throw new LocalAgentHardeningMigrationError(
      `LOCAL_AGENT_MIGRATION_${option.slice(2).replaceAll('-', '_').toUpperCase()}_MISSING`
    );
  }
  return value;
}

export function parseArgs(argv) {
  const options = {
    mode: 'plan',
    confirmPreview: false,
    confirmEmpty: false,
    expectedProjectId: null,
    expectedEnvironmentId: null,
    expectedPostgresServiceId: null
  };
  let selectedMode = false;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (
      argument === '--plan'
      || argument === '--apply-preview'
      || argument === '--verify-preview'
      || argument === '--compensate-preview'
    ) {
      if (selectedMode) {
        throw new LocalAgentHardeningMigrationError(
          'LOCAL_AGENT_MIGRATION_MODE_CONFLICT'
        );
      }
      selectedMode = true;
      options.mode = argument.slice(2);
    } else if (argument === '--confirm-preview') {
      options.confirmPreview = true;
    } else if (argument === '--confirm-empty') {
      options.confirmEmpty = true;
    } else if (argument === '--expected-project-id') {
      options.expectedProjectId = readOptionValue(argv, index, argument);
      index += 1;
    } else if (argument === '--expected-environment-id') {
      options.expectedEnvironmentId = readOptionValue(argv, index, argument);
      index += 1;
    } else if (argument === '--expected-postgres-service-id') {
      options.expectedPostgresServiceId = readOptionValue(argv, index, argument);
      index += 1;
    } else {
      throw new LocalAgentHardeningMigrationError(
        'LOCAL_AGENT_MIGRATION_ARGUMENT_INVALID'
      );
    }
  }
  return options;
}

function requireExactValue(expected, actual, code) {
  if (
    typeof expected !== 'string'
    || expected.trim().length === 0
    || typeof actual !== 'string'
    || actual.trim().length === 0
    || expected !== actual
  ) {
    throw new LocalAgentHardeningMigrationError(code);
  }
}

export function validatePreviewTarget(options, environment = process.env) {
  if (options.confirmPreview !== true) {
    throw new LocalAgentHardeningMigrationError(
      'LOCAL_AGENT_MIGRATION_PREVIEW_CONFIRMATION_REQUIRED'
    );
  }
  requireExactValue(
    options.expectedProjectId,
    environment.RAILWAY_PROJECT_ID,
    'LOCAL_AGENT_MIGRATION_PROJECT_MISMATCH'
  );
  requireExactValue(
    options.expectedEnvironmentId,
    environment.RAILWAY_ENVIRONMENT_ID,
    'LOCAL_AGENT_MIGRATION_ENVIRONMENT_MISMATCH'
  );
  requireExactValue(
    options.expectedPostgresServiceId,
    environment.RAILWAY_SERVICE_ID,
    'LOCAL_AGENT_MIGRATION_POSTGRES_SERVICE_MISMATCH'
  );

  const environmentName = String(environment.RAILWAY_ENVIRONMENT_NAME ?? '');
  const serviceName = String(environment.RAILWAY_SERVICE_NAME ?? '');
  const normalizedEnvironmentName = environmentName.trim().toLowerCase();
  const normalizedServiceName = serviceName.trim().toLowerCase();
  if (
    FORBIDDEN_TARGET_NAMES.has(normalizedEnvironmentName)
    || FORBIDDEN_TARGET_NAMES.has(normalizedServiceName)
  ) {
    throw new LocalAgentHardeningMigrationError(
      'LOCAL_AGENT_MIGRATION_FORBIDDEN_TARGET'
    );
  }
  if (
    !normalizedEnvironmentName
    || normalizedEnvironmentName === 'production'
    || !/(?:preview|(?:^|[-_])pr[-_]?\d+)/u.test(normalizedEnvironmentName)
  ) {
    throw new LocalAgentHardeningMigrationError(
      'LOCAL_AGENT_MIGRATION_PREVIEW_ENVIRONMENT_UNPROVEN'
    );
  }
  if (
    !normalizedServiceName
    || !/(?:postgres|database)/u.test(normalizedServiceName)
  ) {
    throw new LocalAgentHardeningMigrationError(
      'LOCAL_AGENT_MIGRATION_POSTGRES_SERVICE_UNPROVEN'
    );
  }
  if (environment.LOCAL_AGENT_HARDENING_PREVIEW_TARGET !== 'true') {
    throw new LocalAgentHardeningMigrationError(
      'LOCAL_AGENT_MIGRATION_PREVIEW_MARKER_REQUIRED'
    );
  }

  return {
    projectId: options.expectedProjectId,
    environmentId: options.expectedEnvironmentId,
    environmentName,
    postgresServiceId: options.expectedPostgresServiceId,
    postgresServiceName: serviceName
  };
}

export function readMigrationConnectionString(
  environment = process.env,
  validatedTarget = null
) {
  if (
    !validatedTarget
    || validatedTarget.projectId !== environment.RAILWAY_PROJECT_ID
    || validatedTarget.environmentId !== environment.RAILWAY_ENVIRONMENT_ID
    || validatedTarget.postgresServiceId !== environment.RAILWAY_SERVICE_ID
  ) {
    throw new LocalAgentHardeningMigrationError(
      'LOCAL_AGENT_MIGRATION_DATABASE_TARGET_UNBOUND'
    );
  }
  const connectionString = environment[MIGRATION_DATABASE_ENV];
  if (!connectionString) {
    throw new LocalAgentHardeningMigrationError(
      'LOCAL_AGENT_MIGRATION_DATABASE_ENV_MISSING'
    );
  }
  let parsed;
  try {
    parsed = new URL(connectionString);
  } catch {
    throw new LocalAgentHardeningMigrationError(
      'LOCAL_AGENT_MIGRATION_DATABASE_URL_INVALID'
    );
  }
  if (!['postgres:', 'postgresql:'].includes(parsed.protocol)) {
    throw new LocalAgentHardeningMigrationError(
      'LOCAL_AGENT_MIGRATION_DATABASE_URL_INVALID'
    );
  }
  const connectionParameters = [...parsed.searchParams.entries()];
  if (
    parsed.hash
    || connectionParameters.some(
      ([name, value]) => name !== 'sslmode' || value !== 'no-verify'
    )
    || connectionParameters.filter(([name]) => name === 'sslmode').length > 1
  ) {
    throw new LocalAgentHardeningMigrationError(
      'LOCAL_AGENT_MIGRATION_DATABASE_URL_PARAMETERS_DENIED'
    );
  }
  let internal;
  try {
    internal = new URL(String(environment.DATABASE_URL ?? ''));
  } catch {
    throw new LocalAgentHardeningMigrationError(
      'LOCAL_AGENT_MIGRATION_DATABASE_SERVICE_BINDING_INVALID'
    );
  }
  const databaseName = decodeURIComponent(parsed.pathname.replace(/^\/+/u, ''));
  const internalDatabaseName = decodeURIComponent(
    internal.pathname.replace(/^\/+/u, '')
  );
  const publicProxyDomain = String(
    environment.RAILWAY_TCP_PROXY_DOMAIN ?? ''
  ).trim().toLowerCase();
  const publicProxyPort = String(
    environment.RAILWAY_TCP_PROXY_PORT ?? ''
  ).trim();
  if (
    !['postgres:', 'postgresql:'].includes(internal.protocol)
    || !parsed.hostname
    || !internal.hostname
    || !publicProxyDomain
    || !publicProxyPort
    || parsed.hostname.toLowerCase() !== publicProxyDomain
    || parsed.port !== publicProxyPort
    || !parsed.username
    || !parsed.password
    || parsed.username !== internal.username
    || parsed.password !== internal.password
    || databaseName !== internalDatabaseName
    || decodeURIComponent(parsed.username) !== environment.PGUSER
    || decodeURIComponent(parsed.password) !== environment.PGPASSWORD
    || databaseName !== environment.PGDATABASE
    || internal.hostname !== environment.PGHOST
    || internal.port !== String(environment.PGPORT ?? '')
  ) {
    throw new LocalAgentHardeningMigrationError(
      'LOCAL_AGENT_MIGRATION_DATABASE_SERVICE_BINDING_INVALID'
    );
  }
  return connectionString;
}

export function readMigrationConnectionConfig(
  environment = process.env,
  validatedTarget = null
) {
  const connectionString = readMigrationConnectionString(
    environment,
    validatedTarget
  );
  const parsed = new URL(connectionString);
  const database = decodeURIComponent(parsed.pathname.replace(/^\/+/u, ''));
  return {
    host: parsed.hostname,
    port: Number(parsed.port),
    user: decodeURIComponent(parsed.username),
    'password': decodeURIComponent(parsed.password),
    database,
    ...(parsed.searchParams.get('sslmode') === 'no-verify'
      ? { ssl: { rejectUnauthorized: false } }
      : {})
  };
}

export async function verifyDatabaseSchemaWithClient(client) {
  const tableResult = await client.query(
    `SELECT to_regclass('local_agent_job_idempotency')::text AS table_name`
  );
  if (!tableResult.rows[0]?.table_name) {
    throw new LocalAgentHardeningMigrationError(
      'LOCAL_AGENT_MIGRATION_BINDING_TABLE_MISSING'
    );
  }

  const columnsResult = await client.query(
    `SELECT
       column_name,
       udt_name,
       is_nullable,
       column_default,
       character_maximum_length
     FROM information_schema.columns
     WHERE table_schema = current_schema()
       AND table_name = 'local_agent_job_idempotency'
     ORDER BY ordinal_position`
  );
  const expectedColumnEntries = Object.entries(EXPECTED_BINDING_COLUMNS);
  const columns = new Map(
    columnsResult.rows.map((row) => [row.column_name, row])
  );
  if (
    columnsResult.rows.length !== expectedColumnEntries.length
    || expectedColumnEntries.some(([columnName, expected]) => {
      const actual = columns.get(columnName);
      return (
        !actual
        || actual.udt_name !== expected.type
        || (actual.is_nullable === 'YES') !== expected.nullable
        || !defaultMatches(actual.column_default, expected.defaultKind)
        || (
          expected.maximumLength !== undefined
          && Number(actual.character_maximum_length) !== expected.maximumLength
        )
        || (
          expected.maximumLength === undefined
          && actual.character_maximum_length !== null
        )
      );
    })
  ) {
    throw new LocalAgentHardeningMigrationError(
      'LOCAL_AGENT_MIGRATION_COLUMNS_INVALID'
    );
  }

  const constraintsResult = await client.query(
    `SELECT
       conname,
       contype,
       convalidated,
       condeferrable,
       condeferred,
       pg_get_constraintdef(constraint_data.oid, true) AS definition,
       ARRAY(
         SELECT attribute.attname::text
         FROM unnest(constraint_data.conkey) WITH ORDINALITY
           AS key_column(attnum, position)
         JOIN pg_attribute AS attribute
           ON attribute.attrelid = constraint_data.conrelid
          AND attribute.attnum = key_column.attnum
         ORDER BY key_column.position
       ) AS columns,
       referenced_relation.relname AS referenced_table,
       CASE
         WHEN constraint_data.confrelid = 0 THEN ARRAY[]::text[]
         ELSE ARRAY(
           SELECT referenced_attribute.attname::text
           FROM unnest(constraint_data.confkey) WITH ORDINALITY
             AS referenced_key(attnum, position)
           JOIN pg_attribute AS referenced_attribute
             ON referenced_attribute.attrelid = constraint_data.confrelid
            AND referenced_attribute.attnum = referenced_key.attnum
           ORDER BY referenced_key.position
         )
       END AS referenced_columns,
       CASE
         WHEN constraint_data.confrelid = 0 THEN NULL
         ELSE referenced_namespace.nspname = current_schema()
       END AS referenced_schema_matches,
       constraint_data.confupdtype AS update_action,
       constraint_data.confdeltype AS delete_action
     FROM pg_constraint AS constraint_data
     JOIN pg_namespace AS namespace
       ON namespace.oid = constraint_data.connamespace
     LEFT JOIN pg_class AS referenced_relation
       ON referenced_relation.oid = constraint_data.confrelid
     LEFT JOIN pg_namespace AS referenced_namespace
       ON referenced_namespace.oid = referenced_relation.relnamespace
     WHERE constraint_data.conrelid =
       'local_agent_job_idempotency'::regclass
       AND namespace.nspname = current_schema()
       AND constraint_data.conname = ANY($1::text[])`,
    [Object.keys(EXPECTED_BINDING_CONSTRAINTS)]
  );
  const constraints = new Map(
    constraintsResult.rows.map((row) => [row.conname, row])
  );
  const expectedConstraintEntries = Object.entries(
    EXPECTED_BINDING_CONSTRAINTS
  );
  if (
    expectedConstraintEntries.some(([constraintName, expected]) => {
      const actual = constraints.get(constraintName);
      if (
        !actual
        || actual.contype !== expected.type
        || actual.convalidated !== true
        || actual.condeferrable !== expected.deferrable
        || actual.condeferred !== expected.initiallyDeferred
        || !exactStringArray(
          actual.columns,
          expected.columns,
          expected.type !== 'c'
        )
      ) {
        return true;
      }
      if (expected.type === 'c') {
        return normalizeDefinition(actual.definition)
          !== normalizeDefinition(expected.definition);
      }
      if (expected.type !== 'f') {
        return false;
      }
      return (
        actual.referenced_table !== expected.referencedTable
        || actual.referenced_schema_matches !== true
        || !exactStringArray(
          actual.referenced_columns,
          expected.referencedColumns
        )
        || actual.update_action !== expected.updateAction
        || actual.delete_action !== expected.deleteAction
      );
    })
  ) {
    throw new LocalAgentHardeningMigrationError(
      'LOCAL_AGENT_MIGRATION_CONSTRAINTS_INVALID'
    );
  }

  const indexResult = await client.query(
    `SELECT
       index_relation.relname AS index_name,
       index_data.indisunique AS is_unique,
       index_data.indisvalid AS is_valid,
       index_data.indisready AS is_ready,
       access_method.amname AS access_method,
       index_data.indnkeyatts::integer AS key_count,
       index_data.indnatts::integer AS attribute_count,
       index_data.indexprs IS NULL AS expressions_absent,
       index_data.indpred IS NULL AS predicate_absent,
       cardinality(index_data.indoption::smallint[]) >=
         index_data.indnkeyatts
         AND NOT EXISTS (
           SELECT 1
           FROM unnest(index_data.indoption::smallint[]) WITH ORDINALITY
             AS index_option(option_bits, position)
           WHERE index_option.position <= index_data.indnkeyatts
             AND index_option.option_bits <> 0
         ) AS sort_options_default,
       cardinality(index_data.indclass::oid[]) >=
         index_data.indnkeyatts
         AND NOT EXISTS (
           SELECT 1
           FROM unnest(
             index_data.indclass::oid[],
             index_data.indkey::smallint[]
           ) WITH ORDINALITY
             AS index_opclass(opclass_oid, attnum, position)
           LEFT JOIN pg_opclass AS operator_class
             ON operator_class.oid = index_opclass.opclass_oid
           LEFT JOIN pg_attribute AS opclass_attribute
             ON opclass_attribute.attrelid = index_data.indrelid
            AND opclass_attribute.attnum = index_opclass.attnum
           WHERE index_opclass.position <= index_data.indnkeyatts
             AND (
               operator_class.opcdefault IS DISTINCT FROM true
               OR operator_class.opcmethod IS DISTINCT FROM
                 index_relation.relam
               OR operator_class.opcintype IS DISTINCT FROM
                 opclass_attribute.atttypid
             )
         ) AS opclasses_default,
       cardinality(index_data.indcollation::oid[]) >=
         index_data.indnkeyatts
         AND NOT EXISTS (
           SELECT 1
           FROM unnest(
             index_data.indcollation::oid[],
             index_data.indkey::smallint[]
           ) WITH ORDINALITY
             AS index_collation(collation_oid, attnum, position)
           LEFT JOIN pg_attribute AS collated_attribute
             ON collated_attribute.attrelid = index_data.indrelid
            AND collated_attribute.attnum = index_collation.attnum
           WHERE index_collation.position <= index_data.indnkeyatts
             AND index_collation.collation_oid IS DISTINCT FROM
               collated_attribute.attcollation
         ) AS collations_default,
       ARRAY(
         SELECT attribute.attname::text
         FROM unnest(index_data.indkey::smallint[]) WITH ORDINALITY
           AS key_column(attnum, position)
         JOIN pg_attribute AS attribute
           ON attribute.attrelid = index_data.indrelid
          AND attribute.attnum = key_column.attnum
         WHERE key_column.position <= index_data.indnkeyatts
         ORDER BY key_column.position
       ) AS columns
     FROM pg_class AS index_relation
     JOIN pg_index AS index_data
       ON index_data.indexrelid = index_relation.oid
     JOIN pg_class AS table_relation
       ON table_relation.oid = index_data.indrelid
     JOIN pg_namespace AS namespace
       ON namespace.oid = table_relation.relnamespace
     JOIN pg_am AS access_method
       ON access_method.oid = index_relation.relam
     WHERE namespace.nspname = current_schema()
       AND table_relation.relname = 'local_agent_job_idempotency'
       AND index_relation.relname = ANY($1::text[])`,
    [Object.keys(EXPECTED_BINDING_INDEXES)]
  );
  const indexes = new Map(
    indexResult.rows.map((row) => [row.index_name, row])
  );
  const expectedIndexEntries = Object.entries(EXPECTED_BINDING_INDEXES);
  if (
    expectedIndexEntries.some(([indexName, expected]) => {
      const actual = indexes.get(indexName);
      return (
        !actual
        || actual.is_unique !== expected.unique
        || actual.is_valid !== true
        || actual.is_ready !== true
        || actual.access_method !== 'btree'
        || actual.key_count !== expected.columns.length
        || actual.attribute_count !== expected.columns.length
        || actual.expressions_absent !== true
        || actual.predicate_absent !== true
        || actual.sort_options_default !== true
        || actual.opclasses_default !== true
        || actual.collations_default !== true
        || !exactStringArray(actual.columns, expected.columns)
      );
    })
  ) {
    throw new LocalAgentHardeningMigrationError(
      'LOCAL_AGENT_MIGRATION_INDEX_INVALID'
    );
  }

  const requiredJobColumns = [
    'id',
    'worker_id',
    'job_type',
    'status',
    'input',
    'autonomy_state',
    'request_fingerprint_hash',
    'idempotency_key_hash',
    'idempotency_scope_hash',
    'idempotency_origin',
    'idempotency_until'
  ];
  const jobColumnsResult = await client.query(
    `SELECT column_name
     FROM information_schema.columns
     WHERE table_schema = current_schema()
       AND table_name = 'job_data'
       AND column_name = ANY($1::text[])`,
    [requiredJobColumns]
  );
  const jobColumns = new Set(
    jobColumnsResult.rows.map((row) => row.column_name)
  );
  if (requiredJobColumns.some((columnName) => !jobColumns.has(columnName))) {
    throw new LocalAgentHardeningMigrationError(
      'LOCAL_AGENT_MIGRATION_BINDING_PARITY_INVALID'
    );
  }

  const coverageResult = await client.query(
    `SELECT
       (
         SELECT COUNT(*)::int
         FROM job_data AS job_row
         WHERE job_row.job_type = 'local-agent'
           AND (
             job_row.status IN ('pending', 'running')
             OR job_row.idempotency_until > NOW()
             OR (
               job_row.autonomy_state
                 #>> '{localAgent,manualReconciliationRequired}'
             ) = 'true'
           )
           AND NOT EXISTS (
             SELECT 1
             FROM local_agent_job_idempotency AS binding
             WHERE binding.job_id = job_row.id
           )
       ) AS missing_bindings,
       (
         SELECT COUNT(*)::int
         FROM local_agent_job_idempotency AS binding
         LEFT JOIN job_data AS job_row
           ON job_row.id = binding.job_id
         WHERE job_row.id IS NULL
           OR job_row.job_type IS DISTINCT FROM 'local-agent'
           OR binding.device_id IS DISTINCT FROM job_row.worker_id
           OR binding.principal_id IS DISTINCT FROM
             job_row.input->'job'->>'principal'
           OR binding.workspace_id IS DISTINCT FROM
             job_row.input->'job'->>'workspace'
           OR binding.device_id IS DISTINCT FROM
             job_row.input->'job'->>'deviceId'
           OR binding.action IS DISTINCT FROM
             job_row.input->'job'->>'action'
           OR binding.idempotency_key_hash IS DISTINCT FROM
             job_row.idempotency_key_hash
           OR binding.idempotency_scope_hash IS DISTINCT FROM
             job_row.idempotency_scope_hash
           OR binding.request_fingerprint_hash IS DISTINCT FROM
             job_row.request_fingerprint_hash
           OR binding.idempotency_origin IS DISTINCT FROM
             job_row.idempotency_origin
           OR binding.idempotency_until IS DISTINCT FROM
             job_row.idempotency_until
       ) AS mismatched_bindings`
  );
  const missingBindings = Number(coverageResult.rows[0]?.missing_bindings ?? 0);
  const mismatchedBindings = Number(
    coverageResult.rows[0]?.mismatched_bindings ?? 0
  );
  if (missingBindings !== 0) {
    throw new LocalAgentHardeningMigrationError(
      'LOCAL_AGENT_MIGRATION_BACKFILL_INCOMPLETE'
    );
  }
  if (mismatchedBindings !== 0) {
    throw new LocalAgentHardeningMigrationError(
      'LOCAL_AGENT_MIGRATION_BINDING_PARITY_INVALID'
    );
  }

  const countResult = await client.query(
    `SELECT COUNT(*)::int AS binding_count
     FROM local_agent_job_idempotency`
  );
  return {
    table: 'local_agent_job_idempotency',
    bindingCount: Number(countResult.rows[0]?.binding_count ?? 0),
    missingBindings,
    mismatchedBindings,
    scopeUniqueness: true,
    jobForeignKey: {
      onDeleteCascade: true,
      deferrable: true,
      initiallyDeferred: true
    },
    exactColumns: true,
    expectedConstraintsValid: true,
    expectedIndexesValid: true,
    expiryIndex: true
  };
}

async function openPreviewClient(options, environment = process.env) {
  const target = validatePreviewTarget(options, environment);
  const connection = readMigrationConnectionConfig(environment, target);
  const pg = await import('pg');
  const Client = pg.Client ?? pg.default?.Client;
  const client = new Client({
    ...connection,
    application_name: 'arcanos-local-agent-hardening-migration',
    connectionTimeoutMillis: 10_000,
    statement_timeout: 60_000,
    query_timeout: 60_000
  });
  await client.connect();
  return { client, target };
}

async function withMigrationLock(client, lockKey, callback) {
  const lockResult = await client.query(
    'SELECT pg_try_advisory_lock($1::bigint) AS locked',
    [lockKey]
  );
  if (lockResult.rows[0]?.locked !== true) {
    throw new LocalAgentHardeningMigrationError(
      'LOCAL_AGENT_MIGRATION_LOCK_UNAVAILABLE'
    );
  }
  try {
    return await callback();
  } finally {
    await client.query('SELECT pg_advisory_unlock($1::bigint)', [lockKey]);
  }
}

async function runTransactionalSql(client, sql, callback) {
  await client.query('BEGIN');
  try {
    await client.query(`SET LOCAL lock_timeout = '5s'`);
    await client.query(`SET LOCAL statement_timeout = '60s'`);
    await client.query(sql);
    const verification = callback ? await callback() : null;
    await client.query('COMMIT');
    return verification;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}

export async function main(
  argv = process.argv.slice(2),
  environment = process.env
) {
  const options = parseArgs(argv);
  const artifacts = validateMigrationArtifacts();
  if (!artifacts.ok) {
    throw new LocalAgentHardeningMigrationError(
      'LOCAL_AGENT_MIGRATION_ARTIFACTS_UNVERIFIED'
    );
  }
  if (options.mode === 'plan') {
    return {
      ok: true,
      mode: options.mode,
      artifacts
    };
  }
  if (
    options.mode === 'compensate-preview'
    && options.confirmEmpty !== true
  ) {
    throw new LocalAgentHardeningMigrationError(
      'LOCAL_AGENT_MIGRATION_EMPTY_CONFIRMATION_REQUIRED'
    );
  }

  const manifest = readManifest();
  const { client, target } = await openPreviewClient(options, environment);
  try {
    if (options.mode === 'verify-preview') {
      return {
        ok: true,
        mode: options.mode,
        artifacts,
        target,
        verification: await verifyDatabaseSchemaWithClient(client)
      };
    }

    return await withMigrationLock(
      client,
      String(manifest.advisoryLockKey),
      async () => {
        if (options.mode === 'apply-preview') {
          const forwardSql = readReviewedFile(manifest.forwardPath);
          const verification = await runTransactionalSql(
            client,
            forwardSql,
            () => verifyDatabaseSchemaWithClient(client)
          );
          return {
            ok: true,
            mode: options.mode,
            artifacts,
            target,
            verification
          };
        }

        const compensationSql = readReviewedFile(manifest.compensationPath);
        await runTransactionalSql(client, compensationSql);
        const tableResult = await client.query(
          `SELECT to_regclass('local_agent_job_idempotency')::text AS table_name`
        );
        if (tableResult.rows[0]?.table_name) {
          throw new LocalAgentHardeningMigrationError(
            'LOCAL_AGENT_MIGRATION_COMPENSATION_INCOMPLETE'
          );
        }
        return {
          ok: true,
          mode: options.mode,
          artifacts,
          target,
          verification: { bindingTableRemoved: true }
        };
      }
    );
  } finally {
    await client.end();
  }
}

const invokedPath = process.argv[1]
  ? pathToFileURL(resolve(process.argv[1])).href
  : null;
if (invokedPath === import.meta.url) {
  main()
    .then((result) => {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    })
    .catch((error) => {
      const code = error instanceof LocalAgentHardeningMigrationError
        ? error.code
        : 'LOCAL_AGENT_MIGRATION_UNEXPECTED_FAILURE';
      process.stderr.write(
        `${JSON.stringify({
          ok: false,
          error: {
            code,
            type: error instanceof Error ? error.name : typeof error
          }
        })}\n`
      );
      process.exitCode = 1;
    });
}
