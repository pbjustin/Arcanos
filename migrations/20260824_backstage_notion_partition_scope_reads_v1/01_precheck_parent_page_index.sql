-- Refuse to hide an unexpected same-name object behind IF NOT EXISTS.

DO $block$
DECLARE
  index_oid OID;
  indexed_table_oid OID;
  relation_kind "char";
  index_valid BOOLEAN;
  index_ready BOOLEAN;
  index_live BOOLEAN;
  index_unique BOOLEAN;
  index_primary BOOLEAN;
  index_exclusion BOOLEAN;
  access_method TEXT;
  key_attribute_count SMALLINT;
  total_attribute_count SMALLINT;
  indexed_columns TEXT;
  index_collations TEXT;
  index_opclasses TEXT;
  index_options TEXT;
  index_predicate TEXT;
  expected_columns TEXT;
  expected_collations TEXT;
  expected_opclasses TEXT;
  key_definitions TEXT[];
BEGIN
  SELECT
    pg_catalog.format('%s %s %s %s %s',
      universe.attnum, shard.attnum, snapshot.attnum, parent.attnum, page.attnum),
    pg_catalog.format('%s %s %s %s %s',
      universe.attcollation, shard.attcollation, snapshot.attcollation,
      parent.attcollation, page.attcollation)
  INTO expected_columns, expected_collations
  FROM pg_catalog.pg_attribute AS universe
  JOIN pg_catalog.pg_attribute AS shard
    ON shard.attrelid = universe.attrelid AND shard.attname = 'shard_key'
  JOIN pg_catalog.pg_attribute AS snapshot
    ON snapshot.attrelid = universe.attrelid AND snapshot.attname = 'shard_snapshot_id'
  JOIN pg_catalog.pg_attribute AS parent
    ON parent.attrelid = universe.attrelid AND parent.attname = 'parent_page_id'
  JOIN pg_catalog.pg_attribute AS page
    ON page.attrelid = universe.attrelid AND page.attname = 'page_id'
  WHERE universe.attrelid =
      'public.backstage_notion_shard_snapshot_pages'::pg_catalog.regclass
    AND universe.attname = 'universe_id'
    AND NOT universe.attisdropped
    AND NOT shard.attisdropped
    AND NOT snapshot.attisdropped
    AND NOT parent.attisdropped
    AND NOT page.attisdropped;

  SELECT pg_catalog.format('%s %s %s %s %s',
    text_class.oid, text_class.oid, uuid_class.oid, uuid_class.oid, uuid_class.oid)
  INTO expected_opclasses
  FROM pg_catalog.pg_opclass AS text_class
  CROSS JOIN pg_catalog.pg_opclass AS uuid_class
  WHERE text_class.opcmethod = (
      SELECT oid FROM pg_catalog.pg_am WHERE amname = 'btree'
    )
    AND text_class.opcnamespace = 'pg_catalog'::pg_catalog.regnamespace
    AND text_class.opcname = 'text_ops'
    AND uuid_class.opcmethod = text_class.opcmethod
    AND uuid_class.opcnamespace = 'pg_catalog'::pg_catalog.regnamespace
    AND uuid_class.opcname = 'uuid_ops';

  SELECT
    class.oid,
    index_data.indrelid,
    class.relkind,
    index_data.indisvalid,
    index_data.indisready,
    index_data.indislive,
    index_data.indisunique,
    index_data.indisprimary,
    index_data.indisexclusion,
    method.amname,
    index_data.indnkeyatts,
    index_data.indnatts,
    index_data.indkey::TEXT,
    index_data.indcollation::TEXT,
    index_data.indclass::TEXT,
    index_data.indoption::TEXT,
    pg_catalog.btrim(pg_catalog.regexp_replace(
      pg_catalog.pg_get_expr(index_data.indpred, index_data.indrelid),
      '[()]', '', 'g'
    )),
    ARRAY(
      SELECT pg_catalog.pg_get_indexdef(class.oid, position, TRUE)
      FROM pg_catalog.generate_series(1, 5) AS position
      ORDER BY position
    )
  INTO
    index_oid, indexed_table_oid, relation_kind, index_valid, index_ready,
    index_live, index_unique, index_primary, index_exclusion, access_method,
    key_attribute_count, total_attribute_count, indexed_columns,
    index_collations, index_opclasses, index_options, index_predicate,
    key_definitions
  FROM pg_catalog.pg_class AS class
  JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = class.relnamespace
  LEFT JOIN pg_catalog.pg_index AS index_data ON index_data.indexrelid = class.oid
  LEFT JOIN pg_catalog.pg_am AS method ON method.oid = class.relam
  WHERE namespace.nspname = 'public'
    AND class.relname = 'idx_backstage_notion_shard_snapshot_pages_parent'
  LIMIT 1;

  IF expected_columns IS NULL OR expected_opclasses IS NULL THEN
    RAISE EXCEPTION 'scope-read index prerequisite schema is missing'
      USING ERRCODE = '42804';
  END IF;

  IF index_oid IS NOT NULL AND (
    indexed_table_oid IS DISTINCT FROM
      'public.backstage_notion_shard_snapshot_pages'::pg_catalog.regclass
    OR relation_kind IS DISTINCT FROM 'i'::"char"
    OR index_live IS DISTINCT FROM TRUE
    OR index_unique IS DISTINCT FROM FALSE
    OR index_primary IS DISTINCT FROM FALSE
    OR index_exclusion IS DISTINCT FROM FALSE
    OR access_method IS DISTINCT FROM 'btree'
    OR key_attribute_count IS DISTINCT FROM 5
    OR total_attribute_count IS DISTINCT FROM 5
    OR indexed_columns IS DISTINCT FROM expected_columns
    OR index_collations IS DISTINCT FROM expected_collations
    OR index_opclasses IS DISTINCT FROM expected_opclasses
    OR index_options IS DISTINCT FROM '0 0 0 0 0'
    OR index_predicate IS DISTINCT FROM 'parent_page_id IS NOT NULL'
    OR key_definitions IS DISTINCT FROM ARRAY[
      'universe_id', 'shard_key', 'shard_snapshot_id', 'parent_page_id', 'page_id'
    ]::TEXT[]
  ) THEN
    RAISE EXCEPTION 'scope-read parent index has an unexpected definition'
      USING ERRCODE = '42804';
  END IF;

  IF index_oid IS NOT NULL AND (
    index_valid IS DISTINCT FROM TRUE OR index_ready IS DISTINCT FROM TRUE
  ) THEN
    RAISE EXCEPTION 'scope-read parent index is exact but invalid; run guarded recovery'
      USING ERRCODE = '55000';
  END IF;
END
$block$;
