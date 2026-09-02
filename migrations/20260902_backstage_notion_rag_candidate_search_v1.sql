-- Additive native search material for immutable monolith Notion snapshots.
--
-- This migration deliberately does not backfill historical snapshots. New
-- writers populate this derived table in the same transaction as canonical
-- snapshot rows. Operators may populate one explicitly selected immutable
-- snapshot with the bounded, idempotent backfill script after deploying this
-- schema. Until that snapshot is complete, the new reader fails closed.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

CREATE OR REPLACE FUNCTION public.backstage_notion_candidate_embedding_from_jsonb(
  source_embedding JSONB
)
RETURNS DOUBLE PRECISION[]
LANGUAGE plpgsql
IMMUTABLE
STRICT
PARALLEL SAFE
SET search_path = pg_catalog, public
AS $function$
DECLARE
  component JSONB;
  parsed_component DOUBLE PRECISION;
  native_embedding DOUBLE PRECISION[] := ARRAY[]::DOUBLE PRECISION[];
BEGIN
  IF pg_catalog.jsonb_typeof(source_embedding) <> 'array'
     OR pg_catalog.jsonb_array_length(source_embedding) NOT BETWEEN 1 AND 8192 THEN
    RETURN NULL;
  END IF;

  FOR component IN
    SELECT element.value
    FROM pg_catalog.jsonb_array_elements(source_embedding)
      WITH ORDINALITY AS element(value, position)
    ORDER BY element.position
  LOOP
    IF pg_catalog.jsonb_typeof(component) <> 'number' THEN
      RETURN NULL;
    END IF;
    BEGIN
      parsed_component := (component #>> '{}')::DOUBLE PRECISION;
    EXCEPTION
      WHEN numeric_value_out_of_range OR invalid_text_representation THEN
        RETURN NULL;
    END;
    IF parsed_component <= '-Infinity'::DOUBLE PRECISION
       OR parsed_component >= 'Infinity'::DOUBLE PRECISION
       OR parsed_component = 'NaN'::DOUBLE PRECISION THEN
      RETURN NULL;
    END IF;
    native_embedding := pg_catalog.array_append(native_embedding, parsed_component);
  END LOOP;

  RETURN native_embedding;
END;
$function$;

CREATE OR REPLACE FUNCTION public.backstage_notion_candidate_embedding_norm(
  native_embedding DOUBLE PRECISION[]
)
RETURNS DOUBLE PRECISION
LANGUAGE plpgsql
IMMUTABLE
STRICT
PARALLEL SAFE
SET search_path = pg_catalog, public
AS $function$
DECLARE
  component DOUBLE PRECISION;
  squared_norm DOUBLE PRECISION := 0;
  resolved_norm DOUBLE PRECISION;
BEGIN
  IF pg_catalog.array_ndims(native_embedding) <> 1
     OR pg_catalog.array_lower(native_embedding, 1) <> 1
     OR pg_catalog.cardinality(native_embedding) NOT BETWEEN 1 AND 8192 THEN
    RETURN NULL;
  END IF;

  FOREACH component IN ARRAY native_embedding LOOP
    IF component IS NULL
       OR component <= '-Infinity'::DOUBLE PRECISION
       OR component >= 'Infinity'::DOUBLE PRECISION
       OR component = 'NaN'::DOUBLE PRECISION THEN
      RETURN NULL;
    END IF;
    squared_norm := squared_norm + (component * component);
    IF squared_norm >= 'Infinity'::DOUBLE PRECISION
       OR squared_norm = 'NaN'::DOUBLE PRECISION THEN
      RETURN NULL;
    END IF;
  END LOOP;
  IF squared_norm <= 0 THEN
    RETURN NULL;
  END IF;

  BEGIN
    resolved_norm := pg_catalog.sqrt(squared_norm);
  EXCEPTION
    WHEN numeric_value_out_of_range THEN
      RETURN NULL;
  END;
  IF resolved_norm <= 0
     OR resolved_norm >= 'Infinity'::DOUBLE PRECISION
     OR resolved_norm = 'NaN'::DOUBLE PRECISION THEN
    RETURN NULL;
  END IF;
  RETURN resolved_norm;
END;
$function$;

CREATE OR REPLACE FUNCTION public.backstage_notion_candidate_search_vector(
  chunk_content TEXT,
  page_title TEXT,
  page_path JSONB,
  heading_path JSONB,
  category TEXT
)
RETURNS TSVECTOR
LANGUAGE SQL
IMMUTABLE
STRICT
PARALLEL SAFE
SET search_path = pg_catalog, public
AS $function$
  SELECT pg_catalog.to_tsvector(
    'simple'::pg_catalog.regconfig,
    pg_catalog.concat_ws(
      ' ',
      chunk_content,
      page_title,
      page_path::TEXT,
      heading_path::TEXT,
      category
    )
  );
$function$;

CREATE OR REPLACE FUNCTION public.backstage_notion_candidate_brand_mask(
  page_title TEXT,
  page_path JSONB,
  heading_path JSONB,
  category TEXT
)
RETURNS SMALLINT
LANGUAGE SQL
IMMUTABLE
STRICT
PARALLEL SAFE
SET search_path = pg_catalog, public
AS $function$
  SELECT (
    (CASE WHEN scope_signal ~ '(^|[^[:alnum:]])raw([^[:alnum:]]|$)'
      THEN 1 ELSE 0 END)
    + (CASE WHEN scope_signal
        ~ '(^|[^[:alnum:]])smack([[:space:]-]?down)([^[:alnum:]]|$)'
      THEN 2 ELSE 0 END)
    + (CASE WHEN scope_signal ~ '(^|[^[:alnum:]])nxt([^[:alnum:]]|$)'
      THEN 4 ELSE 0 END)
  )::SMALLINT
  FROM (
    SELECT pg_catalog.lower(pg_catalog.concat_ws(
      ' ', page_title, page_path::TEXT, heading_path::TEXT, category
    )) AS scope_signal
  ) AS normalized;
$function$;

CREATE TABLE IF NOT EXISTS public.backstage_notion_snapshot_chunk_search (
  universe_id TEXT NOT NULL,
  snapshot_id UUID NOT NULL,
  chunk_id TEXT NOT NULL,
  page_id TEXT NOT NULL,
  ordinal INTEGER NOT NULL,
  embedding_model TEXT NOT NULL,
  embedding_dimension INTEGER NOT NULL,
  embedding_norm DOUBLE PRECISION NOT NULL,
  embedding DOUBLE PRECISION[] NOT NULL,
  search_vector TSVECTOR NOT NULL,
  booking_brand_mask SMALLINT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT pk_backstage_notion_snapshot_chunk_search
    PRIMARY KEY (snapshot_id, chunk_id),
  CONSTRAINT uq_backstage_notion_snapshot_chunk_search_position
    UNIQUE (snapshot_id, page_id, ordinal),
  CONSTRAINT fk_backstage_notion_snapshot_chunk_search_snapshot
    FOREIGN KEY (universe_id, snapshot_id)
    REFERENCES public.backstage_notion_snapshots(universe_id, id)
    ON DELETE RESTRICT
    ON UPDATE RESTRICT,
  CONSTRAINT fk_backstage_notion_snapshot_chunk_search_chunk
    FOREIGN KEY (snapshot_id, chunk_id)
    REFERENCES public.backstage_notion_snapshot_chunks(snapshot_id, id)
    ON DELETE RESTRICT
    ON UPDATE RESTRICT,
  CONSTRAINT ck_backstage_notion_snapshot_chunk_search_chunk_id
    CHECK (chunk_id ~ '^[0-9a-f]{64}$'),
  CONSTRAINT ck_backstage_notion_snapshot_chunk_search_page_id
    CHECK (page_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),
  CONSTRAINT ck_backstage_notion_snapshot_chunk_search_ordinal
    CHECK (ordinal >= 0),
  CONSTRAINT ck_backstage_notion_snapshot_chunk_search_model
    CHECK (pg_catalog.length(pg_catalog.btrim(embedding_model)) BETWEEN 1 AND 200),
  CONSTRAINT ck_backstage_notion_snapshot_chunk_search_embedding
    CHECK (
      embedding_dimension BETWEEN 1 AND 8192
      AND pg_catalog.array_ndims(embedding) = 1
      AND pg_catalog.array_lower(embedding, 1) = 1
      AND pg_catalog.cardinality(embedding) = embedding_dimension
      AND public.backstage_notion_candidate_embedding_norm(embedding) IS NOT NULL
      AND embedding_norm > 0::DOUBLE PRECISION
      AND embedding_norm < 'Infinity'::DOUBLE PRECISION
      AND embedding_norm <> 'NaN'::DOUBLE PRECISION
      AND pg_catalog.abs(
        public.backstage_notion_candidate_embedding_norm(embedding) - embedding_norm
      ) <= GREATEST(
        1e-12::DOUBLE PRECISION,
        embedding_norm * 1e-9::DOUBLE PRECISION
      )
    ),
  CONSTRAINT ck_backstage_notion_snapshot_chunk_search_brand_mask
    CHECK (booking_brand_mask BETWEEN 0 AND 7),
  CONSTRAINT ck_backstage_notion_snapshot_chunk_search_created_at
    CHECK (pg_catalog.isfinite(created_at))
);

-- The table is new and empty at schema-install time, so building these indexes
-- inside the migration does not scan or lock the canonical chunk table.
CREATE INDEX IF NOT EXISTS idx_backstage_notion_snapshot_chunk_search_scope
  ON public.backstage_notion_snapshot_chunk_search(
    universe_id,
    snapshot_id,
    page_id,
    ordinal,
    chunk_id
  );
CREATE INDEX IF NOT EXISTS idx_backstage_notion_snapshot_chunk_search_model
  ON public.backstage_notion_snapshot_chunk_search(
    universe_id,
    snapshot_id,
    embedding_model,
    embedding_dimension,
    chunk_id
  );
CREATE INDEX IF NOT EXISTS idx_backstage_notion_snapshot_chunk_search_lexical
  ON public.backstage_notion_snapshot_chunk_search USING GIN (search_vector);

DROP TRIGGER IF EXISTS trg_backstage_notion_immutable
  ON public.backstage_notion_snapshot_chunk_search;
CREATE TRIGGER trg_backstage_notion_immutable
  BEFORE UPDATE OR DELETE ON public.backstage_notion_snapshot_chunk_search
  FOR EACH ROW
  EXECUTE FUNCTION public.backstage_notion_reject_immutable_mutation();

COMMIT;
