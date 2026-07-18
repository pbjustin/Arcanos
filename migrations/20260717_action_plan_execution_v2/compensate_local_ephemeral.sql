-- ARCANOS Phase 2E LOCAL-EPHEMERAL COMPENSATING ROLLBACK ONLY.
-- The migration tool refuses non-loopback/non-ephemeral targets and executes this
-- artifact only after proving all Phase 2E tables are empty and all provenance
-- columns remain null. This artifact is never an application-startup path.

DO $guard$
DECLARE
  has_rows BOOLEAN;
BEGIN
  IF to_regclass('"ActionPlanExecutionEvent"') IS NOT NULL THEN
    EXECUTE 'SELECT EXISTS (SELECT 1 FROM "ActionPlanExecutionEvent" LIMIT 1)' INTO has_rows;
    IF has_rows THEN
      RAISE EXCEPTION 'phase2e_compensation_requires_empty_protocol_tables';
    END IF;
  END IF;

  IF to_regclass('"ActionPlanExecutionRun"') IS NOT NULL THEN
    EXECUTE 'SELECT EXISTS (SELECT 1 FROM "ActionPlanExecutionRun" LIMIT 1)' INTO has_rows;
    IF has_rows THEN
      RAISE EXCEPTION 'phase2e_compensation_requires_empty_protocol_tables';
    END IF;
  END IF;

  IF to_regclass('"ActionPlanExecutionCommand"') IS NOT NULL THEN
    EXECUTE 'SELECT EXISTS (SELECT 1 FROM "ActionPlanExecutionCommand" LIMIT 1)' INTO has_rows;
    IF has_rows THEN
      RAISE EXCEPTION 'phase2e_compensation_requires_empty_protocol_tables';
    END IF;
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name = 'ActionPlan'
      AND column_name = 'executionRealm'
  ) THEN
    EXECUTE 'SELECT EXISTS (
      SELECT 1 FROM "ActionPlan"
      WHERE "executionRealm" IS NOT NULL
         OR "ownerPrincipalId" IS NOT NULL
         OR "executionProtocolVersion" IS NOT NULL
         OR "executionGeneration" IS NOT NULL
      LIMIT 1
    )' INTO has_rows;
    IF has_rows THEN
      RAISE EXCEPTION 'phase2e_compensation_requires_unpopulated_provenance';
    END IF;
  END IF;
END
$guard$;

DROP TABLE IF EXISTS "ActionPlanExecutionEvent";
DROP TABLE IF EXISTS "ActionPlanExecutionRun";
DROP TABLE IF EXISTS "ActionPlanExecutionCommand";

ALTER TABLE "ActionPlan"
  DROP CONSTRAINT IF EXISTS "ck_action_plan_execution_provenance_v2",
  DROP COLUMN IF EXISTS "executionRealm",
  DROP COLUMN IF EXISTS "ownerPrincipalId",
  DROP COLUMN IF EXISTS "executionProtocolVersion",
  DROP COLUMN IF EXISTS "executionGeneration";

DROP INDEX IF EXISTS "uq_action_plan_action_plan_id_id_v2";
DROP INDEX IF EXISTS "uq_action_plan_id_execution_realm_v2";
DROP TABLE IF EXISTS "ActionPlanExecutionSchemaMigration";
