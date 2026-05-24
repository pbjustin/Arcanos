#!/usr/bin/env node

import { existsSync, readFileSync } from 'node:fs';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { redactString } from './railway-redaction.mjs';

export const GOVERNANCE_MIGRATION_PATH = 'migrations/20260521_gptoss_governance.sql';

const EXPECTED_TABLES = [
  'arcanos_action_registry',
  'arcanos_route_policy',
  'arcanos_safety_rules',
  'gptoss_eval_runs',
  'gptoss_eval_failures',
  'gptoss_training_candidates',
  'gptoss_approved_training_examples',
];

const EXPECTED_INDEXES = [
  'idx_arcanos_action_registry_source',
  'idx_arcanos_route_policy_route_label',
  'idx_arcanos_safety_rules_applies_to',
  'idx_gptoss_eval_runs_run_id',
  'idx_gptoss_eval_failures_run_id',
  'idx_gptoss_training_candidates_candidate_id',
  'idx_gptoss_training_candidates_source',
  'idx_gptoss_training_candidates_reviewed_allowed',
  'idx_gptoss_approved_training_examples_example_id',
  'idx_gptoss_approved_training_examples_source',
  'idx_gptoss_approved_training_examples_reviewed_allowed',
];

const EXPECTED_SEEDS = {
  actionNames: [
    'railway.status',
    'railway.logs',
    'railway.variables.list',
    'validate_dataset',
    'reject_training_from_raw_logs',
    'reject',
    'workers.status',
    'queue.inspect',
  ],
  routeLabels: ['control-plane', 'writing-plane'],
  safetyRuleKeys: [
    'openai_output_not_training_data',
    'raw_railway_logs_not_training_data',
    'secrets_never_trainable',
    'railway_cli_observation_requires_review',
    'privileged_actions_require_confirmation',
  ],
};

function readSql(path = GOVERNANCE_MIGRATION_PATH) {
  return readFileSync(path, 'utf8');
}

function assertDbConnectionEnvPresent() {
  if (typeof process.env.DATABASE_URL !== 'string' || process.env.DATABASE_URL.trim().length === 0) {
    throw new Error('required_db_connection_env_missing');
  }
}

function validateLiveMigrationSql(sql) {
  const errors = [];
  for (const pattern of [
    /\bDROP\b/i,
    /\bTRUNCATE\b/i,
    /\bDELETE\b/i,
    /\bALTER\b/i,
    /\bCOPY\b/i,
    /\\copy/i,
    /\bpg_dump\b/i,
  ]) {
    if (pattern.test(sql)) {
      errors.push({ code: 'destructive_or_dump_sql_forbidden', pattern: String(pattern) });
    }
  }
  return errors;
}

export function validateGovernanceSchema({ path = GOVERNANCE_MIGRATION_PATH } = {}) {
  const errors = [];
  if (!existsSync(path)) {
    errors.push({ code: 'migration_missing', path });
    return { ok: false, path, tables: [], indexes: [], errors };
  }

  const sql = readSql(path);
  const tables = EXPECTED_TABLES.filter((table) => (
    new RegExp(`CREATE\\s+TABLE\\s+IF\\s+NOT\\s+EXISTS\\s+${table}\\b`, 'i').test(sql)
  ));
  const indexes = EXPECTED_INDEXES.filter((index) => (
    new RegExp(`CREATE\\s+INDEX\\s+IF\\s+NOT\\s+EXISTS\\s+${index}\\b`, 'i').test(sql)
  ));

  for (const table of EXPECTED_TABLES) {
    if (!tables.includes(table)) {
      errors.push({ code: 'table_missing', table });
    }
  }

  for (const index of EXPECTED_INDEXES) {
    if (!indexes.includes(index)) {
      errors.push({ code: 'index_missing', index });
    }
  }

  for (const requiredText of [
    'railway_cli_observation_requires_review',
    'openai_output_not_training_data',
    'raw_railway_logs_not_training_data',
    'secrets_never_trainable',
    'allowed_for_training IS FALSE',
    'allowed_for_training IS TRUE',
    'no_openai_output_used IS TRUE',
  ]) {
    if (!sql.includes(requiredText)) {
      errors.push({ code: 'required_policy_text_missing', value: requiredText });
    }
  }

  return {
    ok: errors.length === 0,
    path,
    tables,
    indexes,
    migrationApplied: false,
    liveDbConnected: false,
    openAiCalled: false,
    trainingExecuted: false,
    vllmUsed: false,
    railwayCliExecuted: false,
    errors,
  };
}

export async function verifyLiveGovernanceSchema() {
  assertDbConnectionEnvPresent();
  const { Pool } = await import('pg');
  const pool = new Pool();
  try {
    const tablesResult = await pool.query(
      `SELECT table_name
       FROM information_schema.tables
       WHERE table_schema = 'public'
         AND table_name = ANY($1::text[])`,
      [EXPECTED_TABLES],
    );
    const verifiedTables = tablesResult.rows.map((row) => row.table_name).sort();
    const missingTables = EXPECTED_TABLES.filter((table) => !verifiedTables.includes(table));

    const [actionResult, routeResult, safetyResult] = await Promise.all([
      pool.query(
        'SELECT COUNT(*)::int AS count FROM arcanos_action_registry WHERE action_name = ANY($1::text[])',
        [EXPECTED_SEEDS.actionNames],
      ),
      pool.query(
        'SELECT COUNT(*)::int AS count FROM arcanos_route_policy WHERE route_label = ANY($1::text[])',
        [EXPECTED_SEEDS.routeLabels],
      ),
      pool.query(
        'SELECT COUNT(*)::int AS count FROM arcanos_safety_rules WHERE rule_key = ANY($1::text[])',
        [EXPECTED_SEEDS.safetyRuleKeys],
      ),
    ]);

    return {
      ok: missingTables.length === 0,
      verifiedTables,
      missingTables,
      seedVerification: {
        actionRegistryRows: actionResult.rows[0]?.count ?? 0,
        routePolicyRows: routeResult.rows[0]?.count ?? 0,
        safetyRuleRows: safetyResult.rows[0]?.count ?? 0,
      },
      liveDbConnected: true,
      liveDbWrite: false,
      openAiCalled: false,
      trainingExecuted: false,
      vllmUsed: false,
      railwayCliExecuted: false,
    };
  } finally {
    await pool.end();
  }
}

export async function applyGovernanceMigration({ path = GOVERNANCE_MIGRATION_PATH } = {}) {
  assertDbConnectionEnvPresent();
  const validation = validateGovernanceSchema({ path });
  if (!validation.ok) {
    return {
      ...validation,
      migrationApplied: false,
      liveDbConnected: false,
      liveDbWrite: false,
    };
  }

  const sql = readSql(path);
  const sqlErrors = validateLiveMigrationSql(sql);
  if (sqlErrors.length > 0) {
    return {
      ok: false,
      path,
      migrationApplied: false,
      liveDbConnected: false,
      liveDbWrite: false,
      errors: sqlErrors,
      openAiCalled: false,
      trainingExecuted: false,
      vllmUsed: false,
      railwayCliExecuted: false,
    };
  }

  const { Pool } = await import('pg');
  const pool = new Pool();
  try {
    await pool.query('BEGIN');
    await pool.query(sql);
    await pool.query('COMMIT');
  } catch (error) {
    await pool.query('ROLLBACK');
    throw error;
  } finally {
    await pool.end();
  }

  const liveVerification = await verifyLiveGovernanceSchema();
  return {
    ...validation,
    migrationApplied: true,
    liveDbConnected: true,
    liveDbWrite: true,
    verifiedTables: liveVerification.verifiedTables,
    missingTables: liveVerification.missingTables,
    seedVerification: liveVerification.seedVerification,
    errors: liveVerification.ok ? [] : liveVerification.missingTables.map((table) => ({ code: 'live_table_missing', table })),
  };
}

export function dryRunSchema({ path = GOVERNANCE_MIGRATION_PATH } = {}) {
  const validation = validateGovernanceSchema({ path });
  return {
    ...validation,
    dryRun: true,
    message: 'Governance migration is present and ready for manual review; no DB connection was opened.',
  };
}

function parseArgs(argv) {
  const options = { mode: 'dry-run', path: GOVERNANCE_MIGRATION_PATH };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const next = argv[index + 1];
    if (flag === '--print') {
      options.mode = 'print';
    } else if (flag === '--validate') {
      options.mode = 'validate';
    } else if (flag === '--dry-run') {
      options.mode = 'dry-run';
    } else if (flag === '--execute') {
      options.mode = 'execute';
    } else if (flag === '--verify-live') {
      options.mode = 'verify-live';
    } else if (flag === '--allow-db-write') {
      options.allowDbWrite = true;
    } else if (flag === '--path' && next) {
      options.path = next;
      index += 1;
    }
  }
  return options;
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.mode === 'print') {
    process.stdout.write(readSql(options.path));
    process.exitCode = 0;
    return;
  }

  let result;
  if (options.mode === 'execute') {
    if (options.allowDbWrite !== true) {
      result = {
        ...dryRunSchema({ path: options.path }),
        ok: false,
        dryRun: true,
        migrationApplied: false,
        liveDbWrite: false,
        errors: [{ code: 'db_write_requires_explicit_allow_flag' }],
      };
    } else {
      result = await applyGovernanceMigration({ path: options.path });
    }
  } else if (options.mode === 'verify-live') {
    result = await verifyLiveGovernanceSchema();
  } else {
    result = options.mode === 'validate'
      ? validateGovernanceSchema({ path: options.path })
      : dryRunSchema({ path: options.path });
  }
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  process.exitCode = result.ok ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stdout.write(`${JSON.stringify({
      ok: false,
      error: 'governance_schema_failed',
      message: redactString(error instanceof Error ? error.message : String(error)),
      migrationApplied: false,
      liveDbConnected: false,
      liveDbWrite: false,
      openAiCalled: false,
      trainingExecuted: false,
      vllmUsed: false,
      railwayCliExecuted: false,
    }, null, 2)}\n`);
    process.exitCode = 2;
  });
}
