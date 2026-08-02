-- Refuse to hide an unexpected same-name index behind IF NOT EXISTS.

DO $$
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
  first_key_definition TEXT;
  second_key_definition TEXT;
  stats_attribute SMALLINT;
  updated_attribute SMALLINT;
  stats_collation OID;
  updated_collation OID;
  stats_opclass OID;
  updated_opclass OID;
BEGIN
  SELECT attnum, attcollation INTO stats_attribute, stats_collation
  FROM pg_attribute
  WHERE attrelid = 'job_data'::regclass
    AND attname = 'stats_worker_id'
    AND NOT attisdropped;

  SELECT attnum, attcollation INTO updated_attribute, updated_collation
  FROM pg_attribute
  WHERE attrelid = 'job_data'::regclass
    AND attname = 'updated_at'
    AND NOT attisdropped;

  SELECT oid INTO stats_opclass
  FROM pg_opclass
  WHERE opcmethod = (SELECT oid FROM pg_am WHERE amname = 'btree')
    AND opcnamespace = 'pg_catalog'::regnamespace
    AND opcname = 'text_ops';

  SELECT oid INTO updated_opclass
  FROM pg_opclass
  WHERE opcmethod = (SELECT oid FROM pg_am WHERE amname = 'btree')
    AND opcnamespace = 'pg_catalog'::regnamespace
    AND opcname = 'timestamptz_ops';

  SELECT c.oid, i.indrelid, c.relkind,
         i.indisvalid, i.indisready, i.indislive, i.indisunique, i.indisprimary,
         i.indisexclusion, am.amname, i.indnkeyatts, i.indnatts,
         i.indkey::text, i.indcollation::text, i.indclass::text, i.indoption::text,
         regexp_replace(pg_get_expr(i.indpred, i.indrelid), '[()]', '', 'g'),
         pg_get_indexdef(c.oid, 1, true),
         pg_get_indexdef(c.oid, 2, true)
  INTO index_oid, indexed_table_oid, relation_kind,
       index_valid, index_ready, index_live, index_unique, index_primary,
       index_exclusion, access_method, key_attribute_count, total_attribute_count,
       indexed_columns, index_collations, index_opclasses, index_options, index_predicate,
       first_key_definition, second_key_definition
  FROM pg_class AS c
  INNER JOIN pg_class AS table_class
    ON table_class.oid = 'job_data'::regclass
   AND table_class.relnamespace = c.relnamespace
  LEFT JOIN pg_index AS i ON i.indexrelid = c.oid
  LEFT JOIN pg_am AS am ON am.oid = c.relam
  WHERE c.relname = 'idx_job_data_stats_worker_updated'
  LIMIT 1;

  IF index_oid IS NOT NULL AND (
    indexed_table_oid IS DISTINCT FROM 'job_data'::regclass
    OR relation_kind IS DISTINCT FROM 'i'::"char"
    OR index_live IS DISTINCT FROM TRUE
    OR index_unique IS DISTINCT FROM FALSE
    OR index_primary IS DISTINCT FROM FALSE
    OR index_exclusion IS DISTINCT FROM FALSE
    OR access_method IS DISTINCT FROM 'btree'
    OR key_attribute_count IS DISTINCT FROM 2
    OR total_attribute_count IS DISTINCT FROM 2
    OR indexed_columns IS DISTINCT FROM format('%s %s', stats_attribute, updated_attribute)
    OR index_collations IS DISTINCT FROM format('%s %s', stats_collation, updated_collation)
    OR index_opclasses IS DISTINCT FROM format('%s %s', stats_opclass, updated_opclass)
    OR index_options IS DISTINCT FROM '0 0'
    OR btrim(index_predicate) IS DISTINCT FROM 'stats_worker_id IS NOT NULL'
    OR first_key_definition IS DISTINCT FROM 'stats_worker_id'
    OR second_key_definition IS DISTINCT FROM 'updated_at'
  ) THEN
    RAISE EXCEPTION
      'idx_job_data_stats_worker_updated has an unexpected definition'
      USING ERRCODE = '42804';
  END IF;

  IF index_oid IS NOT NULL AND (
    index_valid IS DISTINCT FROM TRUE
    OR index_ready IS DISTINCT FROM TRUE
  ) THEN
    RAISE EXCEPTION
      'idx_job_data_stats_worker_updated is exact but not ready and valid; run the guarded invalid-index recovery'
      USING ERRCODE = '55000';
  END IF;
END
$$;
