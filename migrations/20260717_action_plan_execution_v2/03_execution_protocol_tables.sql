-- ARCANOS Phase 2E: authoritative one-action execution commands, runs, and events.
-- Existing ExecutionResult rows remain untouched legacy evidence.

CREATE TABLE IF NOT EXISTS "ActionPlanExecutionCommand" (
  "id" TEXT PRIMARY KEY,
  "planId" TEXT NOT NULL,
  "executionRealm" TEXT NOT NULL,
  "requesterPrincipalId" TEXT NOT NULL,
  "commandIdempotencyKeyHash" TEXT NOT NULL,
  "commandFingerprint" TEXT NOT NULL,
  "lockedPlanExecutionGeneration" BIGINT NOT NULL,
  "protocolVersion" INTEGER NOT NULL,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ck_ap_exec_command_id" CHECK (
    char_length("id") BETWEEN 1 AND 128
    AND char_length("planId") BETWEEN 1 AND 128
  ),
  CONSTRAINT "ck_ap_exec_command_realm" CHECK (char_length("executionRealm") BETWEEN 1 AND 256),
  CONSTRAINT "ck_ap_exec_command_requester" CHECK (char_length("requesterPrincipalId") BETWEEN 1 AND 256),
  CONSTRAINT "ck_ap_exec_command_idem_hash" CHECK ("commandIdempotencyKeyHash" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "ck_ap_exec_command_fingerprint" CHECK ("commandFingerprint" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "ck_ap_exec_command_generation" CHECK ("lockedPlanExecutionGeneration" >= 1),
  CONSTRAINT "ck_ap_exec_command_protocol" CHECK ("protocolVersion" = 2),
  CONSTRAINT "uq_ap_exec_command_id_plan_realm" UNIQUE ("id", "planId", "executionRealm"),
  CONSTRAINT "uq_ap_exec_command_idempotency" UNIQUE (
    "executionRealm",
    "requesterPrincipalId",
    "planId",
    "commandIdempotencyKeyHash"
  ),
  CONSTRAINT "fk_ap_exec_command_plan_realm" FOREIGN KEY ("planId", "executionRealm")
    REFERENCES "ActionPlan" ("id", "executionRealm")
    ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE TABLE IF NOT EXISTS "ActionPlanExecutionRun" (
  "id" TEXT PRIMARY KEY,
  "commandId" TEXT NOT NULL,
  "planId" TEXT NOT NULL,
  "actionId" TEXT NOT NULL,
  "attempt" INTEGER NOT NULL,
  "state" TEXT NOT NULL,
  "executorKind" TEXT NOT NULL,
  "assignedAgentId" TEXT NOT NULL,
  "assignedExecutorPrincipalId" TEXT NOT NULL,
  "assignedExecutorInstanceId" TEXT NOT NULL,
  "claimedExecutorPrincipalId" TEXT,
  "claimedExecutorInstanceId" TEXT,
  "executionRealm" TEXT NOT NULL,
  "actionSnapshotId" TEXT NOT NULL,
  "actionSnapshotSchemaVersion" INTEGER NOT NULL,
  "actionSnapshot" JSONB NOT NULL,
  "claimIdempotencyKeyHash" TEXT,
  "claimFingerprint" TEXT,
  "startIdempotencyKeyHash" TEXT,
  "startFingerprint" TEXT,
  "resultIdempotencyKeyHash" TEXT,
  "resultFingerprint" TEXT,
  "policyCategory" TEXT NOT NULL,
  "policyEvidenceId" TEXT NOT NULL,
  "policyEvaluatedAt" TIMESTAMPTZ NOT NULL,
  "acceptanceReceipt" TEXT,
  "terminalCategory" TEXT,
  "resultOutput" JSONB,
  "resultError" JSONB,
  "eventSequence" BIGINT NOT NULL DEFAULT 0,
  "version" BIGINT NOT NULL DEFAULT 0,
  "requestedAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "claimedAt" TIMESTAMPTZ,
  "startedAt" TIMESTAMPTZ,
  "completedAt" TIMESTAMPTZ,
  "cancelledAt" TIMESTAMPTZ,
  "expiredAt" TIMESTAMPTZ,
  "supersededAt" TIMESTAMPTZ,
  "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ck_ap_exec_run_id" CHECK (
    char_length("id") BETWEEN 1 AND 128
    AND char_length("commandId") BETWEEN 1 AND 128
    AND char_length("planId") BETWEEN 1 AND 128
    AND char_length("actionId") BETWEEN 1 AND 128
  ),
  CONSTRAINT "ck_ap_exec_run_attempt" CHECK ("attempt" >= 1),
  CONSTRAINT "ck_ap_exec_run_state" CHECK (
    "state" IN ('REQUESTED', 'CLAIMED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'CANCELLED', 'EXPIRED', 'SUPERSEDED')
  ),
  CONSTRAINT "ck_ap_exec_run_executor" CHECK ("executorKind" = 'python-daemon'),
  CONSTRAINT "ck_ap_exec_run_realm" CHECK (char_length("executionRealm") BETWEEN 1 AND 256),
  CONSTRAINT "ck_ap_exec_run_assignment" CHECK (
    char_length("assignedAgentId") BETWEEN 1 AND 128
    AND char_length("assignedExecutorPrincipalId") BETWEEN 1 AND 256
    AND char_length("assignedExecutorInstanceId") BETWEEN 1 AND 256
  ),
  CONSTRAINT "ck_ap_exec_run_snapshot_id" CHECK (char_length("actionSnapshotId") BETWEEN 1 AND 128),
  CONSTRAINT "ck_ap_exec_run_snapshot_version" CHECK ("actionSnapshotSchemaVersion" = 1),
  CONSTRAINT "ck_ap_exec_run_snapshot" CHECK (
    jsonb_typeof("actionSnapshot") = 'object'
    AND octet_length("actionSnapshot"::TEXT) <= 65536
  ),
  CONSTRAINT "ck_ap_exec_run_snapshot_shape" CHECK (
    "actionSnapshot"->>'snapshot_version' = 'action-execution-snapshot-v1'
    AND jsonb_typeof("actionSnapshot"->'plan_id') = 'string'
    AND "actionSnapshot"->>'plan_id' = "planId"
    AND jsonb_typeof("actionSnapshot"->'action_id') = 'string'
    AND "actionSnapshot"->>'action_id' = "actionId"
    AND jsonb_typeof("actionSnapshot"->'agent_id') = 'string'
    AND "actionSnapshot"->>'agent_id' = "assignedAgentId"
    AND jsonb_typeof("actionSnapshot"->'capability') = 'string'
    AND char_length("actionSnapshot"->>'capability') BETWEEN 1 AND 128
    AND "actionSnapshot" ? 'params'
    AND jsonb_typeof("actionSnapshot"->'timeout_ms') = 'number'
    AND ("actionSnapshot"->>'timeout_ms')::NUMERIC = trunc(("actionSnapshot"->>'timeout_ms')::NUMERIC)
    AND ("actionSnapshot"->>'timeout_ms')::NUMERIC BETWEEN 1 AND 86400000
    AND jsonb_typeof("actionSnapshot"->'sort_order') = 'number'
    AND ("actionSnapshot"->>'sort_order')::NUMERIC = trunc(("actionSnapshot"->>'sort_order')::NUMERIC)
    AND ("actionSnapshot"->>'sort_order')::NUMERIC >= 0
    AND jsonb_typeof("actionSnapshot"->'plan_execution_generation') = 'number'
    AND ("actionSnapshot"->>'plan_execution_generation')::NUMERIC = trunc(("actionSnapshot"->>'plan_execution_generation')::NUMERIC)
    AND ("actionSnapshot"->>'plan_execution_generation')::NUMERIC >= 1
    AND jsonb_typeof("actionSnapshot"->'executor_kind') = 'string'
    AND "actionSnapshot"->>'executor_kind' = "executorKind"
    AND jsonb_typeof("actionSnapshot"->'assigned_executor_principal_id') = 'string'
    AND "actionSnapshot"->>'assigned_executor_principal_id' = "assignedExecutorPrincipalId"
    AND jsonb_typeof("actionSnapshot"->'agent_capability_fingerprint') = 'string'
    AND "actionSnapshot"->>'agent_capability_fingerprint' ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT "ck_ap_exec_run_hashes" CHECK (
    ("claimIdempotencyKeyHash" IS NULL OR "claimIdempotencyKeyHash" ~ '^[0-9a-f]{64}$')
    AND ("claimFingerprint" IS NULL OR "claimFingerprint" ~ '^[0-9a-f]{64}$')
    AND ("startIdempotencyKeyHash" IS NULL OR "startIdempotencyKeyHash" ~ '^[0-9a-f]{64}$')
    AND ("startFingerprint" IS NULL OR "startFingerprint" ~ '^[0-9a-f]{64}$')
    AND ("resultIdempotencyKeyHash" IS NULL OR "resultIdempotencyKeyHash" ~ '^[0-9a-f]{64}$')
    AND ("resultFingerprint" IS NULL OR "resultFingerprint" ~ '^[0-9a-f]{64}$')
  ),
  CONSTRAINT "ck_ap_exec_run_policy" CHECK (
    "policyCategory" IN ('ALLOW', 'CONFIRM')
    AND "policyEvidenceId" ~ '^clear-recheck-v1:[0-9a-f]{64}$'
  ),
  CONSTRAINT "ck_ap_exec_run_sequence" CHECK ("eventSequence" >= 0 AND "version" >= 0),
  CONSTRAINT "ck_ap_exec_run_result_bounds" CHECK (
    ("resultOutput" IS NULL OR octet_length("resultOutput"::TEXT) <= 65536)
    AND ("resultError" IS NULL OR octet_length("resultError"::TEXT) <= 8192)
    AND ("acceptanceReceipt" IS NULL OR char_length("acceptanceReceipt") BETWEEN 1 AND 256)
  ),
  CONSTRAINT "ck_ap_exec_run_claim_group" CHECK (
    (
      "claimedExecutorPrincipalId" IS NULL
      AND "claimedExecutorInstanceId" IS NULL
      AND "claimIdempotencyKeyHash" IS NULL
      AND "claimFingerprint" IS NULL
      AND "claimedAt" IS NULL
    )
    OR
    (
      "claimedExecutorPrincipalId" IS NOT NULL
      AND char_length("claimedExecutorPrincipalId") BETWEEN 1 AND 256
      AND "claimedExecutorInstanceId" IS NOT NULL
      AND char_length("claimedExecutorInstanceId") BETWEEN 1 AND 256
      AND "claimedExecutorPrincipalId" = "assignedExecutorPrincipalId"
      AND "claimedExecutorInstanceId" = "assignedExecutorInstanceId"
      AND "claimIdempotencyKeyHash" IS NOT NULL
      AND "claimFingerprint" IS NOT NULL
      AND "claimedAt" IS NOT NULL
    )
  ),
  CONSTRAINT "ck_ap_exec_run_start_group" CHECK (
    (
      "startIdempotencyKeyHash" IS NULL
      AND "startFingerprint" IS NULL
      AND "startedAt" IS NULL
    )
    OR
    (
      "startIdempotencyKeyHash" IS NOT NULL
      AND "startFingerprint" IS NOT NULL
      AND "startedAt" IS NOT NULL
      AND "claimedAt" IS NOT NULL
    )
  ),
  CONSTRAINT "ck_ap_exec_run_result_group" CHECK (
    (
      "resultIdempotencyKeyHash" IS NULL
      AND "resultFingerprint" IS NULL
      AND "acceptanceReceipt" IS NULL
      AND "resultOutput" IS NULL
      AND "resultError" IS NULL
      AND "completedAt" IS NULL
    )
    OR
    (
      "resultIdempotencyKeyHash" IS NOT NULL
      AND "resultFingerprint" IS NOT NULL
      AND "acceptanceReceipt" IS NOT NULL
      AND "completedAt" IS NOT NULL
      AND "startedAt" IS NOT NULL
    )
  ),
  CONSTRAINT "ck_ap_exec_run_state_coherence" CHECK (
    (
      "state" = 'REQUESTED'
      AND "claimedAt" IS NULL
      AND "startedAt" IS NULL
      AND "resultIdempotencyKeyHash" IS NULL
      AND "resultFingerprint" IS NULL
      AND "acceptanceReceipt" IS NULL
      AND "resultOutput" IS NULL
      AND "resultError" IS NULL
      AND "completedAt" IS NULL
      AND "terminalCategory" IS NULL
      AND "cancelledAt" IS NULL
      AND "expiredAt" IS NULL
      AND "supersededAt" IS NULL
    )
    OR
    (
      "state" = 'CLAIMED'
      AND "claimedAt" IS NOT NULL
      AND "startedAt" IS NULL
      AND "resultIdempotencyKeyHash" IS NULL
      AND "resultFingerprint" IS NULL
      AND "acceptanceReceipt" IS NULL
      AND "resultOutput" IS NULL
      AND "resultError" IS NULL
      AND "completedAt" IS NULL
      AND "terminalCategory" IS NULL
      AND "cancelledAt" IS NULL
      AND "expiredAt" IS NULL
      AND "supersededAt" IS NULL
    )
    OR
    (
      "state" = 'RUNNING'
      AND "claimedAt" IS NOT NULL
      AND "startedAt" IS NOT NULL
      AND "resultIdempotencyKeyHash" IS NULL
      AND "resultFingerprint" IS NULL
      AND "acceptanceReceipt" IS NULL
      AND "resultOutput" IS NULL
      AND "resultError" IS NULL
      AND "completedAt" IS NULL
      AND "terminalCategory" IS NULL
      AND "cancelledAt" IS NULL
      AND "expiredAt" IS NULL
      AND "supersededAt" IS NULL
    )
    OR
    (
      "state" IN ('SUCCEEDED', 'FAILED')
      AND "terminalCategory" = "state"
      AND "completedAt" IS NOT NULL
      AND "cancelledAt" IS NULL
      AND "expiredAt" IS NULL
      AND "supersededAt" IS NULL
      AND (("state" = 'SUCCEEDED' AND "resultError" IS NULL) OR ("state" = 'FAILED' AND "resultOutput" IS NULL))
    )
    OR
    (
      "state" = 'CANCELLED'
      AND "terminalCategory" = 'CANCELLED'
      AND "completedAt" IS NULL
      AND "cancelledAt" IS NOT NULL
      AND "expiredAt" IS NULL
      AND "supersededAt" IS NULL
    )
    OR
    (
      "state" = 'EXPIRED'
      AND "terminalCategory" = 'EXPIRED'
      AND "completedAt" IS NULL
      AND "cancelledAt" IS NULL
      AND "expiredAt" IS NOT NULL
      AND "supersededAt" IS NULL
    )
    OR
    (
      "state" = 'SUPERSEDED'
      AND "terminalCategory" = 'SUPERSEDED'
      AND "completedAt" IS NULL
      AND "cancelledAt" IS NULL
      AND "expiredAt" IS NULL
      AND "supersededAt" IS NOT NULL
    )
  ),
  CONSTRAINT "uq_ap_exec_run_command_action" UNIQUE ("commandId", "actionId"),
  CONSTRAINT "uq_ap_exec_run_plan_action_attempt" UNIQUE ("planId", "actionId", "attempt"),
  CONSTRAINT "uq_ap_exec_run_snapshot" UNIQUE ("actionSnapshotId"),
  CONSTRAINT "uq_ap_exec_run_claim_idem" UNIQUE (
    "executionRealm",
    "assignedExecutorPrincipalId",
    "assignedExecutorInstanceId",
    "claimIdempotencyKeyHash"
  ),
  CONSTRAINT "uq_ap_exec_run_start_idem" UNIQUE (
    "id",
    "claimedExecutorPrincipalId",
    "claimedExecutorInstanceId",
    "startIdempotencyKeyHash"
  ),
  CONSTRAINT "uq_ap_exec_run_id_realm" UNIQUE ("id", "executionRealm"),
  CONSTRAINT "fk_ap_exec_run_command" FOREIGN KEY ("commandId", "planId", "executionRealm")
    REFERENCES "ActionPlanExecutionCommand" ("id", "planId", "executionRealm")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "fk_ap_exec_run_action" FOREIGN KEY ("planId", "actionId")
    REFERENCES "Action" ("planId", "id")
    ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS "uq_ap_exec_run_active_action"
  ON "ActionPlanExecutionRun" ("planId", "actionId")
  WHERE "state" IN ('REQUESTED', 'CLAIMED', 'RUNNING');

CREATE INDEX IF NOT EXISTS "ix_ap_exec_run_claim_next"
  ON "ActionPlanExecutionRun" (
    "executionRealm",
    "assignedExecutorPrincipalId",
    "assignedExecutorInstanceId",
    "state",
    "requestedAt",
    "id"
  )
  WHERE "state" = 'REQUESTED';

CREATE TABLE IF NOT EXISTS "ActionPlanExecutionEvent" (
  "id" TEXT PRIMARY KEY,
  "runId" TEXT NOT NULL,
  "eventSequence" BIGINT NOT NULL,
  "eventType" TEXT NOT NULL,
  "actorCategory" TEXT NOT NULL,
  "sourceService" TEXT NOT NULL,
  "executionRealm" TEXT NOT NULL,
  "reasonCode" TEXT NOT NULL,
  "requestId" TEXT,
  "traceId" TEXT,
  "safeMetadata" JSONB NOT NULL DEFAULT '{}'::JSONB,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ck_ap_exec_event_id" CHECK (
    char_length("id") BETWEEN 1 AND 128
    AND char_length("runId") BETWEEN 1 AND 128
  ),
  CONSTRAINT "ck_ap_exec_event_sequence" CHECK ("eventSequence" >= 1),
  CONSTRAINT "ck_ap_exec_event_type" CHECK (
    "eventType" IN (
      'EXECUTION_REQUESTED',
      'EXECUTION_CLAIMED',
      'EXECUTION_STARTED',
      'RESULT_ACCEPTED',
      'RESULT_REJECTED',
      'RUN_SUCCEEDED',
      'RUN_FAILED',
      'RUN_CANCELLED',
      'RUN_EXPIRED',
      'RUN_SUPERSEDED',
      'IDEMPOTENT_REPLAY'
    )
  ),
  CONSTRAINT "ck_ap_exec_event_actor" CHECK (
    "actorCategory" IN ('requester', 'operator_override', 'executor', 'system')
  ),
  CONSTRAINT "ck_ap_exec_event_source" CHECK (
    "sourceService" IN ('web', 'mcp', 'python-daemon', 'system')
  ),
  CONSTRAINT "ck_ap_exec_event_identifiers" CHECK (
    char_length("executionRealm") BETWEEN 1 AND 256
    AND char_length("reasonCode") BETWEEN 1 AND 128
    AND ("requestId" IS NULL OR char_length("requestId") BETWEEN 1 AND 128)
    AND ("traceId" IS NULL OR char_length("traceId") BETWEEN 1 AND 128)
  ),
  CONSTRAINT "ck_ap_exec_event_metadata" CHECK (
    jsonb_typeof("safeMetadata") = 'object'
    AND octet_length("safeMetadata"::TEXT) <= 4096
  ),
  CONSTRAINT "uq_ap_exec_event_run_sequence" UNIQUE ("runId", "eventSequence"),
  CONSTRAINT "fk_ap_exec_event_run_realm" FOREIGN KEY ("runId", "executionRealm")
    REFERENCES "ActionPlanExecutionRun" ("id", "executionRealm")
    ON DELETE RESTRICT ON UPDATE CASCADE
);
