import { describe, expect, it } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { TABLE_DEFINITIONS } from '../src/core/db/schema.js';

const migrationPath = join(
  process.cwd(),
  'migrations',
  '20260808_gaming_knowledge_sources.sql'
);
const rollbackPath = join(
  process.cwd(),
  'migrations',
  '20260808_gaming_knowledge_sources.rollback.sql'
);
const migrationSql = readFileSync(migrationPath, 'utf8');
const rollbackSql = readFileSync(rollbackPath, 'utf8');

const GAMING_TABLES = [
  'gaming_sources',
  'gaming_source_revisions',
  'gaming_knowledge_records'
] as const;

const GAMING_INDEXES = [
  'idx_gaming_sources_game_status_type',
  'idx_gaming_source_revisions_source_fetched',
  'idx_gaming_knowledge_game_type_status_patch',
  'idx_gaming_knowledge_semantic_status',
  'idx_gaming_knowledge_active_search'
] as const;

function normalizeSql(statement: string): string {
  return statement.replace(/\s+/gu, ' ').trim().replace(/;$/u, '');
}

function migrationGamingStatements(): string[] {
  return migrationSql
    .replace(/^--.*$/gmu, '')
    .split(';')
    .map(normalizeSql)
    .filter(statement =>
      statement.startsWith('CREATE ')
      && statement.includes('gaming_')
    )
    .sort();
}

function startupGamingStatements(): string[] {
  return TABLE_DEFINITIONS
    .map(normalizeSql)
    .filter(statement =>
      statement.startsWith('CREATE ')
      && statement.includes('gaming_')
    )
    .sort();
}

describe('durable Gaming knowledge schema', () => {
  it('keeps the migration and startup bootstrap semantically aligned', () => {
    expect(startupGamingStatements()).toEqual(migrationGamingStatements());
  });

  it('defines the three-table provenance model and its reviewed indexes', () => {
    const startupSql = TABLE_DEFINITIONS.join('\n');
    for (const table of GAMING_TABLES) {
      expect(migrationSql).toContain(`CREATE TABLE IF NOT EXISTS ${table}`);
      expect(startupSql).toContain(`CREATE TABLE IF NOT EXISTS ${table}`);
    }
    for (const index of GAMING_INDEXES) {
      expect(migrationSql).toContain(`CREATE INDEX IF NOT EXISTS ${index}`);
      expect(startupSql).toContain(`CREATE INDEX IF NOT EXISTS ${index}`);
    }
  });

  it('enforces source identity, immutable revision identity, and active full-text lookup', () => {
    expect(migrationSql).toContain('UNIQUE (game_key, canonical_url_hash)');
    expect(migrationSql).toContain(
      'UNIQUE (source_revision_id, semantic_key, payload_hash)'
    );
    expect(migrationSql).toContain("CHECK (source_type IN ('official', 'patch_notes', 'wiki', 'curated', 'supplied'))");
    expect(migrationSql).toContain("CHECK (record_type IN ('guide', 'build', 'meta'))");
    expect(migrationSql).toContain(
      "USING GIN (to_tsvector('simple'::regconfig, search_text))"
    );
    expect(migrationSql).toContain("WHERE status = 'active'");
  });

  it('rolls back only the additive durable tables in dependency order', () => {
    const statements = rollbackSql
      .replace(/^--.*$/gmu, '')
      .split(';')
      .map(normalizeSql)
      .filter(Boolean);
    expect(statements).toEqual([
      'DROP TABLE IF EXISTS gaming_knowledge_records',
      'DROP TABLE IF EXISTS gaming_source_revisions',
      'DROP TABLE IF EXISTS gaming_sources'
    ]);
    expect(rollbackSql).not.toContain('DROP TABLE IF EXISTS gaming_guides');
    expect(rollbackSql).not.toContain('DROP TABLE IF EXISTS gaming_builds');
    expect(rollbackSql).not.toContain('DROP TABLE IF EXISTS gaming_meta');
  });
});
