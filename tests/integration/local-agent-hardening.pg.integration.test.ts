import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, test } from '@jest/globals';
import { Client } from 'pg';

const connectionString =
  process.env.LOCAL_AGENT_HARDENING_TEST_DATABASE_URL?.trim() ?? '';
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
         created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
       );
       CREATE TABLE job_events (
         id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
         job_id UUID NOT NULL,
         trace_id TEXT,
         event_type TEXT NOT NULL,
         worker_id TEXT,
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
  }, 30_000);
});
