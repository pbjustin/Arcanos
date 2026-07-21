-- ARCANOS Phase 2E: validate the additive legacy-or-v2 provenance invariant.

ALTER TABLE "ActionPlan"
  VALIDATE CONSTRAINT "ck_action_plan_execution_provenance_v2";
