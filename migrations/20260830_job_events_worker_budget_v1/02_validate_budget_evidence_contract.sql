-- Validation scans existing rows under a ShareUpdateExclusive lock, separate
-- from the phase that adds the NOT VALID constraint under AccessExclusive.

ALTER TABLE job_events
  VALIDATE CONSTRAINT job_events_worker_budget_shape_check;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'job_events'::regclass
      AND conname = 'job_events_worker_budget_shape_check'
      AND contype = 'c'
      AND convalidated
  ) THEN
    RAISE EXCEPTION
      'job_events_worker_budget_shape_check is missing or not validated'
      USING ERRCODE = '42804';
  END IF;
END
$$;
