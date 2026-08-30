import { readFile } from 'node:fs/promises';

import { describe, expect, it } from '@jest/globals';

import {
  BACKSTAGE_NOTION_RAG_TABLE_DEFINITIONS,
  BackstageNotionLatestSyncAttemptSchema,
} from '../src/core/db/schema.js';

describe('Backstage Notion latest-sync status schema', () => {
  it('keeps latest refresh state in a separate bounded table', () => {
    const sql = BACKSTAGE_NOTION_RAG_TABLE_DEFINITIONS.join('\n');
    const tableSql = BACKSTAGE_NOTION_RAG_TABLE_DEFINITIONS.find(definition => (
      definition.includes('CREATE TABLE IF NOT EXISTS backstage_notion_latest_sync_attempts')
    ));
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS backstage_notion_latest_sync_attempts');
    expect(sql).toContain('attempt_generation BIGINT NOT NULL');
    expect(sql).toContain("outcome IN ('running', 'activated', 'unchanged', 'failed')");
    expect(sql).toContain('chunks_produced BETWEEN 0 AND 1000000');
    expect(sql).toContain('FOREIGN KEY (universe_id, activated_snapshot_id)');
    expect(tableSql).toBeDefined();
    expect(tableSql).not.toMatch(/page_(?:id|content)/iu);
  });

  it('validates only bounded operator-safe state', () => {
    expect(BackstageNotionLatestSyncAttemptSchema.safeParse({
      universe_id: 'my-universe-2k26',
      attempt_id: '33333333-3333-4333-8333-333333333333',
      attempt_generation: '7',
      started_at: new Date(),
      completed_at: new Date(),
      outcome: 'failed',
      failure_phase: 'chunking',
      failure_reason: 'chunk_limit_reached',
      pages_discovered: 366,
      pages_fetched: 366,
      blocks_fetched: 366,
      chunks_produced: 2307,
      chunks_embedded: 0,
      candidate_snapshot_created: false,
      candidate_snapshot_validated: false,
      candidate_snapshot_activated: false,
      activated_snapshot_id: null,
      updated_at: new Date(),
    }).success).toBe(true);
  });

  it('rolls back diagnostics without changing active snapshot storage', async () => {
    const rollback = await readFile(
      new URL(
        '../migrations/20260829_backstage_notion_rag_v4_sync_status.rollback.sql',
        import.meta.url
      ),
      'utf8'
    );
    expect(rollback).toContain('DROP TABLE IF EXISTS public.backstage_notion_latest_sync_attempts');
    expect(rollback).not.toContain('DROP TABLE IF EXISTS public.backstage_notion_snapshots');
    expect(rollback).not.toContain('UPDATE public.backstage_notion_universe_heads');
  });
});
