#!/usr/bin/env node

import { writeSync } from 'node:fs';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

export const PHASE2E_VALIDATOR_PROJECT_ID = '7faf44e5-519c-4e73-8d7a-da9f389e6187';
export const PHASE2E_VALIDATOR_ENVIRONMENT_ID = 'fb99f47d-5ef5-44c1-96c2-acf7b90fab13';
export const PHASE2E_VALIDATOR_ENVIRONMENT_NAME = 'phase2e-validation-20260717';

const MIGRATION_MODULE_URL = new URL('./action-plan-execution-migration.mjs', import.meta.url);
const MIGRATION_HISTORY_MODULE_URL = new URL(
  './action-plan-execution-migration-history.mjs',
  import.meta.url,
);
const SERVICE_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const SERVICE_NAME_PATTERN = /^phase2e-postgres18-validator-[a-z0-9-]+$/u;
const SOURCE_COMMIT_PATTERN = /^[0-9a-f]{40}$/u;
const PRIVATE_DATABASE_HOST_SUFFIX = '.railway.internal';

const OPERATIONS = new Map([
  ['--plan', 'plan'],
  ['--apply', 'apply'],
  ['--verify', 'verify'],
  ['--verify-runtime', 'verify-runtime'],
  ['--drain', 'drain'],
]);

const FORBIDDEN_VARIABLES = new Set([
  'ACTION_PLAN_EXECUTION_MIGRATION_DATABASE_URL',
  'API_KEY',
  'AI_MODEL',
  'ARCANOS_PROCESS_KIND',
  'CLI_BRIDGE_ENABLED',
  'DATABASE_PRIVATE_URL',
  'DATABASE_PUBLIC_URL',
  'DYLD_INSERT_LIBRARIES',
  'DYLD_LIBRARY_PATH',
  'ENABLE_ACTION_PLANS',
  'ENABLE_AUTO_HEAL',
  'ENABLE_CLEAR_2',
  'ENABLE_CLI_BRIDGE',
  'GPT51_MODEL',
  'GPT5_MODEL',
  'HEALING_ENABLED',
  'LD_LIBRARY_PATH',
  'LD_PRELOAD',
  'MCP_ENABLED',
  'NODE_EXTRA_CA_CERTS',
  'NODE_OPTIONS',
  'NODE_PATH',
  'OPENAI_API_KEY',
  'OPENAI_API_KEY_REQUIRED',
  'OPENAI_BASE_URL',
  'PROVIDER_HEALTHCHECK_ENABLED',
  'REDIS_PUBLIC_URL',
  'REDIS_URL',
  'SHADOW_DATABASE_URL',
  'RAILWAY_OPENAI_API_KEY',
  'RAILWAY_PUBLIC_DOMAIN',
  'RAILWAY_STATIC_URL',
  'RAILWAY_TCP_PROXY_DOMAIN',
  'RAILWAY_TCP_PROXY_PORT',
  'RUN_WORKERS',
  'WORKER_ENABLED',
]);

const FORBIDDEN_VARIABLE_PREFIXES = [
  'ANTHROPIC_',
  'ARCANOS_CLI_BRIDGE_',
  'ARCANOS_GPT_',
  'ARCANOS_HEAL',
  'ARCANOS_MCP_',
  'ARCANOS_OPENAI_',
  'ARCANOS_PROVIDER_',
  'ARCANOS_WORKER_',
  'AWS_',
  'AZURE_',
  'AUTO_HEAL',
  'BRIDGE_',
  'CLI_BRIDGE_',
  'COHERE_',
  'GCP_',
  'GOOGLE_',
  'GROQ_',
  'HF_',
  'HUGGINGFACE_',
  'JOB_WORKER_',
  'MCP_',
  'MISTRAL_',
  'OPENAI_',
  'PG',
  'POSTGRES',
  'PROVIDER_',
  'QUEUE_WORKER_',
  'REDIS',
  'SELF_HEAL',
];

const ALLOWED_SENSITIVE_VARIABLES = new Set([
  'DATABASE_URL',
  'PHASE2E_VALIDATOR_EXPECTED_DATABASE_HOST',
  'PHASE2E_VALIDATOR_EXPECTED_DATABASE_NAME',
  'PHASE2E_VALIDATOR_EXPECTED_SERVICE_ID',
  'PHASE2E_VALIDATOR_EXPECTED_SERVICE_NAME',
  'PHASE2E_VALIDATOR_EXPECTED_SOURCE_COMMIT',
  'RAILWAY_GIT_COMMIT_SHA',
]);
const SENSITIVE_VARIABLE_NAME = /(?:API_?KEY|AUTH|BEARER|CREDENTIAL|DATABASE|DB_|PASSWORD|PRIVATE_?KEY|REDIS|SECRET|TOKEN|URL)/iu;

const SAFE_MIGRATION_FAILURE_CODES = new Set([
  'MIGRATION_ADVISORY_LOCK_UNAVAILABLE',
  'MIGRATION_ADVISORY_UNLOCK_FAILED',
  'MIGRATION_ARTIFACT_VALIDATION_FAILED',
  'MIGRATION_CONCURRENT_INDEX_DEFINITION_INVALID',
  'MIGRATION_CONCURRENT_INDEX_INVALID',
  'MIGRATION_CONCURRENT_PHASE_NOT_SINGLE_STATEMENT',
  'MIGRATION_DRAIN_COUNT_INVALID',
  'MIGRATION_INDEX_RECOVERY_NOT_ALLOWLISTED',
  'MIGRATION_HISTORY_ARTIFACT_VALIDATION_FAILED',
  'MIGRATION_HISTORY_SCHEMA_INVALID',
  'MIGRATION_HISTORY_INSTALL_MARKER_MISSING',
  'MIGRATION_HISTORY_TERMINAL_WRITE_FAILED',
  'MIGRATION_RESULT_INVALID',
  'MIGRATION_COMPENSATION_RESULT_INVALID',
  'MIGRATION_LEDGER_CHECKSUM_CONFLICT',
  'MIGRATION_LEDGER_PHASE_UNKNOWN',
  'MIGRATION_LEDGER_RECOVERY_PHASE_INVALID',
  'MIGRATION_NONTRANSACTIONAL_PHASE_INVALID',
  'MIGRATION_SCHEMA_VERIFICATION_FAILED',
]);

export class Phase2eValidatorError extends Error {
  constructor(code) {
    super(code);
    this.name = 'Phase2eValidatorError';
    this.code = code;
  }
}

function fail(code) {
  throw new Phase2eValidatorError(code);
}

function hasOwn(environment, key) {
  return Object.prototype.hasOwnProperty.call(environment, key);
}

export function parseValidatorOperation(argv) {
  if (argv.length !== 1 || !OPERATIONS.has(argv[0])) {
    fail('PHASE2E_VALIDATOR_ARGUMENT_INVALID');
  }
  return OPERATIONS.get(argv[0]);
}

function assertNoForbiddenVariables(environment) {
  const variableNames = Object.keys(environment);
  for (const variableName of variableNames) {
    if (
      FORBIDDEN_VARIABLES.has(variableName)
      || FORBIDDEN_VARIABLE_PREFIXES.some((prefix) => variableName.startsWith(prefix))
      || (
        SENSITIVE_VARIABLE_NAME.test(variableName)
        && !ALLOWED_SENSITIVE_VARIABLES.has(variableName)
      )
    ) {
      fail('PHASE2E_VALIDATOR_FORBIDDEN_VARIABLE_PRESENT');
    }
  }
}

export function validatePrivateDatabaseUrl(rawValue) {
  if (typeof rawValue !== 'string' || rawValue.length === 0) {
    fail('PHASE2E_VALIDATOR_DATABASE_URL_MISSING');
  }

  let parsed;
  try {
    parsed = new URL(rawValue);
  } catch {
    fail('PHASE2E_VALIDATOR_DATABASE_URL_INVALID');
  }

  if (parsed.protocol !== 'postgres:' && parsed.protocol !== 'postgresql:') {
    fail('PHASE2E_VALIDATOR_DATABASE_PROTOCOL_FORBIDDEN');
  }
  if (parsed.search.length > 0 || parsed.hash.length > 0) {
    fail('PHASE2E_VALIDATOR_DATABASE_OPTIONS_FORBIDDEN');
  }
  if (
    parsed.hostname.length === PRIVATE_DATABASE_HOST_SUFFIX.length
    || !parsed.hostname.toLowerCase().endsWith(PRIVATE_DATABASE_HOST_SUFFIX)
  ) {
    fail('PHASE2E_VALIDATOR_DATABASE_PRIVATE_HOST_REQUIRED');
  }
  if (parsed.username.length === 0 || parsed.password.length === 0) {
    fail('PHASE2E_VALIDATOR_DATABASE_CREDENTIAL_MISSING');
  }
  if (parsed.pathname.length <= 1) {
    fail('PHASE2E_VALIDATOR_DATABASE_NAME_MISSING');
  }

  return rawValue;
}

export function validateValidatorEnvironment(environment) {
  const environmentName = environment.RAILWAY_ENVIRONMENT_NAME;
  if (
    typeof environmentName === 'string'
    && environmentName.toLowerCase().includes('production')
  ) {
    fail('PHASE2E_VALIDATOR_PRODUCTION_FORBIDDEN');
  }
  if (
    typeof environment.RAILWAY_ENVIRONMENT === 'string'
    && environment.RAILWAY_ENVIRONMENT.toLowerCase().includes('production')
  ) {
    fail('PHASE2E_VALIDATOR_PRODUCTION_FORBIDDEN');
  }
  if (environment.RAILWAY_PROJECT_ID !== PHASE2E_VALIDATOR_PROJECT_ID) {
    fail('PHASE2E_VALIDATOR_PROJECT_MISMATCH');
  }
  if (
    environment.RAILWAY_ENVIRONMENT_ID !== PHASE2E_VALIDATOR_ENVIRONMENT_ID
    || environmentName !== PHASE2E_VALIDATOR_ENVIRONMENT_NAME
  ) {
    fail('PHASE2E_VALIDATOR_ENVIRONMENT_MISMATCH');
  }

  const serviceId = environment.RAILWAY_SERVICE_ID;
  const expectedServiceId = environment.PHASE2E_VALIDATOR_EXPECTED_SERVICE_ID;
  const serviceName = environment.RAILWAY_SERVICE_NAME;
  const expectedServiceName = environment.PHASE2E_VALIDATOR_EXPECTED_SERVICE_NAME;
  if (
    typeof serviceId !== 'string'
    || typeof expectedServiceId !== 'string'
    || !SERVICE_ID_PATTERN.test(serviceId)
    || serviceId !== expectedServiceId
    || typeof serviceName !== 'string'
    || typeof expectedServiceName !== 'string'
    || !SERVICE_NAME_PATTERN.test(serviceName)
    || serviceName !== expectedServiceName
  ) {
    fail('PHASE2E_VALIDATOR_SERVICE_MISMATCH');
  }

  const sourceCommit = environment.PHASE2E_VALIDATOR_EXPECTED_SOURCE_COMMIT;
  const railwaySourceCommit = environment.RAILWAY_GIT_COMMIT_SHA;
  if (
    typeof sourceCommit !== 'string'
    || !SOURCE_COMMIT_PATTERN.test(sourceCommit)
    || typeof railwaySourceCommit !== 'string'
    || !SOURCE_COMMIT_PATTERN.test(railwaySourceCommit)
    || railwaySourceCommit !== sourceCommit
  ) {
    fail('PHASE2E_VALIDATOR_SOURCE_COMMIT_MISMATCH');
  }

  assertNoForbiddenVariables(environment);
  if (hasOwn(environment, 'DATABASE_PUBLIC_URL') || hasOwn(environment, 'REDIS_PUBLIC_URL')) {
    fail('PHASE2E_VALIDATOR_FORBIDDEN_VARIABLE_PRESENT');
  }

  const databaseUrl = validatePrivateDatabaseUrl(environment.DATABASE_URL);
  const parsedDatabaseUrl = new URL(databaseUrl);
  const expectedDatabaseHost = environment.PHASE2E_VALIDATOR_EXPECTED_DATABASE_HOST;
  const expectedDatabaseName = environment.PHASE2E_VALIDATOR_EXPECTED_DATABASE_NAME;
  if (
    typeof expectedDatabaseHost !== 'string'
    || !/^[a-z0-9-]+\.railway\.internal$/u.test(expectedDatabaseHost)
    || parsedDatabaseUrl.hostname !== expectedDatabaseHost
    || typeof expectedDatabaseName !== 'string'
    || !/^[A-Za-z0-9_-]+$/u.test(expectedDatabaseName)
    || decodeURIComponent(parsedDatabaseUrl.pathname.slice(1)) !== expectedDatabaseName
  ) {
    fail('PHASE2E_VALIDATOR_DATABASE_IDENTITY_MISMATCH');
  }
  return {
    databaseUrl,
    databaseName: expectedDatabaseName,
    environmentId: PHASE2E_VALIDATOR_ENVIRONMENT_ID,
    projectId: PHASE2E_VALIDATOR_PROJECT_ID,
    serviceId,
    sourceCommit,
  };
}

function safeCount(value) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : 0;
}

function baseOutput(context, operation, migration) {
  return {
    operation,
    projectId: context.projectId,
    environmentId: context.environmentId,
    serviceId: context.serviceId,
    sourceCommit: context.sourceCommit,
    migrationVersion: migration.REVIEWED_MIGRATION_VERSION,
    migrationChecksum: migration.REVIEWED_MIGRATION_CHECKSUM,
  };
}

export function safeOperationResult(context, operation, migration, result) {
  const base = baseOutput(context, operation, migration);
  if (operation === 'apply') {
    return {
      ok: result.ready === true,
      code: result.ready === true
        ? 'PHASE2E_VALIDATOR_APPLY_READY'
        : 'PHASE2E_VALIDATOR_APPLY_INVALID',
      ...base,
      applied: result.applied === true,
      equivalentRerun: result.equivalentRerun === true,
      recoveredFinalVerification: result.recoveredFinalVerification === true,
      historySchemaInstalled: result.historySchemaInstalled === true,
      historyAppended: result.historyAppended === true,
      migrationSchemaMutated: result.migrationSchemaMutated === true,
      databaseMutated: result.databaseMutated === true,
    };
  }
  if (operation === 'verify' || operation === 'verify-runtime') {
    return {
      ok: result.ready === true,
      code: result.ready === true
        ? 'PHASE2E_VALIDATOR_SCHEMA_READY'
        : 'PHASE2E_VALIDATOR_SCHEMA_INVALID',
      ...base,
      issueCount: Array.isArray(result.issues) ? result.issues.length : 0,
    };
  }
  const drainReady = result.canDisableAssignment === true
    && result.canRevertApplication === true
    && result.canCompensateEmptySchema === true;
  return {
    ok: drainReady,
    code: drainReady
      ? 'PHASE2E_VALIDATOR_DRAIN_READY'
      : 'PHASE2E_VALIDATOR_DRAIN_BLOCKED',
    ...base,
    canDisableAssignment: result.canDisableAssignment === true,
    canRevertApplication: result.canRevertApplication === true,
    canCompensateEmptySchema: result.canCompensateEmptySchema === true,
    counts: {
      requested: safeCount(result.counts?.requested),
      claimed: safeCount(result.counts?.claimed),
      running: safeCount(result.counts?.running),
      runs: safeCount(result.counts?.runs),
      commands: safeCount(result.counts?.commands),
      events: safeCount(result.counts?.events),
      populatedProvenancePlans: safeCount(result.counts?.populatedProvenancePlans),
    },
  };
}

export function validateDatabaseIdentityRows(rows, expectedDatabaseName) {
  const row = Array.isArray(rows) && rows.length === 1 ? rows[0] : null;
  if (
    row?.database_name !== expectedDatabaseName
    || row?.schema_name !== 'public'
    || typeof row?.server_version !== 'string'
    || !/^18(?:\.|$)/u.test(row.server_version)
  ) {
    fail('PHASE2E_VALIDATOR_DATABASE_IDENTITY_MISMATCH');
  }
}

async function runDatabaseOperation(context, operation, migration) {
  const pg = await import('pg');
  const Client = pg.Client ?? pg.default?.Client;
  if (typeof Client !== 'function') {
    fail('PHASE2E_VALIDATOR_DATABASE_CLIENT_UNAVAILABLE');
  }

  const client = new Client({
    connectionString: context.databaseUrl,
    connectionTimeoutMillis: 10_000,
    query_timeout: 65_000,
  });
  let primaryError = null;
  try {
    await client.connect();
    await client.query("SET application_name TO 'arcanos-phase2e-validator'");
    await client.query("SET lock_timeout TO '5s'");
    await client.query("SET statement_timeout TO '60s'");
    await client.query('SET search_path TO public, pg_catalog');
    const databaseIdentity = await client.query(
      `SELECT current_database() AS database_name,
              current_schema() AS schema_name,
              current_setting('server_version') AS server_version`,
    );
    validateDatabaseIdentityRows(databaseIdentity.rows, context.databaseName);

    let result;
    if (operation === 'apply') {
      const history = await import(MIGRATION_HISTORY_MODULE_URL.href);
      result = await history.applyMigrationWithDurableHistoryWithClient(client);
    } else if (operation === 'verify') {
      const history = await import(MIGRATION_HISTORY_MODULE_URL.href);
      const [schemaResult, historyResult] = await Promise.all([
        migration.verifyActionPlanExecutionSchemaWithClient(client),
        history.verifyMigrationAttemptHistoryWithClient(client),
      ]);
      result = {
        ready: schemaResult.ready === true && historyResult.ready === true,
        issues: [...schemaResult.issues, ...historyResult.issues].sort(),
      };
    } else if (operation === 'verify-runtime') {
      const runtimeSchema = await import('../dist/core/db/actionPlanExecutionSchema.js');
      result = await runtimeSchema.verifyActionPlanExecutionSchema(client);
    } else {
      result = await migration.inspectMigrationDrainStateWithClient(client);
    }
    return safeOperationResult(context, operation, migration, result);
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    try {
      await client.end();
    } catch {
      if (!primaryError) {
        fail('PHASE2E_VALIDATOR_DATABASE_CLOSE_FAILED');
      }
    }
  }
}

export async function runValidator(argv = process.argv.slice(2), environment = process.env) {
  const operation = parseValidatorOperation(argv);
  const context = validateValidatorEnvironment(environment);
  const migration = await import(MIGRATION_MODULE_URL.href);
  const artifactValidation = migration.validateMigrationArtifacts();
  const history = await import(MIGRATION_HISTORY_MODULE_URL.href);
  const historyArtifactValidation = history.validateMigrationHistoryArtifacts();

  if (operation === 'plan') {
    return {
      ok: artifactValidation.ok === true && historyArtifactValidation.ok === true,
      code: artifactValidation.ok === true && historyArtifactValidation.ok === true
        ? 'PHASE2E_VALIDATOR_PLAN_READY'
        : 'PHASE2E_VALIDATOR_PLAN_INVALID',
      ...baseOutput(context, operation, migration),
      issueCount:
        (Array.isArray(artifactValidation.issues) ? artifactValidation.issues.length : 0)
        + (Array.isArray(historyArtifactValidation.issues)
          ? historyArtifactValidation.issues.length
          : 0),
    };
  }
  if (artifactValidation.ok !== true || historyArtifactValidation.ok !== true) {
    fail('MIGRATION_ARTIFACT_VALIDATION_FAILED');
  }
  return runDatabaseOperation(context, operation, migration);
}

export function safeFailureCode(error) {
  if (error instanceof Phase2eValidatorError) {
    return error.code;
  }
  if (
    error
    && typeof error === 'object'
    && typeof error.code === 'string'
    && SAFE_MIGRATION_FAILURE_CODES.has(error.code)
  ) {
    return error.code;
  }
  return 'PHASE2E_VALIDATOR_OPERATION_FAILED';
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runValidator()
    .then((result) => {
      writeSync(process.stdout.fd, `${JSON.stringify(result)}\n`);
      process.exit(result.ok === true ? 0 : 1);
    })
    .catch((error) => {
      writeSync(
        process.stderr.fd,
        `${JSON.stringify({ ok: false, code: safeFailureCode(error) })}\n`,
      );
      process.exit(1);
    });
}
