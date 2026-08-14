import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from '@jest/globals';

import { TABLE_DEFINITIONS } from '../src/core/db/schema.js';
import { AUDITED_TRANSIENT_READ_QUERIES } from '../src/core/db/transientReadRegistry.js';

const forwardMigration = readFileSync(
  join(process.cwd(), 'migrations', '20260805_backstage_storyline_serialized_data.sql'),
  'utf8'
);
const rollbackMigration = readFileSync(
  join(
    process.cwd(),
    'migrations',
    '20260805_backstage_storyline_serialized_data.rollback.sql'
  ),
  'utf8'
);
const runtimeSchemaSql = TABLE_DEFINITIONS.join('\n');

describe('Backstage storyline serialized storage contract', () => {
  it.each([
    ['runtime bootstrap', runtimeSchemaSql],
    ['forward migration', forwardMigration]
  ])('%s installs the byte-safe additive component', (_label, sql) => {
    expect(sql).toContain('ADD COLUMN IF NOT EXISTS serialized_data TEXT');
    expect(sql).toContain('ADD COLUMN IF NOT EXISTS storage_sequence BIGINT');
    expect(sql).toContain("serialized_data_type IS DISTINCT FROM 'text'::regtype");
    expect(sql).toContain('serialized_data_type_modifier <> -1');
    expect(sql).toContain('serialized_data_default IS NOT NULL');
    expect(sql).toContain(
      'backstage_story_beats.serialized_data has an unexpected definition'
    );
    expect(sql).toContain("storage_sequence_type IS DISTINCT FROM 'bigint'::regtype");
    expect(sql).toContain('backstage_story_beats.storage_sequence has an unexpected definition');
    expect(sql).toContain('NOT serialized_data_is_local');
    expect(sql).toContain('serialized_data_inheritance_count <> 0');
    expect(sql).toContain('NOT storage_sequence_is_local');
    expect(sql).toContain('storage_sequence_inheritance_count <> 0');
    expect(sql).toContain(
      "octet_length(convert_to(serialized_data, 'UTF8')) <= 16384"
    );
    expect(sql).toContain('serialized_data IS NOT NULL');
    expect(sql).toContain('serialized_data IS JSON OBJECT');
    expect(sql).toContain('storage_sequence IS NOT NULL');
    expect(sql).toContain('storage_sequence > 0');
    expect(sql).toContain('created_at IS NOT NULL');
    expect(sql).toContain('isfinite(created_at)');
    expect(sql).not.toContain('serialized_data::JSONB');
    expect(sql).toContain(
      'ADD CONSTRAINT backstage_story_beats_serialized_data_contract'
    );
    expect(sql).toContain('LOCK TABLE backstage_story_beats IN SHARE ROW EXCLUSIVE MODE');
    expect(sql).toContain('pg_get_expr(conbin, conrelid, false)');
    expect(sql).not.toContain('conbin::TEXT');
    expect(sql).toContain(
      'ADD CONSTRAINT backstage_story_beats_serialized_data_contract_expected'
    );
    expect(sql).toContain(
      'actual_constraint_expression IS DISTINCT FROM expected_constraint_expression'
    );
    expect(sql).toContain('actual_constraint_no_inherit');
    expect(sql).toContain('NOT actual_constraint_is_local');
    expect(sql).toContain('actual_constraint_inheritance_count <> 0');
    expect(sql).toContain('actual_constraint_parent <> 0');
    expect(sql).toContain("to_jsonb(pg_constraint) ->> 'conenforced'");
    expect(sql).toContain('NOT actual_constraint_enforced');
    expect(sql).toContain('USING ERRCODE = \'42804\'');
    expect(sql).toContain('NOT VALID');
    expect(sql).toContain(
      'VALIDATE CONSTRAINT backstage_story_beats_serialized_data_contract'
    );
  });

  it('uses only the exact bounded component for mutable prompt context', () => {
    const promptSql =
      AUDITED_TRANSIENT_READ_QUERIES.BACKSTAGE_PROMPT_STORY_BEATS_RECENT.sql;

    expect(promptSql).toContain('SELECT serialized_data, storage_sequence');
    expect(promptSql).toContain('WHERE universe_id = $1');
    expect(promptSql).toContain('AND serialized_data IS NOT NULL');
    expect(promptSql).toContain('ORDER BY storage_sequence DESC, id DESC');
    expect(promptSql).toContain('LIMIT 5');
    expect(promptSql).not.toMatch(/\bSELECT\s+data\b/u);
  });

  it('guards rollback before removing only its text column and check constraint', () => {
    expect(rollbackMigration).toContain(
      "serialized_data_type IS DISTINCT FROM 'text'::regtype"
    );
    expect(rollbackMigration).toContain('serialized_data_type_modifier <> -1');
    expect(rollbackMigration).toContain(
      "storage_sequence_type IS DISTINCT FROM 'bigint'::regtype"
    );
    expect(rollbackMigration).toContain('actual_constraint_oid IS NULL');
    expect(rollbackMigration).toContain('pg_get_expr(conbin, conrelid, false)');
    expect(rollbackMigration).toContain(
      'actual_constraint_expression IS DISTINCT FROM expected_constraint_expression'
    );
    expect(rollbackMigration).toContain('serialized_data IS JSON OBJECT');
    expect(rollbackMigration).toContain('serialized_data IS NOT NULL');
    expect(rollbackMigration).toContain('isfinite(created_at)');
    expect(rollbackMigration).toContain('NOT actual_constraint_validated');
    expect(rollbackMigration).toContain('NOT actual_constraint_enforced');
    expect(rollbackMigration).toContain(
      'cannot roll back populated authoritative storyline storage'
    );
    expect(rollbackMigration).toContain('FROM pg_depend');
    expect(rollbackMigration).toContain('USING ERRCODE = \'42804\'');
    expect(rollbackMigration).toContain(
      'DROP CONSTRAINT backstage_story_beats_serialized_data_contract'
    );
    expect(rollbackMigration).toContain('DROP COLUMN serialized_data');
    expect(rollbackMigration).toContain('DROP COLUMN storage_sequence');
  });
});
