-- Dedicated immutable Notion RAG storage for Backstage Booker.
-- A complete snapshot is inserted and made authoritative in one transaction;
-- prior successful snapshots remain available for audit and embedding reuse.

BEGIN;

CREATE TABLE IF NOT EXISTS backstage_notion_universe_heads (
  universe_id TEXT PRIMARY KEY,
  authority TEXT NOT NULL DEFAULT 'postgres',
  active_snapshot_id UUID,
  activated_at TIMESTAMPTZ,
  last_verified_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT ck_backstage_notion_heads_universe_id
    CHECK (universe_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
  CONSTRAINT ck_backstage_notion_heads_authority
    CHECK (authority IN ('postgres', 'notion')),
  CONSTRAINT ck_backstage_notion_heads_activation
    CHECK (
      (active_snapshot_id IS NULL AND activated_at IS NULL)
      OR (active_snapshot_id IS NOT NULL AND activated_at IS NOT NULL AND isfinite(activated_at))
    ),
  CONSTRAINT ck_backstage_notion_heads_notion_active
    CHECK (authority <> 'notion' OR active_snapshot_id IS NOT NULL),
  CONSTRAINT ck_backstage_notion_heads_verified_at
    CHECK (
      (last_verified_at IS NULL OR isfinite(last_verified_at))
      AND (authority <> 'notion' OR last_verified_at IS NOT NULL)
  )
);

CREATE TABLE IF NOT EXISTS backstage_notion_authority_epoch (
  singleton BOOLEAN PRIMARY KEY DEFAULT TRUE,
  epoch BIGINT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT ck_backstage_notion_authority_epoch_singleton
    CHECK (singleton),
  CONSTRAINT ck_backstage_notion_authority_epoch_value
    CHECK (epoch >= 0),
  CONSTRAINT ck_backstage_notion_authority_epoch_timestamps
    CHECK (isfinite(created_at) AND isfinite(updated_at))
);

INSERT INTO backstage_notion_authority_epoch (singleton, epoch)
VALUES (TRUE, 0)
ON CONFLICT (singleton) DO NOTHING;

CREATE TABLE IF NOT EXISTS backstage_notion_snapshots (
  id UUID PRIMARY KEY,
  universe_id TEXT NOT NULL,
  root_page_id TEXT NOT NULL,
  manifest_hash TEXT NOT NULL,
  embedding_model TEXT NOT NULL,
  page_count INTEGER NOT NULL,
  chunk_count INTEGER NOT NULL,
  source_max_edited_at TIMESTAMPTZ,
  sync_holder_id TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT uq_backstage_notion_snapshots_universe_id
    UNIQUE (universe_id, id),
  CONSTRAINT fk_backstage_notion_snapshots_head
    FOREIGN KEY (universe_id)
    REFERENCES backstage_notion_universe_heads(universe_id)
    ON DELETE RESTRICT
    ON UPDATE RESTRICT,
  CONSTRAINT ck_backstage_notion_snapshots_root_page_id
    CHECK (root_page_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),
  CONSTRAINT ck_backstage_notion_snapshots_manifest_hash
    CHECK (manifest_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT ck_backstage_notion_snapshots_embedding_model
    CHECK (char_length(btrim(embedding_model)) BETWEEN 1 AND 200),
  CONSTRAINT ck_backstage_notion_snapshots_counts
    CHECK (page_count BETWEEN 1 AND 5000 AND chunk_count BETWEEN 1 AND 50000),
  CONSTRAINT ck_backstage_notion_snapshots_source_edited
    CHECK (source_max_edited_at IS NULL OR isfinite(source_max_edited_at)),
  CONSTRAINT ck_backstage_notion_snapshots_holder
    CHECK (char_length(btrim(sync_holder_id)) BETWEEN 1 AND 200),
  CONSTRAINT ck_backstage_notion_snapshots_created_at
    CHECK (isfinite(created_at))
);

DO $$
BEGIN
  LOCK TABLE backstage_notion_universe_heads IN SHARE ROW EXCLUSIVE MODE;
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'backstage_notion_universe_heads'::regclass
      AND conname = 'fk_backstage_notion_heads_active_snapshot'
  ) THEN
    ALTER TABLE backstage_notion_universe_heads
      ADD CONSTRAINT fk_backstage_notion_heads_active_snapshot
      FOREIGN KEY (universe_id, active_snapshot_id)
      REFERENCES backstage_notion_snapshots(universe_id, id)
      ON DELETE RESTRICT
      ON UPDATE RESTRICT
      DEFERRABLE INITIALLY DEFERRED;
  END IF;
END
$$;

CREATE TABLE IF NOT EXISTS backstage_notion_snapshot_pages (
  snapshot_id UUID NOT NULL,
  universe_id TEXT NOT NULL,
  page_id TEXT NOT NULL,
  parent_page_id TEXT,
  title TEXT NOT NULL,
  canonical_url TEXT,
  content_hash TEXT NOT NULL,
  markdown TEXT NOT NULL,
  source_last_edited_at TIMESTAMPTZ,
  depth INTEGER NOT NULL,
  path JSONB NOT NULL DEFAULT '[]'::jsonb,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT pk_backstage_notion_snapshot_pages
    PRIMARY KEY (snapshot_id, page_id),
  CONSTRAINT uq_backstage_notion_pages_universe_id
    UNIQUE (universe_id, snapshot_id, page_id),
  CONSTRAINT fk_backstage_notion_pages_snapshot
    FOREIGN KEY (universe_id, snapshot_id)
    REFERENCES backstage_notion_snapshots(universe_id, id)
    ON DELETE RESTRICT
    ON UPDATE RESTRICT,
  CONSTRAINT fk_backstage_notion_pages_parent
    FOREIGN KEY (universe_id, snapshot_id, parent_page_id)
    REFERENCES backstage_notion_snapshot_pages(universe_id, snapshot_id, page_id)
    ON DELETE RESTRICT
    ON UPDATE RESTRICT
    DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT ck_backstage_notion_pages_page_id
    CHECK (page_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),
  CONSTRAINT ck_backstage_notion_pages_parent_page_id
    CHECK (
      parent_page_id IS NULL
      OR (
        parent_page_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        AND parent_page_id <> page_id
      )
    ),
  CONSTRAINT ck_backstage_notion_pages_title
    CHECK (char_length(btrim(title)) BETWEEN 1 AND 500),
  CONSTRAINT ck_backstage_notion_pages_url
    CHECK (canonical_url IS NULL OR char_length(canonical_url) BETWEEN 1 AND 4096),
  CONSTRAINT ck_backstage_notion_pages_content_hash
    CHECK (content_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT ck_backstage_notion_pages_markdown
    CHECK (octet_length(convert_to(markdown, 'UTF8')) <= 10485760),
  CONSTRAINT ck_backstage_notion_pages_source_edited
    CHECK (source_last_edited_at IS NULL OR isfinite(source_last_edited_at)),
  CONSTRAINT ck_backstage_notion_pages_depth
    CHECK (depth BETWEEN 0 AND 100),
  CONSTRAINT ck_backstage_notion_pages_path
    CHECK (
      jsonb_typeof(path) = 'array'
      AND jsonb_array_length(path) <= 101
      AND octet_length(convert_to(path::TEXT, 'UTF8')) <= 65536
    ),
  CONSTRAINT ck_backstage_notion_pages_metadata
    CHECK (
      jsonb_typeof(metadata) = 'object'
      AND octet_length(convert_to(metadata::TEXT, 'UTF8')) <= 262144
    )
);

CREATE TABLE IF NOT EXISTS backstage_notion_snapshot_chunks (
  id TEXT NOT NULL,
  snapshot_id UUID NOT NULL,
  universe_id TEXT NOT NULL,
  page_id TEXT NOT NULL,
  ordinal INTEGER NOT NULL,
  content_hash TEXT NOT NULL,
  content TEXT NOT NULL,
  code_points INTEGER NOT NULL,
  embedding_model TEXT NOT NULL,
  embedding JSONB NOT NULL,
  heading_path JSONB NOT NULL DEFAULT '[]'::jsonb,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT pk_backstage_notion_snapshot_chunks
    PRIMARY KEY (snapshot_id, id),
  CONSTRAINT uq_backstage_notion_chunks_position
    UNIQUE (snapshot_id, page_id, ordinal),
  CONSTRAINT fk_backstage_notion_chunks_page
    FOREIGN KEY (universe_id, snapshot_id, page_id)
    REFERENCES backstage_notion_snapshot_pages(universe_id, snapshot_id, page_id)
    ON DELETE RESTRICT
    ON UPDATE RESTRICT,
  CONSTRAINT ck_backstage_notion_chunks_id
    CHECK (id ~ '^[0-9a-f]{64}$'),
  CONSTRAINT ck_backstage_notion_chunks_ordinal
    CHECK (ordinal >= 0),
  CONSTRAINT ck_backstage_notion_chunks_content_hash
    CHECK (content_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT ck_backstage_notion_chunks_content
    CHECK (
      char_length(btrim(content)) > 0
      AND octet_length(convert_to(content, 'UTF8')) <= 131072
    ),
  CONSTRAINT ck_backstage_notion_chunks_code_points
    CHECK (code_points BETWEEN 1 AND 131072),
  CONSTRAINT ck_backstage_notion_chunks_embedding_model
    CHECK (char_length(btrim(embedding_model)) BETWEEN 1 AND 200),
  CONSTRAINT ck_backstage_notion_chunks_embedding
    CHECK (
      jsonb_typeof(embedding) = 'array'
      AND jsonb_array_length(embedding) BETWEEN 1 AND 8192
      AND octet_length(convert_to(embedding::TEXT, 'UTF8')) <= 524288
    ),
  CONSTRAINT ck_backstage_notion_chunks_heading_path
    CHECK (
      jsonb_typeof(heading_path) = 'array'
      AND jsonb_array_length(heading_path) <= 32
      AND octet_length(convert_to(heading_path::TEXT, 'UTF8')) <= 32768
    ),
  CONSTRAINT ck_backstage_notion_chunks_metadata
    CHECK (
      jsonb_typeof(metadata) = 'object'
      AND octet_length(convert_to(metadata::TEXT, 'UTF8')) <= 262144
  )
);

DO $$
DECLARE
  existing_primary_key_name TEXT;
  existing_primary_key_definition TEXT;
BEGIN
  LOCK TABLE backstage_notion_snapshot_chunks IN ACCESS EXCLUSIVE MODE;
  SELECT constraint_row.conname, pg_get_constraintdef(constraint_row.oid)
  INTO existing_primary_key_name, existing_primary_key_definition
  FROM pg_constraint AS constraint_row
  WHERE constraint_row.conrelid = 'backstage_notion_snapshot_chunks'::regclass
    AND constraint_row.contype = 'p';

  IF existing_primary_key_definition IS NULL THEN
    ALTER TABLE backstage_notion_snapshot_chunks
      ADD CONSTRAINT pk_backstage_notion_snapshot_chunks
      PRIMARY KEY (snapshot_id, id);
  ELSIF regexp_replace(existing_primary_key_definition, '[[:space:]]+', '', 'g')
    = 'PRIMARYKEY(id)' THEN
    EXECUTE format(
      'ALTER TABLE backstage_notion_snapshot_chunks DROP CONSTRAINT %I',
      existing_primary_key_name
    );
    ALTER TABLE backstage_notion_snapshot_chunks
      ADD CONSTRAINT pk_backstage_notion_snapshot_chunks
      PRIMARY KEY (snapshot_id, id);
  ELSIF regexp_replace(existing_primary_key_definition, '[[:space:]]+', '', 'g')
    <> 'PRIMARYKEY(snapshot_id,id)' THEN
    RAISE EXCEPTION 'backstage_notion_snapshot_chunks has an unexpected primary key definition'
      USING ERRCODE = '42804';
  END IF;
END
$$;

CREATE TABLE IF NOT EXISTS backstage_notion_sync_leases (
  universe_id TEXT PRIMARY KEY,
  holder_id TEXT NOT NULL,
  lease_token UUID NOT NULL UNIQUE,
  acquired_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  CONSTRAINT fk_backstage_notion_sync_leases_head
    FOREIGN KEY (universe_id)
    REFERENCES backstage_notion_universe_heads(universe_id)
    ON DELETE RESTRICT
    ON UPDATE RESTRICT,
  CONSTRAINT ck_backstage_notion_sync_leases_holder
    CHECK (char_length(btrim(holder_id)) BETWEEN 1 AND 200),
  CONSTRAINT ck_backstage_notion_sync_leases_times
    CHECK (isfinite(acquired_at) AND isfinite(expires_at) AND expires_at > acquired_at)
);

CREATE INDEX IF NOT EXISTS idx_backstage_notion_snapshots_universe_created
  ON backstage_notion_snapshots(universe_id, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_backstage_notion_pages_snapshot_depth
  ON backstage_notion_snapshot_pages(universe_id, snapshot_id, depth, page_id);
CREATE INDEX IF NOT EXISTS idx_backstage_notion_chunks_active_scan
  ON backstage_notion_snapshot_chunks(universe_id, snapshot_id, page_id, ordinal);
CREATE INDEX IF NOT EXISTS idx_backstage_notion_chunks_embedding_reuse
  ON backstage_notion_snapshot_chunks(universe_id, embedding_model, content_hash, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_backstage_notion_sync_leases_expiry
  ON backstage_notion_sync_leases(expires_at);

CREATE OR REPLACE FUNCTION backstage_notion_reject_immutable_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  RAISE EXCEPTION '% is immutable after insertion', TG_TABLE_NAME
    USING ERRCODE = '55000';
END
$$;

DO $$
DECLARE
  target_table TEXT;
  existing_trigger_function OID;
  existing_trigger_type SMALLINT;
  existing_trigger_enabled "char";
BEGIN
  FOREACH target_table IN ARRAY ARRAY[
    'backstage_notion_snapshots',
    'backstage_notion_snapshot_pages',
    'backstage_notion_snapshot_chunks'
  ]
  LOOP
    EXECUTE format(
      'LOCK TABLE %I IN SHARE ROW EXCLUSIVE MODE',
      target_table
    );
    existing_trigger_function := NULL;
    existing_trigger_type := NULL;
    existing_trigger_enabled := NULL;
    SELECT trigger_row.tgfoid, trigger_row.tgtype, trigger_row.tgenabled
      INTO existing_trigger_function, existing_trigger_type, existing_trigger_enabled
      FROM pg_trigger AS trigger_row
      WHERE trigger_row.tgrelid = target_table::regclass
        AND trigger_row.tgname = 'trg_backstage_notion_immutable'
        AND NOT trigger_row.tgisinternal;

    IF existing_trigger_function IS NULL THEN
      EXECUTE format(
        'CREATE TRIGGER trg_backstage_notion_immutable BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION backstage_notion_reject_immutable_mutation()',
        target_table
      );
    ELSIF existing_trigger_function <> 'backstage_notion_reject_immutable_mutation()'::regprocedure
      OR existing_trigger_type <> 27
      OR existing_trigger_enabled <> 'O'
    THEN
      RAISE EXCEPTION 'trg_backstage_notion_immutable on % has an unexpected definition', target_table
        USING ERRCODE = '42804';
    END IF;
  END LOOP;
END
$$;

CREATE OR REPLACE FUNCTION backstage_notion_guard_authority_persistence()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  old_root_page_id TEXT;
  new_root_page_id TEXT;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.authority = 'notion' THEN
      RAISE EXCEPTION 'Notion authority cannot be deleted for a Backstage universe'
        USING ERRCODE = 'BN001';
    END IF;
    RETURN OLD;
  END IF;

  IF OLD.authority = 'notion' AND NEW.authority IS DISTINCT FROM 'notion' THEN
    RAISE EXCEPTION 'Notion authority cannot be downgraded for a Backstage universe'
      USING ERRCODE = 'BN001';
  END IF;

  IF OLD.authority = 'notion'
    AND NEW.active_snapshot_id IS DISTINCT FROM OLD.active_snapshot_id
  THEN
    SELECT snapshot.root_page_id
      INTO old_root_page_id
      FROM public.backstage_notion_snapshots AS snapshot
      WHERE snapshot.universe_id = OLD.universe_id
        AND snapshot.id = OLD.active_snapshot_id;

    SELECT snapshot.root_page_id
      INTO new_root_page_id
      FROM public.backstage_notion_snapshots AS snapshot
      WHERE snapshot.universe_id = NEW.universe_id
        AND snapshot.id = NEW.active_snapshot_id;

    IF old_root_page_id IS NULL
      OR new_root_page_id IS NULL
      OR new_root_page_id IS DISTINCT FROM old_root_page_id
    THEN
      RAISE EXCEPTION 'Notion authority root cannot be changed for a Backstage universe'
        USING ERRCODE = 'BN001';
    END IF;
  END IF;

  RETURN NEW;
END
$$;

DO $$
DECLARE
  existing_trigger_function OID;
  existing_trigger_type SMALLINT;
  existing_trigger_enabled "char";
BEGIN
  LOCK TABLE backstage_notion_universe_heads IN SHARE ROW EXCLUSIVE MODE;
  SELECT trigger_row.tgfoid, trigger_row.tgtype, trigger_row.tgenabled
    INTO existing_trigger_function, existing_trigger_type, existing_trigger_enabled
    FROM pg_trigger AS trigger_row
    WHERE trigger_row.tgrelid = 'backstage_notion_universe_heads'::regclass
      AND trigger_row.tgname = 'trg_backstage_notion_authority_persistence'
      AND NOT trigger_row.tgisinternal;

  IF existing_trigger_function IS NULL THEN
    CREATE TRIGGER trg_backstage_notion_authority_persistence
      BEFORE UPDATE OR DELETE ON backstage_notion_universe_heads
      FOR EACH ROW
      EXECUTE FUNCTION backstage_notion_guard_authority_persistence();
  ELSIF existing_trigger_function = 'backstage_notion_guard_authority_persistence()'::regprocedure
    AND existing_trigger_type = 19
    AND existing_trigger_enabled = 'O'
  THEN
    DROP TRIGGER trg_backstage_notion_authority_persistence
      ON backstage_notion_universe_heads;
    CREATE TRIGGER trg_backstage_notion_authority_persistence
      BEFORE UPDATE OR DELETE ON backstage_notion_universe_heads
      FOR EACH ROW
      EXECUTE FUNCTION backstage_notion_guard_authority_persistence();
  ELSIF existing_trigger_function <> 'backstage_notion_guard_authority_persistence()'::regprocedure
    OR existing_trigger_type <> 27
    OR existing_trigger_enabled <> 'O'
  THEN
    RAISE EXCEPTION 'trg_backstage_notion_authority_persistence has an unexpected definition'
      USING ERRCODE = '42804';
  END IF;
END
$$;

CREATE OR REPLACE FUNCTION backstage_notion_guard_legacy_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  old_universe_id TEXT;
  new_universe_id TEXT;
  authority_epoch BIGINT;
  authority_row RECORD;
BEGIN
  IF TG_OP = 'INSERT' THEN
    new_universe_id := NEW.universe_id;
  ELSIF TG_OP = 'DELETE' THEN
    old_universe_id := OLD.universe_id;
  ELSE
    old_universe_id := OLD.universe_id;
    new_universe_id := NEW.universe_id;
  END IF;

  SELECT epoch_row.epoch
    INTO authority_epoch
    FROM public.backstage_notion_authority_epoch AS epoch_row
    WHERE epoch_row.singleton = TRUE
    FOR KEY SHARE;

  IF authority_epoch IS NULL THEN
    RAISE EXCEPTION 'Backstage Notion authority epoch is unavailable'
      USING ERRCODE = 'BN001';
  END IF;

  FOR authority_row IN
    SELECT head.authority
    FROM public.backstage_notion_universe_heads AS head
    WHERE head.universe_id IN (old_universe_id, new_universe_id)
    ORDER BY head.universe_id
    FOR SHARE
  LOOP
    IF authority_row.authority = 'notion' THEN
      RAISE EXCEPTION 'legacy Backstage writes are disabled for a Notion-authoritative universe'
        USING ERRCODE = 'BN001';
    END IF;
  END LOOP;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END
$$;

DO $$
DECLARE
  target_table TEXT;
  existing_trigger_function OID;
  existing_trigger_type SMALLINT;
  existing_trigger_enabled "char";
BEGIN
  FOREACH target_table IN ARRAY ARRAY[
    'backstage_events',
    'backstage_wrestlers',
    'backstage_storylines',
    'backstage_story_beats',
    'backstage_canon_heads',
    'backstage_canon_revisions',
    'backstage_storyline_threads',
    'backstage_storyline_participants',
    'backstage_storyline_canon_beats'
  ]
  LOOP
    EXECUTE format(
      'LOCK TABLE %I IN SHARE ROW EXCLUSIVE MODE',
      target_table
    );
    existing_trigger_function := NULL;
    existing_trigger_type := NULL;
    existing_trigger_enabled := NULL;
    SELECT trigger_row.tgfoid, trigger_row.tgtype, trigger_row.tgenabled
      INTO existing_trigger_function, existing_trigger_type, existing_trigger_enabled
      FROM pg_trigger AS trigger_row
      WHERE trigger_row.tgrelid = target_table::regclass
        AND trigger_row.tgname = 'trg_backstage_notion_authority_guard'
        AND NOT trigger_row.tgisinternal;

    IF existing_trigger_function IS NULL THEN
      EXECUTE format(
        'CREATE TRIGGER trg_backstage_notion_authority_guard BEFORE INSERT OR UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION backstage_notion_guard_legacy_mutation()',
        target_table
      );
    ELSIF existing_trigger_function <> 'backstage_notion_guard_legacy_mutation()'::regprocedure
      OR existing_trigger_type <> 31
      OR existing_trigger_enabled <> 'O'
    THEN
      RAISE EXCEPTION 'trg_backstage_notion_authority_guard on % has an unexpected definition', target_table
        USING ERRCODE = '42804';
    END IF;
  END LOOP;
END
$$;

COMMIT;
