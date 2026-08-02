-- Add the nullable exact worker-group identity before compatible workers use it.

ALTER TABLE job_data
  ADD COLUMN IF NOT EXISTS stats_worker_id VARCHAR(255) COLLATE "C";

DO $$
DECLARE
  column_type OID;
  column_type_modifier INTEGER;
  column_collation OID;
  column_not_null BOOLEAN;
  column_generated "char";
  column_identity "char";
  column_has_default BOOLEAN;
BEGIN
  SELECT atttypid, atttypmod, attcollation, attnotnull,
         attgenerated, attidentity, atthasdef
  INTO column_type, column_type_modifier, column_collation, column_not_null,
       column_generated, column_identity, column_has_default
  FROM pg_attribute
  WHERE attrelid = 'job_data'::regclass
    AND attname = 'stats_worker_id'
    AND NOT attisdropped;

  IF column_type IS DISTINCT FROM 'varchar'::regtype
    OR column_type_modifier IS DISTINCT FROM 259
    OR column_collation IS DISTINCT FROM '"C"'::regcollation
    OR column_not_null IS DISTINCT FROM FALSE
    OR column_generated IS DISTINCT FROM ''::"char"
    OR column_identity IS DISTINCT FROM ''::"char"
    OR column_has_default IS DISTINCT FROM FALSE THEN
    RAISE EXCEPTION
      'job_data.stats_worker_id must be a plain writable nullable VARCHAR(255) COLLATE "C" without a default'
      USING ERRCODE = '42804';
  END IF;
END
$$;
