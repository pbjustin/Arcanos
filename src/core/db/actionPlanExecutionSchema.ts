import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import type { Pool as PoolType } from 'pg';
import { getPool } from './client.js';

export const ACTION_PLAN_EXECUTION_SCHEMA_VERSION = '20260717_action_plan_execution_v2';
export const ACTION_PLAN_EXECUTION_SCHEMA_LABEL = 'action-plan-execution-v1';
export const ACTION_PLAN_EXECUTION_PROTOCOL_VERSION = 2;
export const ACTION_PLAN_EXECUTION_SNAPSHOT_SCHEMA_VERSION = 1;
export const ACTION_PLAN_EXECUTION_SCHEMA_CHECKSUM =
  'cfa339af4282ce47a955acd08fa3f16e617b4a943111890f1e5b4bd5ba929533';

const REQUIRED_TABLES = [
  'ActionPlanExecutionSchemaMigration',
  'ActionPlanExecutionCommand',
  'ActionPlanExecutionRun',
  'ActionPlanExecutionEvent'
] as const;

const REQUIRED_COLUMNS = {
  ActionPlanExecutionSchemaMigration: [
    'version',
    'checksum',
    'completedPhase',
    'validityState',
    'appliedAt',
    'updatedAt'
  ],
  ActionPlan: [
    'executionRealm',
    'ownerPrincipalId',
    'executionProtocolVersion',
    'executionGeneration'
  ],
  ActionPlanExecutionCommand: [
    'id',
    'planId',
    'executionRealm',
    'requesterPrincipalId',
    'commandIdempotencyKeyHash',
    'commandFingerprint',
    'lockedPlanExecutionGeneration',
    'protocolVersion',
    'createdAt'
  ],
  ActionPlanExecutionRun: [
    'id',
    'commandId',
    'planId',
    'actionId',
    'attempt',
    'state',
    'executorKind',
    'assignedAgentId',
    'assignedExecutorPrincipalId',
    'assignedExecutorInstanceId',
    'claimedExecutorPrincipalId',
    'claimedExecutorInstanceId',
    'executionRealm',
    'actionSnapshotId',
    'actionSnapshotSchemaVersion',
    'actionSnapshot',
    'claimIdempotencyKeyHash',
    'claimFingerprint',
    'startIdempotencyKeyHash',
    'startFingerprint',
    'resultIdempotencyKeyHash',
    'resultFingerprint',
    'policyCategory',
    'policyEvidenceId',
    'policyEvaluatedAt',
    'acceptanceReceipt',
    'terminalCategory',
    'resultOutput',
    'resultError',
    'eventSequence',
    'version',
    'requestedAt',
    'claimedAt',
    'startedAt',
    'completedAt',
    'cancelledAt',
    'expiredAt',
    'supersededAt',
    'updatedAt'
  ],
  ActionPlanExecutionEvent: [
    'id',
    'runId',
    'eventSequence',
    'eventType',
    'actorCategory',
    'sourceService',
    'executionRealm',
    'reasonCode',
    'requestId',
    'traceId',
    'safeMetadata',
    'createdAt'
  ]
} as const;

type ColumnDefaultKind = 'none' | 'current_timestamp' | 'zero' | 'empty_json_object';

interface ColumnSpec {
  type: 'text' | 'int4' | 'int8' | 'timestamptz' | 'jsonb';
  nullable: boolean;
  defaultKind: ColumnDefaultKind;
}

const text = (nullable = false): ColumnSpec => ({ type: 'text', nullable, defaultKind: 'none' });
const int4 = (nullable = false): ColumnSpec => ({ type: 'int4', nullable, defaultKind: 'none' });
const int8 = (nullable = false, defaultKind: ColumnDefaultKind = 'none'): ColumnSpec => ({
  type: 'int8',
  nullable,
  defaultKind
});
const timestamptz = (
  nullable = false,
  defaultKind: ColumnDefaultKind = 'none'
): ColumnSpec => ({ type: 'timestamptz', nullable, defaultKind });
const jsonb = (
  nullable = false,
  defaultKind: ColumnDefaultKind = 'none'
): ColumnSpec => ({ type: 'jsonb', nullable, defaultKind });

const REQUIRED_COLUMN_SPECS: Record<string, Record<string, ColumnSpec>> = {
  ActionPlanExecutionSchemaMigration: {
    version: text(),
    checksum: text(),
    completedPhase: text(),
    validityState: text(),
    appliedAt: timestamptz(true),
    updatedAt: timestamptz(false, 'current_timestamp')
  },
  ActionPlan: {
    executionRealm: text(true),
    ownerPrincipalId: text(true),
    executionProtocolVersion: int4(true),
    executionGeneration: int8(true)
  },
  ActionPlanExecutionCommand: {
    id: text(),
    planId: text(),
    executionRealm: text(),
    requesterPrincipalId: text(),
    commandIdempotencyKeyHash: text(),
    commandFingerprint: text(),
    lockedPlanExecutionGeneration: int8(),
    protocolVersion: int4(),
    createdAt: timestamptz(false, 'current_timestamp')
  },
  ActionPlanExecutionRun: {
    id: text(),
    commandId: text(),
    planId: text(),
    actionId: text(),
    attempt: int4(),
    state: text(),
    executorKind: text(),
    assignedAgentId: text(),
    assignedExecutorPrincipalId: text(),
    assignedExecutorInstanceId: text(),
    claimedExecutorPrincipalId: text(true),
    claimedExecutorInstanceId: text(true),
    executionRealm: text(),
    actionSnapshotId: text(),
    actionSnapshotSchemaVersion: int4(),
    actionSnapshot: jsonb(),
    claimIdempotencyKeyHash: text(true),
    claimFingerprint: text(true),
    startIdempotencyKeyHash: text(true),
    startFingerprint: text(true),
    resultIdempotencyKeyHash: text(true),
    resultFingerprint: text(true),
    policyCategory: text(),
    policyEvidenceId: text(),
    policyEvaluatedAt: timestamptz(),
    acceptanceReceipt: text(true),
    terminalCategory: text(true),
    resultOutput: jsonb(true),
    resultError: jsonb(true),
    eventSequence: int8(false, 'zero'),
    version: int8(false, 'zero'),
    requestedAt: timestamptz(false, 'current_timestamp'),
    claimedAt: timestamptz(true),
    startedAt: timestamptz(true),
    completedAt: timestamptz(true),
    cancelledAt: timestamptz(true),
    expiredAt: timestamptz(true),
    supersededAt: timestamptz(true),
    updatedAt: timestamptz(false, 'current_timestamp')
  },
  ActionPlanExecutionEvent: {
    id: text(),
    runId: text(),
    eventSequence: int8(),
    eventType: text(),
    actorCategory: text(),
    sourceService: text(),
    executionRealm: text(),
    reasonCode: text(),
    requestId: text(true),
    traceId: text(true),
    safeMetadata: jsonb(false, 'empty_json_object'),
    createdAt: timestamptz(false, 'current_timestamp')
  }
};

const REQUIRED_CONSTRAINTS = [
  'ActionPlanExecutionSchemaMigration_pkey',
  'ActionPlanExecutionCommand_pkey',
  'ActionPlanExecutionRun_pkey',
  'ActionPlanExecutionEvent_pkey',
  'ck_action_plan_execution_provenance_v2',
  'ck_ap_exec_command_fingerprint',
  'ck_ap_exec_command_generation',
  'ck_ap_exec_command_id',
  'ck_ap_exec_command_idem_hash',
  'ck_ap_exec_command_protocol',
  'ck_ap_exec_command_realm',
  'ck_ap_exec_command_requester',
  'ck_ap_exec_event_actor',
  'ck_ap_exec_event_id',
  'ck_ap_exec_event_identifiers',
  'ck_ap_exec_event_metadata',
  'ck_ap_exec_event_sequence',
  'ck_ap_exec_event_source',
  'ck_ap_exec_event_type',
  'ck_ap_exec_migration_checksum',
  'ck_ap_exec_migration_state',
  'ck_ap_exec_migration_version',
  'ck_ap_exec_run_assignment',
  'ck_ap_exec_run_attempt',
  'ck_ap_exec_run_claim_group',
  'ck_ap_exec_run_executor',
  'ck_ap_exec_run_hashes',
  'ck_ap_exec_run_id',
  'ck_ap_exec_run_policy',
  'ck_ap_exec_run_realm',
  'ck_ap_exec_run_result_bounds',
  'ck_ap_exec_run_result_group',
  'ck_ap_exec_run_sequence',
  'ck_ap_exec_run_snapshot',
  'ck_ap_exec_run_snapshot_id',
  'ck_ap_exec_run_snapshot_shape',
  'ck_ap_exec_run_snapshot_version',
  'ck_ap_exec_run_start_group',
  'ck_ap_exec_run_state',
  'ck_ap_exec_run_state_coherence',
  'fk_ap_exec_command_plan_realm',
  'fk_ap_exec_event_run_realm',
  'fk_ap_exec_run_action',
  'fk_ap_exec_run_command',
  'uq_ap_exec_command_id_plan_realm',
  'uq_ap_exec_command_idempotency',
  'uq_ap_exec_event_run_sequence',
  'uq_ap_exec_run_claim_idem',
  'uq_ap_exec_run_command_action',
  'uq_ap_exec_run_id_realm',
  'uq_ap_exec_run_plan_action_attempt',
  'uq_ap_exec_run_snapshot',
  'uq_ap_exec_run_start_idem'
] as const;

interface ConstraintSpec {
  table: string;
  type: 'c' | 'f' | 'p' | 'u';
  requiredFragments: string[];
  deferrable: false;
  initiallyDeferred: false;
}

const constraint = (
  table: string,
  type: ConstraintSpec['type'],
  ...requiredFragments: string[]
): ConstraintSpec => ({
  table,
  type,
  requiredFragments,
  deferrable: false,
  initiallyDeferred: false
});

const REQUIRED_CONSTRAINT_SPECS: Record<string, ConstraintSpec> = {
  ActionPlanExecutionSchemaMigration_pkey: constraint(
    'ActionPlanExecutionSchemaMigration', 'p', 'PRIMARY KEY (version)'
  ),
  ActionPlanExecutionCommand_pkey: constraint(
    'ActionPlanExecutionCommand', 'p', 'PRIMARY KEY (id)'
  ),
  ActionPlanExecutionRun_pkey: constraint(
    'ActionPlanExecutionRun', 'p', 'PRIMARY KEY (id)'
  ),
  ActionPlanExecutionEvent_pkey: constraint(
    'ActionPlanExecutionEvent', 'p', 'PRIMARY KEY (id)'
  ),
  ck_action_plan_execution_provenance_v2: constraint(
    'ActionPlan', 'c', 'executionRealm IS NULL', 'executionProtocolVersion = 2', 'executionGeneration >= 1'
  ),
  ck_ap_exec_migration_version: constraint(
    'ActionPlanExecutionSchemaMigration', 'c', 'char_length(version)', 'BETWEEN 1 AND 64'
  ),
  ck_ap_exec_migration_checksum: constraint(
    'ActionPlanExecutionSchemaMigration', 'c', "checksum ~ '^[0-9a-f]{64}$'"
  ),
  ck_ap_exec_migration_state: constraint(
    'ActionPlanExecutionSchemaMigration', 'c', 'validityState', 'RECOVERING_INVALID_INDEX', 'VALID'
  ),
  ck_ap_exec_command_id: constraint(
    'ActionPlanExecutionCommand', 'c', 'char_length(id)', 'char_length(planId)', 'BETWEEN 1 AND 128'
  ),
  ck_ap_exec_command_realm: constraint(
    'ActionPlanExecutionCommand', 'c', 'char_length(executionRealm)', 'BETWEEN 1 AND 256'
  ),
  ck_ap_exec_command_requester: constraint(
    'ActionPlanExecutionCommand', 'c', 'char_length(requesterPrincipalId)', 'BETWEEN 1 AND 256'
  ),
  ck_ap_exec_command_idem_hash: constraint(
    'ActionPlanExecutionCommand', 'c', "commandIdempotencyKeyHash ~ '^[0-9a-f]{64}$'"
  ),
  ck_ap_exec_command_fingerprint: constraint(
    'ActionPlanExecutionCommand', 'c', "commandFingerprint ~ '^[0-9a-f]{64}$'"
  ),
  ck_ap_exec_command_generation: constraint(
    'ActionPlanExecutionCommand', 'c', 'lockedPlanExecutionGeneration >= 1'
  ),
  ck_ap_exec_command_protocol: constraint(
    'ActionPlanExecutionCommand', 'c', 'protocolVersion = 2'
  ),
  uq_ap_exec_command_id_plan_realm: constraint(
    'ActionPlanExecutionCommand', 'u', 'UNIQUE (id, planId, executionRealm)'
  ),
  uq_ap_exec_command_idempotency: constraint(
    'ActionPlanExecutionCommand', 'u',
    'UNIQUE (executionRealm, requesterPrincipalId, planId, commandIdempotencyKeyHash)'
  ),
  fk_ap_exec_command_plan_realm: constraint(
    'ActionPlanExecutionCommand', 'f',
    'FOREIGN KEY (planId, executionRealm)',
    'REFERENCES ActionPlan(id, executionRealm)',
    'ON UPDATE CASCADE', 'ON DELETE RESTRICT'
  ),
  ck_ap_exec_run_id: constraint(
    'ActionPlanExecutionRun', 'c', 'char_length(id)', 'char_length(commandId)',
    'char_length(planId)', 'char_length(actionId)', 'BETWEEN 1 AND 128'
  ),
  ck_ap_exec_run_attempt: constraint('ActionPlanExecutionRun', 'c', 'attempt >= 1'),
  ck_ap_exec_run_state: constraint(
    'ActionPlanExecutionRun', 'c', 'state', 'REQUESTED', 'SUPERSEDED'
  ),
  ck_ap_exec_run_executor: constraint(
    'ActionPlanExecutionRun', 'c', "executorKind = 'python-daemon'"
  ),
  ck_ap_exec_run_realm: constraint(
    'ActionPlanExecutionRun', 'c', 'char_length(executionRealm)', 'BETWEEN 1 AND 256'
  ),
  ck_ap_exec_run_assignment: constraint(
    'ActionPlanExecutionRun', 'c', 'char_length(assignedAgentId)',
    'char_length(assignedExecutorPrincipalId)', 'char_length(assignedExecutorInstanceId)'
  ),
  ck_ap_exec_run_snapshot_id: constraint(
    'ActionPlanExecutionRun', 'c', 'char_length(actionSnapshotId)', 'BETWEEN 1 AND 128'
  ),
  ck_ap_exec_run_snapshot_version: constraint(
    'ActionPlanExecutionRun', 'c', 'actionSnapshotSchemaVersion = 1'
  ),
  ck_ap_exec_run_snapshot: constraint(
    'ActionPlanExecutionRun', 'c', "jsonb_typeof(actionSnapshot) = 'object'",
    'octet_length(actionSnapshot::text) <= 65536'
  ),
  ck_ap_exec_run_snapshot_shape: constraint(
    'ActionPlanExecutionRun', 'c',
    "actionSnapshot ->> 'snapshot_version' = 'action-execution-snapshot-v1'",
    "jsonb_typeof(actionSnapshot -> 'plan_id') = 'string'", "actionSnapshot ->> 'plan_id' = planId",
    "jsonb_typeof(actionSnapshot -> 'action_id') = 'string'", "actionSnapshot ->> 'action_id' = actionId",
    "jsonb_typeof(actionSnapshot -> 'agent_id') = 'string'", "actionSnapshot ->> 'agent_id' = assignedAgentId",
    "jsonb_typeof(actionSnapshot -> 'capability') = 'string'", "actionSnapshot ? 'params'",
    "jsonb_typeof(actionSnapshot -> 'timeout_ms') = 'number'",
    "jsonb_typeof(actionSnapshot -> 'sort_order') = 'number'",
    "jsonb_typeof(actionSnapshot -> 'plan_execution_generation') = 'number'",
    "actionSnapshot ->> 'plan_execution_generation'", '>= 1',
    "jsonb_typeof(actionSnapshot -> 'executor_kind') = 'string'", "actionSnapshot ->> 'executor_kind' = executorKind",
    "jsonb_typeof(actionSnapshot -> 'assigned_executor_principal_id') = 'string'",
    "actionSnapshot ->> 'assigned_executor_principal_id' = assignedExecutorPrincipalId",
    "jsonb_typeof(actionSnapshot -> 'agent_capability_fingerprint') = 'string'",
    "actionSnapshot ->> 'agent_capability_fingerprint'", "'^[0-9a-f]{64}$'"
  ),
  ck_ap_exec_run_hashes: constraint(
    'ActionPlanExecutionRun', 'c', 'claimIdempotencyKeyHash', 'startIdempotencyKeyHash',
    'resultIdempotencyKeyHash', "'^[0-9a-f]{64}$'"
  ),
  ck_ap_exec_run_policy: constraint(
    'ActionPlanExecutionRun', 'c', 'policyCategory', 'ALLOW', 'CONFIRM',
    "policyEvidenceId ~ '^clear-recheck-v1:[0-9a-f]{64}$'"
  ),
  ck_ap_exec_run_sequence: constraint(
    'ActionPlanExecutionRun', 'c', 'eventSequence >= 0', 'version >= 0'
  ),
  ck_ap_exec_run_result_bounds: constraint(
    'ActionPlanExecutionRun', 'c', 'octet_length(resultOutput::text) <= 65536',
    'octet_length(resultError::text) <= 8192', 'char_length(acceptanceReceipt)'
  ),
  ck_ap_exec_run_claim_group: constraint(
    'ActionPlanExecutionRun', 'c', 'claimedExecutorPrincipalId IS NULL',
    'claimedExecutorPrincipalId = assignedExecutorPrincipalId',
    'claimedExecutorInstanceId = assignedExecutorInstanceId', 'claimedAt IS NOT NULL'
  ),
  ck_ap_exec_run_start_group: constraint(
    'ActionPlanExecutionRun', 'c', 'startIdempotencyKeyHash IS NULL',
    'startFingerprint IS NOT NULL', 'startedAt IS NOT NULL', 'claimedAt IS NOT NULL'
  ),
  ck_ap_exec_run_result_group: constraint(
    'ActionPlanExecutionRun', 'c', 'resultIdempotencyKeyHash IS NULL',
    'resultOutput IS NULL', 'resultError IS NULL', 'acceptanceReceipt IS NOT NULL',
    'completedAt IS NOT NULL', 'startedAt IS NOT NULL'
  ),
  ck_ap_exec_run_state_coherence: constraint(
    'ActionPlanExecutionRun', 'c', "state = 'REQUESTED'", "state = 'RUNNING'",
    "state = 'SUCCEEDED'", "state = 'FAILED'", "state = 'CANCELLED'",
    "state = 'EXPIRED'", "state = 'SUPERSEDED'", 'terminalCategory = state'
  ),
  uq_ap_exec_run_command_action: constraint(
    'ActionPlanExecutionRun', 'u', 'UNIQUE (commandId, actionId)'
  ),
  uq_ap_exec_run_plan_action_attempt: constraint(
    'ActionPlanExecutionRun', 'u', 'UNIQUE (planId, actionId, attempt)'
  ),
  uq_ap_exec_run_snapshot: constraint(
    'ActionPlanExecutionRun', 'u', 'UNIQUE (actionSnapshotId)'
  ),
  uq_ap_exec_run_claim_idem: constraint(
    'ActionPlanExecutionRun', 'u',
    'UNIQUE (executionRealm, assignedExecutorPrincipalId, assignedExecutorInstanceId, claimIdempotencyKeyHash)'
  ),
  uq_ap_exec_run_start_idem: constraint(
    'ActionPlanExecutionRun', 'u',
    'UNIQUE (id, claimedExecutorPrincipalId, claimedExecutorInstanceId, startIdempotencyKeyHash)'
  ),
  uq_ap_exec_run_id_realm: constraint(
    'ActionPlanExecutionRun', 'u', 'UNIQUE (id, executionRealm)'
  ),
  fk_ap_exec_run_command: constraint(
    'ActionPlanExecutionRun', 'f', 'FOREIGN KEY (commandId, planId, executionRealm)',
    'REFERENCES ActionPlanExecutionCommand(id, planId, executionRealm)',
    'ON UPDATE CASCADE', 'ON DELETE RESTRICT'
  ),
  fk_ap_exec_run_action: constraint(
    'ActionPlanExecutionRun', 'f', 'FOREIGN KEY (planId, actionId)',
    'REFERENCES Action(planId, id)', 'ON UPDATE CASCADE', 'ON DELETE RESTRICT'
  ),
  ck_ap_exec_event_id: constraint(
    'ActionPlanExecutionEvent', 'c', 'char_length(id)', 'char_length(runId)', 'BETWEEN 1 AND 128'
  ),
  ck_ap_exec_event_sequence: constraint(
    'ActionPlanExecutionEvent', 'c', 'eventSequence >= 1'
  ),
  ck_ap_exec_event_type: constraint(
    'ActionPlanExecutionEvent', 'c', 'eventType', 'EXECUTION_REQUESTED', 'RESULT_ACCEPTED',
    'IDEMPOTENT_REPLAY'
  ),
  ck_ap_exec_event_actor: constraint(
    'ActionPlanExecutionEvent', 'c', 'actorCategory', 'requester', 'executor', 'system'
  ),
  ck_ap_exec_event_source: constraint(
    'ActionPlanExecutionEvent', 'c', 'sourceService', 'web', 'mcp', 'python-daemon'
  ),
  ck_ap_exec_event_identifiers: constraint(
    'ActionPlanExecutionEvent', 'c', 'char_length(executionRealm)', 'char_length(reasonCode)',
    'char_length(requestId)', 'char_length(traceId)'
  ),
  ck_ap_exec_event_metadata: constraint(
    'ActionPlanExecutionEvent', 'c', "jsonb_typeof(safeMetadata) = 'object'",
    'octet_length(safeMetadata::text) <= 4096'
  ),
  uq_ap_exec_event_run_sequence: constraint(
    'ActionPlanExecutionEvent', 'u', 'UNIQUE (runId, eventSequence)'
  ),
  fk_ap_exec_event_run_realm: constraint(
    'ActionPlanExecutionEvent', 'f', 'FOREIGN KEY (runId, executionRealm)',
    'REFERENCES ActionPlanExecutionRun(id, executionRealm)',
    'ON UPDATE CASCADE', 'ON DELETE RESTRICT'
  )
};

const REQUIRED_CHECK_DEFINITION_HASHES: Record<string, string> = {
  ck_ap_exec_migration_version: '70f6749c1081d98ce4ccbd59210d716d1ab1e0792b0d4137969dd586056186b9',
  ck_ap_exec_migration_checksum: '92ac0a0e79c37c7b4ef43270e0b9b69404daed5c886c4fa14262214b7a99cd50',
  ck_ap_exec_migration_state: 'bed220fdd744e0a210ea742332cf322c5b090f5a1dc0250737b73b6594523540',
  ck_action_plan_execution_provenance_v2: '6c935b75b3a8b295bdf8497d6a5d25e4488cb8e26d45b6851bfb14301d0bf10e',
  ck_ap_exec_command_id: 'a136015059d12601c14377b28fffa3ce4fc0fcc06c9ecc20c8867c6d7e78f4d8',
  ck_ap_exec_command_realm: '8d8679656d4d3ddfed8c93044066d656c3d25f44a873c4090d1ee115319b38c6',
  ck_ap_exec_command_requester: '014b36374b05a48e23c45f9c27830b50d4c6fa3a347a26529713bb925c9e3952',
  ck_ap_exec_command_idem_hash: 'acf1a717b10515b46abff25b8104af20bf44044a159e4b521073485313ee3713',
  ck_ap_exec_command_fingerprint: '48b24542462f4de65ec83fd6bac2a001900a55ea52a4c5b5dc9e61b2bb5e9f58',
  ck_ap_exec_command_generation: 'e4101f143d850d417ee2249167f077989f97756743ed86b81317f21977fcb71a',
  ck_ap_exec_command_protocol: 'a0a36f60c03b7b2e44af3cb5ee76e495bbfda334ee98c1a098df7fb27f0e9c80',
  ck_ap_exec_run_id: 'de630d3248c39112f4246c53156bfec2665389a54de2fd224bcd4ff6bc7f034c',
  ck_ap_exec_run_attempt: '57af9448c3b033bc925809d88e5b289139f607a2ba663576b232b14a97f7dbfc',
  ck_ap_exec_run_state: '68362eaba7748ea86ae27fc7018776998a94f83c419cf32710530772b489f5b2',
  ck_ap_exec_run_executor: '7b330b02f18e700013c380e8049e8511a9f68a2d383e3e7e526593d113ab6437',
  ck_ap_exec_run_realm: '8d8679656d4d3ddfed8c93044066d656c3d25f44a873c4090d1ee115319b38c6',
  ck_ap_exec_run_assignment: '6345801f79376017ad0ebf82b2b3cdaabe64e626fea0e65a9d0f5f26c8f5c245',
  ck_ap_exec_run_snapshot_id: '37201450d3b39d5f3b75849a8269448e69ce4f2887790833a74a2622464d873d',
  ck_ap_exec_run_snapshot_version: '5b12b718e249fa2c41bb1b0dbeca3cfd6f3e5c103f4195fe047c941aea51d94e',
  ck_ap_exec_run_snapshot: '68f0336f96db55aff39fbba2f99ee97ef3c4a8b6ceb62e313c5aad1ae8bba1f0',
  ck_ap_exec_run_snapshot_shape: '9c8e7a3fb7e770468554f47f702a25ff7ded1b2ac075024b0a22fa0a2633d1fe',
  ck_ap_exec_run_hashes: '1334c164956834d1c1a1b278becd4ec7876d6d090f293fef0f33a6db2a5b816e',
  ck_ap_exec_run_policy: '87d8fa86c20a1fb33695f3852493815381eb263d0a3593bc39cf45148d9c065f',
  ck_ap_exec_run_sequence: '14599d2eb1a346c353f3479011cf263c87bd5f245e06041f09893ceb426a0213',
  ck_ap_exec_run_result_bounds: '127ce6a3d596cd6e3dc5acaedea8730d1c571f32d40dc00f086f337bb75dcfd0',
  ck_ap_exec_run_claim_group: 'bc0b941d7ad645991b06861d0a474b022f9577d67559b225faf3eb4d15ad1940',
  ck_ap_exec_run_start_group: 'b17050d978fd59bd44b6ee43e0c661efaa66d7511143736eab9c7b79cfa553c1',
  ck_ap_exec_run_result_group: '4cfd876a9b5c30bc1dfc63bd0c28a25a5ef041a4374f01a4eaee566b29936907',
  ck_ap_exec_run_state_coherence: '1f694a34703226118cf3079d7e8276c638bac76b0f82bd399cac23cf247e2443',
  ck_ap_exec_event_id: 'f8d79479417765d505542c503ab6696cb5c088ce81ab7df0c1715435b9ddb9ec',
  ck_ap_exec_event_sequence: '8a743d920ee0f08c38d7b5b27e78a7404815391a626fa74e9dc14efcd07cf747',
  ck_ap_exec_event_type: '694448a31992a43458872ea69474f36de45f01244688f0546964220ad3cac6f9',
  ck_ap_exec_event_actor: '88e014053da01d10bb46d93c9aa5cdcd5f10ff4fa4672ee8e533fe602e271e87',
  ck_ap_exec_event_source: '3b320960ce5eec6cd88cabcdada811549ae6fb8bbd719d69ea272cd6216b8b45',
  ck_ap_exec_event_identifiers: '46ea843115ee2f5c8b0b2a230788194e5f793e6473033f7be899e664fa5b5d7e',
  ck_ap_exec_event_metadata: '559e64bec811966e261e1473ea71a31f52433ebc65b9055ffcb6ca6201dc99f0'
};

const checkColumns = (...columns: string[]): string[] => [...columns].sort();

const REQUIRED_CHECK_COLUMN_SETS: Record<string, string[]> = {
  ck_ap_exec_migration_version: checkColumns('version'),
  ck_ap_exec_migration_checksum: checkColumns('checksum'),
  ck_ap_exec_migration_state: checkColumns('validityState'),
  ck_action_plan_execution_provenance_v2: checkColumns(
    'executionRealm', 'ownerPrincipalId', 'executionProtocolVersion', 'executionGeneration'
  ),
  ck_ap_exec_command_id: checkColumns('id', 'planId'),
  ck_ap_exec_command_realm: checkColumns('executionRealm'),
  ck_ap_exec_command_requester: checkColumns('requesterPrincipalId'),
  ck_ap_exec_command_idem_hash: checkColumns('commandIdempotencyKeyHash'),
  ck_ap_exec_command_fingerprint: checkColumns('commandFingerprint'),
  ck_ap_exec_command_generation: checkColumns('lockedPlanExecutionGeneration'),
  ck_ap_exec_command_protocol: checkColumns('protocolVersion'),
  ck_ap_exec_run_id: checkColumns('id', 'commandId', 'planId', 'actionId'),
  ck_ap_exec_run_attempt: checkColumns('attempt'),
  ck_ap_exec_run_state: checkColumns('state'),
  ck_ap_exec_run_executor: checkColumns('executorKind'),
  ck_ap_exec_run_realm: checkColumns('executionRealm'),
  ck_ap_exec_run_assignment: checkColumns(
    'assignedAgentId', 'assignedExecutorPrincipalId', 'assignedExecutorInstanceId'
  ),
  ck_ap_exec_run_snapshot_id: checkColumns('actionSnapshotId'),
  ck_ap_exec_run_snapshot_version: checkColumns('actionSnapshotSchemaVersion'),
  ck_ap_exec_run_snapshot: checkColumns('actionSnapshot'),
  ck_ap_exec_run_snapshot_shape: checkColumns(
    'actionSnapshot', 'planId', 'actionId', 'assignedAgentId', 'executorKind',
    'assignedExecutorPrincipalId'
  ),
  ck_ap_exec_run_hashes: checkColumns(
    'claimIdempotencyKeyHash', 'claimFingerprint', 'startIdempotencyKeyHash',
    'startFingerprint', 'resultIdempotencyKeyHash', 'resultFingerprint'
  ),
  ck_ap_exec_run_policy: checkColumns('policyCategory', 'policyEvidenceId'),
  ck_ap_exec_run_sequence: checkColumns('eventSequence', 'version'),
  ck_ap_exec_run_result_bounds: checkColumns(
    'resultOutput', 'resultError', 'acceptanceReceipt'
  ),
  ck_ap_exec_run_claim_group: checkColumns(
    'claimedExecutorPrincipalId', 'claimedExecutorInstanceId', 'claimIdempotencyKeyHash',
    'claimFingerprint', 'claimedAt', 'assignedExecutorPrincipalId',
    'assignedExecutorInstanceId'
  ),
  ck_ap_exec_run_start_group: checkColumns(
    'startIdempotencyKeyHash', 'startFingerprint', 'startedAt', 'claimedAt'
  ),
  ck_ap_exec_run_result_group: checkColumns(
    'resultIdempotencyKeyHash', 'resultFingerprint', 'acceptanceReceipt', 'resultOutput',
    'resultError', 'completedAt', 'startedAt'
  ),
  ck_ap_exec_run_state_coherence: checkColumns(
    'state', 'claimedAt', 'startedAt', 'resultIdempotencyKeyHash', 'resultFingerprint',
    'acceptanceReceipt', 'resultOutput', 'resultError', 'completedAt', 'terminalCategory',
    'cancelledAt', 'expiredAt', 'supersededAt'
  ),
  ck_ap_exec_event_id: checkColumns('id', 'runId'),
  ck_ap_exec_event_sequence: checkColumns('eventSequence'),
  ck_ap_exec_event_type: checkColumns('eventType'),
  ck_ap_exec_event_actor: checkColumns('actorCategory'),
  ck_ap_exec_event_source: checkColumns('sourceService'),
  ck_ap_exec_event_identifiers: checkColumns(
    'executionRealm', 'reasonCode', 'requestId', 'traceId'
  ),
  ck_ap_exec_event_metadata: checkColumns('safeMetadata')
};

interface RelationalConstraintSpec {
  columns: string[];
  referencedTable?: string;
  referencedColumns?: string[];
  updateAction?: 'c';
  deleteAction?: 'r';
}

const REQUIRED_RELATIONAL_CONSTRAINT_SPECS: Record<string, RelationalConstraintSpec> = {
  ActionPlanExecutionSchemaMigration_pkey: { columns: ['version'] },
  ActionPlanExecutionCommand_pkey: { columns: ['id'] },
  ActionPlanExecutionRun_pkey: { columns: ['id'] },
  ActionPlanExecutionEvent_pkey: { columns: ['id'] },
  uq_ap_exec_command_id_plan_realm: { columns: ['id', 'planId', 'executionRealm'] },
  uq_ap_exec_command_idempotency: {
    columns: ['executionRealm', 'requesterPrincipalId', 'planId', 'commandIdempotencyKeyHash']
  },
  uq_ap_exec_run_command_action: { columns: ['commandId', 'actionId'] },
  uq_ap_exec_run_plan_action_attempt: { columns: ['planId', 'actionId', 'attempt'] },
  uq_ap_exec_run_snapshot: { columns: ['actionSnapshotId'] },
  uq_ap_exec_run_claim_idem: {
    columns: [
      'executionRealm', 'assignedExecutorPrincipalId', 'assignedExecutorInstanceId',
      'claimIdempotencyKeyHash'
    ]
  },
  uq_ap_exec_run_start_idem: {
    columns: [
      'id', 'claimedExecutorPrincipalId', 'claimedExecutorInstanceId',
      'startIdempotencyKeyHash'
    ]
  },
  uq_ap_exec_run_id_realm: { columns: ['id', 'executionRealm'] },
  uq_ap_exec_event_run_sequence: { columns: ['runId', 'eventSequence'] },
  fk_ap_exec_command_plan_realm: {
    columns: ['planId', 'executionRealm'],
    referencedTable: 'ActionPlan',
    referencedColumns: ['id', 'executionRealm'],
    updateAction: 'c',
    deleteAction: 'r'
  },
  fk_ap_exec_run_command: {
    columns: ['commandId', 'planId', 'executionRealm'],
    referencedTable: 'ActionPlanExecutionCommand',
    referencedColumns: ['id', 'planId', 'executionRealm'],
    updateAction: 'c',
    deleteAction: 'r'
  },
  fk_ap_exec_run_action: {
    columns: ['planId', 'actionId'],
    referencedTable: 'Action',
    referencedColumns: ['planId', 'id'],
    updateAction: 'c',
    deleteAction: 'r'
  },
  fk_ap_exec_event_run_realm: {
    columns: ['runId', 'executionRealm'],
    referencedTable: 'ActionPlanExecutionRun',
    referencedColumns: ['id', 'executionRealm'],
    updateAction: 'c',
    deleteAction: 'r'
  }
};

const REQUIRED_INDEXES = [
  'uq_action_plan_id_execution_realm_v2',
  'uq_action_plan_action_plan_id_id_v2',
  'uq_ap_exec_run_active_action',
  'ix_ap_exec_run_claim_next'
] as const;

interface IndexSpec {
  table: string;
  unique: boolean;
  columns: string[];
  predicateStates: string[];
}

const REQUIRED_INDEX_SPECS: Record<string, IndexSpec> = {
  uq_action_plan_id_execution_realm_v2: {
    table: 'ActionPlan',
    unique: true,
    columns: ['id', 'executionRealm'],
    predicateStates: []
  },
  uq_action_plan_action_plan_id_id_v2: {
    table: 'Action',
    unique: true,
    columns: ['planId', 'id'],
    predicateStates: []
  },
  uq_ap_exec_run_active_action: {
    table: 'ActionPlanExecutionRun',
    unique: true,
    columns: ['planId', 'actionId'],
    predicateStates: ['CLAIMED', 'REQUESTED', 'RUNNING']
  },
  ix_ap_exec_run_claim_next: {
    table: 'ActionPlanExecutionRun',
    unique: false,
    columns: [
      'executionRealm',
      'assignedExecutorPrincipalId',
      'assignedExecutorInstanceId',
      'state',
      'requestedAt',
      'id'
    ],
    predicateStates: ['REQUESTED']
  }
};

export const ACTION_PLAN_EXECUTION_SCHEMA_REQUIREMENTS = Object.freeze({
  tables: [...REQUIRED_TABLES],
  columns: Object.fromEntries(
    Object.entries(REQUIRED_COLUMNS).map(([table, columns]) => [table, [...columns]])
  ),
  columnSpecs: REQUIRED_COLUMN_SPECS,
  constraints: [...REQUIRED_CONSTRAINTS],
  constraintSpecs: REQUIRED_CONSTRAINT_SPECS,
  checkColumnSets: REQUIRED_CHECK_COLUMN_SETS,
  relationalConstraintSpecs: REQUIRED_RELATIONAL_CONSTRAINT_SPECS,
  indexes: [...REQUIRED_INDEXES],
  indexSpecs: REQUIRED_INDEX_SPECS
});

interface QueryResultLike<Row> {
  rows: Row[];
}

export interface ActionPlanExecutionSchemaQueryable {
  query<Row extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    values?: unknown[]
  ): Promise<QueryResultLike<Row>>;
}

export type ActionPlanExecutionSchemaVerificationCode =
  | 'ACTION_PLAN_EXECUTION_SCHEMA_READY'
  | 'ACTION_PLAN_EXECUTION_SCHEMA_MISSING'
  | 'ACTION_PLAN_EXECUTION_SCHEMA_INVALID'
  | 'ACTION_PLAN_EXECUTION_SCHEMA_UNAVAILABLE';

export interface ActionPlanExecutionSchemaVerification {
  ready: boolean;
  code: ActionPlanExecutionSchemaVerificationCode;
  version: string;
  schemaLabel: string;
  protocolVersion: number;
  snapshotSchemaVersion: number;
  checksum: string;
  issues: string[];
}

function verification(
  code: ActionPlanExecutionSchemaVerificationCode,
  issues: string[]
): ActionPlanExecutionSchemaVerification {
  return {
    ready: code === 'ACTION_PLAN_EXECUTION_SCHEMA_READY',
    code,
    version: ACTION_PLAN_EXECUTION_SCHEMA_VERSION,
    schemaLabel: ACTION_PLAN_EXECUTION_SCHEMA_LABEL,
    protocolVersion: ACTION_PLAN_EXECUTION_PROTOCOL_VERSION,
    snapshotSchemaVersion: ACTION_PLAN_EXECUTION_SNAPSHOT_SCHEMA_VERSION,
    checksum: ACTION_PLAN_EXECUTION_SCHEMA_CHECKSUM,
    issues: [...issues].sort()
  };
}

const RESERVED_SQL_IDENTIFIERS = new Set([
  'all', 'and', 'any', 'array', 'as', 'between', 'check', 'constraint', 'false',
  'foreign', 'from', 'in', 'is', 'key', 'not', 'null', 'or', 'primary',
  'references', 'select', 'true', 'unique', 'where'
]);
const SAFE_DEQUOTED_SQL_IDENTIFIERS: ReadonlySet<string> = new Set<string>(
  Object.values(REQUIRED_COLUMNS)
    .flat()
    .filter(identifier => /^[a-z_][a-z0-9_$]*$/u.test(identifier))
    .filter(identifier => !RESERVED_SQL_IDENTIFIERS.has(identifier))
);

function rewriteSqlSegments(
  value: string,
  rewriteUnquoted: (segment: string) => string,
  rewriteDoubleQuoted: (segment: string, closed: boolean) => string = segment => segment
): string {
  let output = '';
  let unquotedStart = 0;
  let index = 0;
  while (index < value.length) {
    const quote = value[index];
    if (quote !== "'" && quote !== '"') {
      index += 1;
      continue;
    }

    output += rewriteUnquoted(value.slice(unquotedStart, index));
    let end = index + 1;
    let closed = false;
    while (end < value.length) {
      if (value[end] !== quote) {
        end += 1;
        continue;
      }
      if (value[end + 1] === quote) {
        end += 2;
        continue;
      }
      end += 1;
      closed = true;
      break;
    }
    const quotedSegment = value.slice(index, end);
    output += quote === "'"
      ? quotedSegment
      : rewriteDoubleQuoted(quotedSegment, closed);
    index = end;
    unquotedStart = end;
  }
  return output + rewriteUnquoted(value.slice(unquotedStart));
}

function normalizeDefinition(value: unknown): string {
  const normalizedIdentifiers = rewriteSqlSegments(
    String(value ?? ''),
    segment => segment.toLowerCase(),
    (segment, closed) => {
      if (!closed) return segment;
      const identifier = segment.slice(1, -1);
      return SAFE_DEQUOTED_SQL_IDENTIFIERS.has(identifier)
        ? identifier
        : segment;
    }
  );
  const normalizedLiteralCasts = normalizedIdentifiers.replace(
    /('(?:''|[^'])*')::\s*(?:character varying|text)\b/giu,
    '$1'
  );
  return rewriteSqlSegments(
    normalizedLiteralCasts,
    segment => segment
      .replace(/\s+/gu, ' ')
      .replace(/\s*([\[\](),])\s*/gu, '$1')
  ).trim();
}

type BooleanNode =
  | { kind: 'atom'; value: string }
  | { kind: 'between'; left: string; lower: string; upper: string }
  | { kind: 'and' | 'or'; children: BooleanNode[] };

function stripOuterBooleanParentheses(value: string): string {
  let expression = value.trim();
  while (expression.startsWith('(') && expression.endsWith(')')) {
    let depth = 0;
    let activeQuote: "'" | '"' | null = null;
    let enclosesWholeExpression = true;
    for (let index = 0; index < expression.length; index += 1) {
      const character = expression[index];
      if (activeQuote !== null) {
        if (character === activeQuote && expression[index + 1] === activeQuote) {
          index += 1;
          continue;
        }
        if (character === activeQuote) activeQuote = null;
        continue;
      }
      if (character === "'" || character === '"') {
        activeQuote = character;
        continue;
      }
      if (character === '(') depth += 1;
      if (character === ')') {
        depth -= 1;
        if (depth === 0 && index < expression.length - 1) {
          enclosesWholeExpression = false;
          break;
        }
      }
    }
    if (!enclosesWholeExpression || depth !== 0) break;
    expression = expression.slice(1, -1).trim();
  }
  return expression;
}

function splitTopLevelBoolean(value: string, operator: 'and' | 'or'): string[] {
  const parts: string[] = [];
  let start = 0;
  let depth = 0;
  let activeQuote: "'" | '"' | null = null;
  let betweenPending = false;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (activeQuote !== null) {
      if (character === activeQuote && value[index + 1] === activeQuote) {
        index += 1;
        continue;
      }
      if (character === activeQuote) activeQuote = null;
      continue;
    }
    if (character === "'" || character === '"') {
      activeQuote = character;
      continue;
    }
    if (character === '(' || character === '[') {
      depth += 1;
      continue;
    }
    if (character === ')' || character === ']') {
      depth -= 1;
      continue;
    }
    if (depth !== 0 || !/[a-z_]/u.test(character)) continue;
    let end = index + 1;
    while (end < value.length && /[a-z0-9_]/u.test(value[end])) end += 1;
    const word = value.slice(index, end);
    if (word === 'between') {
      betweenPending = true;
    } else if (word === 'and' && betweenPending) {
      betweenPending = false;
    } else if (word === operator) {
      parts.push(value.slice(start, index));
      start = end;
    }
    index = end - 1;
  }
  if (parts.length === 0) return [value];
  parts.push(value.slice(start));
  return parts;
}

function atomicBooleanNode(value: string): BooleanNode {
  const canonical = rewriteSqlSegments(
    value,
    segment => segment.replace(/[()[\]\s]/gu, '')
  );
  const between = canonical.match(/^(.+)between(-?[0-9]+)and(-?[0-9]+)$/u);
  if (between) {
    return { kind: 'between', left: between[1], lower: between[2], upper: between[3] };
  }
  return { kind: 'atom', value: canonical };
}

function parseBooleanNode(value: string): BooleanNode {
  const expression = stripOuterBooleanParentheses(value);
  const orParts = splitTopLevelBoolean(expression, 'or');
  if (orParts.length > 1) {
    return { kind: 'or', children: orParts.map(parseBooleanNode) };
  }
  const andParts = splitTopLevelBoolean(expression, 'and');
  if (andParts.length > 1) {
    return { kind: 'and', children: andParts.map(parseBooleanNode) };
  }
  return atomicBooleanNode(expression);
}

function lastIndexOfOutsideQuotes(value: string, needle: string): number {
  let activeQuote: "'" | '"' | null = null;
  let marker = -1;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (activeQuote !== null) {
      if (character === activeQuote && value[index + 1] === activeQuote) {
        index += 1;
        continue;
      }
      if (character === activeQuote) activeQuote = null;
      continue;
    }
    if (character === "'" || character === '"') {
      activeQuote = character;
      continue;
    }
    if (value.startsWith(needle, index)) marker = index;
  }
  return marker;
}

function comparisonParts(
  node: BooleanNode | undefined,
  operator: '>=' | '<='
): { left: string; bound: string } | null {
  if (!node || node.kind !== 'atom') return null;
  const marker = lastIndexOfOutsideQuotes(node.value, operator);
  if (marker <= 0) return null;
  const bound = node.value.slice(marker + operator.length);
  if (!/^-?[0-9]+$/u.test(bound)) return null;
  return { left: node.value.slice(0, marker), bound };
}

function canonicalizeBooleanNode(node: BooleanNode): BooleanNode {
  if (node.kind !== 'and' && node.kind !== 'or') return node;
  const children = node.children
    .map(canonicalizeBooleanNode)
    .flatMap(child => child.kind === node.kind ? child.children : [child]);
  if (node.kind === 'and') {
    const collapsed: BooleanNode[] = [];
    for (let index = 0; index < children.length; index += 1) {
      const lower = comparisonParts(children[index], '>=');
      const upper = comparisonParts(children[index + 1], '<=');
      if (lower && upper && lower.left === upper.left) {
        collapsed.push({
          kind: 'between',
          left: lower.left,
          lower: lower.bound,
          upper: upper.bound
        });
        index += 1;
      } else {
        collapsed.push(children[index]);
      }
    }
    return collapsed.length === 1 ? collapsed[0] : { kind: 'and', children: collapsed };
  }
  return { kind: 'or', children };
}

function renderBooleanNode(node: BooleanNode): string {
  if (node.kind === 'atom') return `atom:${node.value}`;
  if (node.kind === 'between') return `between:${node.left}:${node.lower}:${node.upper}`;
  return `${node.kind}(${node.children.map(renderBooleanNode).join(',')})`;
}

function canonicalCheckDefinition(value: unknown): string {
  const expression = rewriteSqlSegments(
    normalizeDefinition(value),
    segment => segment
      .replace(/^constraint [^ ]+ /u, '')
      .replace(/^check\(/u, '(')
      .replace(/=\s*any\(array\[/gu, 'in(')
      .replace(/\]\)/gu, ')')
  );
  return renderBooleanNode(canonicalizeBooleanNode(parseBooleanNode(expression)));
}

function checkDefinitionHash(value: unknown): string {
  return createHash('sha256').update(canonicalCheckDefinition(value)).digest('hex');
}

function defaultMatches(value: unknown, expected: ColumnDefaultKind): boolean {
  const normalized = normalizeDefinition(value);
  if (expected === 'none') return value === null || value === undefined;
  if (expected === 'current_timestamp') {
    return normalized === 'current_timestamp' || normalized === 'now()';
  }
  if (expected === 'zero') return normalized === '0' || normalized === "'0'";
  return normalized === "'{}'" || normalized === "'{}'::jsonb";
}

interface PostgreSqlArrayParserFactory {
  create(
    source: string,
    transform: (entry: string) => string
  ): { parse(): unknown };
}

let cachedPostgreSqlArrayParser: PostgreSqlArrayParserFactory | null | undefined;

function isStrictFlatPostgreSqlStringArrayLiteral(value: string): boolean {
  if (value.length < 2 || value[0] !== '{' || value[value.length - 1] !== '}') return false;
  if (value === '{}') return true;

  const end = value.length - 1;
  let index = 1;
  while (index < end) {
    if (value[index] === ',') return false;

    if (value[index] === '"') {
      index += 1;
      let closed = false;
      while (index < end) {
        if (value[index] === '\\') {
          index += 1;
          if (index >= end) return false;
          index += 1;
          continue;
        }
        if (value[index] === '"') {
          index += 1;
          closed = true;
          break;
        }
        index += 1;
      }
      if (!closed) return false;
    } else {
      const start = index;
      while (index < end && value[index] !== ',') {
        if (
          value[index] === '{'
          || value[index] === '}'
          || value[index] === '"'
          || value[index] === '\\'
          || /\s/u.test(value[index])
        ) {
          return false;
        }
        index += 1;
      }
      const entry = value.slice(start, index);
      if (entry.length === 0 || entry.toUpperCase() === 'NULL') return false;
    }

    if (index === end) return true;
    if (value[index] !== ',') return false;
    index += 1;
    if (index === end) return false;
  }
  return false;
}

function getPostgreSqlArrayParser(): PostgreSqlArrayParserFactory | null {
  if (cachedPostgreSqlArrayParser !== undefined) return cachedPostgreSqlArrayParser;
  try {
    const pg = createRequire(import.meta.url)('pg') as {
      types?: { arrayParser?: unknown };
    };
    const parser = pg.types?.arrayParser as Partial<PostgreSqlArrayParserFactory> | undefined;
    cachedPostgreSqlArrayParser = typeof parser?.create === 'function'
      ? parser as PostgreSqlArrayParserFactory
      : null;
  } catch {
    cachedPostgreSqlArrayParser = null;
  }
  return cachedPostgreSqlArrayParser;
}

function parsePostgreSqlCatalogStringArray(value: string): string[] | null {
  if (!isStrictFlatPostgreSqlStringArrayLiteral(value)) return null;
  const parser = getPostgreSqlArrayParser();
  if (!parser) return null;
  try {
    const decoded = parser.create(value, entry => entry).parse();
    if (!Array.isArray(decoded) || decoded.some(item => typeof item !== 'string')) return null;
    return [...decoded];
  } catch {
    return null;
  }
}

export function parseCatalogStringArray(value: unknown): string[] | null {
  let decoded: unknown = value;
  if (typeof value === 'string') {
    if (value === '{}') return parsePostgreSqlCatalogStringArray(value);
    try {
      decoded = JSON.parse(value);
    } catch {
      return parsePostgreSqlCatalogStringArray(value);
    }
  }
  if (!Array.isArray(decoded) || decoded.some(item => typeof item !== 'string')) return null;
  return [...decoded];
}

function exactSortedStringSetMatches(actual: string[], expected: string[]): boolean {
  return JSON.stringify([...actual].sort()) === JSON.stringify([...expected].sort());
}

function relationalConstraintMatches(
  row: {
    columns_json: unknown;
    referenced_table_name: string | null;
    referenced_schema_matches: boolean | null;
    referenced_columns_json: unknown;
    update_action: string;
    delete_action: string;
  },
  spec: RelationalConstraintSpec
): boolean {
  const columns = parseCatalogStringArray(row.columns_json);
  const referencedColumns = parseCatalogStringArray(row.referenced_columns_json);
  if (!columns || !referencedColumns) return false;
  if (JSON.stringify(columns) !== JSON.stringify(spec.columns)) return false;
  if (spec.referencedTable === undefined) {
    return row.referenced_table_name === null
      && row.referenced_schema_matches === null
      && referencedColumns.length === 0;
  }
  return row.referenced_table_name === spec.referencedTable
    && row.referenced_schema_matches === true
    && JSON.stringify(referencedColumns) === JSON.stringify(spec.referencedColumns)
    && row.update_action === spec.updateAction
    && row.delete_action === spec.deleteAction;
}

function predicateStates(predicate: unknown): string[] | null {
  if (predicate === null || predicate === undefined || String(predicate).trim() === '') return [];
  const normalized = stripOuterBooleanParentheses(normalizeDefinition(predicate));
  const equality = normalized.match(/^state\s*=\s*'(REQUESTED|CLAIMED|RUNNING)'$/u);
  if (equality) return [equality[1]];

  const membership = normalized.match(/^state in\((.*)\)$/u)
    ?? normalized.match(/^state\s*=\s*any\(array\[(.*)\]\)$/u);
  if (!membership || membership[1].length === 0) return null;
  const values = [...membership[1].matchAll(/'(REQUESTED|CLAIMED|RUNNING)'/gu)]
    .map(match => match[1]);
  if (values.length === 0 || values.map(value => `'${value}'`).join(',') !== membership[1]) {
    return null;
  }
  return values.sort();
}

function indexStructurallyMatches(
  row: {
    table_name: string;
    schema_matches: boolean;
    unique: boolean;
    access_method: string;
    columns_json: unknown;
    predicate: string | null;
    key_count: number;
    attribute_count: number;
    expressions_absent: boolean;
    sort_options_default: boolean;
    opclasses_default: boolean;
    collations_default: boolean;
  },
  spec: IndexSpec
): boolean {
  const columns = parseCatalogStringArray(row.columns_json);
  return Boolean(
    columns
    && row.schema_matches === true
    && row.table_name === spec.table
    && row.unique === spec.unique
    && row.access_method === 'btree'
    && row.key_count === spec.columns.length
    && row.attribute_count === spec.columns.length
    && row.expressions_absent === true
    && row.sort_options_default === true
    && row.opclasses_default === true
    && row.collations_default === true
    && JSON.stringify(columns) === JSON.stringify(spec.columns)
    && JSON.stringify(predicateStates(row.predicate)) === JSON.stringify(spec.predicateStates)
  );
}

/**
 * Read-only verification for the Phase 2E schema contract.
 *
 * This function deliberately performs no DDL and never attempts migration repair.
 * Protocol adapters must fail closed unless it returns `ready: true`.
 */
export async function verifyActionPlanExecutionSchema(
  queryable: ActionPlanExecutionSchemaQueryable
): Promise<ActionPlanExecutionSchemaVerification> {
  try {
    const ledgerRelationResult = await queryable.query<{ exists: boolean }>(
      'SELECT to_regclass($1::text) IS NOT NULL AS exists',
      ['"ActionPlanExecutionSchemaMigration"']
    );
    if (ledgerRelationResult.rows[0]?.exists !== true) {
      return verification('ACTION_PLAN_EXECUTION_SCHEMA_MISSING', ['SCHEMA_LEDGER_MISSING']);
    }

    const ledgerResult = await queryable.query<{
      checksum: string;
      completedPhase: string;
      validityState: string;
      appliedAt: Date | null;
    }>(
      `SELECT "checksum", "completedPhase", "validityState", "appliedAt"
       FROM "ActionPlanExecutionSchemaMigration"
       WHERE "version" = $1`,
      [ACTION_PLAN_EXECUTION_SCHEMA_VERSION]
    );

    if (ledgerResult.rows.length === 0) {
      return verification('ACTION_PLAN_EXECUTION_SCHEMA_MISSING', ['SCHEMA_LEDGER_MISSING']);
    }

    const issues: string[] = [];
    const ledger = ledgerResult.rows[0];
    if (ledger.checksum !== ACTION_PLAN_EXECUTION_SCHEMA_CHECKSUM) {
      issues.push('SCHEMA_CHECKSUM_MISMATCH');
    }
    if (ledger.completedPhase !== 'complete') issues.push('SCHEMA_MIGRATION_INCOMPLETE');
    if (ledger.validityState !== 'VALID') issues.push('SCHEMA_LEDGER_NOT_VALID');
    if (!ledger.appliedAt) issues.push('SCHEMA_APPLIED_AT_MISSING');

    const tableResult = await queryable.query<{ table_name: string }>(
      `SELECT table_name
       FROM information_schema.tables
       WHERE table_schema = current_schema()
         AND table_name = ANY($1::text[])`,
      [[...REQUIRED_TABLES]]
    );
    const tables = new Set(tableResult.rows.map(row => row.table_name));
    for (const table of REQUIRED_TABLES) {
      if (!tables.has(table)) issues.push(`SCHEMA_TABLE_MISSING:${table}`);
    }

    const requiredTableNames = Object.keys(REQUIRED_COLUMNS);
    const columnResult = await queryable.query<{
      table_name: string;
      column_name: string;
      udt_name: string;
      is_nullable: string;
      column_default: string | null;
    }>(
      `SELECT table_name, column_name, udt_name, is_nullable, column_default
       FROM information_schema.columns
       WHERE table_schema = current_schema()
         AND table_name = ANY($1::text[])`,
      [requiredTableNames]
    );
    const columns = new Map(
      columnResult.rows.map(row => [`${row.table_name}.${row.column_name}`, row])
    );
    for (const [table, requiredColumns] of Object.entries(REQUIRED_COLUMNS)) {
      for (const column of requiredColumns) {
        const key = `${table}.${column}`;
        const actual = columns.get(key);
        if (!actual) {
          issues.push(`SCHEMA_COLUMN_MISSING:${table}.${column}`);
          continue;
        }
        const expected = REQUIRED_COLUMN_SPECS[table]?.[column];
        if (
          !expected
          || actual.udt_name !== expected.type
          || (actual.is_nullable === 'YES') !== expected.nullable
          || !defaultMatches(actual.column_default, expected.defaultKind)
        ) {
          issues.push(`SCHEMA_COLUMN_DEFINITION_INVALID:${table}.${column}`);
        }
      }
    }

    const constraintResult = await queryable.query<{
      name: string;
      table_name: string;
      type: string;
      validated: boolean;
      definition: string;
      columns_json: unknown;
      referenced_table_name: string | null;
      referenced_schema_matches: boolean | null;
      referenced_columns_json: unknown;
      update_action: string;
      delete_action: string;
      deferrable: boolean;
      initially_deferred: boolean;
    }>(
      `SELECT constraint_data.conname AS name,
              table_relation.relname AS table_name,
              constraint_data.contype AS type,
              constraint_data.convalidated AS validated,
              constraint_data.condeferrable AS deferrable,
              constraint_data.condeferred AS initially_deferred,
              pg_get_constraintdef(constraint_data.oid, true) AS definition,
              to_json(ARRAY(
                SELECT attribute.attname::text
                FROM unnest(constraint_data.conkey) WITH ORDINALITY AS key_column(attnum, position)
                JOIN pg_attribute AS attribute
                  ON attribute.attrelid = constraint_data.conrelid
                 AND attribute.attnum = key_column.attnum
                ORDER BY key_column.position
              )::text[])::text AS columns_json,
              referenced_relation.relname AS referenced_table_name,
              referenced_namespace.nspname = current_schema() AS referenced_schema_matches,
              to_json(CASE WHEN constraint_data.confrelid = 0 THEN ARRAY[]::text[] ELSE ARRAY(
                SELECT referenced_attribute.attname::text
                FROM unnest(constraint_data.confkey) WITH ORDINALITY AS referenced_key(attnum, position)
                JOIN pg_attribute AS referenced_attribute
                  ON referenced_attribute.attrelid = constraint_data.confrelid
                 AND referenced_attribute.attnum = referenced_key.attnum
                ORDER BY referenced_key.position
              )::text[] END)::text AS referenced_columns_json,
              constraint_data.confupdtype AS update_action,
              constraint_data.confdeltype AS delete_action
       FROM pg_constraint AS constraint_data
       JOIN pg_namespace AS namespace ON namespace.oid = constraint_data.connamespace
       JOIN pg_class AS table_relation ON table_relation.oid = constraint_data.conrelid
       LEFT JOIN pg_class AS referenced_relation ON referenced_relation.oid = constraint_data.confrelid
       LEFT JOIN pg_namespace AS referenced_namespace ON referenced_namespace.oid = referenced_relation.relnamespace
       WHERE namespace.nspname = current_schema()
         AND constraint_data.conname = ANY($1::text[])`,
      [[...REQUIRED_CONSTRAINTS]]
    );
    for (const name of REQUIRED_CONSTRAINTS) {
      const matches = constraintResult.rows.filter(row => row.name === name);
      const expected = REQUIRED_CONSTRAINT_SPECS[name];
      const relationalExpected = REQUIRED_RELATIONAL_CONSTRAINT_SPECS[name];
      const checkColumnsExpected = REQUIRED_CHECK_COLUMN_SETS[name];
      if (matches.length === 0) {
        issues.push(`SCHEMA_CONSTRAINT_MISSING:${name}`);
        continue;
      }
      if (
        matches.length !== 1
        || !expected
        || matches[0].table_name !== expected.table
        || matches[0].type !== expected.type
        || matches[0].deferrable !== expected.deferrable
        || matches[0].initially_deferred !== expected.initiallyDeferred
        || parseCatalogStringArray(matches[0].columns_json) === null
        || parseCatalogStringArray(matches[0].referenced_columns_json) === null
        || (
          expected.type === 'c'
            ? !checkColumnsExpected
              || !exactSortedStringSetMatches(
                parseCatalogStringArray(matches[0].columns_json) ?? [],
                checkColumnsExpected
              )
              || checkDefinitionHash(matches[0].definition) !== REQUIRED_CHECK_DEFINITION_HASHES[name]
            : !relationalExpected || !relationalConstraintMatches(matches[0], relationalExpected)
        )
      ) {
        issues.push(`SCHEMA_CONSTRAINT_DEFINITION_INVALID:${name}`);
      }
      if (matches[0].validated !== true) {
        issues.push(`SCHEMA_CONSTRAINT_NOT_VALID:${name}`);
      }
    }

    const indexResult = await queryable.query<{
      name: string;
      table_name: string;
      unique: boolean;
      valid: boolean;
      ready: boolean;
      schema_matches: boolean;
      access_method: string;
      columns_json: unknown;
      predicate: string | null;
      key_count: number;
      attribute_count: number;
      expressions_absent: boolean;
      sort_options_default: boolean;
      opclasses_default: boolean;
      collations_default: boolean;
    }>(
      `SELECT index_relation.relname AS name,
              table_relation.relname AS table_name,
              index_data.indisunique AS unique,
              index_data.indisvalid AS valid,
              index_data.indisready AS ready,
              namespace.nspname = current_schema() AS schema_matches,
              access_method.amname AS access_method,
              index_data.indnkeyatts::integer AS key_count,
              index_data.indnatts::integer AS attribute_count,
              index_data.indexprs IS NULL AS expressions_absent,
              cardinality(index_data.indoption::smallint[]) >= index_data.indnkeyatts
                AND NOT EXISTS (
                  SELECT 1
                  FROM unnest(index_data.indoption::smallint[]) WITH ORDINALITY
                    AS index_option(option_bits, position)
                  WHERE index_option.position <= index_data.indnkeyatts
                    AND index_option.option_bits <> 0
                ) AS sort_options_default,
              cardinality(index_data.indclass::oid[]) >= index_data.indnkeyatts
                AND NOT EXISTS (
                  SELECT 1
                  FROM unnest(
                    index_data.indclass::oid[],
                    index_data.indkey::smallint[]
                  ) WITH ORDINALITY AS index_opclass(opclass_oid, attnum, position)
                  LEFT JOIN pg_opclass AS operator_class
                    ON operator_class.oid = index_opclass.opclass_oid
                  LEFT JOIN pg_attribute AS opclass_attribute
                    ON opclass_attribute.attrelid = index_data.indrelid
                   AND opclass_attribute.attnum = index_opclass.attnum
                  WHERE index_opclass.position <= index_data.indnkeyatts
                    AND (
                      operator_class.opcdefault IS DISTINCT FROM true
                      OR operator_class.opcmethod IS DISTINCT FROM index_relation.relam
                      OR operator_class.opcintype IS DISTINCT FROM opclass_attribute.atttypid
                    )
                ) AS opclasses_default,
              cardinality(index_data.indcollation::oid[]) >= index_data.indnkeyatts
                AND NOT EXISTS (
                  SELECT 1
                  FROM unnest(
                    index_data.indcollation::oid[],
                    index_data.indkey::smallint[]
                  ) WITH ORDINALITY AS index_collation(collation_oid, attnum, position)
                  LEFT JOIN pg_attribute AS collated_attribute
                    ON collated_attribute.attrelid = index_data.indrelid
                   AND collated_attribute.attnum = index_collation.attnum
                  WHERE index_collation.position <= index_data.indnkeyatts
                    AND index_collation.collation_oid
                      IS DISTINCT FROM collated_attribute.attcollation
                ) AS collations_default,
              to_json(ARRAY(
                SELECT attribute.attname::text
                FROM unnest(index_data.indkey::smallint[]) WITH ORDINALITY AS key_column(attnum, position)
                JOIN pg_attribute AS attribute
                  ON attribute.attrelid = index_data.indrelid
                 AND attribute.attnum = key_column.attnum
                WHERE key_column.position <= index_data.indnkeyatts
                ORDER BY key_column.position
              )::text[])::text AS columns_json,
              pg_get_expr(index_data.indpred, index_data.indrelid, true) AS predicate
       FROM pg_class AS index_relation
       JOIN pg_index AS index_data ON index_data.indexrelid = index_relation.oid
       JOIN pg_class AS table_relation ON table_relation.oid = index_data.indrelid
       JOIN pg_am AS access_method ON access_method.oid = index_relation.relam
       JOIN pg_namespace AS namespace ON namespace.oid = index_relation.relnamespace
       WHERE namespace.nspname = current_schema()
         AND index_relation.relname = ANY($1::text[])`,
      [[...REQUIRED_INDEXES]]
    );
    for (const name of REQUIRED_INDEXES) {
      const matches = indexResult.rows.filter(row => row.name === name);
      const expected = REQUIRED_INDEX_SPECS[name];
      if (matches.length === 0) {
        issues.push(`SCHEMA_INDEX_MISSING:${name}`);
        continue;
      }
      const actual = matches[0];
      if (
        matches.length !== 1
        || !expected
        || !indexStructurallyMatches(actual, expected)
      ) {
        issues.push(`SCHEMA_INDEX_DEFINITION_INVALID:${name}`);
      }
      if (actual.valid !== true || actual.ready !== true) {
        issues.push(`SCHEMA_INDEX_INVALID:${name}`);
      }
    }

    return verification(
      issues.length === 0
        ? 'ACTION_PLAN_EXECUTION_SCHEMA_READY'
        : 'ACTION_PLAN_EXECUTION_SCHEMA_INVALID',
      issues
    );
  } catch {
    return verification('ACTION_PLAN_EXECUTION_SCHEMA_UNAVAILABLE', ['SCHEMA_QUERY_FAILED']);
  }
}

/** Verify the connected application pool without mutating schema or connection state. */
export async function verifyConfiguredActionPlanExecutionSchema(): Promise<ActionPlanExecutionSchemaVerification> {
  const pool = getPool();
  if (!pool) {
    return verification('ACTION_PLAN_EXECUTION_SCHEMA_UNAVAILABLE', ['SCHEMA_POOL_UNAVAILABLE']);
  }
  return verifyActionPlanExecutionSchema(pool as PoolType);
}
