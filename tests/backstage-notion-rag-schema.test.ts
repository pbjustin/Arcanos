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

  it('keeps runtime bootstrap and the forward migration semantically identical', () => {
    const normalizeSql = (value: string): string => value
      .replace(/^\s*--.*$/gmu, '')
      .replace(/^\s*(?:BEGIN|COMMIT)\s*;\s*$/gimu, '')
      .replace(/\s+/gu, ' ')
      .trim()
      .replace(/;$/u, '');
    const runtimeStatements = BACKSTAGE_NOTION_RAG_TABLE_DEFINITIONS
      .map(statement => statement.trim().replace(/;$/u, ''))
      .join(';\n');

    expect(normalizeSql(runtimeStatements)).toBe(normalizeSql(forwardMigration));
  });
});
