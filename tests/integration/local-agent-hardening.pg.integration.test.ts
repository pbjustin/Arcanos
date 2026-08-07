import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, test } from '@jest/globals';
import { Client } from 'pg';
import { verifyDatabaseSchemaWithClient } from '../../scripts/local-agent-hardening-migration.mjs';
import { buildJobEventTimelineQuery } from '../../src/core/db/repositories/jobEventRepository.js';
import {
  assertDisposablePostgresTestDatabaseUrl,
  resolvePostgresTestDatabaseUrl,
} from './postgresTestDatabase.js';

const TEST_DATABASE_ENV = 'LOCAL_AGENT_HARDENING_TEST_DATABASE_URL';
const connectionString = resolvePostgresTestDatabaseUrl(TEST_DATABASE_ENV);
if (connectionString) {
  assertDisposablePostgresTestDatabaseUrl(connectionString, TEST_DATABASE_ENV);
}
const describeWithDatabase = connectionString ? describe : describe.skip;
const schemaName = `local_agent_hardening_${randomUUID().replaceAll('-', '')}`;
const quotedSchema = `"${schemaName}"`;
const migrationSql = readFileSync(
  join(
    process.cwd(),
    'migrations',
    '20260724_local_agent_job_hardening_v1',
    '01_local_agent_job_idempotency.sql'
  ),
  'utf8'
);

function repeatedHex(character: string): string {
  return character.repeat(64);
}

async function withRollback(
  client: Client,
  callback: () => Promise<void>
): Promise<void> {
  await client.query('BEGIN');
  try {
    await callback();
  } finally {
    await client.query('ROLLBACK');
  }
}

describeWithDatabase('local-agent hardening PostgreSQL concurrency', () => {
  const firstClient = new Client({
    connectionString,
    application_name: 'arcanos-local-agent-hardening-test-1'
  });
  const secondClient = new Client({
    connectionString,
    application_name: 'arcanos-local-agent-hardening-test-2'
  });

  beforeAll(async () => {
    await Promise.all([firstClient.connect(), secondClient.connect()]);
    await firstClient.query(`CREATE SCHEMA ${quotedSchema}`);
    for (const client of [firstClient, secondClient]) {
      await client.query(`SET search_path TO ${quotedSchema}, public`);
    }
    await firstClient.query(
      `CREATE TABLE job_data (
         id UUID PRIMARY KEY,
         worker_id TEXT NOT NULL,
         job_type TEXT NOT NULL,
         status TEXT NOT NULL,
         input JSONB NOT NULL,
         request_fingerprint_hash TEXT,
         idempotency_key_hash TEXT,
         idempotency_scope_hash TEXT,
         idempotency_origin VARCHAR(32),
         idempotency_until TIMESTAMPTZ,
         autonomy_state JSONB,
         created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
       );
       CREATE TABLE job_events (
         id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
         job_id UUID NOT NULL,
         trace_id TEXT,
         event_type TEXT NOT NULL,
         worker_id TEXT,
         occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
         duration_ms INTEGER,
         metadata JSONB NOT NULL DEFAULT '{}'::jsonb
       )`
    );
    await firstClient.query('BEGIN');
    try {
      await firstClient.query(migrationSql);
      await firstClient.query('COMMIT');
    } catch (error) {
      await firstClient.query('ROLLBACK');
      throw error;
    }
  }, 30_000);

  afterAll(async () => {
    try {
      await firstClient.query('RESET search_path');
      await secondClient.query('RESET search_path');
      await firstClient.query(`DROP SCHEMA IF EXISTS ${quotedSchema} CASCADE`);
    } finally {
      await Promise.allSettled([firstClient.end(), secondClient.end()]);
    }
  }, 30_000);

  test('the forward migration is repeatable', async () => {
    await firstClient.query('BEGIN');
    try {
      await firstClient.query(migrationSql);
      await firstClient.query('COMMIT');
    } catch (error) {
      await firstClient.query('ROLLBACK');
      throw error;
    }
    const result = await firstClient.query(
      `SELECT to_regclass('local_agent_job_idempotency')::text AS table_name`
    );
    expect(result.rows[0]?.table_name).toBe(
      'local_agent_job_idempotency'
    );
  });

  test('the verifier accepts the exact migrated binding schema', async () => {
    await expect(
      verifyDatabaseSchemaWithClient(firstClient)
    ).resolves.toMatchObject({
      table: 'local_agent_job_idempotency',
      missingBindings: 0,
      mismatchedBindings: 0,
      exactColumns: true,
      expectedConstraintsValid: true,
      expectedIndexesValid: true
    });
  });

  test('the verifier rejects malformed columns, constraints, and indexes', async () => {
    await withRollback(firstClient, async () => {
      await firstClient.query(
        `ALTER TABLE local_agent_job_idempotency
         ALTER COLUMN principal_id DROP NOT NULL`
      );
      await expect(
        verifyDatabaseSchemaWithClient(firstClient)
      ).rejects.toMatchObject({
        code: 'LOCAL_AGENT_MIGRATION_COLUMNS_INVALID'
      });
    });

    await withRollback(firstClient, async () => {
      await firstClient.query(
        `ALTER TABLE local_agent_job_idempotency
         DROP CONSTRAINT chk_local_agent_job_idempotency_action`
      );
      await expect(
        verifyDatabaseSchemaWithClient(firstClient)
      ).rejects.toMatchObject({
        code: 'LOCAL_AGENT_MIGRATION_CONSTRAINTS_INVALID'
      });
    });

    await withRollback(firstClient, async () => {
      await firstClient.query(
        'DROP INDEX idx_local_agent_job_idempotency_expiry'
      );
      await expect(
        verifyDatabaseSchemaWithClient(firstClient)
      ).rejects.toMatchObject({
        code: 'LOCAL_AGENT_MIGRATION_INDEX_INVALID'
      });
    });
  }, 30_000);

  test('the verifier rejects binding-to-job drift and missing manual bindings', async () => {
    await withRollback(firstClient, async () => {
      const jobId = randomUUID();
      const idempotencyUntil = new Date(Date.now() + 60_000);
      await firstClient.query(
        `INSERT INTO job_data (
           id,
           worker_id,
           job_type,
           status,
           input,
           request_fingerprint_hash,
           idempotency_key_hash,
           idempotency_scope_hash,
           idempotency_origin,
           idempotency_until,
           autonomy_state
         )
         VALUES (
           $1,
           'device-parity',
           'local-agent',
           'completed',
           $2::jsonb,
           $3,
           $4,
           $5,
           'explicit',
           $6,
           '{}'::jsonb
         )`,
        [
          jobId,
          JSON.stringify({
            job: {
              principal: 'principal-parity',
              workspace: 'workspace-parity',
              deviceId: 'device-parity',
              action: 'git.status'
            }
          }),
          repeatedHex('a'),
          repeatedHex('b'),
          repeatedHex('c'),
          idempotencyUntil
        ]
      );
      await firstClient.query(
        `INSERT INTO local_agent_job_idempotency (
           principal_id,
           workspace_id,
           device_id,
           action,
           idempotency_key_hash,
           idempotency_scope_hash,
           request_fingerprint_hash,
           idempotency_origin,
           job_id,
           idempotency_until
         )
         VALUES (
           'different-principal',
           'workspace-parity',
           'device-parity',
           'git.status',
           $1,
           $2,
           $3,
           'explicit',
           $4,
           $5
         )`,
        [
          repeatedHex('b'),
          repeatedHex('c'),
          repeatedHex('a'),
          jobId,
          idempotencyUntil
        ]
      );

      await expect(
        verifyDatabaseSchemaWithClient(firstClient)
      ).rejects.toMatchObject({
        code: 'LOCAL_AGENT_MIGRATION_BINDING_PARITY_INVALID'
      });
    });

    await withRollback(firstClient, async () => {
      await firstClient.query(
        `INSERT INTO job_data (
           id,
           worker_id,
           job_type,
           status,
           input,
           request_fingerprint_hash,
           idempotency_key_hash,
           idempotency_scope_hash,
           idempotency_origin,
           idempotency_until,
           autonomy_state
         )
         VALUES (
           $1,
           'device-manual',
           'local-agent',
           'failed',
           $2::jsonb,
           $3,
           $4,
           $5,
           'explicit',
           NOW() - INTERVAL '1 hour',
           '{"localAgent":{"manualReconciliationRequired":true}}'::jsonb
         )`,
        [
          randomUUID(),
          JSON.stringify({
            job: {
              principal: 'principal-manual',
              workspace: 'workspace-manual',
              deviceId: 'device-manual',
              action: 'patch.apply'
            }
          }),
          repeatedHex('d'),
          repeatedHex('e'),
          repeatedHex('f')
        ]
      );

      await expect(
        verifyDatabaseSchemaWithClient(firstClient)
      ).rejects.toMatchObject({
        code: 'LOCAL_AGENT_MIGRATION_BACKFILL_INCOMPLETE'
      });
    });
  }, 30_000);

  test('separate connections cannot commit duplicate logical bindings', async () => {
    const firstJobId = randomUUID();
    const secondJobId = randomUUID();
    await firstClient.query(
      `INSERT INTO job_data (
         id,
         worker_id,
         job_type,
         status,
         input,
         request_fingerprint_hash,
         idempotency_key_hash,
         idempotency_scope_hash,
         idempotency_origin,
         idempotency_until
       )
       VALUES
         ($1, 'device-preview', 'local-agent', 'pending', '{}'::jsonb,
          $3, $4, $5, 'explicit', NOW() + INTERVAL '1 hour'),
         ($2, 'device-preview', 'local-agent', 'pending', '{}'::jsonb,
          $3, $4, $5, 'explicit', NOW() + INTERVAL '1 hour')`,
      [
        firstJobId,
        secondJobId,
        repeatedHex('a'),
        repeatedHex('b'),
        repeatedHex('c')
      ]
    );

    await firstClient.query('BEGIN');
    await secondClient.query('BEGIN');
    try {
      await firstClient.query(
        `INSERT INTO local_agent_job_idempotency (
           principal_id,
           workspace_id,
           device_id,
           action,
           idempotency_key_hash,
           idempotency_scope_hash,
           request_fingerprint_hash,
           idempotency_origin,
           job_id,
           idempotency_until
         )
         VALUES (
           'principal-preview',
           'workspace-preview',
           'device-preview',
           'git.status',
           $1,
           $2,
           $3,
           'explicit',
           $4,
           NOW() + INTERVAL '1 hour'
         )`,
        [
          repeatedHex('b'),
          repeatedHex('c'),
          repeatedHex('a'),
          firstJobId
        ]
      );

      const competingInsert = secondClient.query(
        `INSERT INTO local_agent_job_idempotency (
           principal_id,
           workspace_id,
           device_id,
           action,
           idempotency_key_hash,
           idempotency_scope_hash,
           request_fingerprint_hash,
           idempotency_origin,
           job_id,
           idempotency_until
         )
         VALUES (
           'principal-preview',
           'workspace-preview',
           'device-preview',
           'git.status',
           $1,
           $2,
           $3,
           'explicit',
           $4,
           NOW() + INTERVAL '1 hour'
         )`,
        [
          repeatedHex('b'),
          repeatedHex('c'),
          repeatedHex('d'),
          secondJobId
        ]
      );

      await new Promise((resolve) => setTimeout(resolve, 50));
      await firstClient.query('COMMIT');
      await expect(competingInsert).rejects.toMatchObject({ code: '23505' });
      await secondClient.query('ROLLBACK');
    } catch (error) {
      await Promise.allSettled([
        firstClient.query('ROLLBACK'),
        secondClient.query('ROLLBACK')
      ]);
      throw error;
    }

    const countResult = await firstClient.query(
      `SELECT COUNT(*)::int AS binding_count
       FROM local_agent_job_idempotency
       WHERE principal_id = 'principal-preview'
         AND workspace_id = 'workspace-preview'
         AND device_id = 'device-preview'
         AND action = 'git.status'
         AND idempotency_key_hash = $1`,
      [repeatedHex('b')]
    );
    expect(countResult.rows[0]?.binding_count).toBe(1);
    await firstClient.query(
      'DELETE FROM job_data WHERE id = ANY($1::uuid[])',
      [[firstJobId, secondJobId]]
    );
  }, 30_000);

  test('the production timeline query isolates local-agent events by tenant', async () => {
    await withRollback(firstClient, async () => {
      const ownJobId = randomUUID();
      const foreignJobId = randomUUID();
      const genericJobId = randomUUID();
      await firstClient.query(
        `INSERT INTO job_data (
           id,
           worker_id,
           job_type,
           status,
           input
         )
         VALUES
           ($1, 'device-own', 'local-agent', 'completed', $4::jsonb),
           ($2, 'device-foreign', 'local-agent', 'completed', $5::jsonb),
           ($3, 'worker-generic', 'generic', 'completed', '{}'::jsonb)`,
        [
          ownJobId,
          foreignJobId,
          genericJobId,
          JSON.stringify({
            job: {
              principal: 'principal-own',
              workspace: 'workspace-own'
            }
          }),
          JSON.stringify({
            job: {
              principal: 'principal-foreign',
              workspace: 'workspace-foreign'
            }
          })
        ]
      );
      await firstClient.query(
        `INSERT INTO job_events (
           job_id,
           trace_id,
           event_type,
           worker_id,
           occurred_at,
           metadata
         )
         VALUES
           ($1, 'trace-own', 'job.completed', 'device-own',
            '2026-07-24T10:00:00.000Z', '{"tenant":"own"}'::jsonb),
           ($2, 'trace-foreign', 'job.completed', 'device-foreign',
            '2026-07-24T10:01:00.000Z', '{"tenant":"foreign"}'::jsonb),
           ($3, 'trace-generic', 'job.completed', 'worker-generic',
            '2026-07-24T10:02:00.000Z', '{"tenant":"generic"}'::jsonb)`,
        [ownJobId, foreignJobId, genericJobId]
      );

      const ownScopeQuery = buildJobEventTimelineQuery({
        localAgentScope: {
          principalId: 'principal-own',
          workspaceId: 'workspace-own'
        }
      });
      const ownScopeResult = await firstClient.query(
        ownScopeQuery.text,
        ownScopeQuery.params
      );
      expect(ownScopeResult.rows.map((row) => row.job_id)).toEqual([
        ownJobId,
        genericJobId
      ]);

      const foreignExactQuery = buildJobEventTimelineQuery({
        jobId: foreignJobId,
        localAgentScope: {
          principalId: 'principal-own',
          workspaceId: 'workspace-own'
        }
      });
      const foreignExactResult = await firstClient.query(
        foreignExactQuery.text,
        foreignExactQuery.params
      );
      expect(foreignExactResult.rows).toEqual([]);

      const missingScopeQuery = buildJobEventTimelineQuery({
        localAgentScope: null
      });
      const missingScopeResult = await firstClient.query(
        missingScopeQuery.text,
        missingScopeQuery.params
      );
      expect(missingScopeResult.rows.map((row) => row.job_id)).toEqual([
        genericJobId
      ]);
    });
  }, 30_000);
});
