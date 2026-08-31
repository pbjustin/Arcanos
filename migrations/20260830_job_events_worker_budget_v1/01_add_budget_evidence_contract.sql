-- Add the append-only evidence shape used by hard worker budgets. This phase is
-- additive and may run in a transaction. It fails closed on same-name drift.

ALTER TABLE job_events
  ADD COLUMN IF NOT EXISTS stats_worker_id VARCHAR(255) COLLATE "C",
  ADD COLUMN IF NOT EXISTS claim_generation BIGINT,
  ADD COLUMN IF NOT EXISTS operation VARCHAR(200);

DO $$
DECLARE
  stats_type OID;
  stats_modifier INTEGER;
  stats_collation OID;
  stats_not_null BOOLEAN;
  stats_generated "char";
  stats_identity "char";
  stats_has_default BOOLEAN;
  generation_type OID;
  generation_modifier INTEGER;
  generation_collation OID;
  generation_not_null BOOLEAN;
  generation_generated "char";
  generation_identity "char";
  generation_has_default BOOLEAN;
  operation_type OID;
  operation_modifier INTEGER;
  operation_not_null BOOLEAN;
  operation_generated "char";
  operation_identity "char";
  operation_has_default BOOLEAN;
BEGIN
  SELECT atttypid, atttypmod, attcollation, attnotnull,
         attgenerated, attidentity, atthasdef
  INTO stats_type, stats_modifier, stats_collation, stats_not_null,
       stats_generated, stats_identity, stats_has_default
  FROM pg_attribute
  WHERE attrelid = 'job_events'::regclass
    AND attname = 'stats_worker_id'
    AND NOT attisdropped;

  SELECT atttypid, atttypmod, attcollation, attnotnull,
         attgenerated, attidentity, atthasdef
  INTO generation_type, generation_modifier, generation_collation, generation_not_null,
       generation_generated, generation_identity, generation_has_default
  FROM pg_attribute
  WHERE attrelid = 'job_events'::regclass
    AND attname = 'claim_generation'
    AND NOT attisdropped;

  SELECT atttypid, atttypmod, attnotnull,
         attgenerated, attidentity, atthasdef
  INTO operation_type, operation_modifier, operation_not_null,
       operation_generated, operation_identity, operation_has_default
  FROM pg_attribute
  WHERE attrelid = 'job_events'::regclass
    AND attname = 'operation'
    AND NOT attisdropped;

  IF stats_type IS DISTINCT FROM 'varchar'::regtype
    OR stats_modifier IS DISTINCT FROM 259
    OR stats_collation IS DISTINCT FROM '"C"'::regcollation
    OR stats_not_null IS DISTINCT FROM FALSE
    OR stats_generated IS DISTINCT FROM ''::"char"
    OR stats_identity IS DISTINCT FROM ''::"char"
    OR stats_has_default IS DISTINCT FROM FALSE THEN
    RAISE EXCEPTION
      'job_events.stats_worker_id must be a plain writable nullable VARCHAR(255) COLLATE "C" without a default'
      USING ERRCODE = '42804';
  END IF;

  IF generation_type IS DISTINCT FROM 'bigint'::regtype
    OR generation_modifier IS DISTINCT FROM -1
    OR generation_collation IS DISTINCT FROM 0
    OR generation_not_null IS DISTINCT FROM FALSE
    OR generation_generated IS DISTINCT FROM ''::"char"
    OR generation_identity IS DISTINCT FROM ''::"char"
    OR generation_has_default IS DISTINCT FROM FALSE THEN
    RAISE EXCEPTION
      'job_events.claim_generation must be a plain writable nullable BIGINT without a default'
      USING ERRCODE = '42804';
  END IF;

  IF operation_type IS DISTINCT FROM 'varchar'::regtype
    OR operation_modifier IS DISTINCT FROM 204
    OR operation_not_null IS DISTINCT FROM FALSE
    OR operation_generated IS DISTINCT FROM ''::"char"
    OR operation_identity IS DISTINCT FROM ''::"char"
    OR operation_has_default IS DISTINCT FROM FALSE THEN
    RAISE EXCEPTION
      'job_events.operation must be a plain writable nullable VARCHAR(200) without a default'
      USING ERRCODE = '42804';
  END IF;
END
$$;

DO $$
DECLARE
  constraint_type "char";
  constraint_valid BOOLEAN;
  constraint_columns SMALLINT[];
  constraint_definition TEXT;
  expected_definition TEXT;
  event_type_attribute SMALLINT;
  stats_worker_attribute SMALLINT;
  generation_attribute SMALLINT;
  compact_definition TEXT;
BEGIN
  CREATE TEMP TABLE worker_budget_shape_expected_guard (
    event_type TEXT NOT NULL,
    stats_worker_id TEXT,
    claim_generation BIGINT
  ) ON COMMIT DROP;
  ALTER TABLE pg_temp.worker_budget_shape_expected_guard
    ADD CONSTRAINT worker_budget_shape_expected_guard_check
    CHECK (
      event_type NOT IN (
        'worker.budget.job_claim',
        'worker.budget.ai_provider_attempt'
      )
      OR (
        stats_worker_id IS NOT NULL
        AND (
          (event_type = 'worker.budget.job_claim'
            AND claim_generation IS NOT NULL
            AND claim_generation > 0)
          OR (event_type = 'worker.budget.ai_provider_attempt'
            AND claim_generation IS NULL)
        )
      )
    );
  SELECT pg_get_constraintdef(oid, false)
  INTO expected_definition
  FROM pg_constraint
  WHERE conrelid = 'pg_temp.worker_budget_shape_expected_guard'::regclass
    AND conname = 'worker_budget_shape_expected_guard_check';

  SELECT attnum INTO event_type_attribute
  FROM pg_attribute
  WHERE attrelid = 'job_events'::regclass AND attname = 'event_type' AND NOT attisdropped;
  SELECT attnum INTO stats_worker_attribute
  FROM pg_attribute
  WHERE attrelid = 'job_events'::regclass AND attname = 'stats_worker_id' AND NOT attisdropped;
  SELECT attnum INTO generation_attribute
  FROM pg_attribute
  WHERE attrelid = 'job_events'::regclass AND attname = 'claim_generation' AND NOT attisdropped;

  SELECT contype, convalidated, conkey, pg_get_constraintdef(oid, false)
  INTO constraint_type, constraint_valid, constraint_columns, constraint_definition
  FROM pg_constraint
  WHERE conrelid = 'job_events'::regclass
    AND conname = 'job_events_worker_budget_shape_check';

  IF constraint_definition IS NULL THEN
    ALTER TABLE job_events
      ADD CONSTRAINT job_events_worker_budget_shape_check
      CHECK (
        event_type NOT IN (
          'worker.budget.job_claim',
          'worker.budget.ai_provider_attempt'
        )
        OR (
          stats_worker_id IS NOT NULL
          AND (
            (event_type = 'worker.budget.job_claim'
              AND claim_generation IS NOT NULL
              AND claim_generation > 0)
            OR (event_type = 'worker.budget.ai_provider_attempt'
              AND claim_generation IS NULL)
          )
        )
      ) NOT VALID;
  END IF;

  SELECT contype, conkey, pg_get_constraintdef(oid, false)
  INTO constraint_type, constraint_columns, constraint_definition
  FROM pg_constraint
  WHERE conrelid = 'job_events'::regclass
    AND conname = 'job_events_worker_budget_shape_check';
  IF constraint_type IS DISTINCT FROM 'c'::"char"
    OR constraint_columns IS DISTINCT FROM ARRAY[
      event_type_attribute,
      stats_worker_attribute,
      generation_attribute
    ]::SMALLINT[]
    OR constraint_definition IS DISTINCT FROM expected_definition THEN
    RAISE EXCEPTION
      'job_events_worker_budget_shape_check has an unexpected definition'
      USING ERRCODE = '42804';
  END IF;
END
$$;
