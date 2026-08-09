-- Durable, source-attributable ARCANOS Gaming knowledge.
-- Legacy gaming_guides, gaming_builds, and gaming_meta remain untouched.

CREATE TABLE IF NOT EXISTS gaming_sources (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  game_key TEXT NOT NULL,
  game_name TEXT NOT NULL,
  canonical_url TEXT NOT NULL,
  canonical_url_hash TEXT NOT NULL,
  public_url TEXT NOT NULL,
  host TEXT NOT NULL,
  source_type TEXT NOT NULL,
  trust_score DOUBLE PRECISION NOT NULL DEFAULT 0.5,
  priority SMALLINT NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active',
  last_checked_at TIMESTAMPTZ,
  last_success_at TIMESTAMPTZ,
  next_refresh_at TIMESTAMPTZ,
  last_error_code TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_gaming_sources_game_url_hash
    UNIQUE (game_key, canonical_url_hash),
  CONSTRAINT ck_gaming_sources_game_key
    CHECK (char_length(btrim(game_key)) BETWEEN 1 AND 120),
  CONSTRAINT ck_gaming_sources_game_name
    CHECK (char_length(btrim(game_name)) BETWEEN 1 AND 120),
  CONSTRAINT ck_gaming_sources_canonical_url
    CHECK (char_length(canonical_url) BETWEEN 1 AND 4096),
  CONSTRAINT ck_gaming_sources_canonical_url_hash
    CHECK (canonical_url_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT ck_gaming_sources_public_url
    CHECK (char_length(public_url) BETWEEN 1 AND 4096),
  CONSTRAINT ck_gaming_sources_host
    CHECK (char_length(btrim(host)) BETWEEN 1 AND 253),
  CONSTRAINT ck_gaming_sources_source_type
    CHECK (source_type IN ('official', 'patch_notes', 'wiki', 'curated', 'supplied')),
  CONSTRAINT ck_gaming_sources_trust_score
    CHECK (trust_score BETWEEN 0 AND 1),
  CONSTRAINT ck_gaming_sources_priority
    CHECK (priority BETWEEN 0 AND 100),
  CONSTRAINT ck_gaming_sources_status
    CHECK (status IN ('active', 'degraded', 'disabled')),
  CONSTRAINT ck_gaming_sources_last_error_code
    CHECK (last_error_code IS NULL OR char_length(btrim(last_error_code)) BETWEEN 1 AND 120)
);

CREATE TABLE IF NOT EXISTS gaming_source_revisions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id UUID NOT NULL,
  content_hash TEXT NOT NULL,
  cleaned_content TEXT NOT NULL,
  etag TEXT,
  last_modified TEXT,
  fetched_at TIMESTAMPTZ NOT NULL,
  published_at TIMESTAMPTZ,
  patch TEXT,
  extractor TEXT NOT NULL,
  extractor_version TEXT NOT NULL,
  normalizer_schema_version TEXT NOT NULL,
  provenance JSONB NOT NULL DEFAULT '{}'::jsonb,
  extraction_metrics JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_gaming_source_revisions_identity
    UNIQUE (
      source_id,
      content_hash,
      extractor,
      extractor_version,
      normalizer_schema_version
    ),
  CONSTRAINT fk_gaming_source_revisions_source
    FOREIGN KEY (source_id)
    REFERENCES gaming_sources(id)
    ON DELETE CASCADE,
  CONSTRAINT ck_gaming_source_revisions_content_hash
    CHECK (content_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT ck_gaming_source_revisions_cleaned_content
    CHECK (char_length(btrim(cleaned_content)) BETWEEN 1 AND 1000000),
  CONSTRAINT ck_gaming_source_revisions_etag
    CHECK (etag IS NULL OR char_length(etag) BETWEEN 1 AND 1024),
  CONSTRAINT ck_gaming_source_revisions_last_modified
    CHECK (last_modified IS NULL OR char_length(last_modified) BETWEEN 1 AND 256),
  CONSTRAINT ck_gaming_source_revisions_patch
    CHECK (patch IS NULL OR char_length(btrim(patch)) BETWEEN 1 AND 120),
  CONSTRAINT ck_gaming_source_revisions_extractor
    CHECK (char_length(btrim(extractor)) BETWEEN 1 AND 120),
  CONSTRAINT ck_gaming_source_revisions_extractor_version
    CHECK (char_length(btrim(extractor_version)) BETWEEN 1 AND 120),
  CONSTRAINT ck_gaming_source_revisions_normalizer_schema_version
    CHECK (char_length(btrim(normalizer_schema_version)) BETWEEN 1 AND 120),
  CONSTRAINT ck_gaming_source_revisions_provenance
    CHECK (jsonb_typeof(provenance) = 'object'),
  CONSTRAINT ck_gaming_source_revisions_extraction_metrics
    CHECK (jsonb_typeof(extraction_metrics) = 'object')
);

CREATE TABLE IF NOT EXISTS gaming_knowledge_records (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_revision_id UUID NOT NULL,
  game_key TEXT NOT NULL,
  record_type TEXT NOT NULL,
  semantic_key TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  title TEXT,
  patch TEXT,
  search_text TEXT NOT NULL,
  normalized JSONB NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  superseded_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_gaming_knowledge_records_revision_semantic_payload
    UNIQUE (source_revision_id, semantic_key, payload_hash),
  CONSTRAINT fk_gaming_knowledge_records_revision
    FOREIGN KEY (source_revision_id)
    REFERENCES gaming_source_revisions(id)
    ON DELETE CASCADE,
  CONSTRAINT ck_gaming_knowledge_records_game_key
    CHECK (char_length(btrim(game_key)) BETWEEN 1 AND 120),
  CONSTRAINT ck_gaming_knowledge_records_type
    CHECK (record_type IN ('guide', 'build', 'meta')),
  CONSTRAINT ck_gaming_knowledge_records_semantic_key
    CHECK (char_length(btrim(semantic_key)) BETWEEN 1 AND 500),
  CONSTRAINT ck_gaming_knowledge_records_payload_hash
    CHECK (payload_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT ck_gaming_knowledge_records_title
    CHECK (title IS NULL OR char_length(btrim(title)) BETWEEN 1 AND 500),
  CONSTRAINT ck_gaming_knowledge_records_patch
    CHECK (patch IS NULL OR char_length(btrim(patch)) BETWEEN 1 AND 120),
  CONSTRAINT ck_gaming_knowledge_records_search_text
    CHECK (char_length(btrim(search_text)) BETWEEN 1 AND 100000),
  CONSTRAINT ck_gaming_knowledge_records_normalized
    CHECK (jsonb_typeof(normalized) = 'object'),
  CONSTRAINT ck_gaming_knowledge_records_status
    CHECK (status IN ('active', 'superseded')),
  CONSTRAINT ck_gaming_knowledge_records_superseded_at
    CHECK (
      (status = 'active' AND superseded_at IS NULL)
      OR (status = 'superseded' AND superseded_at IS NOT NULL)
    )
);

CREATE INDEX IF NOT EXISTS idx_gaming_sources_game_status_type
  ON gaming_sources(game_key, status, source_type, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_gaming_source_revisions_source_fetched
  ON gaming_source_revisions(source_id, fetched_at DESC);

CREATE INDEX IF NOT EXISTS idx_gaming_knowledge_game_type_status_patch
  ON gaming_knowledge_records(game_key, record_type, status, patch);

CREATE INDEX IF NOT EXISTS idx_gaming_knowledge_semantic_status
  ON gaming_knowledge_records(game_key, semantic_key, status);

CREATE INDEX IF NOT EXISTS idx_gaming_knowledge_active_search
  ON gaming_knowledge_records
  USING GIN (to_tsvector('simple'::regconfig, search_text))
  WHERE status = 'active';
