import { describe, expect, it, jest } from '@jest/globals';

import type { Pool } from 'pg';

import {
  PostgresBackstageNotionSyncStatusRepository,
} from '../src/core/db/repositories/backstageNotionSyncStatusRepository.js';

const UNIVERSE_ID = 'my-universe-2k26';
const ATTEMPT_ID = '33333333-3333-4333-8333-333333333333';
const SNAPSHOT_ID = '22222222-2222-4222-8222-222222222222';
const LEASE_TOKEN = '44444444-4444-4444-8444-444444444444';
const STARTED_AT = new Date('2026-08-29T15:56:00.000Z');
const COMPLETED_AT = new Date('2026-08-29T15:58:00.000Z');

function row(overrides: Record<string, unknown> = {}) {
  return {
    universe_id: UNIVERSE_ID,
    attempt_id: ATTEMPT_ID,
    attempt_generation: '7',
    started_at: STARTED_AT,
    completed_at: null,
    outcome: 'running',
    failure_phase: null,
    failure_reason: null,
    pages_discovered: 0,
    pages_fetched: 0,
    blocks_fetched: 0,
    chunks_produced: 0,
    chunks_embedded: 0,
    candidate_snapshot_created: false,
    candidate_snapshot_validated: false,
    candidate_snapshot_activated: false,
    activated_snapshot_id: null,
    ...overrides,
  };
}

function normalizeSql(value: string): string {
  return value.replace(/\s+/gu, ' ').trim();
}

function poolWithQuery(
  query: (sql: string, values?: unknown[]) => Promise<{
    rows: Record<string, unknown>[];
    rowCount: number;
  }>
): Pool {
  return { query } as unknown as Pool;
}

describe('PostgresBackstageNotionSyncStatusRepository', () => {
  it('starts a generation-fenced attempt only through the current live lease', async () => {
    let sql = '';
    let values: unknown[] = [];
    const repository = new PostgresBackstageNotionSyncStatusRepository(
      poolWithQuery(async (rawSql, rawValues = []) => {
        sql = normalizeSql(rawSql);
        values = rawValues;
        return {
          rows: [row({ attempt_id: String(rawValues[3]) })],
          rowCount: 1,
        };
      })
    );

    const attempt = await repository.beginSyncAttempt({
      universeId: UNIVERSE_ID,
      lease: { holderId: 'worker-1', leaseToken: LEASE_TOKEN },
    });
    expect(attempt).toMatchObject({
      universeId: UNIVERSE_ID,
      generation: '7',
      outcome: 'running',
    });

    expect(sql).toContain('FROM backstage_notion_sync_leases AS lease');
    expect(sql).toContain('lease.expires_at > clock_timestamp()');
    expect(sql).toContain('attempt_generation = backstage_notion_latest_sync_attempts.attempt_generation + 1');
    expect(values.slice(0, 3)).toEqual([
      UNIVERSE_ID,
      'worker-1',
      LEASE_TOKEN,
    ]);
    expect(String(values[3])).toMatch(/^[0-9a-f-]{36}$/u);
    expect(attempt.attemptId).toBe(values[3]);
  });

  it('records a bounded failed refresh without touching the active pointer', async () => {
    let sql = '';
    let values: unknown[] = [];
    const repository = new PostgresBackstageNotionSyncStatusRepository(
      poolWithQuery(async (rawSql, rawValues = []) => {
        sql = normalizeSql(rawSql);
        values = rawValues;
        return {
          rows: [row({
            completed_at: COMPLETED_AT,
            outcome: 'failed',
            failure_phase: 'chunking',
            failure_reason: 'chunk_limit_reached',
            pages_discovered: 366,
            pages_fetched: 366,
            blocks_fetched: 366,
            chunks_produced: 2307,
          })],
          rowCount: 1,
        };
      })
    );

    await expect(repository.completeSyncAttempt({
      universeId: UNIVERSE_ID,
      attemptId: ATTEMPT_ID,
      generation: '7',
      outcome: 'failed',
      failurePhase: 'chunking',
      failureReason: 'chunk_limit_reached',
      pagesDiscovered: 366,
      pagesFetched: 366,
      blocksFetched: 366,
      chunksProduced: 2307,
      chunksEmbedded: 0,
      candidateSnapshotCreated: false,
      candidateSnapshotValidated: false,
      candidateSnapshotActivated: false,
      activatedSnapshotId: null,
    })).resolves.toMatchObject({
      outcome: 'failed',
      failurePhase: 'chunking',
      failureReason: 'chunk_limit_reached',
      chunksProduced: 2307,
    });

    expect(sql).toMatch(/^UPDATE backstage_notion_latest_sync_attempts /u);
    expect(sql).not.toContain('UPDATE backstage_notion_universe_heads');
    expect(sql).not.toContain('UPDATE backstage_notion_snapshots');
    expect(values.slice(0, 6)).toEqual([
      UNIVERSE_ID,
      ATTEMPT_ID,
      '7',
      'failed',
      'chunking',
      'chunk_limit_reached',
    ]);
  });

  it('cannot let an older completion overwrite a newer attempt generation', async () => {
    const query = jest.fn(async () => ({ rows: [], rowCount: 0 }));
    const repository = new PostgresBackstageNotionSyncStatusRepository(
      poolWithQuery(query)
    );

    await expect(repository.completeSyncAttempt({
      universeId: UNIVERSE_ID,
      attemptId: ATTEMPT_ID,
      generation: '7',
      outcome: 'unchanged',
      failurePhase: null,
      failureReason: null,
      pagesDiscovered: 366,
      pagesFetched: 366,
      blocksFetched: 366,
      chunksProduced: 0,
      chunksEmbedded: 0,
      candidateSnapshotCreated: false,
      candidateSnapshotValidated: false,
      candidateSnapshotActivated: false,
      activatedSnapshotId: SNAPSHOT_ID,
    })).resolves.toBeNull();
    expect(normalizeSql(String(query.mock.calls[0]?.[0])))
      .toContain("AND attempt_generation = $3::BIGINT AND outcome = 'running'");
  });

  it('reconstructs bounded latest-sync failure state after a repository restart', async () => {
    const stored = row({
      completed_at: COMPLETED_AT,
      outcome: 'failed',
      failure_phase: 'embedding',
      failure_reason: 'embedding_failed',
      pages_discovered: '366',
      pages_fetched: '366',
      blocks_fetched: '366',
      chunks_produced: '2307',
      chunks_embedded: '2240',
      candidate_snapshot_created: true,
    });
    const repository = new PostgresBackstageNotionSyncStatusRepository(
      poolWithQuery(async () => ({ rows: [stored], rowCount: 1 }))
    );

    await expect(repository.loadLatestSyncAttempt(UNIVERSE_ID)).resolves.toEqual({
      universeId: UNIVERSE_ID,
      attemptId: ATTEMPT_ID,
      generation: '7',
      startedAt: STARTED_AT,
      completedAt: COMPLETED_AT,
      outcome: 'failed',
      failurePhase: 'embedding',
      failureReason: 'embedding_failed',
      pagesDiscovered: 366,
      pagesFetched: 366,
      blocksFetched: 366,
      chunksProduced: 2307,
      chunksEmbedded: 2240,
      candidateSnapshotCreated: true,
      candidateSnapshotValidated: false,
      candidateSnapshotActivated: false,
      activatedSnapshotId: null,
    });
  });

  it('fails closed if a latest-attempt row escapes the requested universe', async () => {
    const repository = new PostgresBackstageNotionSyncStatusRepository(
      poolWithQuery(async () => ({
        rows: [row({ universe_id: 'another-universe' })],
        rowCount: 1,
      }))
    );

    await expect(repository.loadLatestSyncAttempt(UNIVERSE_ID))
      .rejects.toThrow('escaped its universe scope');
  });

  it.each([
    ['a successful attempt without its active snapshot', {
      completed_at: COMPLETED_AT,
      outcome: 'unchanged',
    }],
    ['a failed attempt that claims candidate activation', {
      completed_at: COMPLETED_AT,
      outcome: 'failed',
      failure_phase: 'activation',
      failure_reason: 'activation_failed',
      candidate_snapshot_created: true,
      candidate_snapshot_validated: true,
      candidate_snapshot_activated: true,
    }],
    ['completion before the attempt started', {
      completed_at: new Date(STARTED_AT.getTime() - 1),
      outcome: 'failed',
      failure_phase: 'chunking',
      failure_reason: 'chunk_limit_reached',
    }],
  ])('fails closed while reading stored %s', async (_label, overrides) => {
    const repository = new PostgresBackstageNotionSyncStatusRepository(
      poolWithQuery(async () => ({
        rows: [row(overrides)],
        rowCount: 1,
      }))
    );

    await expect(repository.loadLatestSyncAttempt(UNIVERSE_ID))
      .rejects.toThrow('inconsistent');
  });

  it('rejects inconsistent successful lifecycle diagnostics before PostgreSQL', async () => {
    const query = jest.fn(async () => ({ rows: [], rowCount: 0 }));
    const repository = new PostgresBackstageNotionSyncStatusRepository(
      poolWithQuery(query)
    );

    await expect(repository.completeSyncAttempt({
      universeId: UNIVERSE_ID,
      attemptId: ATTEMPT_ID,
      generation: '7',
      outcome: 'activated',
      failurePhase: null,
      failureReason: null,
      pagesDiscovered: 366,
      pagesFetched: 366,
      blocksFetched: 366,
      chunksProduced: 2307,
      chunksEmbedded: 2307,
      candidateSnapshotCreated: true,
      candidateSnapshotValidated: false,
      candidateSnapshotActivated: false,
      activatedSnapshotId: SNAPSHOT_ID,
    })).rejects.toThrow('requires its active snapshot');
    expect(query).not.toHaveBeenCalled();
  });

  it('rejects unbounded diagnostics before querying PostgreSQL', async () => {
    const query = jest.fn(async () => ({ rows: [], rowCount: 0 }));
    const repository = new PostgresBackstageNotionSyncStatusRepository(
      poolWithQuery(query)
    );

    await expect(repository.completeSyncAttempt({
      universeId: UNIVERSE_ID,
      attemptId: ATTEMPT_ID,
      generation: '7',
      outcome: 'failed',
      failurePhase: 'chunking',
      failureReason: 'chunk_limit_reached',
      pagesDiscovered: 366,
      pagesFetched: 366,
      blocksFetched: 366,
      chunksProduced: 1_000_001,
      chunksEmbedded: 0,
      candidateSnapshotCreated: false,
      candidateSnapshotValidated: false,
      candidateSnapshotActivated: false,
      activatedSnapshotId: null,
    })).rejects.toThrow('outside its bounded range');
    await expect(repository.completeSyncAttempt({
      universeId: UNIVERSE_ID,
      attemptId: ATTEMPT_ID,
      generation: '9223372036854775808',
      outcome: 'failed',
      failurePhase: 'chunking',
      failureReason: 'chunk_limit_reached',
      pagesDiscovered: 366,
      pagesFetched: 366,
      blocksFetched: 366,
      chunksProduced: 2307,
      chunksEmbedded: 0,
      candidateSnapshotCreated: false,
      candidateSnapshotValidated: false,
      candidateSnapshotActivated: false,
      activatedSnapshotId: null,
    })).rejects.toThrow('generation is invalid');
    expect(query).not.toHaveBeenCalled();
  });
});
