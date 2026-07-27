-- Remove only the exact fencing contract installed by the forward migration.
-- A missing column is an idempotent no-op. Drifted types/constraints and any
-- running row not provably owned by the separate local-agent protocol fail
-- closed before destructive DDL.

DO $$
DECLARE
  claim_generation_type OID;
  constraint_type "char";
  constraint_definition TEXT;
BEGIN
  SELECT atttypid
  INTO claim_generation_type
  FROM pg_attribute
  WHERE attrelid = 'job_data'::regclass
    AND attname = 'claim_generation'
    AND NOT attisdropped;

  IF claim_generation_type IS NOT NULL THEN
    IF claim_generation_type IS DISTINCT FROM 'bigint'::regtype THEN
      RAISE EXCEPTION
        'job_data.claim_generation must have PostgreSQL BIGINT type'
        USING ERRCODE = '42804';
    END IF;

    SELECT contype, pg_get_constraintdef(oid, false)
    INTO constraint_type, constraint_definition
    FROM pg_constraint
    WHERE conrelid = 'job_data'::regclass
      AND conname = 'job_data_claim_generation_nonnegative';

    IF constraint_definition IS NOT NULL
      AND (
        constraint_type <> 'c'
        OR regexp_replace(
          constraint_definition,
          '[[:space:]]+',
          '',
          'g'
        ) NOT IN (
          'CHECK((claim_generation>=0))',
          'CHECK((claim_generation>=0))NOTVALID'
        )
      ) THEN
      RAISE EXCEPTION
        'job_data_claim_generation_nonnegative has an unexpected definition'
        USING ERRCODE = '42804';
    END IF;

    IF EXISTS (
      SELECT 1
      FROM job_data
      WHERE status = 'running'
        AND job_type IS DISTINCT FROM 'local-agent'
    ) THEN
      RAISE EXCEPTION
        'cannot roll back claim_generation while non-local-agent jobs are running'
        USING ERRCODE = '55000';
    END IF;

    IF constraint_definition IS NOT NULL THEN
      ALTER TABLE job_data
        DROP CONSTRAINT job_data_claim_generation_nonnegative;
    END IF;

    ALTER TABLE job_data
      DROP COLUMN claim_generation;
  END IF;
END
$$;
