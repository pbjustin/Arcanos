-- Destructive rollback. Drain every compatible stats reader and writer first.
-- This ordinary DROP is kept in the same transaction as the catalog guard so an
-- unexpected same-name object can never replace the verified migration index.

DO $$
DECLARE
  index_oid OID;
  index_schema TEXT;
  indexed_table_oid OID;
  relation_kind "char";
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
  column_type OID;
  column_type_modifier INTEGER;
  column_not_null BOOLEAN;
  column_generated "char";
  column_identity "char";
  column_has_default BOOLEAN;
  stats_collation OID;
  updated_collation OID;
  stats_opclass OID;
  updated_opclass OID;
BEGIN
  LOCK TABLE job_data IN ACCESS EXCLUSIVE MODE;

  SELECT attnum, atttypid, atttypmod, attcollation, attnotnull,
         attgenerated, attidentity, atthasdef
  INTO stats_attribute, column_type, column_type_modifier, stats_collation,
       column_not_null, column_generated, column_identity, column_has_default
  FROM pg_attribute
  WHERE attrelid = 'job_data'::regclass
    AND attname = 'stats_worker_id'
    AND NOT attisdropped;

  IF column_type IS NOT NULL AND (
    column_type IS DISTINCT FROM 'varchar'::regtype
    OR column_type_modifier IS DISTINCT FROM 259
    OR stats_collation IS DISTINCT FROM '"C"'::regcollation
    OR column_not_null IS DISTINCT FROM FALSE
    OR column_generated IS DISTINCT FROM ''::"char"
    OR column_identity IS DISTINCT FROM ''::"char"
    OR column_has_default IS DISTINCT FROM FALSE
  ) THEN
    RAISE EXCEPTION
      'job_data.stats_worker_id has an unexpected definition; rollback refused'
      USING ERRCODE = '42804';
  END IF;

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

  SELECT c.oid, namespace.nspname, i.indrelid, c.relkind, i.indislive,
         i.indisunique, i.indisprimary, i.indisexclusion, am.amname,
         i.indnkeyatts, i.indnatts, i.indkey::text,
         i.indcollation::text, i.indclass::text, i.indoption::text,
         regexp_replace(pg_get_expr(i.indpred, i.indrelid), '[()]', '', 'g'),
         pg_get_indexdef(c.oid, 1, true),
         pg_get_indexdef(c.oid, 2, true)
  INTO index_oid, index_schema, indexed_table_oid, relation_kind, index_live,
       index_unique, index_primary, index_exclusion, access_method,
       key_attribute_count, total_attribute_count, indexed_columns,
       index_collations, index_opclasses, index_options, index_predicate,
       first_key_definition, second_key_definition
  FROM pg_class AS c
  INNER JOIN pg_namespace AS namespace ON namespace.oid = c.relnamespace
  INNER JOIN pg_class AS table_class
    ON table_class.oid = 'job_data'::regclass
   AND table_class.relnamespace = c.relnamespace
  LEFT JOIN pg_index AS i ON i.indexrelid = c.oid
  LEFT JOIN pg_am AS am ON am.oid = c.relam
  WHERE c.relname = 'idx_job_data_stats_worker_updated'
  LIMIT 1;

  IF index_oid IS NOT NULL AND (
    column_type IS NULL
    OR indexed_table_oid IS DISTINCT FROM 'job_data'::regclass
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
      'idx_job_data_stats_worker_updated has an unexpected definition; rollback refused'
      USING ERRCODE = '42804';
  END IF;

  IF column_type IS NOT NULL THEN
    IF EXISTS (SELECT 1 FROM job_data WHERE stats_worker_id IS NOT NULL) THEN
      RAISE EXCEPTION
        'job_data.stats_worker_id contains accounting history; rollback refused'
        USING ERRCODE = '55000';
    END IF;

    IF EXISTS (
      SELECT 1
      FROM pg_depend
      WHERE refclassid = 'pg_class'::regclass
        AND refobjid = 'job_data'::regclass
        AND refobjsubid = stats_attribute
        AND NOT (
          index_oid IS NOT NULL
          AND classid = 'pg_class'::regclass
          AND objid = index_oid
        )
    ) THEN
      RAISE EXCEPTION
        'job_data.stats_worker_id has unexpected dependent objects; rollback refused'
        USING ERRCODE = '55000';
    END IF;
  END IF;

  IF index_oid IS NULL THEN
    RETURN;
  END IF;

  EXECUTE format('DROP INDEX %I.%I', index_schema, 'idx_job_data_stats_worker_updated');
END
$$;
