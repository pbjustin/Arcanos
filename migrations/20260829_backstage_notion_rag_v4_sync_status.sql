BEGIN;

CREATE TABLE IF NOT EXISTS public.backstage_notion_latest_sync_attempts (
  universe_id TEXT PRIMARY KEY,
  attempt_id UUID NOT NULL UNIQUE,
  attempt_generation BIGINT NOT NULL,
  started_at TIMESTAMPTZ NOT NULL,
  completed_at TIMESTAMPTZ,
  outcome TEXT NOT NULL,
  failure_phase TEXT,
  failure_reason TEXT,
  pages_discovered INTEGER NOT NULL DEFAULT 0,
  pages_fetched INTEGER NOT NULL DEFAULT 0,
  blocks_fetched INTEGER NOT NULL DEFAULT 0,
  chunks_produced INTEGER NOT NULL DEFAULT 0,
  chunks_embedded INTEGER NOT NULL DEFAULT 0,
  candidate_snapshot_created BOOLEAN NOT NULL DEFAULT FALSE,
  candidate_snapshot_validated BOOLEAN NOT NULL DEFAULT FALSE,
  candidate_snapshot_activated BOOLEAN NOT NULL DEFAULT FALSE,
  activated_snapshot_id UUID,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT fk_backstage_notion_latest_sync_attempts_head
    FOREIGN KEY (universe_id)
    REFERENCES public.backstage_notion_universe_heads(universe_id)
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT fk_backstage_notion_latest_sync_attempts_snapshot
    FOREIGN KEY (universe_id, activated_snapshot_id)
    REFERENCES public.backstage_notion_snapshots(universe_id, id)
    ON DELETE RESTRICT ON UPDATE RESTRICT
    DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT ck_backstage_notion_latest_sync_attempts_generation
    CHECK (attempt_generation > 0),
  CONSTRAINT ck_backstage_notion_latest_sync_attempts_times
    CHECK (
      isfinite(started_at)
      AND isfinite(updated_at)
      AND (completed_at IS NULL OR (
        isfinite(completed_at)
        AND completed_at >= started_at
      ))
    ),
  CONSTRAINT ck_backstage_notion_latest_sync_attempts_outcome
    CHECK (outcome IN ('running', 'activated', 'unchanged', 'failed')),
  CONSTRAINT ck_backstage_notion_latest_sync_attempts_failure_phase
    CHECK (failure_phase IS NULL OR failure_phase IN (
      'authorization', 'root_resolution', 'discovery', 'page_fetch',
      'block_fetch', 'pagination', 'normalization', 'chunking', 'embedding',
      'persistence', 'completeness_validation', 'activation', 'cleanup',
      'deadline', 'lease'
    )),
  CONSTRAINT ck_backstage_notion_latest_sync_attempts_failure_reason
    CHECK (failure_reason IS NULL OR failure_reason IN (
      'deadline_exhausted', 'rate_limit_exhausted',
      'transient_retry_exhausted', 'permanent_notion_error',
      'inaccessible_page', 'pagination_incomplete',
      'discovered_page_missing', 'source_changed', 'chunk_limit_reached',
      'embedding_failed', 'persistence_failed', 'completeness_mismatch',
      'activation_failed', 'lease_lost', 'invalid_configuration',
      'unexpected_failure'
    )),
  CONSTRAINT ck_backstage_notion_latest_sync_attempts_counts
    CHECK (
      pages_discovered BETWEEN 0 AND 1000000
      AND pages_fetched BETWEEN 0 AND 1000000
      AND blocks_fetched BETWEEN 0 AND 1000000
      AND chunks_produced BETWEEN 0 AND 1000000
      AND chunks_embedded BETWEEN 0 AND 1000000
    ),
  CONSTRAINT ck_backstage_notion_latest_sync_attempts_state
    CHECK (
      (
        outcome = 'running'
        AND completed_at IS NULL
        AND failure_phase IS NULL
        AND failure_reason IS NULL
        AND activated_snapshot_id IS NULL
        AND NOT candidate_snapshot_created
        AND NOT candidate_snapshot_validated
        AND NOT candidate_snapshot_activated
      )
      OR (
        outcome = 'failed'
        AND completed_at IS NOT NULL
        AND failure_phase IS NOT NULL
        AND failure_reason IS NOT NULL
        AND activated_snapshot_id IS NULL
        AND NOT candidate_snapshot_activated
      )
      OR (
        outcome = 'activated'
        AND completed_at IS NOT NULL
        AND failure_phase IS NULL
        AND failure_reason IS NULL
        AND activated_snapshot_id IS NOT NULL
        AND candidate_snapshot_created
        AND candidate_snapshot_validated
        AND candidate_snapshot_activated
      )
      OR (
        outcome = 'unchanged'
        AND completed_at IS NOT NULL
        AND failure_phase IS NULL
        AND failure_reason IS NULL
        AND activated_snapshot_id IS NOT NULL
        AND NOT candidate_snapshot_created
        AND NOT candidate_snapshot_validated
        AND NOT candidate_snapshot_activated
      )
    )
);

COMMIT;
