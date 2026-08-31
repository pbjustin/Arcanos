-- Run only after all job_events readers/writers are drained. The table lock,
-- exact catalog checks, and ordinary drops are intentionally atomic.

BEGIN;
LOCK TABLE job_events IN ACCESS EXCLUSIVE MODE;

DO $$
DECLARE
  group_index RECORD;
  claim_index RECORD;
  expected_group_predicate TEXT;
  expected_claim_predicate TEXT;
BEGIN
  IF EXISTS (
    SELECT 1
    FROM job_events
    WHERE event_type IN (
      'worker.budget.job_claim',
      'worker.budget.ai_provider_attempt'
    )
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '55000',
      MESSAGE = 'worker budget rollback refused because strict budget evidence exists';
  END IF;

  CREATE TEMP TABLE worker_budget_rollback_index_guard (
    id UUID,
    job_id UUID,
    event_type TEXT,
    stats_worker_id VARCHAR(255) COLLATE "C",
    claim_generation BIGINT,
    occurred_at TIMESTAMPTZ
  ) ON COMMIT DROP;
  CREATE INDEX worker_budget_rollback_group_guard
    ON pg_temp.worker_budget_rollback_index_guard
      (stats_worker_id, event_type, occurred_at, id)
    WHERE event_type IN (
      'worker.budget.job_claim',
      'worker.budget.ai_provider_attempt'
    );
  CREATE UNIQUE INDEX worker_budget_rollback_claim_guard
    ON pg_temp.worker_budget_rollback_index_guard (job_id, claim_generation)
    WHERE event_type = 'worker.budget.job_claim';
  SELECT pg_get_expr(i.indpred, i.indrelid)
  INTO expected_group_predicate
  FROM pg_index i
  WHERE i.indexrelid = 'pg_temp.worker_budget_rollback_group_guard'::regclass;
  SELECT pg_get_expr(i.indpred, i.indrelid)
  INTO expected_claim_predicate
  FROM pg_index i
  WHERE i.indexrelid = 'pg_temp.worker_budget_rollback_claim_guard'::regclass;

  SELECT c.relkind, i.indrelid, i.indisvalid, i.indisready, i.indislive,
         i.indisunique, i.indisprimary, i.indisexclusion, i.indnkeyatts,
         i.indnatts, am.amname AS access_method,
         pg_get_expr(i.indpred, i.indrelid) AS predicate,
         pg_get_indexdef(c.oid, 1, true) AS key_1,
         pg_get_indexdef(c.oid, 2, true) AS key_2,
         pg_get_indexdef(c.oid, 3, true) AS key_3,
         pg_get_indexdef(c.oid, 4, true) AS key_4
  INTO group_index
  FROM pg_class c
  INNER JOIN pg_class table_class
    ON table_class.oid = 'job_events'::regclass
   AND table_class.relnamespace = c.relnamespace
  LEFT JOIN pg_index i ON i.indexrelid = c.oid
  LEFT JOIN pg_am am ON am.oid = c.relam
  WHERE c.relname = 'idx_job_events_worker_budget_group_window'
  LIMIT 1;

  IF group_index.relkind IS NOT NULL AND (
    group_index.relkind IS DISTINCT FROM 'i'::"char"
    OR group_index.indrelid IS DISTINCT FROM 'job_events'::regclass
    OR group_index.indisvalid IS DISTINCT FROM TRUE
    OR group_index.indisready IS DISTINCT FROM TRUE
    OR group_index.indislive IS DISTINCT FROM TRUE
    OR group_index.indisunique IS DISTINCT FROM FALSE
    OR group_index.indisprimary IS DISTINCT FROM FALSE
    OR group_index.indisexclusion IS DISTINCT FROM FALSE
    OR group_index.access_method IS DISTINCT FROM 'btree'
    OR group_index.indnkeyatts IS DISTINCT FROM 4
    OR group_index.indnatts IS DISTINCT FROM 4
    OR group_index.key_1 IS DISTINCT FROM 'stats_worker_id'
    OR group_index.key_2 IS DISTINCT FROM 'event_type'
    OR group_index.key_3 IS DISTINCT FROM 'occurred_at'
    OR group_index.key_4 IS DISTINCT FROM 'id'
    OR group_index.predicate IS DISTINCT FROM expected_group_predicate
  ) THEN
    RAISE EXCEPTION
      'idx_job_events_worker_budget_group_window has an unexpected definition; rollback refused'
      USING ERRCODE = '42804';
  END IF;

  SELECT c.relkind, i.indrelid, i.indisvalid, i.indisready, i.indislive,
         i.indisunique, i.indisprimary, i.indisexclusion, i.indnkeyatts,
         i.indnatts, am.amname AS access_method,
         pg_get_expr(i.indpred, i.indrelid) AS predicate,
         pg_get_indexdef(c.oid, 1, true) AS key_1,
         pg_get_indexdef(c.oid, 2, true) AS key_2
  INTO claim_index
  FROM pg_class c
  INNER JOIN pg_class table_class
    ON table_class.oid = 'job_events'::regclass
   AND table_class.relnamespace = c.relnamespace
  LEFT JOIN pg_index i ON i.indexrelid = c.oid
  LEFT JOIN pg_am am ON am.oid = c.relam
  WHERE c.relname = 'idx_job_events_worker_budget_claim_generation'
  LIMIT 1;

  IF claim_index.relkind IS NOT NULL AND (
    claim_index.relkind IS DISTINCT FROM 'i'::"char"
    OR claim_index.indrelid IS DISTINCT FROM 'job_events'::regclass
    OR claim_index.indisvalid IS DISTINCT FROM TRUE
    OR claim_index.indisready IS DISTINCT FROM TRUE
    OR claim_index.indislive IS DISTINCT FROM TRUE
    OR claim_index.indisunique IS DISTINCT FROM TRUE
    OR claim_index.indisprimary IS DISTINCT FROM FALSE
    OR claim_index.indisexclusion IS DISTINCT FROM FALSE
    OR claim_index.access_method IS DISTINCT FROM 'btree'
    OR claim_index.indnkeyatts IS DISTINCT FROM 2
    OR claim_index.indnatts IS DISTINCT FROM 2
    OR claim_index.key_1 IS DISTINCT FROM 'job_id'
    OR claim_index.key_2 IS DISTINCT FROM 'claim_generation'
    OR claim_index.predicate IS DISTINCT FROM expected_claim_predicate
  ) THEN
    RAISE EXCEPTION
      'idx_job_events_worker_budget_claim_generation has an unexpected definition; rollback refused'
      USING ERRCODE = '42804';
  END IF;
END
$$;

DROP INDEX IF EXISTS idx_job_events_worker_budget_claim_generation;
DROP INDEX IF EXISTS idx_job_events_worker_budget_group_window;
COMMIT;
