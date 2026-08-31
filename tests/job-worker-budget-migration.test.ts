import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from '@jest/globals';

function readRepositoryFile(path: string): string {
  return readFileSync(resolve(process.cwd(), path), 'utf8');
}

function readMarkdownSection(document: string, heading: string): string {
  const sectionStart = document.indexOf(heading);
  expect(sectionStart).toBeGreaterThanOrEqual(0);
  const nextSectionStart = document.indexOf('\n### ', sectionStart + heading.length);
  return document.slice(sectionStart, nextSectionStart < 0 ? undefined : nextSectionStart);
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/gu, ' ').trim();
}

function readDelimitedSection(document: string, startMarker: string, endMarker: string): string {
  const sectionStart = document.indexOf(startMarker);
  expect(sectionStart).toBeGreaterThanOrEqual(0);
  const sectionEnd = document.indexOf(endMarker, sectionStart + startMarker.length);
  expect(sectionEnd).toBeGreaterThan(sectionStart);
  return document.slice(sectionStart, sectionEnd);
}

function readFilteredAggregate(sql: string, alias: string): string {
  const aliasMarker = `AS ${alias}`;
  const aliasStart = sql.indexOf(aliasMarker);
  expect(aliasStart).toBeGreaterThanOrEqual(0);
  const aggregateStart = sql.lastIndexOf('COUNT(j.id) FILTER (', aliasStart);
  expect(aggregateStart).toBeGreaterThanOrEqual(0);
  return normalizeWhitespace(sql.slice(aggregateStart, aliasStart + aliasMarker.length));
}

describe('job worker hard-budget evidence migration contract', () => {
  it('compares the exact check expression independently from its validation lifecycle', () => {
    const migrationRoot = 'migrations/20260830_job_events_worker_budget_v1';
    const addContract = readRepositoryFile(`${migrationRoot}/01_add_budget_evidence_contract.sql`);
    const validateContract = readRepositoryFile(
      `${migrationRoot}/02_validate_budget_evidence_contract.sql`
    );
    const rollbackContract = readRepositoryFile(
      `${migrationRoot}/rollback/02_drop_budget_evidence_contract.sql`
    );
    const runtimeSchema = readRepositoryFile('src/core/db/schema.ts');
    const runtimeBudgetContract = readDelimitedSection(
      runtimeSchema,
      'CREATE TEMP TABLE worker_budget_runtime_shape_guard',
      '// DAG verification snapshot storage'
    );

    for (const contract of [addContract, runtimeBudgetContract, rollbackContract]) {
      expect(contract).toContain('SELECT pg_get_expr(conbin, conrelid, false)');
      expect(contract).toContain('pg_get_expr(conbin, conrelid, false),');
      expect(contract).not.toContain('pg_get_constraintdef');
    }

    for (const contract of [addContract, runtimeBudgetContract]) {
      expect(contract).toContain('ADD CONSTRAINT job_events_worker_budget_shape_check');
      expect(contract).toContain(') NOT VALID;');
    }

    expect(addContract).not.toContain(
      'VALIDATE CONSTRAINT job_events_worker_budget_shape_check'
    );
    expect(validateContract).toContain(
      'VALIDATE CONSTRAINT job_events_worker_budget_shape_check'
    );
    expect(runtimeBudgetContract).toContain(
      'VALIDATE CONSTRAINT job_events_worker_budget_shape_check'
    );
  });

  it('requires guarded index rollback and rejects every auxiliary evidence-column dependency', () => {
    const rollbackContract = readRepositoryFile(
      'migrations/20260830_job_events_worker_budget_v1/rollback/02_drop_budget_evidence_contract.sql'
    );
    const normalizedRollbackContract = normalizeWhitespace(rollbackContract);
    const phaseOrderGuard = rollbackContract.indexOf('candidate.relname IN (');
    const shapeGuard = rollbackContract.indexOf(
      'CREATE TEMP TABLE worker_budget_rollback_shape_guard'
    );
    const dependencyGuard = rollbackContract.indexOf('FROM pg_depend AS dependency');
    const destructiveAlter = rollbackContract.lastIndexOf('ALTER TABLE job_events');

    expect(phaseOrderGuard).toBeGreaterThanOrEqual(0);
    expect(phaseOrderGuard).toBeLessThan(shapeGuard);
    expect(rollbackContract).toContain('idx_job_events_worker_budget_group_window');
    expect(rollbackContract).toContain('idx_job_events_worker_budget_claim_generation');
    expect(rollbackContract).toContain(
      "table_class.relnamespace = candidate.relnamespace"
    );
    expect(rollbackContract).toContain(
      'worker budget rollback phase 2 refused because phase 1 index names remain'
    );
    expect(rollbackContract).toContain(
      'INTO operation_attribute, operation_type, operation_modifier, operation_not_null'
    );
    expect(dependencyGuard).toBeGreaterThan(shapeGuard);
    expect(dependencyGuard).toBeLessThan(destructiveAlter);
    expect(rollbackContract).toContain(
      "dependency.refclassid = 'pg_class'::regclass"
    );
    expect(rollbackContract).toContain(
      "dependency.refobjid = 'job_events'::regclass"
    );
    expect(normalizedRollbackContract).toContain(
      'dependency.refobjsubid IN ( stats_attribute, generation_attribute, operation_attribute )'
    );
    expect(rollbackContract).toContain(
      "dependency.classid = 'pg_constraint'::regclass"
    );
    expect(rollbackContract).toContain('dependency.objid = constraint_oid');
    expect(rollbackContract).toContain('dependency.objsubid = 0');
    expect(rollbackContract).toContain(
      'worker budget evidence columns have unexpected dependent objects; rollback refused'
    );
    expect(normalizedRollbackContract).toContain('AND constraint_oid IS NULL THEN RETURN;');
    expect(rollbackContract).not.toMatch(/\bCASCADE\b/u);
  });
});

describe('job worker stats identity migration contract', () => {
  it('keeps the nullable column in runtime schema without a blocking startup index build', () => {
    const runtimeSchema = readRepositoryFile('src/core/db/schema.ts');

    expect(runtimeSchema).toContain('stats_worker_id VARCHAR(255) COLLATE "C"');
    expect(runtimeSchema).toContain(
      'ALTER TABLE job_data ADD COLUMN IF NOT EXISTS stats_worker_id VARCHAR(255) COLLATE "C"'
    );
    expect(runtimeSchema).toContain("column_generated IS DISTINCT FROM ''::\"char\"");
    expect(runtimeSchema).toContain("column_identity IS DISTINCT FROM ''::\"char\"");
    expect(runtimeSchema).toContain('column_has_default IS DISTINCT FROM FALSE');
    expect(runtimeSchema).not.toContain(
      'CREATE INDEX IF NOT EXISTS idx_job_data_stats_worker_updated'
    );
  });

  it('requires an exact separately phased concurrent index and catalog verification', () => {
    const migrationRoot = 'migrations/20260801_job_worker_stats_identity_v1';
    const precheck = readRepositoryFile(`${migrationRoot}/02_precheck_stats_worker_index.sql`);
    const createIndex = readRepositoryFile(`${migrationRoot}/03_create_stats_worker_index.sql`);
    const verify = readRepositoryFile(`${migrationRoot}/04_verify_stats_worker_index.sql`);
    const recover = readRepositoryFile(
      `${migrationRoot}/recovery/01_drop_invalid_stats_worker_index.sql`
    );
    const rollbackIndex = readRepositoryFile(
      `${migrationRoot}/rollback/01_drop_stats_worker_index.sql`
    );
    const rollbackColumn = readRepositoryFile(
      `${migrationRoot}/rollback/02_drop_stats_worker_id.sql`
    );

    expect(precheck).toContain('idx_job_data_stats_worker_updated');
    expect(precheck).toContain('i.indisvalid');
    expect(precheck).toContain('i.indisready');
    expect(precheck).toContain('i.indislive');
    expect(precheck).toContain('i.indcollation::text');
    expect(precheck).toContain('i.indclass::text');
    expect(precheck).toContain('pg_get_indexdef(c.oid, 1, true)');
    expect(precheck).toContain("first_key_definition IS DISTINCT FROM 'stats_worker_id'");
    expect(createIndex).toContain(
      'CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_job_data_stats_worker_updated'
    );
    expect(createIndex).toContain('ON job_data (stats_worker_id, updated_at)');
    expect(createIndex).toContain('WHERE stats_worker_id IS NOT NULL');
    expect(verify).toContain("index_valid IS DISTINCT FROM TRUE");
    expect(verify).toContain("index_ready IS DISTINCT FROM TRUE");
    expect(verify).toContain("second_key_definition IS DISTINCT FROM 'updated_at'");
    expect(precheck).toContain('run the guarded invalid-index recovery');
    expect(recover).toContain('index_valid IS DISTINCT FROM FALSE');
    expect(recover).toContain('LOCK TABLE job_data IN ACCESS EXCLUSIVE MODE');
    expect(recover).toContain("EXECUTE format('DROP INDEX %I.%I'");
    expect(rollbackIndex).toContain("EXECUTE format('DROP INDEX %I.%I'");
    expect(rollbackIndex).toContain('LOCK TABLE job_data IN ACCESS EXCLUSIVE MODE');
    expect(rollbackIndex).toContain('has an unexpected definition');
    expect(rollbackIndex).toContain('contains accounting history; rollback refused');
    expect(rollbackIndex).toContain('has unexpected dependent objects; rollback refused');
    expect(rollbackColumn).toContain("column_collation IS DISTINCT FROM '\"C\"'::regcollation");
    expect(rollbackColumn).toContain("column_generated IS DISTINCT FROM ''::\"char\"");
    expect(rollbackColumn).toContain('contains accounting history; rollback refused');
    expect(rollbackColumn).toContain('still has dependent objects; rollback refused');
  });

  it('fails closed on every mutable legacy null-identity class before activation', () => {
    const migrationRoot = 'migrations/20260801_job_worker_stats_identity_v1';
    const runbook = readRepositoryFile(`${migrationRoot}/README.md`);
    const maintainedGuide = readMarkdownSection(
      readRepositoryFile('docs/DATABASE_MIGRATIONS.md'),
      '### Generic worker stats-identity migration'
    );
    const configurationGuide = readMarkdownSection(
      readRepositoryFile('docs/CONFIGURATION.md'),
      '### Dedicated job runner'
    );
    const workerAutonomySource = readRepositoryFile('src/services/workerAutonomyService.ts');

    const bootstrapBody = readDelimitedSection(
      workerAutonomySource,
      'async bootstrap(',
      'async inspect('
    );
    const inspectorBody = readDelimitedSection(
      workerAutonomySource,
      'async inspect(',
      'async runWatchdogCycle('
    );
    const hourlyStatsBody = readDelimitedSection(
      workerAutonomySource,
      'private async readCurrentHourlyStats()',
      'async evaluateBudgetsBeforeClaim()'
    );

    expect(bootstrapBody).toContain("this.inspect('bootstrap'");
    const watchdogRecoveryStart = inspectorBody.indexOf(
      'const stalledRecovery = await this.runWatchdogCycle'
    );
    const recoveryStart = inspectorBody.indexOf('const recovered = await recoverStaleJobs');
    const gptCleanupStart = inspectorBody.indexOf(
      'const expiredGptJobs = await cleanupExpiredGptJobs()'
    );
    const exactStatsReadStart = inspectorBody.indexOf(
      'const { stats } = await this.readCurrentHourlyStats()'
    );

    expect(watchdogRecoveryStart).toBeGreaterThanOrEqual(0);
    expect(recoveryStart).toBeGreaterThan(watchdogRecoveryStart);
    expect(gptCleanupStart).toBeGreaterThan(recoveryStart);
    expect(exactStatsReadStart).toBeGreaterThan(gptCleanupStart);
    expect(hourlyStatsBody).toContain('await getJobExecutionStatsSince(');

    const unsafeQuietWindowGuidance =
      /(?:drain|stop)[^.]{0,240}workers?[^.]{0,240}(?:one|1) (?:full )?hour[^.]{0,240}(?:start|enable|activate)/iu;
    expect(
      'Drain old workers, keep claims quiesced until one full hour after the final update, then start compatible writers.'
    ).toMatch(unsafeQuietWindowGuidance);

    for (const rawDocument of [runbook, maintainedGuide, configurationGuide]) {
      const document = normalizeWhitespace(rawDocument);
      expect(document).toContain('A quiet-window-only transition is unsupported.');
      expect(document).toContain(
        'Every transition, including an exact backfill, must run under the same continuous freeze.'
      );
      expect(document).toContain(
        'Fail closed if any affected row cannot be mapped or accounted for exactly.'
      );
      expect(document).toContain('The compatible worker must be the first released mutator.');
      expect(document).toMatch(/all `job_data` mutators/iu);
      expect(document).toMatch(/reviewed, bounded exact backfill/iu);
      expect(document).toMatch(/no-backfill/iu);
      expect(document).toMatch(/pending[- ]GPT/iu);
      expect(document).toMatch(/retained[- ]terminal[- ]GPT/iu);
      expect(document).toMatch(
        /bootstrap\/readiness(?: verification)? before releasing (?:any other writer|the remaining compatible writers)/iu
      );
      expect(document).not.toMatch(unsafeQuietWindowGuidance);
    }

    const gateSql = readDelimitedSection(runbook, '```sql', '```');
    const allRunning = readFilteredAggregate(gateSql, 'all_generic_running_rows');
    const recentNull = readFilteredAggregate(gateSql, 'recent_null_budget_rows');
    const recoverableRunning = readFilteredAggregate(
      gateSql,
      'null_recoverable_running_rows'
    );
    const pendingGpt = readFilteredAggregate(gateSql, 'null_pending_gpt_rows');
    const retainedTerminalGpt = readFilteredAggregate(
      gateSql,
      'null_retained_terminal_gpt_rows'
    );

    expect(allRunning).toContain("j.job_type <> 'local-agent'");
    expect(allRunning).toContain("j.status = 'running'");
    expect(recentNull).toContain('j.stats_worker_id IS NULL');
    expect(recentNull).toContain("j.job_type <> 'local-agent'");
    expect(recentNull).toContain("j.updated_at >= gate.gate_at - INTERVAL '1 hour'");
    expect(recentNull).toContain(
      "j.status IN ('running', 'completed', 'failed', 'cancelled', 'expired')"
    );
    expect(recoverableRunning).toContain('j.stats_worker_id IS NULL');
    expect(recoverableRunning).toContain("j.job_type <> 'local-agent'");
    expect(recoverableRunning).toContain("j.status = 'running'");
    expect(pendingGpt).toContain('j.stats_worker_id IS NULL');
    expect(pendingGpt).toContain("j.job_type = 'gpt'");
    expect(pendingGpt).toContain("j.status = 'pending'");
    expect(retainedTerminalGpt).toContain('j.stats_worker_id IS NULL');
    expect(retainedTerminalGpt).toContain("j.job_type = 'gpt'");
    expect(retainedTerminalGpt).toContain(
      "j.status IN ('completed', 'failed', 'cancelled')"
    );
    expect(retainedTerminalGpt).toContain('j.retention_until IS NOT NULL');
    expect(normalizeWhitespace(runbook)).toContain(
      'Every count must be zero while the mutator freeze remains active.'
    );
  });
});
