-- Add a monotonic fencing token to DAG run snapshot persistence.
-- PostgreSQL BIGINT values remain decimal strings in TypeScript so snapshot
-- generations cannot lose precision beyond JavaScript's safe integer range.

ALTER TABLE dag_runs
  ADD COLUMN IF NOT EXISTS snapshot_generation BIGINT;

DO $$
DECLARE
  snapshot_generation_type OID;
BEGIN
  SELECT atttypid
  INTO snapshot_generation_type
  FROM pg_attribute
  WHERE attrelid = 'dag_runs'::regclass
    AND attname = 'snapshot_generation'
    AND NOT attisdropped;

  IF snapshot_generation_type IS DISTINCT FROM 'bigint'::regtype THEN
    RAISE EXCEPTION
      'dag_runs.snapshot_generation must have PostgreSQL BIGINT type'
      USING ERRCODE = '42804';
  END IF;
END
$$;

UPDATE dag_runs
SET snapshot_generation = 0
WHERE snapshot_generation IS NULL;

ALTER TABLE dag_runs
  ALTER COLUMN snapshot_generation SET DEFAULT 0;

ALTER TABLE dag_runs
  ALTER COLUMN snapshot_generation SET NOT NULL;

DO $$
DECLARE
  constraint_type "char";
  constraint_definition TEXT;
BEGIN
  SELECT contype, pg_get_constraintdef(oid, false)
  INTO constraint_type, constraint_definition
  FROM pg_constraint
  WHERE conrelid = 'dag_runs'::regclass
    AND conname = 'dag_runs_snapshot_generation_nonnegative';

  IF constraint_definition IS NULL THEN
    ALTER TABLE dag_runs
      ADD CONSTRAINT dag_runs_snapshot_generation_nonnegative
      CHECK (snapshot_generation >= 0) NOT VALID;
  ELSIF constraint_type <> 'c'
    OR regexp_replace(
      constraint_definition,
      '[[:space:]]+',
      '',
      'g'
    ) NOT IN (
      'CHECK((snapshot_generation>=0))',
      'CHECK((snapshot_generation>=0))NOTVALID'
    ) THEN
    RAISE EXCEPTION
      'dag_runs_snapshot_generation_nonnegative has an unexpected definition'
      USING ERRCODE = '42804';
  END IF;
END
$$;

ALTER TABLE dag_runs
  VALIDATE CONSTRAINT dag_runs_snapshot_generation_nonnegative;
