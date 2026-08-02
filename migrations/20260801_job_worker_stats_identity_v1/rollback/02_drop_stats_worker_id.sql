-- Destructive rollback: after all compatible readers and writers are drained,
-- remove only the reviewed nullable VARCHAR(255) COLLATE "C" column.

DO $$
DECLARE
  column_attribute SMALLINT;
  column_type OID;
  column_type_modifier INTEGER;
  column_collation OID;
  column_not_null BOOLEAN;
  column_generated "char";
  column_identity "char";
  column_has_default BOOLEAN;
BEGIN
  LOCK TABLE job_data IN ACCESS EXCLUSIVE MODE;

  SELECT attnum, atttypid, atttypmod, attcollation, attnotnull,
         attgenerated, attidentity, atthasdef
  INTO column_attribute, column_type, column_type_modifier, column_collation, column_not_null,
       column_generated, column_identity, column_has_default
  FROM pg_attribute
  WHERE attrelid = 'job_data'::regclass
    AND attname = 'stats_worker_id'
    AND NOT attisdropped;

  IF column_type IS NOT NULL THEN
    IF column_type IS DISTINCT FROM 'varchar'::regtype
      OR column_type_modifier IS DISTINCT FROM 259
      OR column_collation IS DISTINCT FROM '"C"'::regcollation
      OR column_not_null IS DISTINCT FROM FALSE
      OR column_generated IS DISTINCT FROM ''::"char"
      OR column_identity IS DISTINCT FROM ''::"char"
      OR column_has_default IS DISTINCT FROM FALSE THEN
      RAISE EXCEPTION
        'job_data.stats_worker_id has an unexpected definition'
      USING ERRCODE = '42804';
    END IF;

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
        AND refobjsubid = column_attribute
    ) THEN
      RAISE EXCEPTION
        'job_data.stats_worker_id still has dependent objects; rollback refused'
        USING ERRCODE = '55000';
    END IF;

    ALTER TABLE job_data DROP COLUMN stats_worker_id;
  END IF;
END
$$;
