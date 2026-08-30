BEGIN;

ALTER TABLE public.backstage_notion_partitioned_universe_heads
  ADD COLUMN IF NOT EXISTS reconciliation_generation BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS published_reconciliation_generation
    BIGINT NOT NULL DEFAULT 0;

DO $block$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint
    WHERE conrelid =
      'public.backstage_notion_partitioned_universe_heads'::pg_catalog.regclass
      AND conname =
        'backstage_notion_partitioned_universe_heads_reconciliation_generation_check'
  ) THEN
    ALTER TABLE public.backstage_notion_partitioned_universe_heads
      ADD CONSTRAINT
        backstage_notion_partitioned_universe_heads_reconciliation_generation_check
      CHECK (reconciliation_generation >= 0);
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint
    WHERE conrelid =
      'public.backstage_notion_partitioned_universe_heads'::pg_catalog.regclass
      AND conname =
        'backstage_notion_partitioned_universe_heads_published_reconciliation_check'
  ) THEN
    ALTER TABLE public.backstage_notion_partitioned_universe_heads
      ADD CONSTRAINT
        backstage_notion_partitioned_universe_heads_published_reconciliation_check
      CHECK (
        published_reconciliation_generation >= 0
        AND published_reconciliation_generation <= reconciliation_generation
      );
  END IF;
END;
$block$;

CREATE TABLE IF NOT EXISTS public.backstage_notion_partition_cutover_evidence (
  universe_id TEXT PRIMARY KEY,
  evidence_version INTEGER NOT NULL,
  manifest_id UUID NOT NULL,
  partition_configuration_version_id UUID NOT NULL,
  configuration_hash TEXT NOT NULL,
  source_generation_id UUID NOT NULL,
  source_digest TEXT NOT NULL,
  source_page_count INTEGER NOT NULL,
  source_chunk_count INTEGER NOT NULL,
  source_verified_at TIMESTAMPTZ NOT NULL,
  source_verification_hash TEXT NOT NULL,
  reconciliation_generation BIGINT NOT NULL,
  rollback_monolith_snapshot_id UUID NOT NULL,
  rollback_validation_verified_at TIMESTAMPTZ NOT NULL,
  rollback_validation_valid_until TIMESTAMPTZ NOT NULL,
  case_count INTEGER NOT NULL,
  exact_scope_case_count INTEGER NOT NULL,
  relevant_case_count INTEGER NOT NULL,
  complete_scope_case_count INTEGER NOT NULL,
  cursor_continuation_case_count INTEGER NOT NULL,
  monolith_request_count INTEGER NOT NULL,
  partition_request_count INTEGER NOT NULL,
  citation_count INTEGER NOT NULL,
  shadow_comparison_completed BOOLEAN NOT NULL,
  exact_scope_parity_passed BOOLEAN NOT NULL,
  relevant_retrieval_parity_passed BOOLEAN NOT NULL,
  complete_scope_parity_passed BOOLEAN NOT NULL,
  cursor_stability_passed BOOLEAN NOT NULL,
  attestation_digest TEXT NOT NULL,
  validated_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (universe_id, manifest_id),
  FOREIGN KEY (universe_id, manifest_id, partition_configuration_version_id)
    REFERENCES public.backstage_notion_universe_manifests(
      universe_id,
      id,
      partition_configuration_version_id
    )
    ON UPDATE RESTRICT
    ON DELETE RESTRICT,
  FOREIGN KEY (
    universe_id,
    source_generation_id,
    partition_configuration_version_id,
    source_digest,
    source_page_count,
    source_chunk_count,
    source_verified_at,
    source_verification_hash
  )
    REFERENCES public.backstage_notion_partition_source_generations(
      universe_id,
      source_generation_id,
      partition_configuration_version_id,
      source_digest,
      source_page_count,
      source_chunk_count,
      source_verified_at,
      source_verification_hash
    )
    ON UPDATE RESTRICT
    ON DELETE RESTRICT,
  FOREIGN KEY (universe_id, rollback_monolith_snapshot_id)
    REFERENCES public.backstage_notion_snapshots(universe_id, id)
    ON UPDATE RESTRICT
    ON DELETE RESTRICT,
  CHECK (evidence_version = 1),
  CHECK (configuration_hash ~ '^[0-9a-f]{64}$'),
  CHECK (source_digest ~ '^[0-9a-f]{64}$'),
  CHECK (source_page_count BETWEEN 1 AND 65536),
  CHECK (source_chunk_count BETWEEN 1 AND 262144),
  CHECK (source_verification_hash ~ '^[0-9a-f]{64}$'),
  CHECK (reconciliation_generation > 0),
  CHECK (case_count BETWEEN 3 AND 64),
  CHECK (exact_scope_case_count BETWEEN 1 AND case_count),
  CHECK (relevant_case_count BETWEEN 1 AND case_count),
  CHECK (complete_scope_case_count BETWEEN 1 AND case_count),
  CHECK (
    exact_scope_case_count
      + relevant_case_count
      + complete_scope_case_count = case_count
  ),
  CHECK (
    cursor_continuation_case_count
      BETWEEN 1 AND complete_scope_case_count
  ),
  CHECK (monolith_request_count BETWEEN case_count AND 262144),
  CHECK (partition_request_count BETWEEN case_count AND 262144),
  CHECK (citation_count BETWEEN case_count AND 2000000),
  CHECK (shadow_comparison_completed),
  CHECK (exact_scope_parity_passed),
  CHECK (relevant_retrieval_parity_passed),
  CHECK (complete_scope_parity_passed),
  CHECK (cursor_stability_passed),
  CHECK (attestation_digest ~ '^[0-9a-f]{64}$'),
  CHECK (pg_catalog.isfinite(source_verified_at)),
  CHECK (pg_catalog.isfinite(validated_at)),
  CHECK (pg_catalog.isfinite(expires_at)),
  CHECK (pg_catalog.isfinite(created_at)),
  CHECK (pg_catalog.isfinite(updated_at)),
  CHECK (validated_at <= updated_at),
  CHECK (created_at <= updated_at),
  CHECK (source_verified_at <= validated_at),
  CHECK (rollback_validation_verified_at <= validated_at),
  CHECK (rollback_validation_valid_until > validated_at),
  CHECK (
    rollback_validation_valid_until
      <= rollback_validation_verified_at + INTERVAL '7 days'
  ),
  CHECK (expires_at > validated_at),
  CHECK (expires_at <= rollback_validation_valid_until),
  CHECK (expires_at <= validated_at + INTERVAL '24 hours')
);

CREATE INDEX IF NOT EXISTS backstage_notion_partition_cutover_evidence_manifest_idx
  ON public.backstage_notion_partition_cutover_evidence (
    universe_id,
    manifest_id,
    partition_configuration_version_id,
    expires_at
  );

COMMIT;
