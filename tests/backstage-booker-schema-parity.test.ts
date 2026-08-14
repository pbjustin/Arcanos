import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from '@jest/globals';

import { TABLE_DEFINITIONS } from '../src/core/db/schema.js';

const forwardMigration = readFileSync(
  join(process.cwd(), 'migrations', '20260814_backstage_universe_scope_v1.sql'),
  'utf8'
);
const rollbackMigration = readFileSync(
  join(
    process.cwd(),
    'migrations',
    '20260814_backstage_universe_scope_v1.rollback.sql'
  ),
  'utf8'
);
const runtimeSchemaSql = TABLE_DEFINITIONS.join('\n');

const BACKSTAGE_TABLES = [
  'backstage_events',
  'backstage_wrestlers',
  'backstage_storylines',
  'backstage_story_beats'
] as const;

const BACKSTAGE_UNIVERSE_CHECKS = [
  'ck_backstage_events_universe_id',
  'ck_backstage_wrestlers_universe_id',
  'ck_backstage_storylines_universe_id',
  'ck_backstage_story_beats_universe_id'
] as const;

const BACKSTAGE_SCOPED_INDEXES = [
  'idx_backstage_wrestlers_universe_updated',
  'idx_backstage_events_universe_created',
  'idx_backstage_storylines_universe_updated',
  'idx_backstage_story_beats_universe_created'
] as const;

describe('Backstage Booker universe-scope schema', () => {
  it.each([
    ['runtime bootstrap', runtimeSchemaSql],
    ['forward migration', forwardMigration]
  ])('%s installs and validates all four universe columns', (_label, sql) => {
    for (const table of BACKSTAGE_TABLES) {
      expect(sql).toContain(`CREATE TABLE IF NOT EXISTS ${table}`);
      expect(sql).toContain(
        `ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS universe_id TEXT`
      );
      expect(sql).toMatch(
        new RegExp(`UPDATE ${table}\\s+SET universe_id = 'legacy'`, 'u')
      );
      expect(sql).toContain(
        `ALTER TABLE ${table} ALTER COLUMN universe_id SET DEFAULT 'legacy'`
      );
      expect(sql).toContain(
        `ALTER TABLE ${table} ALTER COLUMN universe_id SET NOT NULL`
      );
    }

    expect(sql).toContain("'^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'");
    for (const constraint of BACKSTAGE_UNIVERSE_CHECKS) {
      expect(sql).toContain(constraint);
    }
  });

  it.each([
    ['runtime bootstrap', runtimeSchemaSql],
    ['forward migration', forwardMigration]
  ])('%s installs universe-scoped identity', (_label, sql) => {
    expect(sql).toContain('uq_backstage_wrestlers_universe_name');
    expect(sql).toContain('UNIQUE (universe_id, name)');
    expect(sql).toContain('uq_backstage_storylines_universe_story_key');
    expect(sql).toContain('UNIQUE (universe_id, story_key)');
    for (const index of BACKSTAGE_SCOPED_INDEXES) {
      expect(sql).toContain(index);
    }
  });

  it('keeps startup expansion-only and reserves activation for the migration', () => {
    expect(runtimeSchemaSql).toContain(
      'CONSTRAINT backstage_wrestlers_name_key'
    );
    expect(runtimeSchemaSql).toContain('UNIQUE (name)');
    expect(runtimeSchemaSql).toContain(
      'CONSTRAINT backstage_storylines_story_key_key'
    );
    expect(runtimeSchemaSql).toContain('UNIQUE (story_key)');
    expect(runtimeSchemaSql).not.toContain(
      'DROP CONSTRAINT IF EXISTS backstage_wrestlers_name_key'
    );
    expect(runtimeSchemaSql).not.toContain(
      'DROP CONSTRAINT IF EXISTS backstage_storylines_story_key_key'
    );
    expect(runtimeSchemaSql).not.toContain(
      'ADD CONSTRAINT backstage_wrestlers_name_key'
    );
    expect(runtimeSchemaSql).not.toContain(
      'ADD CONSTRAINT backstage_storylines_story_key_key'
    );
    expect(forwardMigration).toContain(
      'DROP CONSTRAINT IF EXISTS backstage_wrestlers_name_key'
    );
    expect(forwardMigration).toContain(
      'DROP CONSTRAINT IF EXISTS backstage_storylines_story_key_key'
    );
  });

  it('backfills before making universe scope required and stays transactional', () => {
    expect(forwardMigration.trimStart().startsWith('--')).toBe(true);
    expect(forwardMigration).toMatch(/\bBEGIN;/u);
    expect(forwardMigration.trimEnd().endsWith('COMMIT;')).toBe(true);

    for (const table of BACKSTAGE_TABLES) {
      const backfillPosition = forwardMigration.indexOf(`UPDATE ${table}`);
      const notNullPosition = forwardMigration.indexOf(
        `ALTER TABLE ${table} ALTER COLUMN universe_id SET NOT NULL`
      );
      expect(backfillPosition).toBeGreaterThan(-1);
      expect(notNullPosition).toBeGreaterThan(backfillPosition);
    }

    expect(forwardMigration).not.toMatch(/\b(?:DELETE\s+FROM|TRUNCATE|DROP\s+TABLE)\b/iu);
  });

  it('provides a guarded rollback that cannot collapse non-legacy universes', () => {
    const guardPosition = rollbackMigration.indexOf(
      'universe_id IS DISTINCT FROM %L'
    );
    let previousLockPosition = rollbackMigration.indexOf('BEGIN;');
    for (const table of [
      'backstage_wrestlers',
      'backstage_events',
      'backstage_story_beats',
      'backstage_storylines'
    ]) {
      const lockPosition = rollbackMigration.indexOf(
        `LOCK TABLE ${table} IN ACCESS EXCLUSIVE MODE`
      );
      expect(lockPosition).toBeGreaterThan(previousLockPosition);
      expect(lockPosition).toBeLessThan(guardPosition);
      previousLockPosition = lockPosition;
    }
    expect(rollbackMigration).toContain("universe_id IS DISTINCT FROM %L");
    expect(rollbackMigration).toContain("'legacy'");
    expect(rollbackMigration).toContain("USING ERRCODE = '55000'");
    expect(rollbackMigration).toContain(
      'DROP CONSTRAINT IF EXISTS uq_backstage_wrestlers_universe_name'
    );
    expect(rollbackMigration).toContain(
      'ADD CONSTRAINT backstage_wrestlers_name_key UNIQUE (name)'
    );
    expect(rollbackMigration).toContain(
      'DROP CONSTRAINT IF EXISTS uq_backstage_storylines_universe_story_key'
    );
    expect(rollbackMigration).toContain(
      'ADD CONSTRAINT backstage_storylines_story_key_key UNIQUE (story_key)'
    );
    for (const table of BACKSTAGE_TABLES) {
      expect(rollbackMigration).toContain(
        `ALTER TABLE ${table} DROP COLUMN IF EXISTS universe_id`
      );
    }
    expect(rollbackMigration).not.toMatch(/\b(?:DELETE\s+FROM|TRUNCATE|DROP\s+TABLE)\b/iu);
  });
});
