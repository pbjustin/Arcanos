#!/usr/bin/env node
/**
 * Sealed PostgreSQL pre-deploy attestor for the disposable Backstage proof.
 *
 * Railway runs `empty` in the worker application image and `schema` in the web
 * application image. Both modes use the normal proof environment and private
 * database reference, issue only read-only SQL, and emit one fixed sentinel.
 */

import process from 'node:process';
import { pathToFileURL } from 'node:url';

import {
  resolveBackstageHeavyProofTargetOrThrow,
} from './railway-backstage-heavy-proof-supervisor.mjs';

export const BACKSTAGE_HEAVY_DB_PREFLIGHT_EMPTY_SUCCESS =
  'ARCANOS_BACKSTAGE_HEAVY_DB_PREFLIGHT_EMPTY_OK_V1';
export const BACKSTAGE_HEAVY_DB_PREFLIGHT_SCHEMA_SUCCESS =
  'ARCANOS_BACKSTAGE_HEAVY_DB_PREFLIGHT_SCHEMA_OK_V1';
export const BACKSTAGE_HEAVY_DB_PREFLIGHT_ERROR =
  'ARCANOS_BACKSTAGE_HEAVY_DB_PREFLIGHT_ERROR_V1';

const DATABASE_HOST = 'postgres.railway.internal';
const DATABASE_PORT = '5432';
const DATABASE_NAME = 'railway';
const DATABASE_IDENTITY_QUERY =
  `SELECT current_database() = '${DATABASE_NAME}' AS database_valid`;
const EMPTY_TABLE_QUERY = `SELECT COUNT(*)::integer AS user_table_count
FROM pg_catalog.pg_tables
WHERE schemaname <> 'pg_catalog'
  AND schemaname <> 'information_schema'
  AND schemaname <> 'pg_toast'
  AND schemaname NOT LIKE 'pg_toast_temp_%'
  AND schemaname NOT LIKE 'pg_temp_%'`;
const SCHEMA_RELATION_QUERY = `SELECT
  EXISTS (
    SELECT 1 FROM pg_catalog.pg_tables
    WHERE schemaname = 'public' AND tablename = 'job_data'
  ) AS job_data_exists,
  EXISTS (
    SELECT 1 FROM pg_catalog.pg_tables
    WHERE schemaname = 'public' AND tablename = 'job_events'
  ) AS job_events_exists`;
const SCHEMA_COUNT_QUERY = `SELECT
  (SELECT COUNT(*)::integer FROM public.job_data) AS job_count,
  (SELECT COUNT(*)::integer FROM public.job_events) AS event_count`;

function fail(code) {
  throw new Error(code);
}

/** Parse the intentionally tiny command surface. */
export function resolveBackstageHeavyDbPreflightConfig(args) {
  if (
    !Array.isArray(args)
    || args.length !== 2
    || args[0] !== '--mode'
    || (args[1] !== 'empty' && args[1] !== 'schema')
  ) {
    fail('BACKSTAGE_HEAVY_DB_PREFLIGHT_ARGUMENT_INVALID');
  }
  return {
    mode: args[1],
    processKind: args[1] === 'empty' ? 'worker' : 'web',
  };
}

function attestPrivateDatabaseUrl(rawValue) {
  if (
    typeof rawValue !== 'string'
    || rawValue.length === 0
    || rawValue !== rawValue.trim()
  ) {
    fail('BACKSTAGE_HEAVY_DB_PREFLIGHT_DATABASE_URL_INVALID');
  }
  let parsed;
  try {
    parsed = new URL(rawValue);
  } catch {
    fail('BACKSTAGE_HEAVY_DB_PREFLIGHT_DATABASE_URL_INVALID');
  }
  if (
    (parsed.protocol !== 'postgres:' && parsed.protocol !== 'postgresql:')
    || parsed.hostname.toLowerCase() !== DATABASE_HOST
    || parsed.port !== DATABASE_PORT
    || parsed.pathname !== `/${DATABASE_NAME}`
    || !parsed.username
    || !parsed.password
    || parsed.search
    || parsed.hash
  ) {
    fail('BACKSTAGE_HEAVY_DB_PREFLIGHT_DATABASE_URL_INVALID');
  }
  return rawValue;
}

/** Bind the mode to the sealed app role and its exact Railway identity. */
export function attestBackstageHeavyDbPreflightRuntime(config, env) {
  if (
    !config
    || (
      config.mode === 'empty'
        ? config.processKind !== 'worker'
        : config.mode !== 'schema' || config.processKind !== 'web'
    )
  ) {
    fail('BACKSTAGE_HEAVY_DB_PREFLIGHT_ARGUMENT_INVALID');
  }
  const proofTarget = resolveBackstageHeavyProofTargetOrThrow(
    config.processKind,
    env
  );
  if (
    !proofTarget.enabled
    || proofTarget.processKind !== config.processKind
    || proofTarget.postgresServiceId
      !== env.ARCANOS_BACKSTAGE_HEAVY_POSTGRES_SERVICE_ID?.toLowerCase()
    || proofTarget.postgresInternalHost !== DATABASE_HOST
    || env.ARCANOS_BACKSTAGE_HEAVY_POSTGRES_SERVICE_NAME !== 'Postgres'
    || env.ARCANOS_BACKSTAGE_HEAVY_POSTGRES_INTERNAL_HOST !== DATABASE_HOST
    || env.RAILWAY_GIT_COMMIT_SHA?.toLowerCase()
      !== proofTarget.sourceCommit
  ) {
    fail('BACKSTAGE_HEAVY_DB_PREFLIGHT_RUNTIME_IDENTITY_MISMATCH');
  }
  return {
    ...proofTarget,
    databaseUrl: attestPrivateDatabaseUrl(proofTarget.databaseUrl),
  };
}

function successSentinelForMode(mode) {
  return mode === 'empty'
    ? BACKSTAGE_HEAVY_DB_PREFLIGHT_EMPTY_SUCCESS
    : BACKSTAGE_HEAVY_DB_PREFLIGHT_SCHEMA_SUCCESS;
}

function isKnownPreflightError(error) {
  return error instanceof Error
    && error.message.startsWith('BACKSTAGE_HEAVY_DB_PREFLIGHT_');
}

/** Execute the sealed read-only database attestation. */
export async function runBackstageHeavyDbPreflight(config, options = {}) {
  const proofTarget = attestBackstageHeavyDbPreflightRuntime(
    config,
    options.env ?? process.env
  );
  let Client = options.Client;
  if (!Client) {
    try {
      const pgModule = await import('pg');
      Client = pgModule.Client ?? pgModule.default?.Client;
    } catch {
      fail('BACKSTAGE_HEAVY_DB_PREFLIGHT_DATABASE_CLIENT_UNAVAILABLE');
    }
  }
  if (typeof Client !== 'function') {
    fail('BACKSTAGE_HEAVY_DB_PREFLIGHT_DATABASE_CLIENT_UNAVAILABLE');
  }

  let client;
  let transactionStarted = false;
  let cleanupFailed = false;
  try {
    client = new Client({
      application_name:
        `arcanos_backstage_heavy_db_preflight_${config.mode}_v1`,
      connectionString: proofTarget.databaseUrl,
      connectionTimeoutMillis: 5_000,
      query_timeout: 5_000,
      options:
        '-c default_transaction_read_only=on -c statement_timeout=5000 -c lock_timeout=1000',
    });
    await client.connect();
    await client.query(
      'BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY'
    );
    transactionStarted = true;
    await client.query('SET LOCAL search_path = pg_catalog, public');
    const readOnly = await client.query('SHOW transaction_read_only');
    if (readOnly.rows?.[0]?.transaction_read_only !== 'on') {
      fail('BACKSTAGE_HEAVY_DB_PREFLIGHT_DATABASE_NOT_READ_ONLY');
    }
    const databaseIdentity = await client.query(DATABASE_IDENTITY_QUERY);
    if (databaseIdentity.rows?.[0]?.database_valid !== true) {
      fail('BACKSTAGE_HEAVY_DB_PREFLIGHT_DATABASE_IDENTITY_INVALID');
    }

    if (config.mode === 'empty') {
      const result = await client.query(EMPTY_TABLE_QUERY);
      if (result.rows?.[0]?.user_table_count !== 0) {
        fail('BACKSTAGE_HEAVY_DB_PREFLIGHT_DATABASE_NOT_EMPTY');
      }
    } else {
      const relations = await client.query(SCHEMA_RELATION_QUERY);
      if (
        relations.rows?.[0]?.job_data_exists !== true
        || relations.rows?.[0]?.job_events_exists !== true
      ) {
        fail('BACKSTAGE_HEAVY_DB_PREFLIGHT_SCHEMA_INVALID');
      }
      const counts = await client.query(SCHEMA_COUNT_QUERY);
      if (
        counts.rows?.[0]?.job_count !== 0
        || counts.rows?.[0]?.event_count !== 0
      ) {
        fail('BACKSTAGE_HEAVY_DB_PREFLIGHT_SCHEMA_INVALID');
      }
    }

    await client.query('ROLLBACK');
    transactionStarted = false;
  } catch (error) {
    if (isKnownPreflightError(error)) {
      throw error;
    }
    fail('BACKSTAGE_HEAVY_DB_PREFLIGHT_DATABASE_FAILED');
  } finally {
    if (transactionStarted && client) {
      await client.query('ROLLBACK').catch(() => {
        cleanupFailed = true;
      });
    }
    if (client) {
      await client.end().catch(() => {
        cleanupFailed = true;
      });
    }
    if (cleanupFailed) {
      fail('BACKSTAGE_HEAVY_DB_PREFLIGHT_CLEANUP_FAILED');
    }
  }

  return successSentinelForMode(config.mode);
}

/** CLI boundary: emit only a fixed success or generic error sentinel. */
export async function main(options = {}) {
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;
  try {
    const config = resolveBackstageHeavyDbPreflightConfig(
      options.args ?? process.argv.slice(2)
    );
    const sentinel = await runBackstageHeavyDbPreflight(config, options);
    stdout.write(`${sentinel}\n`);
    return 0;
  } catch {
    stderr.write(`${BACKSTAGE_HEAVY_DB_PREFLIGHT_ERROR}\n`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main().then(exitCode => {
    process.exitCode = exitCode;
  });
}
