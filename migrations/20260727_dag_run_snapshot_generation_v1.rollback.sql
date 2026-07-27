-- Remove only the exact DAG snapshot-generation fencing contract installed by
-- the forward migration. A missing column is an idempotent no-op. Drifted
-- types/constraints and any nonterminal or unknown-status DAG rows fail closed before
-- destructive DDL.

DO $$
DECLARE
  snapshot_generation_type OID;
  snapshot_generation_not_null BOOLEAN;
  snapshot_generation_default TEXT;
  constraint_type "char";
  constraint_validated BOOLEAN;
  constraint_definition TEXT;
BEGIN
  SELECT
    attribute.atttypid,
    attribute.attnotnull,
    pg_get_expr(attribute_default.adbin, attribute_default.adrelid)
  INTO
    snapshot_generation_type,
    snapshot_generation_not_null,
    snapshot_generation_default
  FROM pg_attribute AS attribute
  LEFT JOIN pg_attrdef AS attribute_default
    ON attribute_default.adrelid = attribute.attrelid
   AND attribute_default.adnum = attribute.attnum
  WHERE attribute.attrelid = 'dag_runs'::regclass
    AND attribute.attname = 'snapshot_generation'
    AND NOT attribute.attisdropped;

  IF snapshot_generation_type IS NOT NULL THEN
    IF snapshot_generation_type IS DISTINCT FROM 'bigint'::regtype THEN
      RAISE EXCEPTION
        'dag_runs.snapshot_generation must have PostgreSQL BIGINT type'
        USING ERRCODE = '42804';
    END IF;

    IF snapshot_generation_not_null IS DISTINCT FROM TRUE
      OR regexp_replace(
        COALESCE(snapshot_generation_default, ''),
        '[[:space:]]+',
        '',
        'g'
      ) NOT IN ('0', '0::bigint') THEN
      RAISE EXCEPTION
        'dag_runs.snapshot_generation has an unexpected nullability or default'
        USING ERRCODE = '42804';
    END IF;

    SELECT contype, convalidated, pg_get_constraintdef(oid, false)
    INTO constraint_type, constraint_validated, constraint_definition
    FROM pg_constraint
    WHERE conrelid = 'dag_runs'::regclass
      AND conname = 'dag_runs_snapshot_generation_nonnegative';

    IF constraint_definition IS NULL
      OR constraint_type <> 'c'
      OR constraint_validated IS DISTINCT FROM TRUE
      OR regexp_replace(
        constraint_definition,
        '[[:space:]]+',
        '',
        'g'
      ) <> 'CHECK((snapshot_generation>=0))' THEN
      RAISE EXCEPTION
        'dag_runs_snapshot_generation_nonnegative has an unexpected definition'
        USING ERRCODE = '42804';
    END IF;

    IF EXISTS (
      SELECT 1
      FROM dag_runs
      WHERE status IS NULL
         OR status NOT IN ('complete', 'failed', 'cancelled')
    ) THEN
      RAISE EXCEPTION
        'cannot roll back snapshot_generation while DAG runs are nonterminal or have an unknown status'
        USING ERRCODE = '55000';
    END IF;

    ALTER TABLE dag_runs
      DROP CONSTRAINT dag_runs_snapshot_generation_nonnegative;

    ALTER TABLE dag_runs
      DROP COLUMN snapshot_generation;
  END IF;
END
$$;
