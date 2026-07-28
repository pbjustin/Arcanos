import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from '@jest/globals';

import {
  JobDataSchema,
  TABLE_DEFINITIONS
} from '../src/core/db/schema.js';

const forwardMigration = readFileSync(
  join(process.cwd(), 'migrations', '20260727_job_claim_generation_v1.sql'),
  'utf8'
);
const rollbackMigration = readFileSync(
  join(
    process.cwd(),
    'migrations',
    '20260727_job_claim_generation_v1.rollback.sql'
  ),
  'utf8'
);
const runtimeSchemaSql = TABLE_DEFINITIONS.join('\n');

function buildJobData(claimGeneration: unknown): Record<string, unknown> {
  return {
    id: 'job-1',
    worker_id: 'worker-1',
    job_type: 'ask',
    status: 'pending',
    claim_generation: claimGeneration,
    input: {},
    created_at: new Date(),
    updated_at: new Date()
  };
}

describe('job claim generation schema and migrations', () => {
  it('models PostgreSQL BIGINT generations as canonical decimal strings', () => {
    expect(
      JobDataSchema.safeParse(buildJobData('9223372036854775807')).success
    ).toBe(true);
    expect(JobDataSchema.safeParse(buildJobData(1)).success).toBe(false);
    expect(JobDataSchema.safeParse(buildJobData('-1')).success).toBe(false);
    expect(JobDataSchema.safeParse(buildJobData('01')).success).toBe(false);
    expect(
      JobDataSchema.safeParse(buildJobData('9223372036854775808')).success
    ).toBe(false);
    expect(
      JobDataSchema.safeParse(buildJobData('9'.repeat(10_000))).success
    ).toBe(false);
  });

  it.each([
    ['runtime bootstrap', runtimeSchemaSql],
    ['forward migration', forwardMigration]
  ])('%s enforces the exact column contract and fails closed on drift', (_label, sql) => {
    expect(sql).toContain('claim_generation BIGINT');
    expect(sql).toMatch(/UPDATE job_data\s+SET claim_generation = 0/u);
    expect(sql).toContain('ALTER COLUMN claim_generation SET DEFAULT 0');
    expect(sql).toContain('ALTER COLUMN claim_generation SET NOT NULL');
    expect(sql).toContain(
      "claim_generation_type IS DISTINCT FROM 'bigint'::regtype"
    );
    expect(sql).toContain(
      'job_data.claim_generation must have PostgreSQL BIGINT type'
    );
    expect(sql).toContain('CHECK (claim_generation >= 0) NOT VALID');
    expect(sql).toContain('SELECT contype, pg_get_constraintdef(oid, false)');
    expect(sql).toContain("'CHECK((claim_generation>=0))NOTVALID'");
    expect(sql).toContain(
      'VALIDATE CONSTRAINT job_data_claim_generation_nonnegative'
    );
    expect(sql).toContain(
      'job_data_claim_generation_nonnegative has an unexpected definition'
    );
  });

  it('provides a rollback that refuses while generic jobs are running', () => {
    expect(rollbackMigration).toContain("status = 'running'");
    expect(rollbackMigration).toContain(
      "job_type IS DISTINCT FROM 'local-agent'"
    );
    expect(rollbackMigration).toContain("USING ERRCODE = '55000'");
    expect(rollbackMigration).toContain(
      "claim_generation_type IS DISTINCT FROM 'bigint'::regtype"
    );
    expect(rollbackMigration).toContain(
      'job_data_claim_generation_nonnegative has an unexpected definition'
    );
    expect(rollbackMigration).toContain(
      'IF claim_generation_type IS NOT NULL THEN'
    );
    expect(rollbackMigration).toContain(
      'DROP CONSTRAINT job_data_claim_generation_nonnegative'
    );
    expect(rollbackMigration).toContain(
      'DROP COLUMN claim_generation'
    );
  });
});
