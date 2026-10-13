-- Disposable catalog fixture. Column and budget-index shapes follow
-- migrations/20260507_job_events.sql and
-- migrations/20260830_job_events_worker_budget_v1/{01,04,05}_*.sql.
CREATE TABLE public.inspection_fixture_sentinel (id integer PRIMARY KEY, value text NOT NULL);
INSERT INTO public.inspection_fixture_sentinel VALUES (1, 'unchanged fixture sentinel');
CREATE TABLE public.job_events (
  id uuid PRIMARY KEY,
  job_id uuid NOT NULL,
  trace_id text,
  event_type text NOT NULL,
  worker_id text,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  duration_ms integer,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  stats_worker_id varchar(255) COLLATE "C",
  claim_generation bigint,
  operation varchar(200),
  CONSTRAINT job_events_worker_budget_shape_check CHECK (
    event_type NOT IN ('worker.budget.job_claim', 'worker.budget.ai_provider_attempt')
    OR (stats_worker_id IS NOT NULL AND (
      (event_type = 'worker.budget.job_claim' AND claim_generation IS NOT NULL AND claim_generation > 0)
      OR (event_type = 'worker.budget.ai_provider_attempt' AND claim_generation IS NULL)
    ))
  )
);
CREATE INDEX idx_job_events_worker_budget_group_window
  ON public.job_events (stats_worker_id, event_type, occurred_at, id)
  WHERE event_type IN ('worker.budget.job_claim', 'worker.budget.ai_provider_attempt');
CREATE UNIQUE INDEX idx_job_events_worker_budget_claim_generation
  ON public.job_events (job_id, claim_generation)
  WHERE event_type = 'worker.budget.job_claim';
INSERT INTO public.job_events (id, job_id, event_type, occurred_at, stats_worker_id, claim_generation, operation)
VALUES ('10000000-1111-4111-8111-111111111111', '20000000-1111-4111-8111-111111111111',
  'worker.budget.job_claim', '2026-01-01T00:00:00Z', 'fixture-worker', 1, 'fixture-operation');
