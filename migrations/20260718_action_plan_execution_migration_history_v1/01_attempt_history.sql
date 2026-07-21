-- ARCANOS Phase 2E: additive, append-oriented migration-attempt evidence.
-- The mutable ActionPlanExecutionSchemaMigration row remains the recovery cursor.

CREATE TABLE "ActionPlanExecutionSchemaMigrationAttempt" (
  "id" TEXT PRIMARY KEY,
  "migrationVersion" TEXT NOT NULL,
  "migrationChecksum" TEXT NOT NULL,
  "operation" TEXT NOT NULL,
  "startedAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ck_ap_exec_migration_attempt_identity" CHECK (
    char_length("id") BETWEEN 1 AND 128
    AND char_length("migrationVersion") BETWEEN 1 AND 128
    AND "migrationChecksum" ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT "ck_ap_exec_migration_attempt_operation" CHECK (
    "operation" IN ('HISTORY_SCHEMA_INSTALL', 'APPLY', 'COMPENSATE')
  )
);

CREATE TABLE "ActionPlanExecutionSchemaMigrationAttemptEvent" (
  "id" TEXT PRIMARY KEY,
  "attemptId" TEXT NOT NULL,
  "eventSequence" BIGINT NOT NULL,
  "eventType" TEXT NOT NULL,
  "phase" TEXT,
  "reasonCode" TEXT NOT NULL,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ck_ap_exec_migration_attempt_event_identity" CHECK (
    char_length("id") BETWEEN 1 AND 128
    AND char_length("attemptId") BETWEEN 1 AND 128
  ),
  CONSTRAINT "ck_ap_exec_migration_attempt_event_sequence" CHECK (
    "eventSequence" >= 1
  ),
  CONSTRAINT "ck_ap_exec_migration_attempt_event_type" CHECK (
    "eventType" IN (
      'PHASE_COMPLETED',
      'RECOVERY_STARTED',
      'ATTEMPT_REFUSED',
      'ATTEMPT_FAILED',
      'ATTEMPT_SUCCEEDED'
    )
  ),
  CONSTRAINT "ck_ap_exec_migration_attempt_event_phase" CHECK (
    "phase" IS NULL OR char_length("phase") BETWEEN 1 AND 128
  ),
  CONSTRAINT "ck_ap_exec_migration_attempt_event_reason" CHECK (
    "reasonCode" ~ '^[A-Z][A-Z0-9_]{0,127}$'
  ),
  CONSTRAINT "uq_ap_exec_migration_attempt_event_sequence" UNIQUE (
    "attemptId", "eventSequence"
  ),
  CONSTRAINT "fk_ap_exec_migration_attempt_event_attempt" FOREIGN KEY (
    "attemptId"
  ) REFERENCES "ActionPlanExecutionSchemaMigrationAttempt"("id")
    ON UPDATE RESTRICT ON DELETE RESTRICT
);

CREATE INDEX "ix_ap_exec_migration_attempt_version_started"
  ON "ActionPlanExecutionSchemaMigrationAttempt" (
    "migrationVersion", "startedAt", "id"
  );

CREATE UNIQUE INDEX "uq_ap_exec_migration_attempt_terminal"
  ON "ActionPlanExecutionSchemaMigrationAttemptEvent" ("attemptId")
  WHERE "eventType" IN (
    'ATTEMPT_REFUSED', 'ATTEMPT_FAILED', 'ATTEMPT_SUCCEEDED'
  );
