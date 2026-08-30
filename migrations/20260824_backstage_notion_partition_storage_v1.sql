BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

CREATE OR REPLACE FUNCTION public.backstage_notion_partition_tags_are_valid(
  tags JSONB
)
RETURNS BOOLEAN
LANGUAGE SQL
IMMUTABLE
STRICT
SET search_path = pg_catalog, public
AS $function$
  SELECT CASE
    WHEN pg_catalog.jsonb_typeof(tags) <> 'array' THEN FALSE
    WHEN pg_catalog.jsonb_array_length(tags) > 32 THEN FALSE
    WHEN pg_catalog.octet_length(tags::TEXT) > 8192 THEN FALSE
    ELSE
      NOT EXISTS (
        SELECT 1
        FROM pg_catalog.jsonb_array_elements(tags) AS entry(value)
        WHERE pg_catalog.jsonb_typeof(entry.value) <> 'string'
           OR (entry.value #>> '{}') !~ '^[a-z0-9][a-z0-9._:/-]{0,63}$'
      )
      AND (
        SELECT pg_catalog.count(*) = pg_catalog.count(DISTINCT entry.value)
        FROM pg_catalog.jsonb_array_elements_text(tags) AS entry(value)
      )
  END;
$function$;

CREATE OR REPLACE FUNCTION public.backstage_notion_embedding_values_are_valid(
  embedding DOUBLE PRECISION[],
  expected_dimension INTEGER,
  expected_norm DOUBLE PRECISION
)
RETURNS BOOLEAN
LANGUAGE plpgsql
IMMUTABLE
STRICT
SET search_path = pg_catalog, public
AS $function$
DECLARE
  coordinate DOUBLE PRECISION;
  squared_norm NUMERIC := 0;
  recomputed_norm DOUBLE PRECISION;
BEGIN
  IF expected_dimension NOT BETWEEN 1 AND 8192
     OR pg_catalog.array_ndims(embedding) <> 1
     OR pg_catalog.array_lower(embedding, 1) <> 1
     OR pg_catalog.cardinality(embedding) <> expected_dimension
     OR expected_norm <= 0
     OR expected_norm >= 'Infinity'::DOUBLE PRECISION
     OR expected_norm = 'NaN'::DOUBLE PRECISION THEN
    RETURN FALSE;
  END IF;

  FOREACH coordinate IN ARRAY embedding LOOP
    IF coordinate IS NULL
       OR coordinate <= '-Infinity'::DOUBLE PRECISION
       OR coordinate >= 'Infinity'::DOUBLE PRECISION
       OR coordinate = 'NaN'::DOUBLE PRECISION THEN
      RETURN FALSE;
    END IF;
    squared_norm := squared_norm + (coordinate::NUMERIC * coordinate::NUMERIC);
  END LOOP;

  IF squared_norm <= 0 THEN
    RETURN FALSE;
  END IF;

  recomputed_norm := pg_catalog.sqrt(squared_norm)::DOUBLE PRECISION;
  RETURN pg_catalog.abs(recomputed_norm - expected_norm)
    <= GREATEST(1e-12::DOUBLE PRECISION, recomputed_norm * 1e-9);
END;
$function$;

CREATE OR REPLACE FUNCTION public.backstage_notion_scope_key_array_is_valid(
  keys JSONB,
  expected_length INTEGER
)
RETURNS BOOLEAN
LANGUAGE SQL
IMMUTABLE
STRICT
SET search_path = pg_catalog, public
AS $function$
  SELECT CASE
    WHEN expected_length NOT BETWEEN 0 AND 32 THEN FALSE
    WHEN pg_catalog.jsonb_typeof(keys) <> 'array' THEN FALSE
    WHEN pg_catalog.jsonb_array_length(keys) <> expected_length THEN FALSE
    WHEN pg_catalog.octet_length(keys::TEXT) > 8192 THEN FALSE
    ELSE NOT EXISTS (
      SELECT 1
      FROM pg_catalog.jsonb_array_elements(keys) AS entry(value)
      WHERE pg_catalog.jsonb_typeof(entry.value) <> 'string'
         OR (entry.value #>> '{}') !~ '^[0-9a-f]{64}$'
    )
  END;
$function$;

CREATE OR REPLACE FUNCTION public.backstage_notion_page_scope_metadata_is_valid(
  title TEXT,
  depth INTEGER,
  scope_path JSONB,
  scope_title_key TEXT,
  scope_path_key JSONB
)
RETURNS BOOLEAN
LANGUAGE SQL
IMMUTABLE
STRICT
SET search_path = pg_catalog, public
AS $function$
  SELECT CASE
    WHEN depth NOT BETWEEN 0 AND 16 THEN FALSE
    WHEN scope_title_key !~ '^[0-9a-f]{64}$' THEN FALSE
    WHEN pg_catalog.jsonb_typeof(scope_path) <> 'array' THEN FALSE
    WHEN pg_catalog.jsonb_array_length(scope_path) <> depth + 1 THEN FALSE
    WHEN pg_catalog.octet_length(scope_path::TEXT) > 16384 THEN FALSE
    WHEN scope_path ->> depth IS DISTINCT FROM title THEN FALSE
    WHEN NOT public.backstage_notion_scope_key_array_is_valid(
      scope_path_key,
      depth + 1
    ) THEN FALSE
    WHEN scope_path_key ->> depth IS DISTINCT FROM scope_title_key THEN FALSE
    ELSE NOT EXISTS (
      SELECT 1
      FROM pg_catalog.jsonb_array_elements(scope_path) AS entry(value)
      WHERE pg_catalog.jsonb_typeof(entry.value) <> 'string'
         OR pg_catalog.length(pg_catalog.btrim(entry.value #>> '{}')) NOT BETWEEN 1 AND 500
    )
  END;
$function$;

CREATE OR REPLACE FUNCTION public.backstage_notion_heading_occurrence_path_is_valid(
  occurrence_path JSONB,
  expected_length INTEGER
)
RETURNS BOOLEAN
LANGUAGE SQL
IMMUTABLE
STRICT
SET search_path = pg_catalog, public
AS $function$
  SELECT CASE
    WHEN expected_length NOT BETWEEN 0 AND 32 THEN FALSE
    WHEN pg_catalog.jsonb_typeof(occurrence_path) <> 'array' THEN FALSE
    WHEN pg_catalog.jsonb_array_length(occurrence_path) <> expected_length THEN FALSE
    WHEN pg_catalog.octet_length(occurrence_path::TEXT) > 1024 THEN FALSE
    ELSE NOT EXISTS (
      SELECT 1
      FROM pg_catalog.jsonb_array_elements(occurrence_path) AS entry(value)
      WHERE CASE
        WHEN pg_catalog.jsonb_typeof(entry.value) <> 'number' THEN TRUE
        WHEN (entry.value #>> '{}') !~ '^(0|[1-9][0-9]{0,3})$' THEN TRUE
        ELSE (entry.value #>> '{}')::INTEGER > 2048
      END
    )
  END;
$function$;

CREATE TABLE IF NOT EXISTS public.backstage_notion_partition_configuration_versions (
  id UUID PRIMARY KEY,
  universe_id TEXT NOT NULL,
  configuration_generation TEXT NOT NULL,
  configuration_hash TEXT NOT NULL,
  shard_count INTEGER NOT NULL,
  state TEXT NOT NULL DEFAULT 'building',
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  sealed_at TIMESTAMPTZ,
  UNIQUE (universe_id, id),
  UNIQUE (universe_id, id, configuration_generation),
  UNIQUE (universe_id, configuration_generation),
  UNIQUE (universe_id, id, configuration_generation, configuration_hash),
  FOREIGN KEY (universe_id)
    REFERENCES public.backstage_notion_universe_heads(universe_id)
    ON UPDATE RESTRICT
    ON DELETE RESTRICT,
  CHECK (configuration_generation ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
  CHECK (configuration_hash ~ '^[0-9a-f]{64}$'),
  CHECK (shard_count BETWEEN 1 AND 512),
  CHECK (state IN ('building', 'sealed')),
  CHECK (
    (state = 'building' AND sealed_at IS NULL)
    OR (state = 'sealed' AND sealed_at IS NOT NULL)
  ),
  CHECK (pg_catalog.isfinite(created_at)),
  CHECK (sealed_at IS NULL OR pg_catalog.isfinite(sealed_at))
);

CREATE TABLE IF NOT EXISTS public.backstage_notion_partition_identities (
  universe_id TEXT NOT NULL,
  shard_key TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (universe_id, shard_key),
  FOREIGN KEY (universe_id)
    REFERENCES public.backstage_notion_universe_heads(universe_id)
    ON UPDATE RESTRICT
    ON DELETE RESTRICT,
  CHECK (universe_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
  CHECK (shard_key ~ '^[a-z0-9][a-z0-9._:/-]{0,127}$'),
  CHECK (pg_catalog.isfinite(created_at))
);

CREATE TABLE IF NOT EXISTS public.backstage_notion_partition_versions (
  id UUID PRIMARY KEY,
  universe_id TEXT NOT NULL,
  shard_key TEXT NOT NULL,
  configuration_version INTEGER NOT NULL DEFAULT 1,
  root_page_id UUID NOT NULL,
  display_name TEXT NOT NULL,
  retrieval_tier TEXT NOT NULL,
  is_required BOOLEAN NOT NULL,
  scope_tags JSONB NOT NULL DEFAULT '[]'::JSONB,
  category_tags JSONB NOT NULL DEFAULT '[]'::JSONB,
  max_pages INTEGER NOT NULL,
  max_chunks INTEGER NOT NULL,
  max_depth INTEGER NOT NULL,
  max_content_code_points INTEGER NOT NULL,
  semantic_hash TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (universe_id, shard_key, id),
  UNIQUE (universe_id, shard_key, semantic_hash),
  UNIQUE (universe_id, shard_key, id, root_page_id),
  FOREIGN KEY (universe_id, shard_key)
    REFERENCES public.backstage_notion_partition_identities(universe_id, shard_key)
    ON UPDATE RESTRICT
    ON DELETE RESTRICT,
  CHECK (configuration_version = 1),
  CHECK (pg_catalog.length(display_name) BETWEEN 1 AND 200),
  CHECK (retrieval_tier IN ('hot', 'cold', 'archive')),
  CHECK (public.backstage_notion_partition_tags_are_valid(scope_tags)),
  CHECK (public.backstage_notion_partition_tags_are_valid(category_tags)),
  CHECK (max_pages BETWEEN 1 AND 512),
  CHECK (max_chunks BETWEEN 1 AND 2048),
  CHECK (max_depth BETWEEN 0 AND 16),
  CHECK (max_content_code_points BETWEEN 1 AND 4000000),
  CHECK (semantic_hash ~ '^[0-9a-f]{64}$'),
  CHECK (pg_catalog.isfinite(created_at))
);

CREATE TABLE IF NOT EXISTS public.backstage_notion_partition_configuration_members (
  universe_id TEXT NOT NULL,
  partition_configuration_version_id UUID NOT NULL,
  configuration_generation TEXT NOT NULL,
  shard_key TEXT NOT NULL,
  partition_version_id UUID NOT NULL,
  root_page_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (universe_id, partition_configuration_version_id, shard_key),
  UNIQUE (universe_id, partition_configuration_version_id, partition_version_id),
  UNIQUE (universe_id, partition_configuration_version_id, root_page_id),
  FOREIGN KEY (
    universe_id,
    partition_configuration_version_id,
    configuration_generation
  ) REFERENCES public.backstage_notion_partition_configuration_versions(
    universe_id,
    id,
    configuration_generation
  ) ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY (universe_id, shard_key, partition_version_id, root_page_id)
    REFERENCES public.backstage_notion_partition_versions(
      universe_id,
      shard_key,
      id,
      root_page_id
    )
    ON UPDATE RESTRICT
    ON DELETE RESTRICT,
  CHECK (configuration_generation ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
  CHECK (pg_catalog.isfinite(created_at))
);

CREATE TABLE IF NOT EXISTS public.backstage_notion_chunk_versions (
  id UUID PRIMARY KEY,
  universe_id TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  chunker_version INTEGER NOT NULL,
  content TEXT NOT NULL,
  content_code_points INTEGER NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (universe_id, id),
  UNIQUE (universe_id, content_hash, chunker_version),
  FOREIGN KEY (universe_id)
    REFERENCES public.backstage_notion_universe_heads(universe_id)
    ON UPDATE RESTRICT
    ON DELETE RESTRICT,
  CHECK (content_hash ~ '^[0-9a-f]{64}$'),
  CHECK (chunker_version > 0),
  CHECK (pg_catalog.length(content) BETWEEN 1 AND 20000),
  CHECK (content_code_points BETWEEN 1 AND 20000),
  CHECK (content_code_points = pg_catalog.char_length(content)),
  CHECK (pg_catalog.isfinite(created_at))
);

CREATE TABLE IF NOT EXISTS public.backstage_notion_chunk_embeddings (
  universe_id TEXT NOT NULL,
  chunk_version_id UUID NOT NULL,
  embedding_model TEXT NOT NULL,
  embedding_version INTEGER NOT NULL,
  embedding_dimension INTEGER NOT NULL,
  embedding_norm DOUBLE PRECISION NOT NULL,
  embedding DOUBLE PRECISION[] NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (universe_id, chunk_version_id, embedding_model, embedding_version),
  FOREIGN KEY (universe_id, chunk_version_id)
    REFERENCES public.backstage_notion_chunk_versions(universe_id, id)
    ON UPDATE RESTRICT
    ON DELETE RESTRICT,
  CHECK (pg_catalog.length(embedding_model) BETWEEN 1 AND 200),
  CHECK (embedding_version > 0),
  CHECK (embedding_dimension BETWEEN 1 AND 8192),
  CHECK (
    embedding_norm > 0
    AND embedding_norm < 'Infinity'::DOUBLE PRECISION
    AND embedding_norm <> 'NaN'::DOUBLE PRECISION
  ),
  CHECK (
    public.backstage_notion_embedding_values_are_valid(
      embedding,
      embedding_dimension,
      embedding_norm
    )
  ),
  CHECK (pg_catalog.isfinite(created_at))
);

CREATE TABLE IF NOT EXISTS public.backstage_notion_page_versions (
  id UUID PRIMARY KEY,
  universe_id TEXT NOT NULL,
  page_id UUID NOT NULL,
  content_hash TEXT NOT NULL,
  page_format_version INTEGER NOT NULL,
  chunker_version INTEGER NOT NULL,
  markdown TEXT NOT NULL,
  content_code_points INTEGER NOT NULL,
  chunk_count INTEGER NOT NULL,
  state TEXT NOT NULL DEFAULT 'building',
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  sealed_at TIMESTAMPTZ,
  UNIQUE (universe_id, id),
  UNIQUE (universe_id, id, page_id),
  UNIQUE (
    universe_id,
    page_id,
    content_hash,
    page_format_version,
    chunker_version
  ),
  FOREIGN KEY (universe_id)
    REFERENCES public.backstage_notion_universe_heads(universe_id)
    ON UPDATE RESTRICT
    ON DELETE RESTRICT,
  CHECK (content_hash ~ '^[0-9a-f]{64}$'),
  CHECK (page_format_version > 0),
  CHECK (chunker_version > 0),
  CHECK (content_code_points BETWEEN 0 AND 4000000),
  CHECK (content_code_points = pg_catalog.char_length(markdown)),
  CHECK (chunk_count BETWEEN 0 AND 2048),
  CHECK (state IN ('building', 'sealed')),
  CHECK (
    (state = 'building' AND sealed_at IS NULL)
    OR (state = 'sealed' AND sealed_at IS NOT NULL)
  ),
  CHECK (pg_catalog.isfinite(created_at)),
  CHECK (sealed_at IS NULL OR pg_catalog.isfinite(sealed_at))
);

CREATE TABLE IF NOT EXISTS public.backstage_notion_page_version_chunks (
  universe_id TEXT NOT NULL,
  page_version_id UUID NOT NULL,
  ordinal INTEGER NOT NULL,
  chunk_version_id UUID NOT NULL,
  heading_path JSONB NOT NULL DEFAULT '[]'::JSONB,
  scope_heading_path_key JSONB NOT NULL DEFAULT '[]'::JSONB,
  heading_occurrence_path JSONB NOT NULL DEFAULT '[]'::JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (universe_id, page_version_id, ordinal),
  UNIQUE (universe_id, page_version_id, ordinal, chunk_version_id),
  FOREIGN KEY (universe_id, page_version_id)
    REFERENCES public.backstage_notion_page_versions(universe_id, id)
    ON UPDATE RESTRICT
    ON DELETE RESTRICT,
  FOREIGN KEY (universe_id, chunk_version_id)
    REFERENCES public.backstage_notion_chunk_versions(universe_id, id)
    ON UPDATE RESTRICT
    ON DELETE RESTRICT,
  CHECK (ordinal >= 0),
  CHECK (pg_catalog.jsonb_typeof(heading_path) = 'array'),
  CHECK (pg_catalog.jsonb_array_length(heading_path) <= 32),
  CHECK (pg_catalog.octet_length(heading_path::TEXT) <= 8192),
  CHECK (
    public.backstage_notion_scope_key_array_is_valid(
      scope_heading_path_key,
      pg_catalog.jsonb_array_length(heading_path)
    )
  ),
  CHECK (
    public.backstage_notion_heading_occurrence_path_is_valid(
      heading_occurrence_path,
      pg_catalog.jsonb_array_length(heading_path)
    )
  ),
  CHECK (pg_catalog.isfinite(created_at))
);

CREATE TABLE IF NOT EXISTS public.backstage_notion_shard_snapshots (
  id UUID PRIMARY KEY,
  universe_id TEXT NOT NULL,
  shard_key TEXT NOT NULL,
  partition_version_id UUID NOT NULL,
  root_page_id UUID NOT NULL,
  source_generation_id UUID NOT NULL,
  source_manifest_hash TEXT NOT NULL,
  embedding_model TEXT NOT NULL,
  embedding_version INTEGER NOT NULL,
  embedding_dimension INTEGER NOT NULL,
  index_format_version INTEGER NOT NULL,
  page_count INTEGER NOT NULL,
  chunk_count INTEGER NOT NULL,
  content_code_points INTEGER NOT NULL,
  max_depth INTEGER NOT NULL,
  source_max_last_edited_at TIMESTAMPTZ NOT NULL,
  verification_count INTEGER NOT NULL,
  state TEXT NOT NULL DEFAULT 'building',
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  sealed_at TIMESTAMPTZ,
  UNIQUE (universe_id, shard_key, id),
  UNIQUE (universe_id, shard_key, partition_version_id, id),
  UNIQUE (universe_id, shard_key, partition_version_id, root_page_id, id),
  FOREIGN KEY (universe_id, shard_key, partition_version_id, root_page_id)
    REFERENCES public.backstage_notion_partition_versions(
      universe_id,
      shard_key,
      id,
      root_page_id
    )
    ON UPDATE RESTRICT
    ON DELETE RESTRICT,
  CHECK (source_manifest_hash ~ '^[0-9a-f]{64}$'),
  CHECK (pg_catalog.length(embedding_model) BETWEEN 1 AND 200),
  CHECK (embedding_version > 0),
  CHECK (embedding_dimension BETWEEN 1 AND 8192),
  CHECK (index_format_version > 0),
  CHECK (page_count BETWEEN 1 AND 512),
  CHECK (chunk_count BETWEEN 1 AND 2048),
  CHECK (content_code_points BETWEEN 1 AND 4000000),
  CHECK (max_depth BETWEEN 0 AND 16),
  CHECK (verification_count BETWEEN 2 AND 3),
  CHECK (state IN ('building', 'sealed')),
  CHECK (
    (state = 'building' AND sealed_at IS NULL)
    OR (state = 'sealed' AND sealed_at IS NOT NULL)
  ),
  CHECK (pg_catalog.isfinite(source_max_last_edited_at)),
  CHECK (pg_catalog.isfinite(created_at)),
  CHECK (sealed_at IS NULL OR pg_catalog.isfinite(sealed_at))
);

-- Existing storage-v1 installations gain a nullable historical column. New
-- snapshots cannot seal without an explicit reconciliation generation.
ALTER TABLE public.backstage_notion_shard_snapshots
  ADD COLUMN IF NOT EXISTS source_generation_id UUID;

CREATE TABLE IF NOT EXISTS public.backstage_notion_shard_snapshot_pages (
  universe_id TEXT NOT NULL,
  shard_key TEXT NOT NULL,
  shard_snapshot_id UUID NOT NULL,
  page_id UUID NOT NULL,
  page_version_id UUID NOT NULL,
  parent_page_id UUID,
  title TEXT NOT NULL,
  canonical_url TEXT NOT NULL,
  source_last_edited_at TIMESTAMPTZ NOT NULL,
  depth INTEGER NOT NULL,
  path JSONB NOT NULL,
  scope_path JSONB NOT NULL,
  scope_title_key TEXT NOT NULL,
  scope_path_key JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (universe_id, shard_key, shard_snapshot_id, page_id),
  UNIQUE (
    universe_id,
    shard_key,
    shard_snapshot_id,
    page_id,
    page_version_id
  ),
  FOREIGN KEY (universe_id, shard_key, shard_snapshot_id)
    REFERENCES public.backstage_notion_shard_snapshots(universe_id, shard_key, id)
    ON UPDATE RESTRICT
    ON DELETE RESTRICT,
  FOREIGN KEY (universe_id, page_version_id, page_id)
    REFERENCES public.backstage_notion_page_versions(universe_id, id, page_id)
    ON UPDATE RESTRICT
    ON DELETE RESTRICT,
  FOREIGN KEY (universe_id, shard_key, shard_snapshot_id, parent_page_id)
    REFERENCES public.backstage_notion_shard_snapshot_pages(
      universe_id,
      shard_key,
      shard_snapshot_id,
      page_id
    )
    ON UPDATE RESTRICT
    ON DELETE RESTRICT
    DEFERRABLE INITIALLY DEFERRED,
  CHECK (pg_catalog.length(title) BETWEEN 1 AND 500),
  CHECK (pg_catalog.length(canonical_url) BETWEEN 1 AND 2048),
  CHECK (depth BETWEEN 0 AND 16),
  CHECK (pg_catalog.jsonb_typeof(path) = 'array'),
  CHECK (pg_catalog.jsonb_array_length(path) = depth + 1),
  CHECK (pg_catalog.octet_length(path::TEXT) <= 16384),
  CHECK (
    public.backstage_notion_page_scope_metadata_is_valid(
      title,
      depth,
      scope_path,
      scope_title_key,
      scope_path_key
    )
  ),
  CHECK (pg_catalog.isfinite(source_last_edited_at)),
  CHECK (pg_catalog.isfinite(created_at))
);

CREATE TABLE IF NOT EXISTS public.backstage_notion_shard_snapshot_chunk_occurrences (
  universe_id TEXT NOT NULL,
  shard_key TEXT NOT NULL,
  shard_snapshot_id UUID NOT NULL,
  page_id UUID NOT NULL,
  page_version_id UUID NOT NULL,
  ordinal INTEGER NOT NULL,
  chunk_version_id UUID NOT NULL,
  embedding_model TEXT NOT NULL,
  embedding_version INTEGER NOT NULL,
  category TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (
    universe_id,
    shard_key,
    shard_snapshot_id,
    page_id,
    ordinal
  ),
  FOREIGN KEY (
    universe_id,
    shard_key,
    shard_snapshot_id,
    page_id,
    page_version_id
  ) REFERENCES public.backstage_notion_shard_snapshot_pages(
    universe_id,
    shard_key,
    shard_snapshot_id,
    page_id,
    page_version_id
  ) ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY (
    universe_id,
    page_version_id,
    ordinal,
    chunk_version_id
  ) REFERENCES public.backstage_notion_page_version_chunks(
    universe_id,
    page_version_id,
    ordinal,
    chunk_version_id
  ) ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY (
    universe_id,
    chunk_version_id,
    embedding_model,
    embedding_version
  ) REFERENCES public.backstage_notion_chunk_embeddings(
    universe_id,
    chunk_version_id,
    embedding_model,
    embedding_version
  ) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CHECK (ordinal >= 0),
  CHECK (pg_catalog.length(embedding_model) BETWEEN 1 AND 200),
  CHECK (embedding_version > 0),
  CHECK (category IN (
    'championships',
    'events',
    'general',
    'kayfabe',
    'nxt',
    'raw',
    'roster',
    'smackdown',
    'storylines'
  )),
  CHECK (pg_catalog.isfinite(created_at))
);

CREATE TABLE IF NOT EXISTS public.backstage_notion_shard_snapshot_verifications (
  universe_id TEXT NOT NULL,
  shard_key TEXT NOT NULL,
  shard_snapshot_id UUID NOT NULL,
  ordinal INTEGER NOT NULL,
  verification_kind TEXT NOT NULL,
  result_hash TEXT NOT NULL,
  verified_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (universe_id, shard_key, shard_snapshot_id, ordinal),
  UNIQUE (
    universe_id,
    shard_key,
    shard_snapshot_id,
    verification_kind
  ),
  FOREIGN KEY (universe_id, shard_key, shard_snapshot_id)
    REFERENCES public.backstage_notion_shard_snapshots(universe_id, shard_key, id)
    ON UPDATE RESTRICT
    ON DELETE RESTRICT,
  CHECK (ordinal >= 0),
  CHECK (verification_kind IN ('capture', 'source_drift', 'completeness')),
  CHECK (result_hash ~ '^[0-9a-f]{64}$'),
  CHECK (pg_catalog.isfinite(verified_at)),
  CHECK (pg_catalog.isfinite(created_at))
);

CREATE TABLE IF NOT EXISTS public.backstage_notion_shard_heads (
  universe_id TEXT NOT NULL,
  shard_key TEXT NOT NULL,
  current_partition_version_id UUID NOT NULL,
  root_page_id UUID NOT NULL,
  active_snapshot_id UUID,
  head_generation BIGINT NOT NULL DEFAULT 0,
  snapshot_generation BIGINT NOT NULL DEFAULT 0,
  last_attempt_at TIMESTAMPTZ,
  last_verified_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (universe_id, shard_key),
  FOREIGN KEY (universe_id, shard_key)
    REFERENCES public.backstage_notion_partition_identities(universe_id, shard_key)
    ON UPDATE RESTRICT
    ON DELETE RESTRICT,
  FOREIGN KEY (universe_id, shard_key, current_partition_version_id, root_page_id)
    REFERENCES public.backstage_notion_partition_versions(
      universe_id,
      shard_key,
      id,
      root_page_id
    )
    ON UPDATE RESTRICT
    ON DELETE RESTRICT,
  FOREIGN KEY (universe_id, shard_key, active_snapshot_id)
    REFERENCES public.backstage_notion_shard_snapshots(universe_id, shard_key, id)
    ON UPDATE RESTRICT
    ON DELETE RESTRICT,
  CHECK (head_generation >= 0),
  CHECK (snapshot_generation >= 0),
  CHECK (
    (active_snapshot_id IS NULL AND snapshot_generation = 0)
    OR (active_snapshot_id IS NOT NULL AND snapshot_generation > 0)
  ),
  CHECK (last_attempt_at IS NULL OR pg_catalog.isfinite(last_attempt_at)),
  CHECK (last_verified_at IS NULL OR pg_catalog.isfinite(last_verified_at)),
  CHECK (pg_catalog.isfinite(updated_at))
);

-- Shard heads retain immutable last-known-good pointers after a shard leaves a
-- configuration. Active root ownership is unique in each sealed configuration,
-- not across these historical heads; keeping a global unique key here would
-- make safe root reassignment and two-key root swaps impossible.
ALTER TABLE public.backstage_notion_shard_heads
  DROP CONSTRAINT IF EXISTS backstage_notion_shard_heads_universe_id_root_page_id_key;

CREATE INDEX IF NOT EXISTS backstage_notion_shard_heads_root_page_idx
  ON public.backstage_notion_shard_heads (universe_id, root_page_id);

CREATE TABLE IF NOT EXISTS public.backstage_notion_shard_sync_leases (
  universe_id TEXT NOT NULL,
  shard_key TEXT NOT NULL,
  holder_id TEXT NOT NULL,
  lease_token UUID NOT NULL,
  lease_generation BIGINT NOT NULL,
  acquired_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (universe_id, shard_key),
  UNIQUE (lease_token),
  FOREIGN KEY (universe_id, shard_key)
    REFERENCES public.backstage_notion_shard_heads(universe_id, shard_key)
    ON UPDATE RESTRICT
    ON DELETE RESTRICT,
  CHECK (pg_catalog.length(holder_id) BETWEEN 1 AND 200),
  CHECK (lease_generation > 0),
  CHECK (pg_catalog.isfinite(acquired_at)),
  CHECK (pg_catalog.isfinite(expires_at)),
  CHECK (expires_at > acquired_at)
);

CREATE TABLE IF NOT EXISTS public.backstage_notion_provider_coordinator_leases (
  provider_key TEXT NOT NULL,
  model_key TEXT NOT NULL,
  holder_id TEXT NOT NULL,
  lease_token UUID NOT NULL,
  lease_generation BIGINT NOT NULL,
  acquired_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  next_request_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (provider_key, model_key),
  UNIQUE (lease_token),
  CHECK (provider_key ~ '^[a-z0-9][a-z0-9._:-]{0,127}$'),
  CHECK (pg_catalog.length(model_key) BETWEEN 1 AND 200),
  CHECK (pg_catalog.length(holder_id) BETWEEN 1 AND 200),
  CHECK (lease_generation > 0),
  CHECK (pg_catalog.isfinite(acquired_at)),
  CHECK (pg_catalog.isfinite(expires_at)),
  CHECK (pg_catalog.isfinite(next_request_at)),
  CHECK (expires_at > acquired_at)
);

CREATE TABLE IF NOT EXISTS public.backstage_notion_partition_source_generations (
  universe_id TEXT NOT NULL,
  source_generation_id UUID NOT NULL,
  partition_configuration_version_id UUID NOT NULL,
  source_digest TEXT NOT NULL,
  source_page_count INTEGER NOT NULL,
  source_chunk_count INTEGER NOT NULL,
  member_count INTEGER NOT NULL,
  source_verified_at TIMESTAMPTZ NOT NULL,
  source_verification_hash TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (universe_id, source_generation_id),
  UNIQUE (
    universe_id,
    source_generation_id,
    partition_configuration_version_id,
    source_digest,
    source_page_count,
    source_chunk_count,
    source_verified_at,
    source_verification_hash
  ),
  FOREIGN KEY (universe_id)
    REFERENCES public.backstage_notion_universe_heads(universe_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY (universe_id, partition_configuration_version_id)
    REFERENCES public.backstage_notion_partition_configuration_versions(universe_id, id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CHECK (source_digest ~ '^[0-9a-f]{64}$'),
  CHECK (source_verification_hash ~ '^[0-9a-f]{64}$'),
  CHECK (source_page_count > 0),
  CHECK (source_chunk_count > 0),
  CHECK (member_count BETWEEN 1 AND 512),
  CHECK (pg_catalog.isfinite(source_verified_at)),
  CHECK (pg_catalog.isfinite(created_at))
);

CREATE TABLE IF NOT EXISTS public.backstage_notion_universe_manifests (
  id UUID PRIMARY KEY,
  universe_id TEXT NOT NULL,
  partition_configuration_version_id UUID NOT NULL,
  configuration_generation TEXT NOT NULL,
  configuration_hash TEXT NOT NULL,
  source_generation_id UUID NOT NULL,
  source_digest TEXT NOT NULL,
  source_page_count INTEGER NOT NULL,
  source_chunk_count INTEGER NOT NULL,
  source_verified_at TIMESTAMPTZ NOT NULL,
  source_verification_hash TEXT NOT NULL,
  embedding_model TEXT NOT NULL,
  embedding_version INTEGER NOT NULL,
  embedding_dimension INTEGER NOT NULL,
  index_format_version INTEGER NOT NULL,
  member_count INTEGER NOT NULL,
  omission_count INTEGER NOT NULL,
  page_count INTEGER NOT NULL,
  chunk_count INTEGER NOT NULL,
  state TEXT NOT NULL DEFAULT 'building',
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  sealed_at TIMESTAMPTZ,
  UNIQUE (universe_id, id),
  UNIQUE (universe_id, id, partition_configuration_version_id),
  FOREIGN KEY (universe_id)
    REFERENCES public.backstage_notion_universe_heads(universe_id)
    ON UPDATE RESTRICT
    ON DELETE RESTRICT,
  FOREIGN KEY (
    universe_id,
    partition_configuration_version_id,
    configuration_generation,
    configuration_hash
  ) REFERENCES public.backstage_notion_partition_configuration_versions(
    universe_id,
    id,
    configuration_generation,
    configuration_hash
  ) ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY (
    universe_id,
    source_generation_id,
    partition_configuration_version_id,
    source_digest,
    source_page_count,
    source_chunk_count,
    source_verified_at,
    source_verification_hash
  ) REFERENCES public.backstage_notion_partition_source_generations(
    universe_id,
    source_generation_id,
    partition_configuration_version_id,
    source_digest,
    source_page_count,
    source_chunk_count,
    source_verified_at,
    source_verification_hash
  ) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CHECK (configuration_generation ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
  CHECK (configuration_hash ~ '^[0-9a-f]{64}$'),
  CHECK (source_digest ~ '^[0-9a-f]{64}$'),
  CHECK (source_verification_hash ~ '^[0-9a-f]{64}$'),
  CHECK (source_page_count > 0),
  CHECK (source_chunk_count > 0),
  CHECK (pg_catalog.isfinite(source_verified_at)),
  CHECK (pg_catalog.length(embedding_model) BETWEEN 1 AND 200),
  CHECK (embedding_version > 0),
  CHECK (embedding_dimension BETWEEN 1 AND 8192),
  CHECK (index_format_version > 0),
  CHECK (member_count BETWEEN 1 AND 512),
  CHECK (omission_count BETWEEN 0 AND 512),
  CHECK (member_count + omission_count <= 512),
  CHECK (page_count > 0),
  CHECK (chunk_count > 0),
  CHECK (state IN ('building', 'sealed')),
  CHECK (
    (state = 'building' AND sealed_at IS NULL)
    OR (state = 'sealed' AND sealed_at IS NOT NULL)
  ),
  CHECK (pg_catalog.isfinite(created_at)),
  CHECK (sealed_at IS NULL OR pg_catalog.isfinite(sealed_at))
);

-- Historical manifests are not assigned invented generation evidence.
ALTER TABLE public.backstage_notion_universe_manifests
  ADD COLUMN IF NOT EXISTS source_generation_id UUID,
  ADD COLUMN IF NOT EXISTS source_digest TEXT,
  ADD COLUMN IF NOT EXISTS source_page_count INTEGER,
  ADD COLUMN IF NOT EXISTS source_chunk_count INTEGER,
  ADD COLUMN IF NOT EXISTS source_verified_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS source_verification_hash TEXT;

CREATE TABLE IF NOT EXISTS public.backstage_notion_universe_manifest_shards (
  universe_id TEXT NOT NULL,
  manifest_id UUID NOT NULL,
  shard_key TEXT NOT NULL,
  partition_version_id UUID NOT NULL,
  shard_snapshot_id UUID NOT NULL,
  decision TEXT NOT NULL,
  is_required BOOLEAN NOT NULL,
  verified_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (universe_id, manifest_id, shard_key),
  UNIQUE (universe_id, manifest_id, shard_key, shard_snapshot_id),
  FOREIGN KEY (universe_id, manifest_id)
    REFERENCES public.backstage_notion_universe_manifests(universe_id, id)
    ON UPDATE RESTRICT
    ON DELETE RESTRICT,
  FOREIGN KEY (universe_id, shard_key, partition_version_id, shard_snapshot_id)
    REFERENCES public.backstage_notion_shard_snapshots(
      universe_id,
      shard_key,
      partition_version_id,
      id
    )
    ON UPDATE RESTRICT
    ON DELETE RESTRICT,
  CHECK (decision IN ('fresh', 'retained_last_known_good')),
  CHECK (pg_catalog.isfinite(verified_at)),
  CHECK (pg_catalog.isfinite(created_at))
);

CREATE TABLE IF NOT EXISTS public.backstage_notion_universe_manifest_omissions (
  universe_id TEXT NOT NULL,
  manifest_id UUID NOT NULL,
  shard_key TEXT NOT NULL,
  partition_version_id UUID NOT NULL,
  decision TEXT NOT NULL,
  safe_reason_code TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (universe_id, manifest_id, shard_key),
  FOREIGN KEY (universe_id, manifest_id)
    REFERENCES public.backstage_notion_universe_manifests(universe_id, id)
    ON UPDATE RESTRICT
    ON DELETE RESTRICT,
  FOREIGN KEY (universe_id, shard_key, partition_version_id)
    REFERENCES public.backstage_notion_partition_versions(universe_id, shard_key, id)
    ON UPDATE RESTRICT
    ON DELETE RESTRICT,
  CHECK (decision IN ('optional_unavailable', 'optional_disabled')),
  CHECK (safe_reason_code ~ '^[A-Z][A-Z0-9_]{0,127}$'),
  CHECK (pg_catalog.isfinite(created_at))
);

CREATE TABLE IF NOT EXISTS public.backstage_notion_manifest_page_ownership (
  universe_id TEXT NOT NULL,
  manifest_id UUID NOT NULL,
  page_id UUID NOT NULL,
  shard_key TEXT NOT NULL,
  shard_snapshot_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (universe_id, manifest_id, page_id),
  FOREIGN KEY (universe_id, manifest_id, shard_key, shard_snapshot_id)
    REFERENCES public.backstage_notion_universe_manifest_shards(
      universe_id,
      manifest_id,
      shard_key,
      shard_snapshot_id
    )
    ON UPDATE RESTRICT
    ON DELETE RESTRICT,
  FOREIGN KEY (universe_id, shard_key, shard_snapshot_id, page_id)
    REFERENCES public.backstage_notion_shard_snapshot_pages(
      universe_id,
      shard_key,
      shard_snapshot_id,
      page_id
    )
    ON UPDATE RESTRICT
    ON DELETE RESTRICT,
  CHECK (pg_catalog.isfinite(created_at))
);

CREATE TABLE IF NOT EXISTS public.backstage_notion_partitioned_universe_heads (
  universe_id TEXT PRIMARY KEY,
  desired_configuration_version_id UUID NOT NULL,
  desired_configuration_generation TEXT NOT NULL,
  desired_configuration_hash TEXT NOT NULL,
  active_manifest_id UUID,
  active_configuration_version_id UUID,
  head_generation BIGINT NOT NULL DEFAULT 0,
  manifest_generation BIGINT NOT NULL DEFAULT 0,
  reconciliation_generation BIGINT NOT NULL DEFAULT 0,
  published_reconciliation_generation BIGINT NOT NULL DEFAULT 0,
  last_verified_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (universe_id)
    REFERENCES public.backstage_notion_universe_heads(universe_id)
    ON UPDATE RESTRICT
    ON DELETE RESTRICT,
  FOREIGN KEY (
    universe_id,
    desired_configuration_version_id,
    desired_configuration_generation,
    desired_configuration_hash
  ) REFERENCES public.backstage_notion_partition_configuration_versions(
    universe_id,
    id,
    configuration_generation,
    configuration_hash
  ) ON UPDATE RESTRICT ON DELETE RESTRICT,
  FOREIGN KEY (universe_id, active_manifest_id, active_configuration_version_id)
    REFERENCES public.backstage_notion_universe_manifests(
      universe_id,
      id,
      partition_configuration_version_id
    )
    ON UPDATE RESTRICT
    ON DELETE RESTRICT,
  CHECK (desired_configuration_generation ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
  CHECK (desired_configuration_hash ~ '^[0-9a-f]{64}$'),
  CHECK (head_generation >= 0),
  CHECK (manifest_generation >= 0),
  CHECK (reconciliation_generation >= 0),
  CHECK (
    published_reconciliation_generation >= 0
    AND published_reconciliation_generation <= reconciliation_generation
  ),
  CHECK (
    (
      active_manifest_id IS NULL
      AND active_configuration_version_id IS NULL
      AND manifest_generation = 0
    )
    OR (
      active_manifest_id IS NOT NULL
      AND active_configuration_version_id IS NOT NULL
      AND manifest_generation > 0
    )
  ),
  CHECK (last_verified_at IS NULL OR pg_catalog.isfinite(last_verified_at)),
  CHECK (pg_catalog.isfinite(updated_at))
);

CREATE INDEX IF NOT EXISTS idx_backstage_notion_partition_versions_root
  ON public.backstage_notion_partition_versions(
    universe_id,
    shard_key,
    root_page_id
  );

CREATE INDEX IF NOT EXISTS idx_backstage_notion_partition_configuration_members_version
  ON public.backstage_notion_partition_configuration_members(
    universe_id,
    partition_version_id,
    partition_configuration_version_id
  );
CREATE INDEX IF NOT EXISTS idx_backstage_notion_chunk_versions_hash
  ON public.backstage_notion_chunk_versions(universe_id, content_hash, chunker_version);
CREATE INDEX IF NOT EXISTS idx_backstage_notion_chunk_versions_lexical
  ON public.backstage_notion_chunk_versions
  USING GIN (pg_catalog.to_tsvector('simple'::pg_catalog.regconfig, content));
CREATE INDEX IF NOT EXISTS idx_backstage_notion_chunk_embeddings_model
  ON public.backstage_notion_chunk_embeddings(
    universe_id,
    embedding_model,
    embedding_version,
    chunk_version_id
  );
CREATE INDEX IF NOT EXISTS idx_backstage_notion_page_versions_page
  ON public.backstage_notion_page_versions(universe_id, page_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_backstage_notion_shard_snapshots_history
  ON public.backstage_notion_shard_snapshots(
    universe_id,
    shard_key,
    created_at DESC
  );
CREATE INDEX IF NOT EXISTS idx_backstage_notion_shard_snapshot_pages_version
  ON public.backstage_notion_shard_snapshot_pages(universe_id, page_version_id);
CREATE INDEX IF NOT EXISTS idx_backstage_notion_shard_snapshot_pages_scope_title
  ON public.backstage_notion_shard_snapshot_pages(
    universe_id,
    shard_key,
    shard_snapshot_id,
    scope_title_key,
    page_id
  );
CREATE INDEX IF NOT EXISTS idx_backstage_notion_shard_snapshot_pages_scope_path
  ON public.backstage_notion_shard_snapshot_pages(
    universe_id,
    shard_key,
    shard_snapshot_id,
    scope_path_key,
    page_id
  );
CREATE INDEX IF NOT EXISTS idx_backstage_notion_page_chunks_scope_heading
  ON public.backstage_notion_page_version_chunks(
    universe_id,
    page_version_id,
    scope_heading_path_key,
    heading_occurrence_path,
    ordinal
  );
CREATE INDEX IF NOT EXISTS idx_backstage_notion_shard_occurrences_embedding
  ON public.backstage_notion_shard_snapshot_chunk_occurrences(
    universe_id,
    shard_key,
    shard_snapshot_id,
    embedding_model,
    embedding_version,
    chunk_version_id
  );
CREATE INDEX IF NOT EXISTS idx_backstage_notion_shard_occurrences_category
  ON public.backstage_notion_shard_snapshot_chunk_occurrences(
    universe_id,
    shard_key,
    shard_snapshot_id,
    category,
    page_id,
    ordinal
  );
CREATE INDEX IF NOT EXISTS idx_backstage_notion_shard_leases_expiry
  ON public.backstage_notion_shard_sync_leases(expires_at);
CREATE INDEX IF NOT EXISTS idx_backstage_notion_provider_leases_expiry
  ON public.backstage_notion_provider_coordinator_leases(expires_at, next_request_at);
CREATE INDEX IF NOT EXISTS idx_backstage_notion_universe_manifests_history
  ON public.backstage_notion_universe_manifests(universe_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_backstage_notion_manifest_ownership_shard
  ON public.backstage_notion_manifest_page_ownership(
    universe_id,
    manifest_id,
    shard_key,
    page_id
  );

CREATE OR REPLACE FUNCTION public.backstage_notion_partition_reject_immutable_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $function$
BEGIN
  RAISE EXCEPTION USING
    ERRCODE = '55000',
    MESSAGE = pg_catalog.format(
      '%I.%I is append-only',
      TG_TABLE_SCHEMA,
      TG_TABLE_NAME
    );
END;
$function$;

CREATE OR REPLACE FUNCTION public.backstage_notion_require_building_insert()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $function$
BEGIN
  IF NEW.state IS DISTINCT FROM 'building' OR NEW.sealed_at IS NOT NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'immutable candidates must be inserted in the building state';
  END IF;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.backstage_notion_guard_partition_configuration_seal()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $function$
DECLARE
  actual_shard_count BIGINT;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION USING
      ERRCODE = '55000',
      MESSAGE = 'partition configuration versions are immutable';
  END IF;

  IF OLD.state <> 'building'
     OR NEW.state <> 'sealed'
     OR NEW.sealed_at IS NULL
     OR NEW.sealed_at < NEW.created_at
     OR NEW.id IS DISTINCT FROM OLD.id
     OR NEW.universe_id IS DISTINCT FROM OLD.universe_id
     OR NEW.configuration_generation IS DISTINCT FROM OLD.configuration_generation
     OR NEW.configuration_hash IS DISTINCT FROM OLD.configuration_hash
     OR NEW.shard_count IS DISTINCT FROM OLD.shard_count
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION USING
      ERRCODE = '55000',
      MESSAGE = 'partition configurations only support an unchanged building-to-sealed transition';
  END IF;

  SELECT pg_catalog.count(*)
  INTO actual_shard_count
  FROM public.backstage_notion_partition_configuration_members AS member
  WHERE member.universe_id = NEW.universe_id
    AND member.partition_configuration_version_id = NEW.id;

  IF actual_shard_count <> NEW.shard_count THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'partition configuration shard count does not match immutable definitions';
  END IF;

  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.backstage_notion_guard_partition_configuration_member_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $function$
DECLARE
  parent_state TEXT;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION USING
      ERRCODE = '55000',
      MESSAGE = 'partition configuration memberships are immutable';
  END IF;

  SELECT configuration.state
  INTO parent_state
  FROM public.backstage_notion_partition_configuration_versions AS configuration
  WHERE configuration.universe_id = NEW.universe_id
    AND configuration.id = NEW.partition_configuration_version_id
    AND configuration.configuration_generation = NEW.configuration_generation
  FOR SHARE;

  IF parent_state IS DISTINCT FROM 'building' THEN
    RAISE EXCEPTION USING
      ERRCODE = '55000',
      MESSAGE = 'partition configuration memberships may only be inserted while their configuration is building';
  END IF;

  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.backstage_notion_guard_page_version_seal()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $function$
DECLARE
  actual_chunk_count BIGINT;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'page versions are immutable';
  END IF;

  IF OLD.state <> 'building'
     OR NEW.state <> 'sealed'
     OR NEW.sealed_at IS NULL
     OR NEW.sealed_at < NEW.created_at
     OR NEW.id IS DISTINCT FROM OLD.id
     OR NEW.universe_id IS DISTINCT FROM OLD.universe_id
     OR NEW.page_id IS DISTINCT FROM OLD.page_id
     OR NEW.content_hash IS DISTINCT FROM OLD.content_hash
     OR NEW.page_format_version IS DISTINCT FROM OLD.page_format_version
     OR NEW.chunker_version IS DISTINCT FROM OLD.chunker_version
     OR NEW.markdown IS DISTINCT FROM OLD.markdown
     OR NEW.content_code_points IS DISTINCT FROM OLD.content_code_points
     OR NEW.chunk_count IS DISTINCT FROM OLD.chunk_count
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION USING
      ERRCODE = '55000',
      MESSAGE = 'page versions only support an unchanged building-to-sealed transition';
  END IF;

  SELECT pg_catalog.count(*)
  INTO actual_chunk_count
  FROM public.backstage_notion_page_version_chunks AS occurrence
  WHERE occurrence.universe_id = NEW.universe_id
    AND occurrence.page_version_id = NEW.id;

  IF actual_chunk_count <> NEW.chunk_count THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'page version chunk count does not match immutable occurrences';
  END IF;

  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.backstage_notion_guard_page_chunk_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $function$
DECLARE
  parent_state TEXT;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION USING
      ERRCODE = '55000',
      MESSAGE = 'page chunk occurrences are immutable';
  END IF;

  SELECT page_version.state
  INTO parent_state
  FROM public.backstage_notion_page_versions AS page_version
  WHERE page_version.universe_id = NEW.universe_id
    AND page_version.id = NEW.page_version_id
  FOR SHARE;

  IF parent_state IS DISTINCT FROM 'building' THEN
    RAISE EXCEPTION USING
      ERRCODE = '55000',
      MESSAGE = 'page chunk occurrences may only be inserted while the page version is building';
  END IF;

  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.backstage_notion_guard_shard_snapshot_child_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $function$
DECLARE
  parent_state TEXT;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION USING
      ERRCODE = '55000',
      MESSAGE = 'shard snapshot children are immutable';
  END IF;

  SELECT snapshot.state
  INTO parent_state
  FROM public.backstage_notion_shard_snapshots AS snapshot
  WHERE snapshot.universe_id = NEW.universe_id
    AND snapshot.shard_key = NEW.shard_key
    AND snapshot.id = NEW.shard_snapshot_id
  FOR SHARE;

  IF parent_state IS DISTINCT FROM 'building' THEN
    RAISE EXCEPTION USING
      ERRCODE = '55000',
      MESSAGE = 'shard snapshot children may only be inserted while the snapshot is building';
  END IF;

  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.backstage_notion_guard_shard_snapshot_seal()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $function$
DECLARE
  allowed_pages INTEGER;
  allowed_chunks INTEGER;
  allowed_depth INTEGER;
  allowed_code_points INTEGER;
  configured_root_page_id UUID;
  actual_page_count BIGINT;
  actual_chunk_count BIGINT;
  actual_occurrence_count BIGINT;
  actual_code_points BIGINT;
  actual_max_depth INTEGER;
  actual_source_max TIMESTAMPTZ;
  root_count BIGINT;
  null_parent_count BIGINT;
  invalid_path_count BIGINT;
  unsealed_page_count BIGINT;
  invalid_occurrence_count BIGINT;
  actual_verification_count BIGINT;
  source_drift_verification_count BIGINT;
  completeness_verification_count BIGINT;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'shard snapshots are immutable';
  END IF;

  IF OLD.state <> 'building'
     OR NEW.state <> 'sealed'
     OR NEW.sealed_at IS NULL
     OR NEW.sealed_at < NEW.created_at
     OR NEW.id IS DISTINCT FROM OLD.id
     OR NEW.universe_id IS DISTINCT FROM OLD.universe_id
     OR NEW.shard_key IS DISTINCT FROM OLD.shard_key
     OR NEW.partition_version_id IS DISTINCT FROM OLD.partition_version_id
     OR NEW.root_page_id IS DISTINCT FROM OLD.root_page_id
     OR NEW.source_generation_id IS DISTINCT FROM OLD.source_generation_id
     OR NEW.source_manifest_hash IS DISTINCT FROM OLD.source_manifest_hash
     OR NEW.embedding_model IS DISTINCT FROM OLD.embedding_model
     OR NEW.embedding_version IS DISTINCT FROM OLD.embedding_version
     OR NEW.embedding_dimension IS DISTINCT FROM OLD.embedding_dimension
     OR NEW.index_format_version IS DISTINCT FROM OLD.index_format_version
     OR NEW.page_count IS DISTINCT FROM OLD.page_count
     OR NEW.chunk_count IS DISTINCT FROM OLD.chunk_count
     OR NEW.content_code_points IS DISTINCT FROM OLD.content_code_points
     OR NEW.max_depth IS DISTINCT FROM OLD.max_depth
     OR NEW.source_max_last_edited_at IS DISTINCT FROM OLD.source_max_last_edited_at
     OR NEW.verification_count IS DISTINCT FROM OLD.verification_count
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION USING
      ERRCODE = '55000',
      MESSAGE = 'shard snapshots only support an unchanged building-to-sealed transition';
  END IF;

  SELECT
    definition.max_pages,
    definition.max_chunks,
    definition.max_depth,
    definition.max_content_code_points,
    definition.root_page_id
  INTO
    allowed_pages,
    allowed_chunks,
    allowed_depth,
    allowed_code_points,
    configured_root_page_id
  FROM public.backstage_notion_partition_versions AS definition
  WHERE definition.universe_id = NEW.universe_id
    AND definition.shard_key = NEW.shard_key
    AND definition.id = NEW.partition_version_id;

  IF NOT FOUND OR configured_root_page_id <> NEW.root_page_id THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'shard snapshot definition is invalid';
  END IF;

  SELECT
    pg_catalog.count(*),
    COALESCE(pg_catalog.sum(page_version.chunk_count), 0),
    COALESCE(pg_catalog.sum(page_version.content_code_points), 0),
    COALESCE(pg_catalog.max(snapshot_page.depth), 0),
    pg_catalog.max(snapshot_page.source_last_edited_at),
    pg_catalog.count(*) FILTER (
      WHERE snapshot_page.page_id = NEW.root_page_id
        AND snapshot_page.parent_page_id IS NULL
        AND snapshot_page.depth = 0
    ),
    pg_catalog.count(*) FILTER (WHERE snapshot_page.parent_page_id IS NULL),
    pg_catalog.count(*) FILTER (WHERE page_version.state <> 'sealed')
  INTO
    actual_page_count,
    actual_chunk_count,
    actual_code_points,
    actual_max_depth,
    actual_source_max,
    root_count,
    null_parent_count,
    unsealed_page_count
  FROM public.backstage_notion_shard_snapshot_pages AS snapshot_page
  JOIN public.backstage_notion_page_versions AS page_version
    ON page_version.universe_id = snapshot_page.universe_id
   AND page_version.id = snapshot_page.page_version_id
  WHERE snapshot_page.universe_id = NEW.universe_id
    AND snapshot_page.shard_key = NEW.shard_key
    AND snapshot_page.shard_snapshot_id = NEW.id;

  SELECT pg_catalog.count(*)
  INTO invalid_path_count
  FROM public.backstage_notion_shard_snapshot_pages AS child
  LEFT JOIN public.backstage_notion_shard_snapshot_pages AS parent
    ON parent.universe_id = child.universe_id
   AND parent.shard_key = child.shard_key
   AND parent.shard_snapshot_id = child.shard_snapshot_id
   AND parent.page_id = child.parent_page_id
  WHERE child.universe_id = NEW.universe_id
    AND child.shard_key = NEW.shard_key
    AND child.shard_snapshot_id = NEW.id
    AND (
      (
        child.page_id = NEW.root_page_id
        AND child.path <> pg_catalog.jsonb_build_array(NEW.root_page_id::TEXT)
      )
      OR (
        child.page_id <> NEW.root_page_id
        AND (
          parent.page_id IS NULL
          OR child.path ->> (pg_catalog.jsonb_array_length(child.path) - 1)
             <> child.page_id::TEXT
          OR child.path - (pg_catalog.jsonb_array_length(child.path) - 1)
             IS DISTINCT FROM parent.path
        )
      )
    );

  SELECT pg_catalog.count(*)
  INTO actual_occurrence_count
  FROM public.backstage_notion_shard_snapshot_chunk_occurrences AS occurrence
  WHERE occurrence.universe_id = NEW.universe_id
    AND occurrence.shard_key = NEW.shard_key
    AND occurrence.shard_snapshot_id = NEW.id;

  SELECT pg_catalog.count(*)
  INTO invalid_occurrence_count
  FROM public.backstage_notion_shard_snapshot_chunk_occurrences AS occurrence
  JOIN public.backstage_notion_chunk_embeddings AS embedding
    ON embedding.universe_id = occurrence.universe_id
   AND embedding.chunk_version_id = occurrence.chunk_version_id
   AND embedding.embedding_model = occurrence.embedding_model
   AND embedding.embedding_version = occurrence.embedding_version
  WHERE occurrence.universe_id = NEW.universe_id
    AND occurrence.shard_key = NEW.shard_key
    AND occurrence.shard_snapshot_id = NEW.id
    AND (
      occurrence.embedding_model <> NEW.embedding_model
      OR occurrence.embedding_version <> NEW.embedding_version
      OR embedding.embedding_dimension <> NEW.embedding_dimension
    );

  SELECT
    pg_catalog.count(*),
    pg_catalog.count(*) FILTER (WHERE verification_kind = 'source_drift'),
    pg_catalog.count(*) FILTER (WHERE verification_kind = 'completeness')
  INTO
    actual_verification_count,
    source_drift_verification_count,
    completeness_verification_count
  FROM public.backstage_notion_shard_snapshot_verifications AS verification
  WHERE verification.universe_id = NEW.universe_id
    AND verification.shard_key = NEW.shard_key
    AND verification.shard_snapshot_id = NEW.id;

  IF NEW.source_generation_id IS NULL
     OR actual_page_count <> NEW.page_count
     OR actual_chunk_count <> NEW.chunk_count
     OR actual_occurrence_count <> NEW.chunk_count
     OR actual_code_points <> NEW.content_code_points
     OR actual_max_depth <> NEW.max_depth
     OR actual_source_max IS DISTINCT FROM NEW.source_max_last_edited_at
     OR root_count <> 1
     OR null_parent_count <> 1
     OR invalid_path_count <> 0
     OR unsealed_page_count <> 0
     OR invalid_occurrence_count <> 0
     OR actual_verification_count <> NEW.verification_count
     OR source_drift_verification_count <> 1
     OR completeness_verification_count <> 1
     OR NEW.page_count > allowed_pages
     OR NEW.chunk_count > allowed_chunks
     OR NEW.max_depth > allowed_depth
     OR NEW.content_code_points > allowed_code_points THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'shard snapshot cannot be sealed because its immutable evidence is incomplete';
  END IF;

  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.backstage_notion_guard_universe_manifest_child_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $function$
DECLARE
  parent_state TEXT;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION USING
      ERRCODE = '55000',
      MESSAGE = 'universe manifest children are immutable';
  END IF;

  SELECT manifest.state
  INTO parent_state
  FROM public.backstage_notion_universe_manifests AS manifest
  WHERE manifest.universe_id = NEW.universe_id
    AND manifest.id = NEW.manifest_id
  FOR SHARE;

  IF parent_state IS DISTINCT FROM 'building' THEN
    RAISE EXCEPTION USING
      ERRCODE = '55000',
      MESSAGE = 'universe manifest children may only be inserted while the manifest is building';
  END IF;

  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.backstage_notion_guard_universe_manifest_seal()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $function$
DECLARE
  legacy_authority TEXT;
  configuration_state TEXT;
  configured_shard_count INTEGER;
  actual_configuration_member_count BIGINT;
  actual_member_count BIGINT;
  actual_omission_count BIGINT;
  actual_page_count BIGINT;
  actual_chunk_count BIGINT;
  actual_ownership_count BIGINT;
  overlapping_decision_count BIGINT;
  invalid_member_count BIGINT;
  invalid_omission_count BIGINT;
  uncovered_configuration_member_count BIGINT;
  missing_ownership_count BIGINT;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'universe manifests are immutable';
  END IF;

  IF OLD.state <> 'building'
     OR NEW.state <> 'sealed'
     OR NEW.sealed_at IS NULL
     OR NEW.sealed_at < NEW.created_at
     OR NEW.id IS DISTINCT FROM OLD.id
     OR NEW.universe_id IS DISTINCT FROM OLD.universe_id
     OR NEW.partition_configuration_version_id IS DISTINCT FROM OLD.partition_configuration_version_id
     OR NEW.configuration_generation IS DISTINCT FROM OLD.configuration_generation
     OR NEW.configuration_hash IS DISTINCT FROM OLD.configuration_hash
     OR NEW.source_generation_id IS DISTINCT FROM OLD.source_generation_id
     OR NEW.source_digest IS DISTINCT FROM OLD.source_digest
     OR NEW.source_page_count IS DISTINCT FROM OLD.source_page_count
     OR NEW.source_chunk_count IS DISTINCT FROM OLD.source_chunk_count
     OR NEW.source_verified_at IS DISTINCT FROM OLD.source_verified_at
     OR NEW.source_verification_hash IS DISTINCT FROM OLD.source_verification_hash
     OR NEW.embedding_model IS DISTINCT FROM OLD.embedding_model
     OR NEW.embedding_version IS DISTINCT FROM OLD.embedding_version
     OR NEW.embedding_dimension IS DISTINCT FROM OLD.embedding_dimension
     OR NEW.index_format_version IS DISTINCT FROM OLD.index_format_version
     OR NEW.member_count IS DISTINCT FROM OLD.member_count
     OR NEW.omission_count IS DISTINCT FROM OLD.omission_count
     OR NEW.page_count IS DISTINCT FROM OLD.page_count
     OR NEW.chunk_count IS DISTINCT FROM OLD.chunk_count
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION USING
      ERRCODE = '55000',
      MESSAGE = 'universe manifests only support an unchanged building-to-sealed transition';
  END IF;

  SELECT authority
  INTO legacy_authority
  FROM public.backstage_notion_universe_heads
  WHERE universe_id = NEW.universe_id
  FOR SHARE;

  IF legacy_authority IS DISTINCT FROM 'notion' THEN
    RAISE EXCEPTION USING
      ERRCODE = '55000',
      MESSAGE = 'universe manifests require active Notion authority';
  END IF;

  SELECT configuration.state, configuration.shard_count
  INTO configuration_state, configured_shard_count
  FROM public.backstage_notion_partition_configuration_versions AS configuration
  WHERE configuration.universe_id = NEW.universe_id
    AND configuration.id = NEW.partition_configuration_version_id
  FOR KEY SHARE;

  IF configuration_state IS DISTINCT FROM 'sealed' THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'universe manifest configuration must be sealed';
  END IF;

  PERFORM 1
  FROM public.backstage_notion_shard_heads AS head
  WHERE head.universe_id = NEW.universe_id
  ORDER BY head.shard_key
  FOR SHARE;

  SELECT pg_catalog.count(*)
  INTO actual_configuration_member_count
  FROM public.backstage_notion_partition_configuration_members AS configured_member
  WHERE configured_member.universe_id = NEW.universe_id
    AND configured_member.partition_configuration_version_id = NEW.partition_configuration_version_id;

  SELECT pg_catalog.count(*)
  INTO actual_member_count
  FROM public.backstage_notion_universe_manifest_shards AS member
  WHERE member.universe_id = NEW.universe_id
    AND member.manifest_id = NEW.id;

  SELECT pg_catalog.count(*)
  INTO actual_omission_count
  FROM public.backstage_notion_universe_manifest_omissions AS omission
  WHERE omission.universe_id = NEW.universe_id
    AND omission.manifest_id = NEW.id;

  SELECT
    COALESCE(pg_catalog.sum(snapshot.page_count), 0),
    COALESCE(pg_catalog.sum(snapshot.chunk_count), 0)
  INTO actual_page_count, actual_chunk_count
  FROM public.backstage_notion_universe_manifest_shards AS member
  JOIN public.backstage_notion_shard_snapshots AS snapshot
    ON snapshot.universe_id = member.universe_id
   AND snapshot.shard_key = member.shard_key
   AND snapshot.id = member.shard_snapshot_id
  WHERE member.universe_id = NEW.universe_id
    AND member.manifest_id = NEW.id;

  SELECT pg_catalog.count(*)
  INTO actual_ownership_count
  FROM public.backstage_notion_manifest_page_ownership AS ownership
  WHERE ownership.universe_id = NEW.universe_id
    AND ownership.manifest_id = NEW.id;

  SELECT pg_catalog.count(*)
  INTO overlapping_decision_count
  FROM public.backstage_notion_universe_manifest_shards AS member
  JOIN public.backstage_notion_universe_manifest_omissions AS omission
    ON omission.universe_id = member.universe_id
   AND omission.manifest_id = member.manifest_id
   AND omission.shard_key = member.shard_key
  WHERE member.universe_id = NEW.universe_id
    AND member.manifest_id = NEW.id;

  SELECT pg_catalog.count(*)
  INTO invalid_member_count
  FROM public.backstage_notion_universe_manifest_shards AS member
  LEFT JOIN public.backstage_notion_shard_heads AS head
    ON head.universe_id = member.universe_id
   AND head.shard_key = member.shard_key
  LEFT JOIN public.backstage_notion_partition_configuration_members AS configured_member
    ON configured_member.universe_id = member.universe_id
   AND configured_member.partition_configuration_version_id = NEW.partition_configuration_version_id
   AND configured_member.shard_key = member.shard_key
   AND configured_member.partition_version_id = member.partition_version_id
  LEFT JOIN public.backstage_notion_partition_versions AS definition
    ON definition.universe_id = configured_member.universe_id
   AND definition.shard_key = configured_member.shard_key
   AND definition.id = configured_member.partition_version_id
  LEFT JOIN public.backstage_notion_shard_snapshots AS snapshot
    ON snapshot.universe_id = member.universe_id
   AND snapshot.shard_key = member.shard_key
   AND snapshot.id = member.shard_snapshot_id
  LEFT JOIN LATERAL (
    SELECT pg_catalog.max(verification.verified_at) AS latest_verified_at
    FROM public.backstage_notion_shard_snapshot_verifications AS verification
    WHERE verification.universe_id = member.universe_id
      AND verification.shard_key = member.shard_key
      AND verification.shard_snapshot_id = member.shard_snapshot_id
      AND verification.verification_kind IN ('source_drift', 'completeness')
  ) AS verification_window ON TRUE
  WHERE member.universe_id = NEW.universe_id
    AND member.manifest_id = NEW.id
    AND (
      head.shard_key IS NULL
      OR head.current_partition_version_id <> member.partition_version_id
      OR head.active_snapshot_id IS DISTINCT FROM member.shard_snapshot_id
      OR configured_member.partition_version_id IS NULL
      OR definition.is_required <> member.is_required
      OR snapshot.state <> 'sealed'
      OR snapshot.source_generation_id IS DISTINCT FROM NEW.source_generation_id
      OR snapshot.embedding_model <> NEW.embedding_model
      OR snapshot.embedding_version <> NEW.embedding_version
      OR snapshot.embedding_dimension <> NEW.embedding_dimension
      OR snapshot.index_format_version <> NEW.index_format_version
      OR member.verified_at IS DISTINCT FROM verification_window.latest_verified_at
    );

  SELECT pg_catalog.count(*)
  INTO invalid_omission_count
  FROM public.backstage_notion_universe_manifest_omissions AS omission
  LEFT JOIN public.backstage_notion_partition_configuration_members AS configured_member
    ON configured_member.universe_id = omission.universe_id
   AND configured_member.partition_configuration_version_id = NEW.partition_configuration_version_id
   AND configured_member.shard_key = omission.shard_key
   AND configured_member.partition_version_id = omission.partition_version_id
  LEFT JOIN public.backstage_notion_partition_versions AS definition
    ON definition.universe_id = configured_member.universe_id
   AND definition.shard_key = configured_member.shard_key
   AND definition.id = configured_member.partition_version_id
  WHERE omission.universe_id = NEW.universe_id
    AND omission.manifest_id = NEW.id
    AND (
      configured_member.partition_version_id IS NULL
      OR definition.is_required
    );

  SELECT pg_catalog.count(*)
  INTO uncovered_configuration_member_count
  FROM public.backstage_notion_partition_configuration_members AS configured_member
  WHERE configured_member.universe_id = NEW.universe_id
    AND configured_member.partition_configuration_version_id = NEW.partition_configuration_version_id
    AND NOT EXISTS (
      SELECT 1
      FROM public.backstage_notion_universe_manifest_shards AS member
      WHERE member.universe_id = configured_member.universe_id
        AND member.manifest_id = NEW.id
        AND member.shard_key = configured_member.shard_key
    )
    AND NOT EXISTS (
      SELECT 1
      FROM public.backstage_notion_universe_manifest_omissions AS omission
      WHERE omission.universe_id = configured_member.universe_id
        AND omission.manifest_id = NEW.id
        AND omission.shard_key = configured_member.shard_key
    );

  SELECT pg_catalog.count(*)
  INTO missing_ownership_count
  FROM public.backstage_notion_universe_manifest_shards AS member
  JOIN public.backstage_notion_shard_snapshot_pages AS snapshot_page
    ON snapshot_page.universe_id = member.universe_id
   AND snapshot_page.shard_key = member.shard_key
   AND snapshot_page.shard_snapshot_id = member.shard_snapshot_id
  LEFT JOIN public.backstage_notion_manifest_page_ownership AS ownership
    ON ownership.universe_id = member.universe_id
   AND ownership.manifest_id = member.manifest_id
   AND ownership.shard_key = member.shard_key
   AND ownership.shard_snapshot_id = member.shard_snapshot_id
   AND ownership.page_id = snapshot_page.page_id
  WHERE member.universe_id = NEW.universe_id
    AND member.manifest_id = NEW.id
    AND ownership.page_id IS NULL;

  IF NEW.source_generation_id IS NULL
     OR NEW.source_digest IS NULL
     OR NEW.source_digest !~ '^[0-9a-f]{64}$'
     OR NEW.source_verified_at IS NULL
     OR NOT pg_catalog.isfinite(NEW.source_verified_at)
     OR NEW.source_verification_hash IS NULL
     OR NEW.source_verification_hash !~ '^[0-9a-f]{64}$'
     OR NEW.source_page_count IS DISTINCT FROM NEW.page_count
     OR NEW.source_chunk_count IS DISTINCT FROM NEW.chunk_count
     OR configured_shard_count <> actual_configuration_member_count
     OR actual_member_count <> NEW.member_count
     OR actual_omission_count <> NEW.omission_count
     OR actual_member_count + actual_omission_count <> configured_shard_count
     OR actual_page_count <> NEW.page_count
     OR actual_chunk_count <> NEW.chunk_count
     OR actual_ownership_count <> NEW.page_count
     OR overlapping_decision_count <> 0
     OR invalid_member_count <> 0
     OR invalid_omission_count <> 0
     OR uncovered_configuration_member_count <> 0
     OR missing_ownership_count <> 0 THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'universe manifest cannot be sealed because its immutable decisions are incomplete';
  END IF;

  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.backstage_notion_guard_shard_head()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $function$
DECLARE
  definition_root UUID;
  snapshot_state TEXT;
  snapshot_partition_version_id UUID;
  legacy_authority TEXT;
  pointer_changed BOOLEAN := FALSE;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'shard heads cannot be deleted';
  END IF;

  IF TG_OP = 'UPDATE' THEN
    IF NEW.universe_id IS DISTINCT FROM OLD.universe_id
       OR NEW.shard_key IS DISTINCT FROM OLD.shard_key THEN
      RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'shard head identity is immutable';
    END IF;

    IF OLD.active_snapshot_id IS NOT NULL AND NEW.active_snapshot_id IS NULL THEN
      RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'last-known-good shard heads cannot be cleared';
    END IF;

    IF NEW.current_partition_version_id IS DISTINCT FROM OLD.current_partition_version_id
       OR NEW.root_page_id IS DISTINCT FROM OLD.root_page_id
       OR NEW.active_snapshot_id IS DISTINCT FROM OLD.active_snapshot_id THEN
      pointer_changed := TRUE;
      IF NEW.head_generation <> OLD.head_generation + 1 THEN
        RAISE EXCEPTION USING ERRCODE = '40001', MESSAGE = 'shard head compare-and-swap generation is stale';
      END IF;
    ELSIF NEW.head_generation <> OLD.head_generation THEN
      RAISE EXCEPTION USING ERRCODE = '40001', MESSAGE = 'shard head generation cannot advance without a pointer change';
    END IF;

    IF NEW.active_snapshot_id IS DISTINCT FROM OLD.active_snapshot_id THEN
      IF NEW.snapshot_generation <> OLD.snapshot_generation + 1 THEN
        RAISE EXCEPTION USING ERRCODE = '40001', MESSAGE = 'shard snapshot generation is stale';
      END IF;
    ELSIF NEW.snapshot_generation <> OLD.snapshot_generation THEN
      RAISE EXCEPTION USING ERRCODE = '40001', MESSAGE = 'snapshot generation cannot advance without a snapshot change';
    END IF;
  ELSIF NEW.active_snapshot_id IS NULL THEN
    IF NEW.head_generation <> 0 OR NEW.snapshot_generation <> 0 THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'an empty shard head starts at generation zero';
    END IF;
  ELSIF NEW.head_generation <> 1 OR NEW.snapshot_generation <> 1 THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'an initialized shard head starts at generation one';
  ELSE
    pointer_changed := TRUE;
  END IF;

  IF pointer_changed THEN
    SELECT authority
    INTO legacy_authority
    FROM public.backstage_notion_universe_heads
    WHERE universe_id = NEW.universe_id
    FOR SHARE;

    IF legacy_authority IS DISTINCT FROM 'notion' THEN
      RAISE EXCEPTION USING
        ERRCODE = '55000',
        MESSAGE = 'shard head pointers require active Notion authority';
    END IF;
  END IF;

  SELECT definition.root_page_id
  INTO definition_root
  FROM public.backstage_notion_partition_versions AS definition
  WHERE definition.universe_id = NEW.universe_id
    AND definition.shard_key = NEW.shard_key
    AND definition.id = NEW.current_partition_version_id
  FOR KEY SHARE;

  IF definition_root IS DISTINCT FROM NEW.root_page_id THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'shard head must reference an immutable semantic definition';
  END IF;

  IF NEW.active_snapshot_id IS NOT NULL THEN
    SELECT snapshot.state, snapshot.partition_version_id
    INTO snapshot_state, snapshot_partition_version_id
    FROM public.backstage_notion_shard_snapshots AS snapshot
    WHERE snapshot.universe_id = NEW.universe_id
      AND snapshot.shard_key = NEW.shard_key
      AND snapshot.id = NEW.active_snapshot_id
    FOR KEY SHARE;

    IF snapshot_state IS DISTINCT FROM 'sealed'
       OR snapshot_partition_version_id IS DISTINCT FROM NEW.current_partition_version_id THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        MESSAGE = 'shard head can only reference a sealed snapshot for its current definition';
    END IF;
  END IF;

  RETURN NEW;
END;
$function$;

-- Fresh installations receive the complete-manifest guard here; the additive
-- 20260829 migration upgrades databases that already installed storage v1.
CREATE OR REPLACE FUNCTION public.backstage_notion_guard_partitioned_universe_head()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $function$
DECLARE
  desired_state TEXT;
  manifest_state TEXT;
  manifest_configuration_version_id UUID;
  active_manifest_changed BOOLEAN;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION USING
      ERRCODE = '55000',
      MESSAGE = 'partitioned universe heads cannot be deleted';
  END IF;

  active_manifest_changed := TG_OP = 'INSERT';

  IF TG_OP = 'UPDATE' THEN
    active_manifest_changed := NEW.active_manifest_id IS DISTINCT FROM OLD.active_manifest_id;
    IF NEW.universe_id IS DISTINCT FROM OLD.universe_id THEN
      RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'partitioned universe head identity is immutable';
    END IF;

    IF OLD.active_manifest_id IS NOT NULL AND NEW.active_manifest_id IS NULL THEN
      RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'last-known-good universe manifests cannot be cleared';
    END IF;

    IF NEW.desired_configuration_version_id IS DISTINCT FROM OLD.desired_configuration_version_id
       OR NEW.desired_configuration_generation IS DISTINCT FROM OLD.desired_configuration_generation
       OR NEW.desired_configuration_hash IS DISTINCT FROM OLD.desired_configuration_hash
       OR NEW.active_manifest_id IS DISTINCT FROM OLD.active_manifest_id
       OR NEW.active_configuration_version_id IS DISTINCT FROM OLD.active_configuration_version_id THEN
      IF NEW.head_generation <> OLD.head_generation + 1 THEN
        RAISE EXCEPTION USING ERRCODE = '40001', MESSAGE = 'partitioned universe head compare-and-swap generation is stale';
      END IF;
    ELSIF NEW.head_generation <> OLD.head_generation THEN
      RAISE EXCEPTION USING ERRCODE = '40001', MESSAGE = 'universe head generation cannot advance without a pointer change';
    END IF;

    IF NEW.active_manifest_id IS DISTINCT FROM OLD.active_manifest_id THEN
      IF NEW.manifest_generation <> OLD.manifest_generation + 1 THEN
        RAISE EXCEPTION USING ERRCODE = '40001', MESSAGE = 'universe manifest generation is stale';
      END IF;
      IF NEW.active_configuration_version_id IS DISTINCT FROM NEW.desired_configuration_version_id THEN
        RAISE EXCEPTION USING
          ERRCODE = '23514',
          MESSAGE = 'a newly activated manifest must match the desired configuration';
      END IF;
    ELSIF NEW.manifest_generation <> OLD.manifest_generation THEN
      RAISE EXCEPTION USING ERRCODE = '40001', MESSAGE = 'manifest generation cannot advance without a manifest change';
    END IF;
  ELSIF NEW.active_manifest_id IS NULL THEN
    IF NEW.head_generation <> 0 OR NEW.manifest_generation <> 0 THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'an empty universe head starts at generation zero';
    END IF;
  ELSE
    IF NEW.head_generation <> 1 OR NEW.manifest_generation <> 1 THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'an initialized universe head starts at generation one';
    END IF;
    IF NEW.active_configuration_version_id IS DISTINCT FROM NEW.desired_configuration_version_id THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        MESSAGE = 'an initially active manifest must match the desired configuration';
    END IF;
  END IF;

  SELECT configuration.state
  INTO desired_state
  FROM public.backstage_notion_partition_configuration_versions AS configuration
  WHERE configuration.universe_id = NEW.universe_id
    AND configuration.id = NEW.desired_configuration_version_id
    AND configuration.configuration_generation = NEW.desired_configuration_generation
    AND configuration.configuration_hash = NEW.desired_configuration_hash
  FOR KEY SHARE;

  IF desired_state IS DISTINCT FROM 'sealed' THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'desired partition configuration must be sealed';
  END IF;

  IF NEW.active_manifest_id IS NOT NULL THEN
    SELECT manifest.state, manifest.partition_configuration_version_id
    INTO manifest_state, manifest_configuration_version_id
    FROM public.backstage_notion_universe_manifests AS manifest
    WHERE manifest.universe_id = NEW.universe_id
      AND manifest.id = NEW.active_manifest_id
    FOR KEY SHARE;

    IF manifest_state IS DISTINCT FROM 'sealed'
       OR manifest_configuration_version_id IS DISTINCT FROM NEW.active_configuration_version_id THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        MESSAGE = 'partitioned universe head can only reference a sealed exact manifest';
    END IF;

    IF active_manifest_changed THEN
      PERFORM 1
      FROM public.backstage_notion_universe_manifests AS manifest
      JOIN public.backstage_notion_partition_configuration_versions AS configuration
        ON configuration.universe_id = manifest.universe_id
       AND configuration.id = manifest.partition_configuration_version_id
       AND configuration.configuration_generation = manifest.configuration_generation
       AND configuration.configuration_hash = manifest.configuration_hash
      WHERE manifest.universe_id = NEW.universe_id
        AND manifest.id = NEW.active_manifest_id
        AND manifest.partition_configuration_version_id = NEW.active_configuration_version_id
        AND manifest.state = 'sealed'
        AND configuration.state = 'sealed'
        AND manifest.index_format_version = 1
        AND manifest.omission_count = 0
        AND manifest.member_count = configuration.shard_count
        AND NOT EXISTS (
          SELECT 1
          FROM public.backstage_notion_universe_manifest_omissions AS omission
          WHERE omission.universe_id = manifest.universe_id
            AND omission.manifest_id = manifest.id
        )
        AND (
          SELECT pg_catalog.count(*)
          FROM public.backstage_notion_universe_manifest_shards AS member
          WHERE member.universe_id = manifest.universe_id
            AND member.manifest_id = manifest.id
        ) = configuration.shard_count
        AND NOT EXISTS (
          SELECT 1
          FROM public.backstage_notion_partition_configuration_members AS configured
          LEFT JOIN public.backstage_notion_universe_manifest_shards AS member
            ON member.universe_id = configured.universe_id
           AND member.manifest_id = manifest.id
           AND member.shard_key = configured.shard_key
           AND member.partition_version_id = configured.partition_version_id
          LEFT JOIN public.backstage_notion_shard_snapshots AS snapshot
            ON snapshot.universe_id = member.universe_id
           AND snapshot.shard_key = member.shard_key
           AND snapshot.partition_version_id = member.partition_version_id
           AND snapshot.id = member.shard_snapshot_id
          WHERE configured.universe_id = manifest.universe_id
            AND configured.partition_configuration_version_id =
              manifest.partition_configuration_version_id
            AND (
              member.shard_key IS NULL
              OR member.decision <> 'fresh'
              OR snapshot.id IS NULL
              OR snapshot.state <> 'sealed'
              OR snapshot.sealed_at IS NULL
              OR manifest.source_generation_id IS NULL
              OR manifest.source_digest IS NULL
              OR manifest.source_verified_at IS NULL
              OR manifest.source_verification_hash IS NULL
              OR manifest.source_page_count IS DISTINCT FROM manifest.page_count
              OR manifest.source_chunk_count IS DISTINCT FROM manifest.chunk_count
              OR snapshot.source_generation_id IS DISTINCT FROM manifest.source_generation_id
              OR snapshot.embedding_model <> manifest.embedding_model
              OR snapshot.embedding_version <> manifest.embedding_version
              OR snapshot.embedding_dimension <> manifest.embedding_dimension
              OR snapshot.index_format_version <> manifest.index_format_version
            )
        );

      IF NOT FOUND THEN
        RAISE EXCEPTION USING
          ERRCODE = '23514',
          MESSAGE = 'partitioned universe head requires a complete readable fresh manifest';
      END IF;
    END IF;
  END IF;

  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.backstage_notion_guard_lease_fencing()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $function$
BEGIN
  IF TG_TABLE_NAME NOT IN (
    'backstage_notion_shard_sync_leases',
    'backstage_notion_provider_coordinator_leases'
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'lease fencing trigger attached to an unsupported table';
  END IF;

  IF TG_OP = 'DELETE' THEN
    IF OLD.expires_at > pg_catalog.statement_timestamp() THEN
      RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'an unexpired synchronization lease cannot be deleted';
    END IF;
    RETURN OLD;
  END IF;

  IF TG_OP = 'INSERT' THEN
    RETURN NEW;
  END IF;

  IF TG_TABLE_NAME = 'backstage_notion_shard_sync_leases' THEN
    IF NEW.universe_id IS DISTINCT FROM OLD.universe_id
       OR NEW.shard_key IS DISTINCT FROM OLD.shard_key THEN
      RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'shard lease identity is immutable';
    END IF;
  ELSE
    IF NEW.provider_key IS DISTINCT FROM OLD.provider_key
       OR NEW.model_key IS DISTINCT FROM OLD.model_key THEN
      RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'provider lease identity is immutable';
    END IF;
  END IF;

  IF NEW.lease_generation <> OLD.lease_generation + 1 THEN
    RAISE EXCEPTION USING ERRCODE = '40001', MESSAGE = 'lease compare-and-swap generation is stale';
  END IF;

  IF OLD.expires_at > pg_catalog.statement_timestamp() THEN
    IF NEW.holder_id IS DISTINCT FROM OLD.holder_id
       OR NEW.lease_token IS DISTINCT FROM OLD.lease_token THEN
      RAISE EXCEPTION USING ERRCODE = '55P03', MESSAGE = 'an unexpired lease cannot be taken over or rotated';
    END IF;
  ELSIF NEW.lease_token IS NOT DISTINCT FROM OLD.lease_token THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'an expired lease takeover requires a fresh token';
  END IF;

  RETURN NEW;
END;
$function$;

DO $block$
DECLARE
  expected RECORD;
BEGIN
  FOR expected IN
    SELECT *
    FROM (
      VALUES
        ('backstage_notion_partition_configuration_versions', 'backstage_notion_building_insert_guard', 'INSERT', 'backstage_notion_require_building_insert', 7),
        ('backstage_notion_partition_configuration_versions', 'backstage_notion_partition_configuration_seal_guard', 'UPDATE OR DELETE', 'backstage_notion_guard_partition_configuration_seal', 27),
        ('backstage_notion_partition_identities', 'backstage_notion_immutable_guard', 'UPDATE OR DELETE', 'backstage_notion_partition_reject_immutable_mutation', 27),
        ('backstage_notion_partition_versions', 'backstage_notion_immutable_guard', 'UPDATE OR DELETE', 'backstage_notion_partition_reject_immutable_mutation', 27),
        ('backstage_notion_partition_configuration_members', 'backstage_notion_partition_configuration_member_guard', 'INSERT OR UPDATE OR DELETE', 'backstage_notion_guard_partition_configuration_member_mutation', 31),
        ('backstage_notion_chunk_versions', 'backstage_notion_immutable_guard', 'UPDATE OR DELETE', 'backstage_notion_partition_reject_immutable_mutation', 27),
        ('backstage_notion_chunk_embeddings', 'backstage_notion_immutable_guard', 'UPDATE OR DELETE', 'backstage_notion_partition_reject_immutable_mutation', 27),
        ('backstage_notion_page_versions', 'backstage_notion_building_insert_guard', 'INSERT', 'backstage_notion_require_building_insert', 7),
        ('backstage_notion_page_versions', 'backstage_notion_page_version_seal_guard', 'UPDATE OR DELETE', 'backstage_notion_guard_page_version_seal', 27),
        ('backstage_notion_page_version_chunks', 'backstage_notion_page_chunk_guard', 'INSERT OR UPDATE OR DELETE', 'backstage_notion_guard_page_chunk_mutation', 31),
        ('backstage_notion_shard_snapshots', 'backstage_notion_building_insert_guard', 'INSERT', 'backstage_notion_require_building_insert', 7),
        ('backstage_notion_shard_snapshots', 'backstage_notion_shard_snapshot_seal_guard', 'UPDATE OR DELETE', 'backstage_notion_guard_shard_snapshot_seal', 27),
        ('backstage_notion_shard_snapshot_pages', 'backstage_notion_shard_snapshot_child_guard', 'INSERT OR UPDATE OR DELETE', 'backstage_notion_guard_shard_snapshot_child_mutation', 31),
        ('backstage_notion_shard_snapshot_chunk_occurrences', 'backstage_notion_shard_snapshot_child_guard', 'INSERT OR UPDATE OR DELETE', 'backstage_notion_guard_shard_snapshot_child_mutation', 31),
        ('backstage_notion_shard_snapshot_verifications', 'backstage_notion_shard_snapshot_child_guard', 'INSERT OR UPDATE OR DELETE', 'backstage_notion_guard_shard_snapshot_child_mutation', 31),
        ('backstage_notion_shard_heads', 'backstage_notion_shard_head_guard', 'INSERT OR UPDATE OR DELETE', 'backstage_notion_guard_shard_head', 31),
        ('backstage_notion_shard_sync_leases', 'backstage_notion_lease_fencing_guard', 'INSERT OR UPDATE OR DELETE', 'backstage_notion_guard_lease_fencing', 31),
        ('backstage_notion_provider_coordinator_leases', 'backstage_notion_lease_fencing_guard', 'INSERT OR UPDATE OR DELETE', 'backstage_notion_guard_lease_fencing', 31),
        ('backstage_notion_partition_source_generations', 'backstage_notion_immutable_guard', 'UPDATE OR DELETE', 'backstage_notion_partition_reject_immutable_mutation', 27),
        ('backstage_notion_universe_manifests', 'backstage_notion_building_insert_guard', 'INSERT', 'backstage_notion_require_building_insert', 7),
        ('backstage_notion_universe_manifests', 'backstage_notion_universe_manifest_seal_guard', 'UPDATE OR DELETE', 'backstage_notion_guard_universe_manifest_seal', 27),
        ('backstage_notion_universe_manifest_shards', 'backstage_notion_universe_manifest_child_guard', 'INSERT OR UPDATE OR DELETE', 'backstage_notion_guard_universe_manifest_child_mutation', 31),
        ('backstage_notion_universe_manifest_omissions', 'backstage_notion_universe_manifest_child_guard', 'INSERT OR UPDATE OR DELETE', 'backstage_notion_guard_universe_manifest_child_mutation', 31),
        ('backstage_notion_manifest_page_ownership', 'backstage_notion_universe_manifest_child_guard', 'INSERT OR UPDATE OR DELETE', 'backstage_notion_guard_universe_manifest_child_mutation', 31),
        ('backstage_notion_partitioned_universe_heads', 'backstage_notion_partitioned_universe_head_guard', 'INSERT OR UPDATE OR DELETE', 'backstage_notion_guard_partitioned_universe_head', 31)
    ) AS contract(table_name, trigger_name, events_sql, function_name, expected_type)
  LOOP
    IF NOT EXISTS (
      SELECT 1
      FROM pg_catalog.pg_trigger AS installed_trigger
      JOIN pg_catalog.pg_class AS relation ON relation.oid = installed_trigger.tgrelid
      JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
      WHERE namespace.nspname = 'public'
        AND relation.relname = expected.table_name
        AND installed_trigger.tgname = expected.trigger_name
        AND NOT installed_trigger.tgisinternal
    ) THEN
      EXECUTE pg_catalog.format(
        'CREATE TRIGGER %I BEFORE %s ON public.%I FOR EACH ROW EXECUTE FUNCTION public.%I()',
        expected.trigger_name,
        expected.events_sql,
        expected.table_name,
        expected.function_name
      );
    END IF;
  END LOOP;

  FOR expected IN
    SELECT *
    FROM (
      VALUES
        ('backstage_notion_partition_configuration_versions', 'backstage_notion_building_insert_guard', 'backstage_notion_require_building_insert', 7),
        ('backstage_notion_partition_configuration_versions', 'backstage_notion_partition_configuration_seal_guard', 'backstage_notion_guard_partition_configuration_seal', 27),
        ('backstage_notion_partition_identities', 'backstage_notion_immutable_guard', 'backstage_notion_partition_reject_immutable_mutation', 27),
        ('backstage_notion_partition_versions', 'backstage_notion_immutable_guard', 'backstage_notion_partition_reject_immutable_mutation', 27),
        ('backstage_notion_partition_configuration_members', 'backstage_notion_partition_configuration_member_guard', 'backstage_notion_guard_partition_configuration_member_mutation', 31),
        ('backstage_notion_chunk_versions', 'backstage_notion_immutable_guard', 'backstage_notion_partition_reject_immutable_mutation', 27),
        ('backstage_notion_chunk_embeddings', 'backstage_notion_immutable_guard', 'backstage_notion_partition_reject_immutable_mutation', 27),
        ('backstage_notion_page_versions', 'backstage_notion_building_insert_guard', 'backstage_notion_require_building_insert', 7),
        ('backstage_notion_page_versions', 'backstage_notion_page_version_seal_guard', 'backstage_notion_guard_page_version_seal', 27),
        ('backstage_notion_page_version_chunks', 'backstage_notion_page_chunk_guard', 'backstage_notion_guard_page_chunk_mutation', 31),
        ('backstage_notion_shard_snapshots', 'backstage_notion_building_insert_guard', 'backstage_notion_require_building_insert', 7),
        ('backstage_notion_shard_snapshots', 'backstage_notion_shard_snapshot_seal_guard', 'backstage_notion_guard_shard_snapshot_seal', 27),
        ('backstage_notion_shard_snapshot_pages', 'backstage_notion_shard_snapshot_child_guard', 'backstage_notion_guard_shard_snapshot_child_mutation', 31),
        ('backstage_notion_shard_snapshot_chunk_occurrences', 'backstage_notion_shard_snapshot_child_guard', 'backstage_notion_guard_shard_snapshot_child_mutation', 31),
        ('backstage_notion_shard_snapshot_verifications', 'backstage_notion_shard_snapshot_child_guard', 'backstage_notion_guard_shard_snapshot_child_mutation', 31),
        ('backstage_notion_shard_heads', 'backstage_notion_shard_head_guard', 'backstage_notion_guard_shard_head', 31),
        ('backstage_notion_shard_sync_leases', 'backstage_notion_lease_fencing_guard', 'backstage_notion_guard_lease_fencing', 31),
        ('backstage_notion_provider_coordinator_leases', 'backstage_notion_lease_fencing_guard', 'backstage_notion_guard_lease_fencing', 31),
        ('backstage_notion_partition_source_generations', 'backstage_notion_immutable_guard', 'backstage_notion_partition_reject_immutable_mutation', 27),
        ('backstage_notion_universe_manifests', 'backstage_notion_building_insert_guard', 'backstage_notion_require_building_insert', 7),
        ('backstage_notion_universe_manifests', 'backstage_notion_universe_manifest_seal_guard', 'backstage_notion_guard_universe_manifest_seal', 27),
        ('backstage_notion_universe_manifest_shards', 'backstage_notion_universe_manifest_child_guard', 'backstage_notion_guard_universe_manifest_child_mutation', 31),
        ('backstage_notion_universe_manifest_omissions', 'backstage_notion_universe_manifest_child_guard', 'backstage_notion_guard_universe_manifest_child_mutation', 31),
        ('backstage_notion_manifest_page_ownership', 'backstage_notion_universe_manifest_child_guard', 'backstage_notion_guard_universe_manifest_child_mutation', 31),
        ('backstage_notion_partitioned_universe_heads', 'backstage_notion_partitioned_universe_head_guard', 'backstage_notion_guard_partitioned_universe_head', 31)
    ) AS contract(table_name, trigger_name, function_name, expected_type)
  LOOP
    IF NOT EXISTS (
      SELECT 1
      FROM pg_catalog.pg_trigger AS installed_trigger
      JOIN pg_catalog.pg_class AS relation ON relation.oid = installed_trigger.tgrelid
      JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
      WHERE namespace.nspname = 'public'
        AND relation.relname = expected.table_name
        AND installed_trigger.tgname = expected.trigger_name
        AND installed_trigger.tgfoid = pg_catalog.to_regprocedure(
          pg_catalog.format('public.%I()', expected.function_name)
        )
        AND installed_trigger.tgtype = expected.expected_type
        AND installed_trigger.tgenabled = 'O'
        AND NOT installed_trigger.tgisinternal
    ) THEN
      RAISE EXCEPTION USING
        ERRCODE = '55000',
        MESSAGE = pg_catalog.format(
          'partition trigger contract mismatch for public.%I.%I',
          expected.table_name,
          expected.trigger_name
        );
    END IF;
  END LOOP;
END;
$block$;

COMMIT;
