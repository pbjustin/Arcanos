import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, test } from '@jest/globals';

import { BACKSTAGE_NOTION_PARTITION_CUTOVER_EVIDENCE_TABLE_DEFINITIONS } from '../src/core/db/backstageNotionPartitionCutoverEvidenceSchema.js';

function normalizeLineEndings(value: string): string {
  return value.replace(/\r\n?/gu, '\n');
}

const forwardMigration = normalizeLineEndings(readFileSync(
  join(
    process.cwd(),
    'migrations',
    '20260830_backstage_notion_partition_cutover_evidence_v1.sql'
  ),
  'utf8'
));
const rollbackMigration = normalizeLineEndings(readFileSync(
  join(
    process.cwd(),
    'migrations',
    '20260830_backstage_notion_partition_cutover_evidence_v1.rollback.sql'
  ),
  'utf8'
));
const runtimeSql =
  BACKSTAGE_NOTION_PARTITION_CUTOVER_EVIDENCE_TABLE_DEFINITIONS.join('\n');

function normalizeSql(value: string): string {
  return value
    .replace(/^\s*--.*$/gmu, '')
    .replace(/;/gu, '')
    .replace(/\s+/gu, ' ')
    .trim();
}

function migrationBody(value: string): string {
  return value
    .replace(/^\s*BEGIN;\s*/u, '')
    .replace(/\s*COMMIT;\s*$/u, '');
}

describe('Backstage Notion partition cutover evidence database contract', () => {
  test('keeps runtime bootstrap semantics aligned with the additive migration', () => {
    expect(normalizeSql(runtimeSql)).toBe(
      normalizeSql(migrationBody(forwardMigration))
    );
  });

  test.each([
    ['runtime bootstrap', runtimeSql],
    ['forward migration', forwardMigration],
  ])('%s defines content-free manifest, source, rollback, and attestation evidence', (
    _label,
    sql
  ) => {
    const normalized = normalizeSql(sql);
    expect(sql).toContain(
      'CREATE TABLE IF NOT EXISTS public.backstage_notion_partition_cutover_evidence'
    );
    expect(sql).toContain('universe_id TEXT PRIMARY KEY');
    expect(sql).toContain('UNIQUE (universe_id, manifest_id)');
    expect(sql).toContain('manifest_id UUID NOT NULL');
    expect(sql).toContain('partition_configuration_version_id UUID NOT NULL');
    expect(sql).toContain('source_generation_id UUID NOT NULL');
    expect(sql).toContain('reconciliation_generation BIGINT NOT NULL');
    expect(normalized).toContain(
      'published_reconciliation_generation BIGINT NOT NULL DEFAULT 0'
    );
    expect(sql).toContain('rollback_monolith_snapshot_id UUID NOT NULL');
    expect(sql).toContain(
      'rollback_validation_verified_at TIMESTAMPTZ NOT NULL'
    );
    expect(sql).toContain(
      'rollback_validation_valid_until TIMESTAMPTZ NOT NULL'
    );
    expect(sql).toContain('attestation_digest TEXT NOT NULL');
    expect(sql).not.toMatch(/\b(?:prompt|query_text|case_content|chunk_text|page_content)\b/iu);
  });

  test.each([
    ['runtime bootstrap', runtimeSql],
    ['forward migration', forwardMigration],
  ])('%s pins evidence with restrictive composite foreign keys', (_label, sql) => {
    expect(sql).toContain(
      'FOREIGN KEY (universe_id, manifest_id, partition_configuration_version_id)'
    );
    expect(sql).toContain(
      'REFERENCES public.backstage_notion_universe_manifests('
    );
    expect(sql).toContain(
      'source_generation_id,\n      partition_configuration_version_id,\n      source_digest,\n      source_page_count,\n      source_chunk_count,\n      source_verified_at,\n      source_verification_hash'
    );
    expect(sql).toContain(
      'REFERENCES public.backstage_notion_partition_source_generations('
    );
    expect(sql).toContain(
      'FOREIGN KEY (universe_id, rollback_monolith_snapshot_id)'
    );
    expect(sql).toContain(
      'REFERENCES public.backstage_notion_snapshots(universe_id, id)'
    );
    expect(sql.match(/ON UPDATE RESTRICT/gu)).toHaveLength(3);
    expect(sql.match(/ON DELETE RESTRICT/gu)).toHaveLength(3);
    expect(sql).not.toMatch(/\bCASCADE\b|ON\s+DELETE\s+SET\s+NULL/iu);
  });

  test.each([
    ['runtime bootstrap', runtimeSql],
    ['forward migration', forwardMigration],
  ])('%s enforces positive all-pass evidence and bounded source and rollback freshness windows', (
    _label,
    sql
  ) => {
    const normalized = normalizeSql(sql);
    expect(sql).toContain('CHECK (source_page_count BETWEEN 1 AND 65536)');
    expect(sql).toContain('CHECK (source_chunk_count BETWEEN 1 AND 262144)');
    expect(sql).toContain('CHECK (reconciliation_generation >= 0)');
    expect(sql).toContain('CHECK (reconciliation_generation > 0)');
    expect(normalized).toContain(
      'published_reconciliation_generation >= 0 AND published_reconciliation_generation <= reconciliation_generation'
    );
    expect(sql).toContain('CHECK (case_count BETWEEN 3 AND 64)');
    expect(normalized).toContain(
      'exact_scope_case_count + relevant_case_count + complete_scope_case_count = case_count'
    );
    expect(normalized).toContain(
      'cursor_continuation_case_count BETWEEN 1 AND complete_scope_case_count'
    );
    expect(sql).toContain(
      'CHECK (monolith_request_count BETWEEN case_count AND 262144)'
    );
    expect(sql).toContain(
      'CHECK (partition_request_count BETWEEN case_count AND 262144)'
    );
    expect(sql).toContain(
      'CHECK (citation_count BETWEEN case_count AND 2000000)'
    );
    for (const passedColumn of [
      'shadow_comparison_completed',
      'exact_scope_parity_passed',
      'relevant_retrieval_parity_passed',
      'complete_scope_parity_passed',
      'cursor_stability_passed',
    ]) {
      expect(sql).toContain(`CHECK (${passedColumn})`);
    }
    expect(sql).toContain('CHECK (source_verified_at <= validated_at)');
    expect(sql).toContain(
      'CHECK (rollback_validation_verified_at <= validated_at)'
    );
    expect(sql).toContain(
      'CHECK (rollback_validation_valid_until > validated_at)'
    );
    expect(normalized).toContain(
      "rollback_validation_valid_until <= rollback_validation_verified_at + INTERVAL '7 days'"
    );
    expect(sql).toContain('CHECK (expires_at > validated_at)');
    expect(sql).toContain(
      'CHECK (expires_at <= rollback_validation_valid_until)'
    );
    expect(sql).toContain(
      "CHECK (expires_at <= validated_at + INTERVAL '24 hours')"
    );
    expect(sql).toContain('CHECK (pg_catalog.isfinite(source_verified_at))');
    expect(sql).toContain('CHECK (pg_catalog.isfinite(validated_at))');
    expect(sql).toContain('CHECK (pg_catalog.isfinite(expires_at))');
  });

  test('rollback refuses populated evidence before dropping the table', () => {
    const existenceGuard = rollbackMigration.indexOf(
      "pg_catalog.to_regclass(\n    'public.backstage_notion_partition_cutover_evidence'"
    );
    const populatedGuard = rollbackMigration.indexOf(
      'SELECT 1\n    FROM public.backstage_notion_partition_cutover_evidence'
    );
    const refusal = rollbackMigration.indexOf("ERRCODE = '55000'");
    const drop = rollbackMigration.indexOf(
      'DROP TABLE IF EXISTS public.backstage_notion_partition_cutover_evidence'
    );

    expect(existenceGuard).toBeGreaterThanOrEqual(0);
    expect(populatedGuard).toBeGreaterThan(existenceGuard);
    expect(refusal).toBeGreaterThan(populatedGuard);
    expect(drop).toBeGreaterThan(refusal);
    expect(rollbackMigration).toContain(
      'cutover evidence rollback refused because verified evidence exists'
    );
    expect(rollbackMigration).not.toContain('CASCADE');
    expect(rollbackMigration.trim().startsWith('BEGIN;')).toBe(true);
    expect(rollbackMigration.trim().endsWith('COMMIT;')).toBe(true);
  });
});
