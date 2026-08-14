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
  ])('%s rejects drifted universe check expressions and metadata', (_label, sql) => {
    const firstTargetPosition = sql.indexOf(
      "('backstage_events', 'ck_backstage_events_universe_id')"
    );
    const verifierStart = sql.lastIndexOf('DO $$', firstTargetPosition);
    const verifierEnd = sql.indexOf(
      'uq_backstage_wrestlers_universe_name',
      firstTargetPosition
    );
    expect(firstTargetPosition).toBeGreaterThan(-1);
    expect(verifierStart).toBeGreaterThan(-1);
    expect(verifierEnd).toBeGreaterThan(firstTargetPosition);
    const verifierSql = sql.slice(verifierStart, verifierEnd);

    expect(verifierSql).toContain("expected_constraint_name := target.constraint_name || '_expected'");
    expect(verifierSql).toContain(
      'pg_get_expr(constraint_row.conbin, constraint_row.conrelid, false)'
    );
    expect(verifierSql).toContain(
      'actual_constraint_expression IS DISTINCT FROM expected_constraint_expression'
    );
    expect(verifierSql).toContain('actual_constraint_type <> \'c\'');
    expect(verifierSql).toContain('actual_constraint_no_inherit');
    expect(verifierSql).toContain('NOT actual_constraint_is_local');
    expect(verifierSql).toContain('actual_constraint_inheritance_count <> 0');
    expect(verifierSql).toContain('actual_constraint_parent <> 0');
    expect(verifierSql).toContain('NOT actual_constraint_enforced');
    expect(verifierSql).not.toContain("existing_definition NOT LIKE '%universe_id%'");
    expect(verifierSql).not.toContain("existing_definition NOT LIKE '%A-Za-z0-9._:-%'");
    let previousTargetPosition = verifierSql.indexOf('FROM (VALUES');
    for (const table of [
      'backstage_wrestlers',
      'backstage_events',
      'backstage_story_beats',
      'backstage_storylines'
    ]) {
      const targetPosition = verifierSql.indexOf(
        `('${table}', 'ck_${table}_universe_id')`
      );
      expect(targetPosition).toBeGreaterThan(previousTargetPosition);
      previousTargetPosition = targetPosition;
    }
    for (const constraint of BACKSTAGE_UNIVERSE_CHECKS) {
      expect(verifierSql).toContain(constraint);
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

  it('fences forward activation in the context-read lock order', () => {
    const contextReadOrder = [
      'backstage_wrestlers',
      'backstage_events',
      'backstage_story_beats',
      'backstage_storylines'
    ] as const;
    const firstLockPosition = forwardMigration.indexOf(
      'LOCK TABLE backstage_wrestlers IN ACCESS EXCLUSIVE MODE'
    );
    const firstAlterPosition = forwardMigration.indexOf(
      'ALTER TABLE backstage_wrestlers ADD COLUMN IF NOT EXISTS universe_id TEXT'
    );

    let previousCreatePosition = forwardMigration.indexOf('BEGIN;');
    for (const table of contextReadOrder) {
      const createPosition = forwardMigration.indexOf(
        `CREATE TABLE IF NOT EXISTS ${table}`
      );
      expect(createPosition).toBeGreaterThan(previousCreatePosition);
      expect(createPosition).toBeLessThan(firstLockPosition);
      previousCreatePosition = createPosition;
    }

    let previousLockPosition = previousCreatePosition;
    for (const table of contextReadOrder) {
      const lockPosition = forwardMigration.indexOf(
        `LOCK TABLE ${table} IN ACCESS EXCLUSIVE MODE`
      );
      expect(lockPosition).toBeGreaterThan(previousLockPosition);
      expect(lockPosition).toBeLessThan(firstAlterPosition);
      previousLockPosition = lockPosition;
    }
  });

  it('verifies runtime universe checks in the context-read lock order', () => {
    const contextReadOrder = [
      'backstage_wrestlers',
      'backstage_events',
      'backstage_story_beats',
      'backstage_storylines'
    ] as const;
    const verifierTargetPosition = runtimeSchemaSql.indexOf(
      "('backstage_wrestlers', 'ck_backstage_wrestlers_universe_id')"
    );
    const verifierStart = runtimeSchemaSql.lastIndexOf('DO $$', verifierTargetPosition);
    const verifierEnd = runtimeSchemaSql.indexOf(
      'uq_backstage_wrestlers_universe_name',
      verifierTargetPosition
    );
    const verifierSql = runtimeSchemaSql.slice(verifierStart, verifierEnd);

    let previousTargetPosition = verifierSql.indexOf('FROM (VALUES');
    for (const table of contextReadOrder) {
      const targetPosition = verifierSql.indexOf(
        `('${table}', 'ck_${table}_universe_id')`
      );
      expect(targetPosition).toBeGreaterThan(previousTargetPosition);
      previousTargetPosition = targetPosition;
    }
    const dynamicLockPosition = verifierSql.indexOf(
      "LOCK TABLE %I IN SHARE ROW EXCLUSIVE MODE"
    );
    const temporaryConstraintPosition = verifierSql.indexOf(
      'ADD CONSTRAINT %I CHECK (universe_id ~ %L) NOT VALID'
    );
    expect(dynamicLockPosition).toBeGreaterThan(previousTargetPosition);
    expect(temporaryConstraintPosition).toBeGreaterThan(dynamicLockPosition);
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
