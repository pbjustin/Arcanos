-- Add a monotonic fencing token to generic queue claims.
-- PostgreSQL BIGINT values remain decimal strings in TypeScript so generations
-- cannot lose precision when they exceed JavaScript's safe integer range.

ALTER TABLE job_data
  ADD COLUMN IF NOT EXISTS claim_generation BIGINT;

DO $$
DECLARE
  claim_generation_type OID;
BEGIN
  SELECT atttypid
  INTO claim_generation_type
  FROM pg_attribute
  WHERE attrelid = 'job_data'::regclass
    AND attname = 'claim_generation'
    AND NOT attisdropped;

  IF claim_generation_type IS DISTINCT FROM 'bigint'::regtype THEN
    RAISE EXCEPTION
      'job_data.claim_generation must have PostgreSQL BIGINT type'
      USING ERRCODE = '42804';
  END IF;
END
$$;

UPDATE job_data
SET claim_generation = 0
WHERE claim_generation IS NULL;

ALTER TABLE job_data
  ALTER COLUMN claim_generation SET DEFAULT 0;

ALTER TABLE job_data
  ALTER COLUMN claim_generation SET NOT NULL;

DO $$
DECLARE
  constraint_type "char";
  constraint_definition TEXT;
BEGIN
  SELECT contype, pg_get_constraintdef(oid, false)
  INTO constraint_type, constraint_definition
    FROM pg_constraint
    WHERE conrelid = 'job_data'::regclass
      AND conname = 'job_data_claim_generation_nonnegative';

  IF constraint_definition IS NULL THEN
    ALTER TABLE job_data
      ADD CONSTRAINT job_data_claim_generation_nonnegative
      CHECK (claim_generation >= 0) NOT VALID;
  ELSIF constraint_type <> 'c'
    OR regexp_replace(
      constraint_definition,
      '[[:space:]]+',
      '',
      'g'
    ) NOT IN (
      'CHECK((claim_generation>=0))',
      'CHECK((claim_generation>=0))NOTVALID'
    ) THEN
    RAISE EXCEPTION
      'job_data_claim_generation_nonnegative has an unexpected definition'
      USING ERRCODE = '42804';
  END IF;
END
$$;

ALTER TABLE job_data
  VALIDATE CONSTRAINT job_data_claim_generation_nonnegative;
