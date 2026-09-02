import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from '@jest/globals';

import { BACKSTAGE_NOTION_RAG_TABLE_DEFINITIONS } from '../src/core/db/schema.js';

const forwardMigration = readFileSync(
  join(process.cwd(), 'migrations', '20260819_backstage_notion_rag_v1.sql'),
  'utf8'
);
const rollbackMigration = readFileSync(
  join(process.cwd(), 'migrations', '20260819_backstage_notion_rag_v1.rollback.sql'),
  'utf8'
);
const indexVersionFenceMigration = readFileSync(
  join(
    process.cwd(),
    'migrations',
    '20260819_backstage_notion_rag_v2_index_version_fence.sql'
  ),
  'utf8'
);
const indexVersionFenceRollback = readFileSync(
  join(
    process.cwd(),
    'migrations',
    '20260819_backstage_notion_rag_v2_index_version_fence.rollback.sql'
  ),
  'utf8'
);
const snapshotCapacityMigration = readFileSync(
  join(
    process.cwd(),
    'migrations',
    '20260829_backstage_notion_rag_v3_snapshot_capacity.sql'
  ),
  'utf8'
);
const snapshotCapacityRollback = readFileSync(
  join(
    process.cwd(),
    'migrations',
    '20260829_backstage_notion_rag_v3_snapshot_capacity.rollback.sql'
  ),
  'utf8'
);
const candidateSearchMigration = readFileSync(
  join(
    process.cwd(),
    'migrations',
    '20260902_backstage_notion_rag_candidate_search_v1.sql'
  ),
  'utf8'
);
const candidateSearchRollback = readFileSync(
  join(
    process.cwd(),
    'migrations',
    '20260902_backstage_notion_rag_candidate_search_v1.rollback.sql'
  ),
  'utf8'
);
const candidateSearchBackfill = readFileSync(
  join(
    process.cwd(),
    'scripts',
    'backstage-notion-candidate-search-backfill.mjs'
  ),
  'utf8'
);
const runtimeSql = BACKSTAGE_NOTION_RAG_TABLE_DEFINITIONS.join('\n');

const dedicatedTables = [
  'backstage_notion_universe_heads',
  'backstage_notion_authority_epoch',
  'backstage_notion_snapshots',
  'backstage_notion_snapshot_pages',
  'backstage_notion_snapshot_chunks',
  'backstage_notion_sync_leases'
];

const protectedLegacyTables = [
  'backstage_events',
  'backstage_wrestlers',
  'backstage_storylines',
  'backstage_story_beats',
  'backstage_canon_heads',
  'backstage_canon_revisions',
  'backstage_storyline_threads',
  'backstage_storyline_participants',
  'backstage_storyline_canon_beats'
];

describe('Backstage Notion RAG database contract', () => {
  it('orders the additive fences after the V1 storage migration', () => {
    const migrationNames = [
      '20260819_backstage_notion_rag_v1.sql',
      '20260819_backstage_notion_rag_v2_index_version_fence.sql',
      '20260829_backstage_notion_rag_v3_snapshot_capacity.sql',
    ];
    expect([...migrationNames].sort()).toEqual(migrationNames);
  });

  it.each([
    ['runtime bootstrap', runtimeSql],
    ['forward migration', forwardMigration]
  ])('%s creates dedicated authority and immutable snapshot storage', (_label, sql) => {
    for (const table of dedicatedTables) {
      expect(sql).toContain(`CREATE TABLE IF NOT EXISTS ${table}`);
    }
    expect(sql).not.toMatch(/CREATE TABLE IF NOT EXISTS rag_docs/iu);
    expect(sql).toContain('embedding JSONB NOT NULL');
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS backstage_notion_snapshot_chunks');
    expect(sql).toContain('CONSTRAINT pk_backstage_notion_snapshot_chunks');
    expect(sql).toContain('PRIMARY KEY (snapshot_id, id)');
    expect(sql).not.toMatch(
      /CREATE TABLE IF NOT EXISTS backstage_notion_snapshot_chunks\s*\(\s*id TEXT PRIMARY KEY/iu
    );
    expect(sql).toContain("= 'PRIMARYKEY(id)'");
    expect(sql).toContain(
      'ALTER TABLE backstage_notion_snapshot_chunks DROP CONSTRAINT %I'
    );
    expect(sql).toContain("<> 'PRIMARYKEY(snapshot_id,id)'");
    expect(sql).toContain("CONSTRAINT ck_backstage_notion_chunks_id");
    expect(sql).toContain("CHECK (id ~ '^[0-9a-f]{64}$')");
    expect(sql).toContain('jsonb_typeof(embedding) = \'array\'');
    expect(sql).toContain('UNIQUE (universe_id, id)');
    expect(sql).toContain('FOREIGN KEY (universe_id, active_snapshot_id)');
    expect(sql).toContain('REFERENCES backstage_notion_snapshots(universe_id, id)');
    expect(sql).toContain('trg_backstage_notion_immutable BEFORE UPDATE OR DELETE');
    expect(sql).toContain("RAISE EXCEPTION '% is immutable after insertion'");
    expect(sql).toContain('last_verified_at TIMESTAMPTZ');
    expect(sql).toContain("authority <> 'notion' OR last_verified_at IS NOT NULL");
    expect(sql).toContain('INSERT INTO backstage_notion_authority_epoch');
    expect(sql).toContain('ON CONFLICT (singleton) DO NOTHING');
    expect(sql).toContain('CHECK (singleton)');
    expect(sql).not.toContain('chunk_count BETWEEN 1 AND 50000');
  });

  it('keeps V1 historical while runtime and V3 end at a bounded 4,096 chunks', () => {
    expect(forwardMigration).toContain(
      'CHECK (page_count BETWEEN 1 AND 5000 AND chunk_count BETWEEN 1 AND 2048)'
    );
    for (const sql of [runtimeSql, snapshotCapacityMigration]) {
      expect(sql).toContain('ck_backstage_notion_snapshots_counts_v3');
      expect(sql).toContain(
        'CHECK (page_count BETWEEN 1 AND 5000 AND chunk_count BETWEEN 1 AND 4096)'
      );
    }
  });

  it.each([
    ['runtime bootstrap', runtimeSql],
    ['forward migration', forwardMigration]
  ])('%s blocks every legacy write plane for Notion authority', (_label, sql) => {
    for (const table of protectedLegacyTables) {
      expect(sql).toContain(`'${table}'`);
    }
    expect(sql).toContain(
      'trg_backstage_notion_authority_guard BEFORE INSERT OR UPDATE OR DELETE'
    );
    expect(sql).toContain("authority_row.authority = 'notion'");
    expect(sql).toContain('head.universe_id IN (old_universe_id, new_universe_id)');
    expect(sql).toContain('FROM public.backstage_notion_authority_epoch AS epoch_row');
    expect(sql).toContain('FOR KEY SHARE');
    expect(sql).toContain('Backstage Notion authority epoch is unavailable');
    expect(sql).toContain('ORDER BY head.universe_id');
    expect(sql).toContain('FOR SHARE');
    expect(sql).toContain("'LOCK TABLE %I IN SHARE ROW EXCLUSIVE MODE'");
    expect(sql).toContain('legacy Backstage writes are disabled');
    expect(sql).toMatch(
      /legacy Backstage writes are disabled[\s\S]{0,100}USING ERRCODE = 'BN001'/u
    );
    expect(sql).toContain("existing_trigger_type <> 31");
    expect(sql).toContain("existing_trigger_enabled <> 'O'");
  });

  it.each([
    ['runtime bootstrap', runtimeSql],
    ['forward migration', forwardMigration]
  ])('%s makes Notion authority persistent without blocking head refreshes', (_label, sql) => {
    const guardStart = sql.indexOf(
      'CREATE OR REPLACE FUNCTION backstage_notion_guard_authority_persistence()'
    );
    const legacyGuardStart = sql.indexOf(
      'CREATE OR REPLACE FUNCTION backstage_notion_guard_legacy_mutation()'
    );
    const authorityGuardSql = sql.slice(guardStart, legacyGuardStart);
    expect(sql).toContain(
      'CREATE OR REPLACE FUNCTION backstage_notion_guard_authority_persistence()'
    );
    expect(sql).toContain(
      "OLD.authority = 'notion' AND NEW.authority IS DISTINCT FROM 'notion'"
    );
    expect(sql).toContain('Notion authority cannot be downgraded');
    expect(authorityGuardSql).toContain("USING ERRCODE = 'BN001'");
    expect(sql).toContain(
      'CREATE TRIGGER trg_backstage_notion_authority_persistence'
    );
    expect(sql).toContain('BEFORE UPDATE OR DELETE ON backstage_notion_universe_heads');
    expect(sql).toContain('existing_trigger_type = 19');
    expect(sql).toContain('existing_trigger_type <> 27');
    expect(authorityGuardSql).toContain('RETURN NEW;');
    expect(authorityGuardSql).toContain("TG_OP = 'DELETE'");
    expect(authorityGuardSql).toContain('Notion authority cannot be deleted');
    expect(authorityGuardSql).toContain(
      'NEW.active_snapshot_id IS DISTINCT FROM OLD.active_snapshot_id'
    );
    expect(authorityGuardSql).toContain(
      'new_root_page_id IS DISTINCT FROM old_root_page_id'
    );
    expect(authorityGuardSql).toContain('Notion authority root cannot be changed');
    expect(authorityGuardSql).not.toContain('last_verified_at');
  });

  it.each([
    ['runtime bootstrap', runtimeSql],
    ['index-version fence migration', indexVersionFenceMigration]
  ])('%s database-fences snapshot index version downgrades', (_label, sql) => {
    expect(sql).toContain(
      'CREATE OR REPLACE FUNCTION backstage_notion_snapshot_index_version('
    );
    expect(sql).toContain("page.metadata -> 'indexFormat'");
    expect(sql).toContain(
      "^backstage-notion-rag-index-v(0|[1-9][0-9]{0,8})$"
    );
    expect(sql).toContain('ELSE 0');
    expect(sql).toContain('COUNT(DISTINCT page_marker.index_version)');
    expect(sql).toContain(
      'actual_page_count IS DISTINCT FROM expected_page_count::BIGINT'
    );
    expect(sql).toContain('distinct_marker_count IS DISTINCT FROM 1::BIGINT');
    expect(sql).toContain('snapshot contains mixed index format markers');
    expect(sql).toContain('candidate_index_version < current_index_version');
    expect(sql).toContain('Backstage Notion index version downgrade rejected');
    expect(sql).toContain("USING ERRCODE = 'BN002'");
    expect(sql).toContain(
      'CREATE TRIGGER trg_backstage_notion_index_version_fence'
    );
    expect(sql).toContain('BEFORE UPDATE ON backstage_notion_universe_heads');
    expect(sql).toContain('existing_trigger_type <> 19');
    expect(sql).toContain("existing_trigger_columns <> ''");
    expect(sql).toContain('existing_trigger_when IS NOT NULL');
    expect(sql).not.toContain('MAX(page_marker.index_version)');
  });

  it('keeps the index-version fence rollback fail-closed while active', () => {
    expect(indexVersionFenceRollback).toContain(
      'LOCK TABLE backstage_notion_universe_heads IN ACCESS EXCLUSIVE MODE'
    );
    expect(indexVersionFenceRollback).toContain(
      'WHERE active_snapshot_id IS NOT NULL'
    );
    expect(indexVersionFenceRollback).toContain(
      'cannot remove Backstage Notion index version fence while a snapshot is active'
    );
    expect(indexVersionFenceRollback).toContain("USING ERRCODE = '55000'");
    expect(indexVersionFenceRollback).toContain(
      'DROP TRIGGER IF EXISTS trg_backstage_notion_index_version_fence'
    );
    expect(indexVersionFenceRollback).toContain(
      'DROP FUNCTION IF EXISTS backstage_notion_snapshot_index_version(TEXT, UUID)'
    );
    expect(indexVersionFenceRollback).not.toContain('CASCADE');
  });

  it('fences V3 activation on exact chunk inventory and rollback on expanded history', () => {
    for (const sql of [runtimeSql, snapshotCapacityMigration]) {
      expect(sql).toContain('expected_chunk_count INTEGER');
      expect(sql).toContain('actual_chunk_count BIGINT');
      expect(sql).toContain(
        'actual_chunk_count IS DISTINCT FROM expected_chunk_count::BIGINT'
      );
      expect(sql).toContain(
        'Backstage Notion snapshot chunk inventory is incomplete for index activation'
      );
      expect(sql).toContain("USING ERRCODE = 'BN002'");
    }
    expect(snapshotCapacityRollback).toContain(
      'cannot restore the 2048-chunk limit while expanded immutable snapshots exist'
    );
    expect(snapshotCapacityRollback).toContain("USING ERRCODE = '55000'");
    expect(snapshotCapacityRollback).not.toContain('DELETE FROM');
  });

  it('keeps rollback fail-closed once authoritative history exists', () => {
    for (const table of dedicatedTables) {
      expect(rollbackMigration).toContain(`LOCK TABLE ${table} IN ACCESS EXCLUSIVE MODE`);
    }
    expect(rollbackMigration).toContain(
      'cannot roll back populated Backstage Notion RAG storage'
    );
    expect(rollbackMigration).toContain("USING ERRCODE = '55000'");
    expect(rollbackMigration).not.toContain('CASCADE');
    expect(rollbackMigration).toContain(
      'DROP CONSTRAINT fk_backstage_notion_heads_active_snapshot'
    );
    expect(rollbackMigration).toContain(
      'DROP TRIGGER IF EXISTS trg_backstage_notion_authority_persistence'
    );
    expect(rollbackMigration).toContain(
      'DROP FUNCTION backstage_notion_guard_authority_persistence()'
    );
    expect(rollbackMigration).toContain(
      'DROP TABLE backstage_notion_authority_epoch'
    );
    expect(rollbackMigration).toContain(
      'FROM backstage_notion_authority_epoch'
    );
  });

  it('keeps runtime bootstrap and V3 migration aligned on final capacity', () => {
    for (const fragment of [
      'ck_backstage_notion_snapshots_counts_v3',
      'chunk_count BETWEEN 1 AND 4096',
      'expected_chunk_count INTEGER',
      'actual_chunk_count BIGINT',
      'snapshot chunk inventory is incomplete for index activation',
    ]) {
      expect(runtimeSql).toContain(fragment);
      expect(snapshotCapacityMigration).toContain(fragment);
    }
  });

  it.each([
    ['runtime bootstrap', runtimeSql],
    ['candidate-search migration', candidateSearchMigration]
  ])('%s creates the immutable native candidate-search sidecar', (_label, sql) => {
    for (const fragment of [
      'backstage_notion_candidate_embedding_from_jsonb',
      'backstage_notion_candidate_embedding_norm',
      'backstage_notion_candidate_search_vector',
      'backstage_notion_candidate_brand_mask',
      'CREATE TABLE IF NOT EXISTS public.backstage_notion_snapshot_chunk_search',
      'embedding DOUBLE PRECISION[] NOT NULL',
      'embedding_norm > 0::DOUBLE PRECISION',
      "embedding_norm < 'Infinity'::DOUBLE PRECISION",
      "embedding_norm <> 'NaN'::DOUBLE PRECISION",
      'search_vector TSVECTOR NOT NULL',
      'booking_brand_mask SMALLINT NOT NULL',
      'FOREIGN KEY (snapshot_id, chunk_id)',
      'REFERENCES public.backstage_notion_snapshot_chunks(snapshot_id, id)',
      'idx_backstage_notion_snapshot_chunk_search_scope',
      'idx_backstage_notion_snapshot_chunk_search_model',
      'idx_backstage_notion_snapshot_chunk_search_lexical',
      'USING GIN (search_vector)',
    ]) {
      expect(sql).toContain(fragment);
    }
  });

  it('includes the candidate sidecar in both immutable-trigger installation paths', () => {
    expect(runtimeSql).toContain("'backstage_notion_snapshot_chunk_search'");
    expect(runtimeSql).toContain(
      "'CREATE TRIGGER trg_backstage_notion_immutable BEFORE UPDATE OR DELETE ON %I"
    );
    expect(candidateSearchMigration).toContain(
      'BEFORE UPDATE OR DELETE ON public.backstage_notion_snapshot_chunk_search'
    );
  });

  it.each([
    ['runtime bootstrap', runtimeSql],
    ['candidate-search migration', candidateSearchMigration]
  ])('%s fences activation on exact canonical/sidecar membership', (_label, sql) => {
    for (const fragment of [
      'backstage_notion_guard_candidate_search_activation',
      'canonical_chunk_count BIGINT',
      'sidecar_chunk_count BIGINT',
      'exact_membership_count BIGINT',
      'search.chunk_id = chunk.id',
      'search.page_id = chunk.page_id',
      'search.ordinal = chunk.ordinal',
      'search.embedding_model = chunk.embedding_model',
      'candidate-search sidecar is incomplete for snapshot activation',
      "USING ERRCODE = 'BN003'",
      'trg_backstage_notion_candidate_search_activation',
      'BEFORE UPDATE ON',
      'backstage_notion_universe_heads',
    ]) {
      expect(sql).toContain(fragment);
    }
  });

  it('keeps the candidate-search migration additive and defers bounded backfill', () => {
    expect(candidateSearchMigration).toContain(
      'This migration deliberately does not backfill historical snapshots.'
    );
    expect(candidateSearchMigration).not.toMatch(
      /(?:UPDATE|DELETE\s+FROM|TRUNCATE)\s+(?:public\.)?backstage_notion_snapshot_(?:chunks|pages)/iu
    );
    expect(candidateSearchMigration).not.toContain(
      'INSERT INTO public.backstage_notion_snapshot_chunk_search SELECT'
    );
    expect(candidateSearchMigration).toContain(
      'The table is new and empty at schema-install time'
    );
  });

  it('compensates only derived candidate-search state', () => {
    expect(candidateSearchRollback).toContain(
      'DROP TRIGGER IF EXISTS trg_backstage_notion_candidate_search_activation'
    );
    expect(candidateSearchRollback).toContain(
      'DROP FUNCTION IF EXISTS public.backstage_notion_guard_candidate_search_activation()'
    );
    expect(candidateSearchRollback).toContain(
      'DROP TABLE IF EXISTS public.backstage_notion_snapshot_chunk_search'
    );
    expect(candidateSearchRollback).toContain(
      'DROP FUNCTION IF EXISTS public.backstage_notion_candidate_embedding_from_jsonb'
    );
    expect(candidateSearchRollback).not.toMatch(
      /(?:DROP|DELETE\s+FROM|TRUNCATE)\s+(?:TABLE\s+)?(?:public\.)?backstage_notion_snapshot_(?:chunks|pages)/iu
    );
    expect(candidateSearchRollback).not.toContain('CASCADE');
    expect(candidateSearchRollback).not.toMatch(
      /DROP TRIGGER IF EXISTS trg_backstage_notion_immutable\s+ON public\.backstage_notion_snapshot_chunk_search/iu
    );
  });

  it('keeps candidate backfill pagination and completion evidence deterministic', () => {
    expect(candidateSearchBackfill).toContain(
      'AND (chunk.id COLLATE "C") > ($3::TEXT COLLATE "C")'
    );
    expect(candidateSearchBackfill).toContain('ORDER BY chunk.id COLLATE "C"');
    expect(candidateSearchBackfill).toContain(
      "TARGET_DIGEST_DOMAIN = 'backstage-notion-candidate-backfill-target/v1'"
    );
    expect(candidateSearchBackfill).toContain('input.universeId');
    expect(candidateSearchBackfill).toContain('input.snapshotId');
    expect(candidateSearchBackfill).toContain('input.expectedChunks');
    expect(candidateSearchBackfill).toContain('targetDigest,');
  });
});
