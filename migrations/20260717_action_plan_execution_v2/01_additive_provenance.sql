-- ARCANOS Phase 2E: additive plan provenance and checksummed migration ledger.
-- This phase is executed transactionally by scripts/action-plan-execution-migration.mjs.

CREATE TABLE IF NOT EXISTS "ActionPlanExecutionSchemaMigration" (
  "version" TEXT PRIMARY KEY,
  "checksum" TEXT NOT NULL,
  "completedPhase" TEXT NOT NULL,
  "validityState" TEXT NOT NULL,
  "appliedAt" TIMESTAMPTZ,
  "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ck_ap_exec_migration_version" CHECK (char_length("version") BETWEEN 1 AND 64),
  CONSTRAINT "ck_ap_exec_migration_checksum" CHECK ("checksum" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "ck_ap_exec_migration_state" CHECK (
    "validityState" IN ('IN_PROGRESS', 'RECOVERING_INVALID_INDEX', 'FAILED', 'VALID')
  )
);

ALTER TABLE "ActionPlan"
  ADD COLUMN IF NOT EXISTS "executionRealm" TEXT,
  ADD COLUMN IF NOT EXISTS "ownerPrincipalId" TEXT,
  ADD COLUMN IF NOT EXISTS "executionProtocolVersion" INTEGER,
  ADD COLUMN IF NOT EXISTS "executionGeneration" BIGINT;

DO $phase$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'ck_action_plan_execution_provenance_v2'
      AND conrelid = '"ActionPlan"'::regclass
  ) THEN
    ALTER TABLE "ActionPlan"
      ADD CONSTRAINT "ck_action_plan_execution_provenance_v2"
      CHECK (
        (
          "executionRealm" IS NULL
          AND "ownerPrincipalId" IS NULL
          AND "executionProtocolVersion" IS NULL
          AND "executionGeneration" IS NULL
        )
        OR
        (
          "executionRealm" IS NOT NULL
          AND char_length("executionRealm") BETWEEN 1 AND 256
          AND "ownerPrincipalId" IS NOT NULL
          AND char_length("ownerPrincipalId") BETWEEN 1 AND 256
          AND "executionProtocolVersion" = 2
          AND "executionGeneration" >= 1
        )
      ) NOT VALID;
  END IF;
END
$phase$;
