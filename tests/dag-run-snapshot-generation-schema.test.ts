import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from '@jest/globals';

import { TABLE_DEFINITIONS } from '../src/core/db/schema.js';

const forwardMigration = readFileSync(
  join(
    process.cwd(),
    'migrations',
    '20260727_dag_run_snapshot_generation_v1.sql'
  ),
  'utf8'
);
const rollbackMigration = readFileSync(
  join(
    process.cwd(),
    'migrations',
    '20260727_dag_run_snapshot_generation_v1.rollback.sql'
  ),
  'utf8'
);
const runtimeSchemaSql = TABLE_DEFINITIONS.join('\n');

describe('DAG run snapshot generation schema contract', () => {
  it.each([
    ['runtime bootstrap', runtimeSchemaSql],
    ['forward migration', forwardMigration]
  ])('%s installs and validates the exact fencing contract', (_label, sql) => {
    expect(sql).toContain('snapshot_generation BIGINT');
    expect(sql).toMatch(
      /UPDATE dag_runs\s+SET snapshot_generation = 0\s+WHERE snapshot_generation IS NULL/u
    );
    expect(sql).toContain(
      'ALTER COLUMN snapshot_generation SET DEFAULT 0'
    );
    expect(sql).toContain(
      'ALTER COLUMN snapshot_generation SET NOT NULL'
    );
    expect(sql).toContain(
      "snapshot_generation_type IS DISTINCT FROM 'bigint'::regtype"
    );
    expect(sql).toContain(
      'dag_runs.snapshot_generation must have PostgreSQL BIGINT type'
    );
    expect(sql).toContain(
      'CHECK (snapshot_generation >= 0) NOT VALID'
    );
    expect(sql).toContain(
      "'CHECK((snapshot_generation>=0))NOTVALID'"
    );
    expect(sql).toContain(
      'VALIDATE CONSTRAINT dag_runs_snapshot_generation_nonnegative'
    );
    expect(sql).toContain(
      'dag_runs_snapshot_generation_nonnegative has an unexpected definition'
    );
  });

  it('guards rollback before removing only the exact generation contract', () => {
    expect(rollbackMigration).toContain(
      "snapshot_generation_type IS DISTINCT FROM 'bigint'::regtype"
    );
    expect(rollbackMigration).toContain(
      'dag_runs_snapshot_generation_nonnegative has an unexpected definition'
    );
    expect(rollbackMigration).toContain(
      'snapshot_generation_not_null IS DISTINCT FROM TRUE'
    );
    expect(rollbackMigration).toContain(
      "NOT IN ('0', '0::bigint')"
    );
    expect(rollbackMigration).toContain(
      'constraint_definition IS NULL'
    );
    expect(rollbackMigration).toContain(
      'constraint_validated IS DISTINCT FROM TRUE'
    );
    expect(rollbackMigration).toContain(
      "status NOT IN ('complete', 'failed', 'cancelled')"
    );
    expect(rollbackMigration).toContain("USING ERRCODE = '55000'");
    expect(rollbackMigration).toContain(
      'DROP CONSTRAINT dag_runs_snapshot_generation_nonnegative'
    );
    expect(rollbackMigration).toContain(
      'DROP COLUMN snapshot_generation'
    );
  });
});
