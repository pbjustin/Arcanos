-- ARCANOS Phase 2E: least-blocking unique index over existing ActionPlan rows.
-- This phase must not run inside a transaction.

CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "uq_action_plan_id_execution_realm_v2"
  ON "ActionPlan" ("id", "executionRealm");
