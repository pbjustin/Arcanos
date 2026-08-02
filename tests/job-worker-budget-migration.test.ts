import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from '@jest/globals';

function readRepositoryFile(path: string): string {
  return readFileSync(resolve(process.cwd(), path), 'utf8');
}

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
});
