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

async function verifyDatabaseSchema(client) {
  const tableResult = await client.query(
    `SELECT to_regclass('local_agent_job_idempotency')::text AS table_name`
  );
  if (!tableResult.rows[0]?.table_name) {
    throw new LocalAgentHardeningMigrationError(
      'LOCAL_AGENT_MIGRATION_BINDING_TABLE_MISSING'
    );
  }

  const columnsResult = await client.query(
    `SELECT column_name
     FROM information_schema.columns
     WHERE table_schema = current_schema()
       AND table_name = 'local_agent_job_idempotency'
     ORDER BY ordinal_position`
  );
  const columns = new Set(columnsResult.rows.map((row) => row.column_name));
  const expectedColumns = [
    'id',
    'principal_id',
    'workspace_id',
    'device_id',
    'action',
    'idempotency_key_hash',
    'idempotency_scope_hash',
    'request_fingerprint_hash',
    'idempotency_origin',
    'job_id',
    'idempotency_until',
    'created_at',
    'updated_at'
  ];
  if (expectedColumns.some((column) => !columns.has(column))) {
    throw new LocalAgentHardeningMigrationError(
      'LOCAL_AGENT_MIGRATION_COLUMNS_INVALID'
    );
  }

  const constraintsResult = await client.query(
    `SELECT
       conname,
       contype,
       condeferrable,
       condeferred,
       pg_get_constraintdef(oid) AS definition
     FROM pg_constraint
     WHERE conrelid = 'local_agent_job_idempotency'::regclass`
  );
  const constraints = new Map(
    constraintsResult.rows.map((row) => [row.conname, row])
  );
  const scopeConstraint = constraints.get(
    'uq_local_agent_job_idempotency_scope'
  );
  const jobConstraint = constraints.get('fk_local_agent_job_idempotency_job');
  if (scopeConstraint?.contype !== 'u') {
    throw new LocalAgentHardeningMigrationError(
      'LOCAL_AGENT_MIGRATION_UNIQUENESS_INVALID'
    );
  }
  if (
    jobConstraint?.contype !== 'f'
    || jobConstraint.condeferrable !== true
    || jobConstraint.condeferred !== true
    || !String(jobConstraint.definition).includes('ON DELETE CASCADE')
  ) {
    throw new LocalAgentHardeningMigrationError(
      'LOCAL_AGENT_MIGRATION_FOREIGN_KEY_INVALID'
    );
  }

  const indexResult = await client.query(
    `SELECT to_regclass(
       'idx_local_agent_job_idempotency_expiry'
     )::text AS index_name`
  );
  if (!indexResult.rows[0]?.index_name) {
    throw new LocalAgentHardeningMigrationError(
      'LOCAL_AGENT_MIGRATION_EXPIRY_INDEX_MISSING'
    );
  }

  const coverageResult = await client.query(
    `SELECT COUNT(*)::int AS missing_bindings
     FROM job_data AS job_row
     WHERE job_row.job_type = 'local-agent'
       AND (
         job_row.status IN ('pending', 'running')
         OR job_row.idempotency_until > NOW()
       )
       AND NOT EXISTS (
         SELECT 1
         FROM local_agent_job_idempotency AS binding
         WHERE binding.job_id = job_row.id
       )`
  );
  const missingBindings = Number(coverageResult.rows[0]?.missing_bindings ?? 0);
  if (missingBindings !== 0) {
    throw new LocalAgentHardeningMigrationError(
      'LOCAL_AGENT_MIGRATION_BACKFILL_INCOMPLETE'
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
    scopeUniqueness: true,
    jobForeignKey: {
      onDeleteCascade: true,
      deferrable: true,
      initiallyDeferred: true
    },
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
        verification: await verifyDatabaseSchema(client)
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
            () => verifyDatabaseSchema(client)
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
