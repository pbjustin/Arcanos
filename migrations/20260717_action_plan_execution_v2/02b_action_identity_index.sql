-- ARCANOS Phase 2E: least-blocking unique index over existing Action rows.
-- This phase must not run inside a transaction.

CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "uq_action_plan_action_plan_id_id_v2"
  ON "Action" ("planId", "id");
