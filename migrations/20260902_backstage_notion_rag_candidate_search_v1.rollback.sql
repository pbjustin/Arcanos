-- Conservative compensation for the derived monolith candidate-search sidecar.
-- Canonical snapshots/chunks are not changed by this rollback. Roll back the
-- application reader/writer before applying it.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

DROP TRIGGER IF EXISTS trg_backstage_notion_immutable
  ON public.backstage_notion_snapshot_chunk_search;
DROP TABLE IF EXISTS public.backstage_notion_snapshot_chunk_search;
DROP FUNCTION IF EXISTS public.backstage_notion_candidate_brand_mask(
  TEXT, JSONB, JSONB, TEXT
);
DROP FUNCTION IF EXISTS public.backstage_notion_candidate_search_vector(
  TEXT, TEXT, JSONB, JSONB, TEXT
);
DROP FUNCTION IF EXISTS public.backstage_notion_candidate_embedding_norm(
  DOUBLE PRECISION[]
);
DROP FUNCTION IF EXISTS public.backstage_notion_candidate_embedding_from_jsonb(
  JSONB
);

COMMIT;
