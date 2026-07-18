#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
export const REPOSITORY_ROOT = resolve(SCRIPT_DIR, '..');
export const MIGRATION_DIRECTORY = join(
  REPOSITORY_ROOT,
  'migrations',
  '20260717_action_plan_execution_v2',
);
export const MIGRATION_MANIFEST_PATH = join(MIGRATION_DIRECTORY, 'manifest.json');
export const MIGRATION_DATABASE_ENV = 'ACTION_PLAN_EXECUTION_MIGRATION_DATABASE_URL';
export const REVIEWED_MIGRATION_VERSION = '20260717_action_plan_execution_v2';
export const REVIEWED_MIGRATION_CHECKSUM =
  'cfa339af4282ce47a955acd08fa3f16e617b4a943111890f1e5b4bd5ba929533';

const EXPECTED_TABLES = [
  'ActionPlanExecutionSchemaMigration',
  'ActionPlanExecutionCommand',
  'ActionPlanExecutionRun',
  'ActionPlanExecutionEvent',
];

const EXPECTED_COLUMNS = {
  ActionPlanExecutionSchemaMigration: [
    'version',
    'checksum',
    'completedPhase',
    'validityState',
    'appliedAt',
    'updatedAt',
  ],
  ActionPlan: [
    'executionRealm',
    'ownerPrincipalId',
    'executionProtocolVersion',
    'executionGeneration',
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
    'createdAt',
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
    'updatedAt',
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
    'createdAt',
  ],
};

const column = (type, nullable = false, defaultKind = 'none') => ({
  type,
  nullable,
  defaultKind,
});

const EXPECTED_COLUMN_SPECS = {
  ActionPlanExecutionSchemaMigration: {
    version: column('text'),
    checksum: column('text'),
    completedPhase: column('text'),
    validityState: column('text'),
    appliedAt: column('timestamptz', true),
    updatedAt: column('timestamptz', false, 'current_timestamp'),
  },
  ActionPlan: {
    executionRealm: column('text', true),
    ownerPrincipalId: column('text', true),
    executionProtocolVersion: column('int4', true),
    executionGeneration: column('int8', true),
  },
  ActionPlanExecutionCommand: {
    id: column('text'),
    planId: column('text'),
    executionRealm: column('text'),
    requesterPrincipalId: column('text'),
    commandIdempotencyKeyHash: column('text'),
    commandFingerprint: column('text'),
    lockedPlanExecutionGeneration: column('int8'),
    protocolVersion: column('int4'),
    createdAt: column('timestamptz', false, 'current_timestamp'),
  },
  ActionPlanExecutionRun: {
    id: column('text'),
    commandId: column('text'),
    planId: column('text'),
    actionId: column('text'),
    attempt: column('int4'),
    state: column('text'),
    executorKind: column('text'),
    assignedAgentId: column('text'),
    assignedExecutorPrincipalId: column('text'),
    assignedExecutorInstanceId: column('text'),
    claimedExecutorPrincipalId: column('text', true),
    claimedExecutorInstanceId: column('text', true),
    executionRealm: column('text'),
    actionSnapshotId: column('text'),
    actionSnapshotSchemaVersion: column('int4'),
    actionSnapshot: column('jsonb'),
    claimIdempotencyKeyHash: column('text', true),
    claimFingerprint: column('text', true),
    startIdempotencyKeyHash: column('text', true),
    startFingerprint: column('text', true),
    resultIdempotencyKeyHash: column('text', true),
    resultFingerprint: column('text', true),
    policyCategory: column('text'),
    policyEvidenceId: column('text'),
    policyEvaluatedAt: column('timestamptz'),
    acceptanceReceipt: column('text', true),
    terminalCategory: column('text', true),
    resultOutput: column('jsonb', true),
    resultError: column('jsonb', true),
    eventSequence: column('int8', false, 'zero'),
    version: column('int8', false, 'zero'),
    requestedAt: column('timestamptz', false, 'current_timestamp'),
    claimedAt: column('timestamptz', true),
    startedAt: column('timestamptz', true),
    completedAt: column('timestamptz', true),
    cancelledAt: column('timestamptz', true),
    expiredAt: column('timestamptz', true),
    supersededAt: column('timestamptz', true),
    updatedAt: column('timestamptz', false, 'current_timestamp'),
  },
  ActionPlanExecutionEvent: {
    id: column('text'),
    runId: column('text'),
    eventSequence: column('int8'),
    eventType: column('text'),
    actorCategory: column('text'),
    sourceService: column('text'),
    executionRealm: column('text'),
    reasonCode: column('text'),
    requestId: column('text', true),
    traceId: column('text', true),
    safeMetadata: column('jsonb', false, 'empty_json_object'),
    createdAt: column('timestamptz', false, 'current_timestamp'),
  },
};

const EXPECTED_CONSTRAINTS = [
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
  'uq_ap_exec_run_start_idem',
];

const constraint = (table, type, ...requiredFragments) => ({
  table,
  type,
  requiredFragments,
  deferrable: false,
  initiallyDeferred: false,
});

const EXPECTED_CONSTRAINT_SPECS = {
  ActionPlanExecutionSchemaMigration_pkey: constraint(
    'ActionPlanExecutionSchemaMigration', 'p', 'PRIMARY KEY (version)',
  ),
  ActionPlanExecutionCommand_pkey: constraint(
    'ActionPlanExecutionCommand', 'p', 'PRIMARY KEY (id)',
  ),
  ActionPlanExecutionRun_pkey: constraint('ActionPlanExecutionRun', 'p', 'PRIMARY KEY (id)'),
  ActionPlanExecutionEvent_pkey: constraint('ActionPlanExecutionEvent', 'p', 'PRIMARY KEY (id)'),
  ck_action_plan_execution_provenance_v2: constraint(
    'ActionPlan', 'c', 'executionRealm IS NULL', 'executionProtocolVersion = 2', 'executionGeneration >= 1',
  ),
  ck_ap_exec_migration_version: constraint(
    'ActionPlanExecutionSchemaMigration', 'c', 'char_length(version)', 'BETWEEN 1 AND 64',
  ),
  ck_ap_exec_migration_checksum: constraint(
    'ActionPlanExecutionSchemaMigration', 'c', "checksum ~ '^[0-9a-f]{64}$'",
  ),
  ck_ap_exec_migration_state: constraint(
    'ActionPlanExecutionSchemaMigration', 'c', 'validityState', 'RECOVERING_INVALID_INDEX', 'VALID',
  ),
  ck_ap_exec_command_id: constraint(
    'ActionPlanExecutionCommand', 'c', 'char_length(id)', 'char_length(planId)', 'BETWEEN 1 AND 128',
  ),
  ck_ap_exec_command_realm: constraint(
    'ActionPlanExecutionCommand', 'c', 'char_length(executionRealm)', 'BETWEEN 1 AND 256',
  ),
  ck_ap_exec_command_requester: constraint(
    'ActionPlanExecutionCommand', 'c', 'char_length(requesterPrincipalId)', 'BETWEEN 1 AND 256',
  ),
  ck_ap_exec_command_idem_hash: constraint(
    'ActionPlanExecutionCommand', 'c', "commandIdempotencyKeyHash ~ '^[0-9a-f]{64}$'",
  ),
  ck_ap_exec_command_fingerprint: constraint(
    'ActionPlanExecutionCommand', 'c', "commandFingerprint ~ '^[0-9a-f]{64}$'",
  ),
  ck_ap_exec_command_generation: constraint(
    'ActionPlanExecutionCommand', 'c', 'lockedPlanExecutionGeneration >= 1',
  ),
  ck_ap_exec_command_protocol: constraint('ActionPlanExecutionCommand', 'c', 'protocolVersion = 2'),
  uq_ap_exec_command_id_plan_realm: constraint(
    'ActionPlanExecutionCommand', 'u', 'UNIQUE (id, planId, executionRealm)',
  ),
  uq_ap_exec_command_idempotency: constraint(
    'ActionPlanExecutionCommand', 'u',
    'UNIQUE (executionRealm, requesterPrincipalId, planId, commandIdempotencyKeyHash)',
  ),
  fk_ap_exec_command_plan_realm: constraint(
    'ActionPlanExecutionCommand', 'f', 'FOREIGN KEY (planId, executionRealm)',
    'REFERENCES ActionPlan(id, executionRealm)', 'ON UPDATE CASCADE', 'ON DELETE RESTRICT',
  ),
  ck_ap_exec_run_id: constraint(
    'ActionPlanExecutionRun', 'c', 'char_length(id)', 'char_length(commandId)',
    'char_length(planId)', 'char_length(actionId)', 'BETWEEN 1 AND 128',
  ),
  ck_ap_exec_run_attempt: constraint('ActionPlanExecutionRun', 'c', 'attempt >= 1'),
  ck_ap_exec_run_state: constraint('ActionPlanExecutionRun', 'c', 'state', 'REQUESTED', 'SUPERSEDED'),
  ck_ap_exec_run_executor: constraint('ActionPlanExecutionRun', 'c', "executorKind = 'python-daemon'"),
  ck_ap_exec_run_realm: constraint(
    'ActionPlanExecutionRun', 'c', 'char_length(executionRealm)', 'BETWEEN 1 AND 256',
  ),
  ck_ap_exec_run_assignment: constraint(
    'ActionPlanExecutionRun', 'c', 'char_length(assignedAgentId)',
    'char_length(assignedExecutorPrincipalId)', 'char_length(assignedExecutorInstanceId)',
  ),
  ck_ap_exec_run_snapshot_id: constraint(
    'ActionPlanExecutionRun', 'c', 'char_length(actionSnapshotId)', 'BETWEEN 1 AND 128',
  ),
  ck_ap_exec_run_snapshot_version: constraint(
    'ActionPlanExecutionRun', 'c', 'actionSnapshotSchemaVersion = 1',
  ),
  ck_ap_exec_run_snapshot: constraint(
    'ActionPlanExecutionRun', 'c', "jsonb_typeof(actionSnapshot) = 'object'",
    'octet_length(actionSnapshot::text) <= 65536',
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
    "actionSnapshot ->> 'agent_capability_fingerprint'", "'^[0-9a-f]{64}$'",
  ),
  ck_ap_exec_run_hashes: constraint(
    'ActionPlanExecutionRun', 'c', 'claimIdempotencyKeyHash', 'startIdempotencyKeyHash',
    'resultIdempotencyKeyHash', "'^[0-9a-f]{64}$'",
  ),
  ck_ap_exec_run_policy: constraint(
    'ActionPlanExecutionRun', 'c', 'policyCategory', 'ALLOW', 'CONFIRM',
    "policyEvidenceId ~ '^clear-recheck-v1:[0-9a-f]{64}$'",
  ),
  ck_ap_exec_run_sequence: constraint(
    'ActionPlanExecutionRun', 'c', 'eventSequence >= 0', 'version >= 0',
  ),
  ck_ap_exec_run_result_bounds: constraint(
    'ActionPlanExecutionRun', 'c', 'octet_length(resultOutput::text) <= 65536',
    'octet_length(resultError::text) <= 8192', 'char_length(acceptanceReceipt)',
  ),
  ck_ap_exec_run_claim_group: constraint(
    'ActionPlanExecutionRun', 'c', 'claimedExecutorPrincipalId IS NULL',
    'claimedExecutorPrincipalId = assignedExecutorPrincipalId',
    'claimedExecutorInstanceId = assignedExecutorInstanceId', 'claimedAt IS NOT NULL',
  ),
  ck_ap_exec_run_start_group: constraint(
    'ActionPlanExecutionRun', 'c', 'startIdempotencyKeyHash IS NULL',
    'startFingerprint IS NOT NULL', 'startedAt IS NOT NULL', 'claimedAt IS NOT NULL',
  ),
  ck_ap_exec_run_result_group: constraint(
    'ActionPlanExecutionRun', 'c', 'resultIdempotencyKeyHash IS NULL',
    'resultOutput IS NULL', 'resultError IS NULL', 'acceptanceReceipt IS NOT NULL',
    'completedAt IS NOT NULL', 'startedAt IS NOT NULL',
  ),
  ck_ap_exec_run_state_coherence: constraint(
    'ActionPlanExecutionRun', 'c', "state = 'REQUESTED'", "state = 'RUNNING'",
    "state = 'SUCCEEDED'", "state = 'FAILED'", "state = 'CANCELLED'",
    "state = 'EXPIRED'", "state = 'SUPERSEDED'", 'terminalCategory = state',
  ),
  uq_ap_exec_run_command_action: constraint(
    'ActionPlanExecutionRun', 'u', 'UNIQUE (commandId, actionId)',
  ),
  uq_ap_exec_run_plan_action_attempt: constraint(
    'ActionPlanExecutionRun', 'u', 'UNIQUE (planId, actionId, attempt)',
  ),
  uq_ap_exec_run_snapshot: constraint('ActionPlanExecutionRun', 'u', 'UNIQUE (actionSnapshotId)'),
  uq_ap_exec_run_claim_idem: constraint(
    'ActionPlanExecutionRun', 'u',
    'UNIQUE (executionRealm, assignedExecutorPrincipalId, assignedExecutorInstanceId, claimIdempotencyKeyHash)',
  ),
  uq_ap_exec_run_start_idem: constraint(
    'ActionPlanExecutionRun', 'u',
    'UNIQUE (id, claimedExecutorPrincipalId, claimedExecutorInstanceId, startIdempotencyKeyHash)',
  ),
  uq_ap_exec_run_id_realm: constraint(
    'ActionPlanExecutionRun', 'u', 'UNIQUE (id, executionRealm)',
  ),
  fk_ap_exec_run_command: constraint(
    'ActionPlanExecutionRun', 'f', 'FOREIGN KEY (commandId, planId, executionRealm)',
    'REFERENCES ActionPlanExecutionCommand(id, planId, executionRealm)',
    'ON UPDATE CASCADE', 'ON DELETE RESTRICT',
  ),
  fk_ap_exec_run_action: constraint(
    'ActionPlanExecutionRun', 'f', 'FOREIGN KEY (planId, actionId)',
    'REFERENCES Action(planId, id)', 'ON UPDATE CASCADE', 'ON DELETE RESTRICT',
  ),
  ck_ap_exec_event_id: constraint(
    'ActionPlanExecutionEvent', 'c', 'char_length(id)', 'char_length(runId)', 'BETWEEN 1 AND 128',
  ),
  ck_ap_exec_event_sequence: constraint('ActionPlanExecutionEvent', 'c', 'eventSequence >= 1'),
  ck_ap_exec_event_type: constraint(
    'ActionPlanExecutionEvent', 'c', 'eventType', 'EXECUTION_REQUESTED',
    'RESULT_ACCEPTED', 'IDEMPOTENT_REPLAY',
  ),
  ck_ap_exec_event_actor: constraint(
    'ActionPlanExecutionEvent', 'c', 'actorCategory', 'requester', 'executor', 'system',
  ),
  ck_ap_exec_event_source: constraint(
    'ActionPlanExecutionEvent', 'c', 'sourceService', 'web', 'mcp', 'python-daemon',
  ),
  ck_ap_exec_event_identifiers: constraint(
    'ActionPlanExecutionEvent', 'c', 'char_length(executionRealm)', 'char_length(reasonCode)',
    'char_length(requestId)', 'char_length(traceId)',
  ),
  ck_ap_exec_event_metadata: constraint(
    'ActionPlanExecutionEvent', 'c', "jsonb_typeof(safeMetadata) = 'object'",
    'octet_length(safeMetadata::text) <= 4096',
  ),
  uq_ap_exec_event_run_sequence: constraint(
    'ActionPlanExecutionEvent', 'u', 'UNIQUE (runId, eventSequence)',
  ),
  fk_ap_exec_event_run_realm: constraint(
    'ActionPlanExecutionEvent', 'f', 'FOREIGN KEY (runId, executionRealm)',
    'REFERENCES ActionPlanExecutionRun(id, executionRealm)',
    'ON UPDATE CASCADE', 'ON DELETE RESTRICT',
  ),
};

const RAW_EXPECTED_CHECK_COLUMN_SETS = {
  ck_action_plan_execution_provenance_v2: [
    'executionRealm',
    'ownerPrincipalId',
    'executionProtocolVersion',
    'executionGeneration',
  ],
  ck_ap_exec_migration_version: ['version'],
  ck_ap_exec_migration_checksum: ['checksum'],
  ck_ap_exec_migration_state: ['validityState'],
  ck_ap_exec_command_id: ['id', 'planId'],
  ck_ap_exec_command_realm: ['executionRealm'],
  ck_ap_exec_command_requester: ['requesterPrincipalId'],
  ck_ap_exec_command_idem_hash: ['commandIdempotencyKeyHash'],
  ck_ap_exec_command_fingerprint: ['commandFingerprint'],
  ck_ap_exec_command_generation: ['lockedPlanExecutionGeneration'],
  ck_ap_exec_command_protocol: ['protocolVersion'],
  ck_ap_exec_run_id: ['id', 'commandId', 'planId', 'actionId'],
  ck_ap_exec_run_attempt: ['attempt'],
  ck_ap_exec_run_state: ['state'],
  ck_ap_exec_run_executor: ['executorKind'],
  ck_ap_exec_run_realm: ['executionRealm'],
  ck_ap_exec_run_assignment: [
    'assignedAgentId',
    'assignedExecutorPrincipalId',
    'assignedExecutorInstanceId',
  ],
  ck_ap_exec_run_snapshot_id: ['actionSnapshotId'],
  ck_ap_exec_run_snapshot_version: ['actionSnapshotSchemaVersion'],
  ck_ap_exec_run_snapshot: ['actionSnapshot'],
  ck_ap_exec_run_snapshot_shape: [
    'planId',
    'actionId',
    'assignedAgentId',
    'executorKind',
    'assignedExecutorPrincipalId',
    'actionSnapshot',
  ],
  ck_ap_exec_run_hashes: [
    'claimIdempotencyKeyHash',
    'claimFingerprint',
    'startIdempotencyKeyHash',
    'startFingerprint',
    'resultIdempotencyKeyHash',
    'resultFingerprint',
  ],
  ck_ap_exec_run_policy: ['policyCategory', 'policyEvidenceId'],
  ck_ap_exec_run_sequence: ['eventSequence', 'version'],
  ck_ap_exec_run_result_bounds: ['acceptanceReceipt', 'resultOutput', 'resultError'],
  ck_ap_exec_run_claim_group: [
    'assignedExecutorPrincipalId',
    'assignedExecutorInstanceId',
    'claimedExecutorPrincipalId',
    'claimedExecutorInstanceId',
    'claimIdempotencyKeyHash',
    'claimFingerprint',
    'claimedAt',
  ],
  ck_ap_exec_run_start_group: [
    'claimedAt',
    'startIdempotencyKeyHash',
    'startFingerprint',
    'startedAt',
  ],
  ck_ap_exec_run_result_group: [
    'startedAt',
    'resultIdempotencyKeyHash',
    'resultFingerprint',
    'acceptanceReceipt',
    'resultOutput',
    'resultError',
    'completedAt',
  ],
  ck_ap_exec_run_state_coherence: [
    'state',
    'claimedAt',
    'startedAt',
    'resultIdempotencyKeyHash',
    'resultFingerprint',
    'acceptanceReceipt',
    'terminalCategory',
    'resultOutput',
    'resultError',
    'completedAt',
    'cancelledAt',
    'expiredAt',
    'supersededAt',
  ],
  ck_ap_exec_event_id: ['id', 'runId'],
  ck_ap_exec_event_sequence: ['eventSequence'],
  ck_ap_exec_event_type: ['eventType'],
  ck_ap_exec_event_actor: ['actorCategory'],
  ck_ap_exec_event_source: ['sourceService'],
  ck_ap_exec_event_identifiers: ['executionRealm', 'reasonCode', 'requestId', 'traceId'],
  ck_ap_exec_event_metadata: ['safeMetadata'],
};

const EXPECTED_CHECK_COLUMN_SETS = Object.fromEntries(
  Object.entries(RAW_EXPECTED_CHECK_COLUMN_SETS)
    .map(([name, columns]) => [name, [...columns].sort()]),
);

const EXPECTED_CHECK_DEFINITION_HASHES = {
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
  ck_ap_exec_run_snapshot: 'f175cca68fe5575cbf044832fa00d153d6323e8ff2cf69e11c94ca0682919404',
  ck_ap_exec_run_snapshot_shape: 'b75e2a6afb1e1a48f4da8f5c02ad89828f03d3ad06fa77ca152207104c83e96d',
  ck_ap_exec_run_hashes: '1334c164956834d1c1a1b278becd4ec7876d6d090f293fef0f33a6db2a5b816e',
  ck_ap_exec_run_policy: '87d8fa86c20a1fb33695f3852493815381eb263d0a3593bc39cf45148d9c065f',
  ck_ap_exec_run_sequence: '14599d2eb1a346c353f3479011cf263c87bd5f245e06041f09893ceb426a0213',
  ck_ap_exec_run_result_bounds: '10ca14c20d760c57b028bfa4811cbd6456012f36d10c3fe16a73a3622a1ae80f',
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
  ck_ap_exec_event_metadata: '300c1ba7c7178569d4af9c314fbe8551472c6f7b994be874840707220c302647',
};

const EXPECTED_RELATIONAL_CONSTRAINT_SPECS = {
  ActionPlanExecutionSchemaMigration_pkey: { columns: ['version'] },
  ActionPlanExecutionCommand_pkey: { columns: ['id'] },
  ActionPlanExecutionRun_pkey: { columns: ['id'] },
  ActionPlanExecutionEvent_pkey: { columns: ['id'] },
  uq_ap_exec_command_id_plan_realm: { columns: ['id', 'planId', 'executionRealm'] },
  uq_ap_exec_command_idempotency: {
    columns: ['executionRealm', 'requesterPrincipalId', 'planId', 'commandIdempotencyKeyHash'],
  },
  uq_ap_exec_run_command_action: { columns: ['commandId', 'actionId'] },
  uq_ap_exec_run_plan_action_attempt: { columns: ['planId', 'actionId', 'attempt'] },
  uq_ap_exec_run_snapshot: { columns: ['actionSnapshotId'] },
  uq_ap_exec_run_claim_idem: {
    columns: [
      'executionRealm', 'assignedExecutorPrincipalId', 'assignedExecutorInstanceId',
      'claimIdempotencyKeyHash',
    ],
  },
  uq_ap_exec_run_start_idem: {
    columns: [
      'id', 'claimedExecutorPrincipalId', 'claimedExecutorInstanceId',
      'startIdempotencyKeyHash',
    ],
  },
  uq_ap_exec_run_id_realm: { columns: ['id', 'executionRealm'] },
  uq_ap_exec_event_run_sequence: { columns: ['runId', 'eventSequence'] },
  fk_ap_exec_command_plan_realm: {
    columns: ['planId', 'executionRealm'],
    referencedTable: 'ActionPlan',
    referencedColumns: ['id', 'executionRealm'],
    updateAction: 'c',
    deleteAction: 'r',
  },
  fk_ap_exec_run_command: {
    columns: ['commandId', 'planId', 'executionRealm'],
    referencedTable: 'ActionPlanExecutionCommand',
    referencedColumns: ['id', 'planId', 'executionRealm'],
    updateAction: 'c',
    deleteAction: 'r',
  },
  fk_ap_exec_run_action: {
    columns: ['planId', 'actionId'],
    referencedTable: 'Action',
    referencedColumns: ['planId', 'id'],
    updateAction: 'c',
    deleteAction: 'r',
  },
  fk_ap_exec_event_run_realm: {
    columns: ['runId', 'executionRealm'],
    referencedTable: 'ActionPlanExecutionRun',
    referencedColumns: ['id', 'executionRealm'],
    updateAction: 'c',
    deleteAction: 'r',
  },
};

const EXPECTED_INDEXES = [
  'uq_action_plan_id_execution_realm_v2',
  'uq_action_plan_action_plan_id_id_v2',
  'uq_ap_exec_run_active_action',
  'ix_ap_exec_run_claim_next',
];

const EXPECTED_INDEX_SPECS = {
  uq_action_plan_id_execution_realm_v2: {
    table: 'ActionPlan',
    unique: true,
    columns: ['id', 'executionRealm'],
    predicateStates: [],
  },
  uq_action_plan_action_plan_id_id_v2: {
    table: 'Action',
    unique: true,
    columns: ['planId', 'id'],
    predicateStates: [],
  },
  uq_ap_exec_run_active_action: {
    table: 'ActionPlanExecutionRun',
    unique: true,
    columns: ['planId', 'actionId'],
    predicateStates: ['CLAIMED', 'REQUESTED', 'RUNNING'],
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
      'id',
    ],
    predicateStates: ['REQUESTED'],
  },
};

export const ACTION_PLAN_EXECUTION_SCHEMA_REQUIREMENTS = Object.freeze({
  tables: [...EXPECTED_TABLES],
  columns: Object.fromEntries(
    Object.entries(EXPECTED_COLUMNS).map(([table, columns]) => [table, [...columns]]),
  ),
  columnSpecs: EXPECTED_COLUMN_SPECS,
  constraints: [...EXPECTED_CONSTRAINTS],
  constraintSpecs: EXPECTED_CONSTRAINT_SPECS,
  checkColumnSets: EXPECTED_CHECK_COLUMN_SETS,
  relationalConstraintSpecs: EXPECTED_RELATIONAL_CONSTRAINT_SPECS,
  indexes: [...EXPECTED_INDEXES],
  indexSpecs: EXPECTED_INDEX_SPECS,
});

class MigrationError extends Error {
  constructor(code) {
    super(code);
    this.name = 'MigrationError';
    this.code = code;
  }
}

function normalizeSql(text) {
  return text.replace(/\r\n/g, '\n');
}

const RESERVED_SQL_IDENTIFIERS = new Set([
  'all', 'and', 'any', 'array', 'as', 'between', 'check', 'constraint', 'false',
  'foreign', 'from', 'in', 'is', 'key', 'not', 'null', 'or', 'primary',
  'references', 'select', 'true', 'unique', 'where',
]);
const SAFE_DEQUOTED_SQL_IDENTIFIERS = new Set(
  Object.values(EXPECTED_COLUMNS)
    .flat()
    .filter((identifier) => /^[a-z_][a-z0-9_$]*$/u.test(identifier))
    .filter((identifier) => !RESERVED_SQL_IDENTIFIERS.has(identifier)),
);

function rewriteSqlSegments(value, rewriteUnquoted, rewriteDoubleQuoted = (segment) => segment) {
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

function normalizeDefinition(value) {
  const normalizedIdentifiers = rewriteSqlSegments(
    String(value ?? ''),
    (segment) => segment
      .toLowerCase()
      .replace(
        /::\s*(?:character varying|timestamp with time zone|bigint|integer|numeric|text|jsonb)\b/giu,
        '',
      ),
    (segment, closed) => {
      if (!closed) return segment;
      const identifier = segment.slice(1, -1);
      return /^[a-z_][a-z0-9_$]*$/u.test(identifier)
        && !RESERVED_SQL_IDENTIFIERS.has(identifier)
        && SAFE_DEQUOTED_SQL_IDENTIFIERS.has(identifier)
        ? identifier
        : segment;
    },
  );
  return rewriteSqlSegments(
    normalizedIdentifiers,
    (segment) => segment
      .replace(/\s+/gu, ' ')
      .replace(/\s*([\[\](),])\s*/gu, '$1'),
  ).trim();
}

function stripOuterBooleanParentheses(value) {
  let expression = value.trim();
  while (expression.startsWith('(') && expression.endsWith(')')) {
    let depth = 0;
    let activeQuote = null;
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

function splitTopLevelBoolean(value, operator) {
  const parts = [];
  let start = 0;
  let depth = 0;
  let activeQuote = null;
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

function atomicBooleanNode(value) {
  const canonical = rewriteSqlSegments(
    value,
    (segment) => segment.replace(/[()[\]\s]/gu, ''),
  );
  const between = canonical.match(/^(.+)between(-?[0-9]+)and(-?[0-9]+)$/u);
  if (between) {
    return { kind: 'between', left: between[1], lower: between[2], upper: between[3] };
  }
  return { kind: 'atom', value: canonical };
}

function parseBooleanNode(value) {
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

function lastIndexOfOutsideQuotes(value, needle) {
  let activeQuote = null;
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

function comparisonParts(node, operator) {
  if (!node || node.kind !== 'atom') return null;
  const marker = lastIndexOfOutsideQuotes(node.value, operator);
  if (marker <= 0) return null;
  const bound = node.value.slice(marker + operator.length);
  if (!/^-?[0-9]+$/u.test(bound)) return null;
  return { left: node.value.slice(0, marker), bound };
}

function canonicalizeBooleanNode(node) {
  if (node.kind !== 'and' && node.kind !== 'or') return node;
  const children = node.children
    .map(canonicalizeBooleanNode)
    .flatMap((child) => child.kind === node.kind ? child.children : [child]);
  if (node.kind === 'and') {
    const collapsed = [];
    for (let index = 0; index < children.length; index += 1) {
      const lower = comparisonParts(children[index], '>=');
      const upper = comparisonParts(children[index + 1], '<=');
      if (lower && upper && lower.left === upper.left) {
        collapsed.push({
          kind: 'between',
          left: lower.left,
          lower: lower.bound,
          upper: upper.bound,
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

function renderBooleanNode(node) {
  if (node.kind === 'atom') return `atom:${node.value}`;
  if (node.kind === 'between') return `between:${node.left}:${node.lower}:${node.upper}`;
  return `${node.kind}(${node.children.map(renderBooleanNode).join(',')})`;
}

function canonicalCheckDefinition(value) {
  const expression = rewriteSqlSegments(
    normalizeDefinition(value),
    (segment) => segment
      .replace(/^constraint [^ ]+ /u, '')
      .replace(/^check\(/u, '(')
      .replace(/=\s*any\(array\[/gu, 'in(')
      .replace(/\]\)/gu, ')'),
  );
  return renderBooleanNode(canonicalizeBooleanNode(parseBooleanNode(expression)));
}

export function checkDefinitionHash(value) {
  return createHash('sha256').update(canonicalCheckDefinition(value)).digest('hex');
}

export function extractCheckDefinitions(sql) {
  const definitions = new Map();
  const pattern = /CONSTRAINT\s+"([^"]+)"\s+CHECK\s*\(/giu;
  for (const match of sql.matchAll(pattern)) {
    const name = match[1];
    const start = (match.index ?? 0) + match[0].lastIndexOf('(');
    let depth = 0;
    let inString = false;
    let end = -1;
    for (let index = start; index < sql.length; index += 1) {
      const character = sql[index];
      if (character === "'") {
        if (inString && sql[index + 1] === "'") {
          index += 1;
          continue;
        }
        inString = !inString;
      }
      if (inString) continue;
      if (character === '(') depth += 1;
      if (character === ')') {
        depth -= 1;
        if (depth === 0) {
          end = index;
          break;
        }
      }
    }
    if (end < 0) throw new MigrationError(`MIGRATION_CHECK_DEFINITION_UNCLOSED:${name}`);
    definitions.set(name, `CHECK ${sql.slice(start, end + 1)}`);
  }
  return definitions;
}

export function loadReviewedCheckDefinitions(
  manifest = loadMigrationManifest(),
  directory = MIGRATION_DIRECTORY,
) {
  return extractCheckDefinitions(
    manifest.phases
      .map((phase) => normalizeSql(readFileSync(join(directory, phase.path), 'utf8')))
      .join('\n'),
  );
}

function defaultMatches(value, expected) {
  const normalized = normalizeDefinition(value);
  if (expected === 'none') return value === null || value === undefined;
  if (expected === 'current_timestamp') {
    return normalized === 'current_timestamp' || normalized === 'now()';
  }
  if (expected === 'zero') {
    return normalized === '0' || normalized === normalizeDefinition("'0'");
  }
  return normalized === normalizeDefinition("'{}'")
    || normalized === normalizeDefinition("'{}'::jsonb");
}

let cachedPostgreSqlArrayParser;

function isStrictFlatPostgreSqlStringArrayLiteral(value) {
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

function getPostgreSqlArrayParser() {
  if (cachedPostgreSqlArrayParser !== undefined) return cachedPostgreSqlArrayParser;
  try {
    const pg = createRequire(import.meta.url)('pg');
    const parser = pg?.types?.arrayParser;
    cachedPostgreSqlArrayParser = typeof parser?.create === 'function' ? parser : null;
  } catch {
    cachedPostgreSqlArrayParser = null;
  }
  return cachedPostgreSqlArrayParser;
}

function parsePostgreSqlCatalogStringArray(value) {
  if (!isStrictFlatPostgreSqlStringArrayLiteral(value)) return null;
  const parser = getPostgreSqlArrayParser();
  if (!parser) return null;
  try {
    const decoded = parser.create(value, (entry) => entry).parse();
    if (!Array.isArray(decoded) || decoded.some((item) => typeof item !== 'string')) return null;
    return [...decoded];
  } catch {
    return null;
  }
}

export function parseCatalogJsonTextArray(value) {
  let decoded = value;
  if (typeof value === 'string') {
    if (value === '{}') return parsePostgreSqlCatalogStringArray(value);
    try {
      decoded = JSON.parse(value);
    } catch {
      return parsePostgreSqlCatalogStringArray(value);
    }
  }
  if (!Array.isArray(decoded) || decoded.some((item) => typeof item !== 'string')) return null;
  return [...decoded];
}

function relationalConstraintMatches(row, spec) {
  const columns = parseCatalogJsonTextArray(row.columns_json);
  const referencedColumns = parseCatalogJsonTextArray(row.referenced_columns_json);
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

function checkConstraintColumnsMatch(row, name) {
  const columns = parseCatalogJsonTextArray(row.columns_json);
  const referencedColumns = parseCatalogJsonTextArray(row.referenced_columns_json);
  const expected = EXPECTED_CHECK_COLUMN_SETS[name];
  if (!columns || !referencedColumns || !expected || referencedColumns.length !== 0) return false;
  if (new Set(columns).size !== columns.length) return false;
  return JSON.stringify([...columns].sort()) === JSON.stringify([...expected].sort());
}

function predicateStates(predicate) {
  if (predicate === null || predicate === undefined || String(predicate).trim() === '') return [];
  const normalized = stripOuterBooleanParentheses(normalizeDefinition(predicate));
  const equality = normalized.match(/^state\s*=\s*'(REQUESTED|CLAIMED|RUNNING)'$/u);
  if (equality) return [equality[1]];

  const membership = normalized.match(/^state in\((.*)\)$/u)
    ?? normalized.match(/^state\s*=\s*any\(array\[(.*)\]\)$/u);
  if (!membership || membership[1].length === 0) return null;
  const values = [...membership[1].matchAll(/'(REQUESTED|CLAIMED|RUNNING)'/gu)]
    .map((match) => match[1]);
  if (values.length === 0 || values.map((value) => `'${value}'`).join(',') !== membership[1]) {
    return null;
  }
  return values.sort();
}

function indexStructurallyMatches(row, spec) {
  const columns = parseCatalogJsonTextArray(row?.columns_json);
  return Boolean(
    row
    && spec
    && columns
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

export function loadMigrationManifest(path = MIGRATION_MANIFEST_PATH) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

export function calculateMigrationChecksum(
  manifest = loadMigrationManifest(),
  directory = MIGRATION_DIRECTORY,
) {
  const hash = createHash('sha256');
  hash.update(`${manifest.version}\n`);
  for (const phase of manifest.phases) {
    const sql = normalizeSql(readFileSync(join(directory, phase.path), 'utf8'));
    hash.update(`${phase.id}\n${sql}\n`);
  }
  return hash.digest('hex');
}

export function validateMigrationArtifacts({
  manifest = loadMigrationManifest(),
  directory = MIGRATION_DIRECTORY,
} = {}) {
  const issues = [];
  const calculatedChecksum = calculateMigrationChecksum(manifest, directory);
  if (manifest.version !== REVIEWED_MIGRATION_VERSION) {
    issues.push('MIGRATION_VERSION_MISMATCH');
  }
  if (
    calculatedChecksum !== manifest.checksum
    || manifest.checksum !== REVIEWED_MIGRATION_CHECKSUM
  ) {
    issues.push('MIGRATION_CHECKSUM_MISMATCH');
  }
  if (manifest.schemaLabel !== 'action-plan-execution-v1') {
    issues.push('MIGRATION_SCHEMA_LABEL_INVALID');
  }
  if (manifest.protocolVersion !== 2 || manifest.snapshotSchemaVersion !== 1) {
    issues.push('MIGRATION_PROTOCOL_VERSION_INVALID');
  }
  if (!/^[0-9]+$/.test(manifest.advisoryLockKey)) {
    issues.push('MIGRATION_ADVISORY_LOCK_INVALID');
  }

  const seenPhaseIds = new Set();
  const forwardSqlParts = [];
  for (const phase of manifest.phases) {
    if (seenPhaseIds.has(phase.id)) {
      issues.push(`MIGRATION_PHASE_DUPLICATE:${phase.id}`);
    }
    seenPhaseIds.add(phase.id);
    const sql = normalizeSql(readFileSync(join(directory, phase.path), 'utf8'));
    forwardSqlParts.push(sql);
    const sqlWithoutComments = sql.replace(/--[^\n]*/g, '');
    if (/(?:^|;)\s*(?:DROP\b|TRUNCATE\b|DELETE\s+FROM\b)/im.test(sqlWithoutComments)) {
      issues.push(`MIGRATION_FORWARD_DESTRUCTIVE_SQL:${phase.id}`);
    }
    if (phase.transactional === false) {
      if (!/^\s*(?:--[^\n]*\n\s*)*CREATE\s+UNIQUE\s+INDEX\s+CONCURRENTLY\b/i.test(sql)) {
        issues.push(`MIGRATION_NONTRANSACTIONAL_PHASE_INVALID:${phase.id}`);
      }
      const statements = sql
        .split(';')
        .map((value) => value.replace(/--[^\n]*/g, '').trim())
        .filter(Boolean);
      if (statements.length !== 1) {
        issues.push(`MIGRATION_CONCURRENT_PHASE_NOT_SINGLE_STATEMENT:${phase.id}`);
      }
    }
  }

  const reviewedChecks = extractCheckDefinitions(forwardSqlParts.join('\n'));
  for (const [name, expectedHash] of Object.entries(EXPECTED_CHECK_DEFINITION_HASHES)) {
    const definition = reviewedChecks.get(name);
    if (!definition || checkDefinitionHash(definition) !== expectedHash) {
      issues.push(`MIGRATION_CHECK_DEFINITION_MISMATCH:${name}`);
    }
  }
  for (const name of reviewedChecks.keys()) {
    if (!Object.hasOwn(EXPECTED_CHECK_DEFINITION_HASHES, name)) {
      issues.push(`MIGRATION_CHECK_DEFINITION_UNREVIEWED:${name}`);
    }
  }

  const compensationSql = readFileSync(join(directory, manifest.compensationPath), 'utf8');
  if (!compensationSql.includes('LOCAL-EPHEMERAL COMPENSATING ROLLBACK ONLY')) {
    issues.push('MIGRATION_COMPENSATION_GUARD_BANNER_MISSING');
  }

  return {
    ok: issues.length === 0,
    version: manifest.version,
    schemaLabel: manifest.schemaLabel,
    protocolVersion: manifest.protocolVersion,
    snapshotSchemaVersion: manifest.snapshotSchemaVersion,
    checksum: manifest.checksum,
    calculatedChecksum,
    phases: manifest.phases.map(({ id, path, transactional }) => ({ id, path, transactional })),
    compensationPath: manifest.compensationPath,
    issues: issues.sort(),
    databaseConnected: false,
    databaseMutated: false,
  };
}

export function assertLocalEphemeralConnectionString(connectionString) {
  let parsed;
  try {
    parsed = new URL(connectionString);
  } catch {
    throw new MigrationError('MIGRATION_DATABASE_URL_INVALID');
  }
  if (!['postgres:', 'postgresql:'].includes(parsed.protocol)) {
    throw new MigrationError('MIGRATION_DATABASE_PROTOCOL_INVALID');
  }
  if (parsed.search.length > 0 || parsed.hash.length > 0) {
    throw new MigrationError('MIGRATION_DATABASE_OPTIONS_FORBIDDEN');
  }
  const hostname = parsed.hostname.toLowerCase();
  if (!['localhost', '127.0.0.1', '[::1]', '::1'].includes(hostname)) {
    throw new MigrationError('MIGRATION_DATABASE_NOT_LOOPBACK');
  }
  const databaseName = decodeURIComponent(parsed.pathname.replace(/^\//, '')).toLowerCase();
  if (!/^arcanos_phase2e_[a-z0-9_]+$/.test(databaseName)) {
    throw new MigrationError('MIGRATION_DATABASE_NOT_EXPLICIT_EPHEMERAL');
  }
  return { hostname: 'loopback', databaseName };
}

async function relationExists(client, relationName) {
  const result = await client.query(
    'SELECT to_regclass($1::text) IS NOT NULL AS exists',
    [`"${relationName}"`],
  );
  return result.rows[0]?.exists === true;
}

async function readLedger(client, manifest) {
  if (!(await relationExists(client, 'ActionPlanExecutionSchemaMigration'))) {
    return null;
  }
  const result = await client.query(
    `SELECT "checksum", "completedPhase", "validityState", "appliedAt"
     FROM "ActionPlanExecutionSchemaMigration"
     WHERE "version" = $1`,
    [manifest.version],
  );
  return result.rows[0] ?? null;
}

async function writeLedger(client, manifest, completedPhase, validityState, applied = false) {
  const result = await client.query(
    `INSERT INTO "ActionPlanExecutionSchemaMigration"
       ("version", "checksum", "completedPhase", "validityState", "appliedAt", "updatedAt")
     VALUES ($1, $2, $3, $4, CASE WHEN $5::boolean THEN CURRENT_TIMESTAMP ELSE NULL END, CURRENT_TIMESTAMP)
     ON CONFLICT ("version") DO UPDATE SET
       "completedPhase" = EXCLUDED."completedPhase",
       "validityState" = EXCLUDED."validityState",
       "appliedAt" = CASE
         WHEN EXCLUDED."validityState" = 'FAILED' THEN NULL
         WHEN $5::boolean THEN CURRENT_TIMESTAMP
         ELSE "ActionPlanExecutionSchemaMigration"."appliedAt"
       END,
       "updatedAt" = CURRENT_TIMESTAMP
     WHERE "ActionPlanExecutionSchemaMigration"."checksum" = EXCLUDED."checksum"
     RETURNING "version"`,
    [manifest.version, manifest.checksum, completedPhase, validityState, applied],
  );
  if (result.rowCount !== 1) {
    throw new MigrationError('MIGRATION_LEDGER_CHECKSUM_CONFLICT');
  }
}

async function inspectConcurrentIndex(client, name) {
  const result = await client.query(
    `SELECT index_relation.relname AS name,
            table_relation.relname AS table_name,
            index_data.indisunique AS unique,
            index_data.indisvalid AS valid,
            index_data.indisready AS ready,
            namespace.nspname = current_schema() AS schema_matches,
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
            access_method.amname AS access_method,
            to_json(ARRAY(
              SELECT attribute.attname::text
              FROM unnest(index_data.indkey::smallint[]) WITH ORDINALITY AS key_column(attnum, position)
              JOIN pg_attribute AS attribute
                ON attribute.attrelid = index_data.indrelid
               AND attribute.attnum = key_column.attnum
              WHERE key_column.position <= index_data.indnkeyatts
              ORDER BY key_column.position
            ))::text AS columns_json,
            pg_get_expr(index_data.indpred, index_data.indrelid, true) AS predicate
     FROM pg_class AS index_relation
     JOIN pg_index AS index_data ON index_data.indexrelid = index_relation.oid
     JOIN pg_class AS table_relation ON table_relation.oid = index_data.indrelid
     JOIN pg_am AS access_method ON access_method.oid = index_relation.relam
     JOIN pg_namespace AS namespace ON namespace.oid = index_relation.relnamespace
     WHERE namespace.nspname = current_schema()
       AND index_relation.relname = $1`,
    [name],
  );
  return result.rows[0] ?? null;
}

async function runPhase(client, manifest, phase, sql) {
  if (phase.transactional) {
    await client.query('BEGIN');
    try {
      await client.query("SET LOCAL lock_timeout TO '5s'");
      await client.query("SET LOCAL statement_timeout TO '60s'");
      await client.query(sql);
      await writeLedger(client, manifest, phase.id, 'IN_PROGRESS');
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
    return;
  }

  const index = await inspectConcurrentIndex(client, phase.concurrentIndex);
  if (
    index
    && !indexStructurallyMatches(index, EXPECTED_INDEX_SPECS[phase.concurrentIndex])
  ) {
    throw new MigrationError('MIGRATION_CONCURRENT_INDEX_DEFINITION_INVALID');
  }
  if (index && (!index.valid || !index.ready)) {
    await writeLedger(client, manifest, phase.id, 'RECOVERING_INVALID_INDEX');
    const allowedIndex = manifest.phases.some(
      (candidate) => candidate.concurrentIndex === phase.concurrentIndex,
    );
    if (!allowedIndex) {
      throw new MigrationError('MIGRATION_INDEX_RECOVERY_NOT_ALLOWLISTED');
    }
    await client.query(`REINDEX INDEX CONCURRENTLY "${phase.concurrentIndex}"`);
  } else if (!index) {
    await client.query(sql);
  }
  const verifiedIndex = await inspectConcurrentIndex(client, phase.concurrentIndex);
  if (
    !indexStructurallyMatches(verifiedIndex, EXPECTED_INDEX_SPECS[phase.concurrentIndex])
    || !verifiedIndex?.valid
    || !verifiedIndex?.ready
  ) {
    throw new MigrationError('MIGRATION_CONCURRENT_INDEX_INVALID');
  }
  await writeLedger(client, manifest, phase.id, 'IN_PROGRESS');
}

export async function verifyActionPlanExecutionSchemaWithClient(
  client,
  manifest = loadMigrationManifest(),
  { ignoreLedgerCompletion = false } = {},
) {
  const issues = [];
  const ledger = await readLedger(client, manifest);
  if (!ledger) {
    issues.push('SCHEMA_LEDGER_MISSING');
  } else {
    if (ledger.checksum !== manifest.checksum) issues.push('SCHEMA_CHECKSUM_MISMATCH');
    if (!ignoreLedgerCompletion) {
      if (ledger.completedPhase !== 'complete') issues.push('SCHEMA_MIGRATION_INCOMPLETE');
      if (ledger.validityState !== 'VALID') issues.push('SCHEMA_LEDGER_NOT_VALID');
      if (!ledger.appliedAt) issues.push('SCHEMA_APPLIED_AT_MISSING');
    }
  }

  const tableResult = await client.query(
    `SELECT table_name
     FROM information_schema.tables
     WHERE table_schema = current_schema()
       AND table_name = ANY($1::text[])`,
    [EXPECTED_TABLES],
  );
  const tables = new Set(tableResult.rows.map((row) => row.table_name));
  for (const table of EXPECTED_TABLES) {
    if (!tables.has(table)) issues.push(`SCHEMA_TABLE_MISSING:${table}`);
  }

  const expectedTableNames = Object.keys(EXPECTED_COLUMNS);
  const columnResult = await client.query(
    `SELECT table_name, column_name, udt_name, is_nullable, column_default
     FROM information_schema.columns
     WHERE table_schema = current_schema()
       AND table_name = ANY($1::text[])`,
    [expectedTableNames],
  );
  const columns = new Map(
    columnResult.rows.map((row) => [`${row.table_name}.${row.column_name}`, row]),
  );
  for (const [table, expectedColumns] of Object.entries(EXPECTED_COLUMNS)) {
    for (const columnName of expectedColumns) {
      const key = `${table}.${columnName}`;
      const actual = columns.get(key);
      if (!actual) {
        issues.push(`SCHEMA_COLUMN_MISSING:${table}.${columnName}`);
        continue;
      }
      const expected = EXPECTED_COLUMN_SPECS[table]?.[columnName];
      if (
        !expected
        || actual.udt_name !== expected.type
        || (actual.is_nullable === 'YES') !== expected.nullable
        || !defaultMatches(actual.column_default, expected.defaultKind)
      ) {
        issues.push(`SCHEMA_COLUMN_DEFINITION_INVALID:${table}.${columnName}`);
      }
    }
  }

  const constraintResult = await client.query(
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
            to_json(CASE WHEN constraint_data.confrelid = 0 THEN ARRAY[]::text[] ELSE ARRAY(
              SELECT referenced_attribute.attname::text
              FROM unnest(constraint_data.confkey) WITH ORDINALITY AS referenced_key(attnum, position)
              JOIN pg_attribute AS referenced_attribute
                ON referenced_attribute.attrelid = constraint_data.confrelid
               AND referenced_attribute.attnum = referenced_key.attnum
              ORDER BY referenced_key.position
            )::text[] END)::text AS referenced_columns_json,
            CASE WHEN constraint_data.confrelid = 0 THEN NULL
                 ELSE referenced_namespace.nspname = current_schema()
            END AS referenced_schema_matches,
            constraint_data.confupdtype AS update_action,
            constraint_data.confdeltype AS delete_action
     FROM pg_constraint AS constraint_data
     JOIN pg_namespace AS namespace ON namespace.oid = constraint_data.connamespace
     JOIN pg_class AS table_relation ON table_relation.oid = constraint_data.conrelid
     LEFT JOIN pg_class AS referenced_relation ON referenced_relation.oid = constraint_data.confrelid
     LEFT JOIN pg_namespace AS referenced_namespace
       ON referenced_namespace.oid = referenced_relation.relnamespace
     WHERE namespace.nspname = current_schema()
       AND constraint_data.conname = ANY($1::text[])`,
    [EXPECTED_CONSTRAINTS],
  );
  for (const name of EXPECTED_CONSTRAINTS) {
    const matches = constraintResult.rows.filter((row) => row.name === name);
    const expected = EXPECTED_CONSTRAINT_SPECS[name];
    const relationalExpected = EXPECTED_RELATIONAL_CONSTRAINT_SPECS[name];
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
      || (
        expected.type === 'c'
          ? !checkConstraintColumnsMatch(matches[0], name)
            || checkDefinitionHash(matches[0].definition) !== EXPECTED_CHECK_DEFINITION_HASHES[name]
          : !relationalExpected || !relationalConstraintMatches(matches[0], relationalExpected)
      )
    ) {
      issues.push(`SCHEMA_CONSTRAINT_DEFINITION_INVALID:${name}`);
    }
    if (matches[0].validated !== true) {
      issues.push(`SCHEMA_CONSTRAINT_NOT_VALID:${name}`);
    }
  }

  const indexResult = await client.query(
    `SELECT index_relation.relname AS name,
            table_relation.relname AS table_name,
            index_data.indisunique AS unique,
            index_data.indisvalid AS valid,
            index_data.indisready AS ready,
            namespace.nspname = current_schema() AS schema_matches,
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
            access_method.amname AS access_method,
            to_json(ARRAY(
              SELECT attribute.attname::text
              FROM unnest(index_data.indkey::smallint[]) WITH ORDINALITY AS key_column(attnum, position)
              JOIN pg_attribute AS attribute
                ON attribute.attrelid = index_data.indrelid
               AND attribute.attnum = key_column.attnum
              WHERE key_column.position <= index_data.indnkeyatts
              ORDER BY key_column.position
            ))::text AS columns_json,
            pg_get_expr(index_data.indpred, index_data.indrelid, true) AS predicate
     FROM pg_class AS index_relation
     JOIN pg_index AS index_data ON index_data.indexrelid = index_relation.oid
     JOIN pg_class AS table_relation ON table_relation.oid = index_data.indrelid
     JOIN pg_am AS access_method ON access_method.oid = index_relation.relam
     JOIN pg_namespace AS namespace ON namespace.oid = index_relation.relnamespace
     WHERE namespace.nspname = current_schema()
       AND index_relation.relname = ANY($1::text[])`,
    [EXPECTED_INDEXES],
  );
  for (const name of EXPECTED_INDEXES) {
    const matches = indexResult.rows.filter((row) => row.name === name);
    const expected = EXPECTED_INDEX_SPECS[name];
    if (matches.length === 0) {
      issues.push(`SCHEMA_INDEX_MISSING:${name}`);
      continue;
    }
    if (
      matches.length !== 1
      || !indexStructurallyMatches(matches[0], expected)
    ) {
      issues.push(`SCHEMA_INDEX_DEFINITION_INVALID:${name}`);
    }
    if (matches[0].valid !== true || matches[0].ready !== true) {
      issues.push(`SCHEMA_INDEX_INVALID:${name}`);
    }
  }

  return {
    ready: issues.length === 0,
    code: issues.length === 0 ? 'ACTION_PLAN_EXECUTION_SCHEMA_READY' : 'ACTION_PLAN_EXECUTION_SCHEMA_INVALID',
    version: manifest.version,
    schemaLabel: manifest.schemaLabel,
    protocolVersion: manifest.protocolVersion,
    snapshotSchemaVersion: manifest.snapshotSchemaVersion,
    checksum: manifest.checksum,
    issues: issues.sort(),
  };
}

async function acquireMigrationLock(client, manifest) {
  const result = await client.query(
    'SELECT pg_try_advisory_lock($1::bigint) AS locked',
    [manifest.advisoryLockKey],
  );
  if (result.rows[0]?.locked !== true) {
    throw new MigrationError('MIGRATION_ADVISORY_LOCK_UNAVAILABLE');
  }
}

async function releaseMigrationLock(client, manifest) {
  const result = await client.query(
    'SELECT pg_advisory_unlock($1::bigint) AS unlocked',
    [manifest.advisoryLockKey],
  );
  if (result.rows[0]?.unlocked !== true) {
    throw new MigrationError('MIGRATION_ADVISORY_UNLOCK_FAILED');
  }
}

function queryPlanFrom(result) {
  const plan = result.rows[0]?.['QUERY PLAN'];
  return Array.isArray(plan) ? plan : null;
}

export async function inspectMigrationPreflightWithClient(client) {
  const [planCount, actionCount, legacyResultCount, planLookup, actionLookup] = await Promise.all([
    client.query('SELECT COUNT(*)::bigint AS count FROM "ActionPlan"'),
    client.query('SELECT COUNT(*)::bigint AS count FROM "Action"'),
    client.query('SELECT COUNT(*)::bigint AS count FROM "ExecutionResult"'),
    client.query(
      'EXPLAIN (FORMAT JSON, COSTS TRUE) SELECT "id" FROM "ActionPlan" WHERE "id"=$1',
      ['migration-plan-probe'],
    ),
    client.query(
      `EXPLAIN (FORMAT JSON, COSTS TRUE)
       SELECT "id" FROM "Action" WHERE "planId"=$1 ORDER BY "id" LIMIT 1`,
      ['migration-plan-probe'],
    ),
  ]);
  return {
    rowCounts: {
      actionPlans: safeCount(planCount.rows[0]?.count),
      actions: safeCount(actionCount.rows[0]?.count),
      legacyExecutionResults: safeCount(legacyResultCount.rows[0]?.count),
    },
    queryPlans: {
      actionPlanIdentityLookup: queryPlanFrom(planLookup),
      actionIdentityLookup: queryPlanFrom(actionLookup),
    },
  };
}

export async function inspectMigrationPostflightWithClient(client) {
  const claimLookup = await client.query(
    `EXPLAIN (FORMAT JSON, COSTS TRUE)
     SELECT "id"
     FROM "ActionPlanExecutionRun"
     WHERE "executionRealm"=$1
       AND "assignedExecutorPrincipalId"=$2
       AND "assignedExecutorInstanceId"=$3
       AND "assignedAgentId"=$4
       AND "state"='REQUESTED'
     ORDER BY "requestedAt", "id"
     LIMIT 1`,
    [
      'migration-realm-probe',
      'migration-principal-probe',
      'migration-instance-probe',
      'migration-agent-probe',
    ],
  );
  return {
    queryPlans: {
      claimNextLookup: queryPlanFrom(claimLookup),
    },
  };
}

async function finalizeMigrationLedger(client, manifest) {
  await client.query('BEGIN');
  try {
    await writeLedger(client, manifest, 'complete', 'VALID', true);
    const verification = await verifyActionPlanExecutionSchemaWithClient(client, manifest);
    if (!verification.ready) {
      throw new MigrationError('MIGRATION_SCHEMA_VERIFICATION_FAILED');
    }
    await client.query('COMMIT');
    return verification;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}

export async function applyMigrationWithClient(client, {
  manifest = loadMigrationManifest(),
  directory = MIGRATION_DIRECTORY,
} = {}) {
  const artifactValidation = validateMigrationArtifacts({ manifest, directory });
  if (!artifactValidation.ok) {
    throw new MigrationError('MIGRATION_ARTIFACT_VALIDATION_FAILED');
  }

  await client.query("SET application_name TO 'arcanos-phase2e-local-migrator'");
  await client.query("SET lock_timeout TO '5s'");
  await client.query("SET statement_timeout TO '60s'");
  await acquireMigrationLock(client, manifest);
  let lastCompletedPhase = null;
  let primaryError = null;
  try {
    const existingLedger = await readLedger(client, manifest);
    if (existingLedger && existingLedger.checksum !== manifest.checksum) {
      throw new MigrationError('MIGRATION_LEDGER_CHECKSUM_CONFLICT');
    }
    if (
      existingLedger?.completedPhase === 'complete'
      && existingLedger.validityState === 'VALID'
    ) {
      lastCompletedPhase = 'complete';
      const verification = await verifyActionPlanExecutionSchemaWithClient(client, manifest);
      if (!verification.ready) throw new MigrationError('MIGRATION_SCHEMA_VERIFICATION_FAILED');
      return { ...verification, applied: false, equivalentRerun: true };
    }
    if (existingLedger?.completedPhase === 'complete') {
      const recoveryVerification = await verifyActionPlanExecutionSchemaWithClient(
        client,
        manifest,
        { ignoreLedgerCompletion: true },
      );
      if (!recoveryVerification.ready) {
        throw new MigrationError('MIGRATION_SCHEMA_VERIFICATION_FAILED');
      }
      lastCompletedPhase = 'complete';
      const verification = await finalizeMigrationLedger(client, manifest);
      return {
        ...verification,
        applied: false,
        equivalentRerun: true,
        recoveredFinalVerification: true,
      };
    }

    const preflight = await inspectMigrationPreflightWithClient(client);

    let completedIndex = existingLedger
      ? manifest.phases.findIndex((phase) => phase.id === existingLedger.completedPhase)
      : -1;
    if (existingLedger && completedIndex < 0) {
      throw new MigrationError('MIGRATION_LEDGER_PHASE_UNKNOWN');
    }
    if (existingLedger?.validityState === 'RECOVERING_INVALID_INDEX') {
      const recoveringPhase = manifest.phases[completedIndex];
      if (recoveringPhase?.transactional !== false || !recoveringPhase.concurrentIndex) {
        throw new MigrationError('MIGRATION_LEDGER_RECOVERY_PHASE_INVALID');
      }
      completedIndex -= 1;
    }
    lastCompletedPhase = existingLedger?.completedPhase ?? null;

    for (let index = completedIndex + 1; index < manifest.phases.length; index += 1) {
      const phase = manifest.phases[index];
      const sql = normalizeSql(readFileSync(join(directory, phase.path), 'utf8'));
      await runPhase(client, manifest, phase, sql);
      lastCompletedPhase = phase.id;
    }

    const preFinalVerification = await verifyActionPlanExecutionSchemaWithClient(
      client,
      manifest,
      { ignoreLedgerCompletion: true },
    );
    if (!preFinalVerification.ready) {
      lastCompletedPhase = 'complete';
      await writeLedger(client, manifest, 'complete', 'FAILED');
      throw new MigrationError('MIGRATION_SCHEMA_VERIFICATION_FAILED');
    }
    lastCompletedPhase = 'complete';
    const verification = await finalizeMigrationLedger(client, manifest);
    const postflight = await inspectMigrationPostflightWithClient(client);
    return {
      ...verification,
      applied: true,
      equivalentRerun: false,
      preflight,
      postflight,
    };
  } catch (error) {
    primaryError = error;
    if (lastCompletedPhase) {
      try {
        if (await relationExists(client, 'ActionPlanExecutionSchemaMigration')) {
          await writeLedger(client, manifest, lastCompletedPhase, 'FAILED');
        }
      } catch {
        // The original failure remains authoritative; checksum conflicts are not overwritten.
      }
    }
    throw error;
  } finally {
    try {
      await releaseMigrationLock(client, manifest);
    } catch (unlockError) {
      if (!primaryError) throw unlockError;
    }
  }
}

export async function compensateMigrationWithClient(client, {
  manifest = loadMigrationManifest(),
  directory = MIGRATION_DIRECTORY,
} = {}) {
  const artifactValidation = validateMigrationArtifacts({ manifest, directory });
  if (!artifactValidation.ok) {
    throw new MigrationError('MIGRATION_ARTIFACT_VALIDATION_FAILED');
  }
  await client.query("SET application_name TO 'arcanos-phase2e-local-compensator'");
  await client.query("SET lock_timeout TO '5s'");
  await client.query("SET statement_timeout TO '60s'");
  await acquireMigrationLock(client, manifest);
  let primaryError = null;
  try {
    const sql = normalizeSql(
      readFileSync(join(directory, manifest.compensationPath), 'utf8'),
    );
    await client.query('BEGIN');
    try {
      await client.query(sql);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
    return {
      ok: true,
      compensated: true,
      version: manifest.version,
      databaseMutated: true,
    };
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    try {
      await releaseMigrationLock(client, manifest);
    } catch (unlockError) {
      if (!primaryError) throw unlockError;
    }
  }
}

function safeCount(value) {
  const parsed = Number(value ?? 0);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new MigrationError('MIGRATION_DRAIN_COUNT_INVALID');
  }
  return parsed;
}

export async function inspectMigrationDrainStateWithClient(client) {
  const runTablePresent = await relationExists(client, 'ActionPlanExecutionRun');
  if (!runTablePresent) {
    return {
      protocolTablesPresent: false,
      counts: {
        requested: 0,
        claimed: 0,
        running: 0,
        runs: 0,
        commands: 0,
        events: 0,
        populatedProvenancePlans: 0,
      },
      canDisableAssignment: true,
      canRevertApplication: true,
      canCompensateEmptySchema: false,
    };
  }

  const [stateResult, runResult, commandResult, eventResult, provenanceResult] = await Promise.all([
    client.query(
      `SELECT "state", COUNT(*)::bigint AS count
       FROM "ActionPlanExecutionRun"
       WHERE "state" = ANY($1::text[])
       GROUP BY "state"`,
      [['REQUESTED', 'CLAIMED', 'RUNNING']],
    ),
    client.query('SELECT COUNT(*)::bigint AS count FROM "ActionPlanExecutionRun"'),
    client.query('SELECT COUNT(*)::bigint AS count FROM "ActionPlanExecutionCommand"'),
    client.query('SELECT COUNT(*)::bigint AS count FROM "ActionPlanExecutionEvent"'),
    client.query(
      `SELECT COUNT(*)::bigint AS count
       FROM "ActionPlan"
       WHERE "executionRealm" IS NOT NULL
          OR "ownerPrincipalId" IS NOT NULL
          OR "executionProtocolVersion" IS NOT NULL
          OR "executionGeneration" IS NOT NULL`,
    ),
  ]);
  const states = new Map(
    stateResult.rows.map((row) => [String(row.state), safeCount(row.count)]),
  );
  const counts = {
    requested: states.get('REQUESTED') ?? 0,
    claimed: states.get('CLAIMED') ?? 0,
    running: states.get('RUNNING') ?? 0,
    runs: safeCount(runResult.rows[0]?.count),
    commands: safeCount(commandResult.rows[0]?.count),
    events: safeCount(eventResult.rows[0]?.count),
    populatedProvenancePlans: safeCount(provenanceResult.rows[0]?.count),
  };
  return {
    protocolTablesPresent: true,
    counts,
    canDisableAssignment: counts.requested === 0,
    canRevertApplication:
      counts.requested === 0 && counts.claimed === 0 && counts.running === 0,
    canCompensateEmptySchema:
      counts.runs === 0
      && counts.commands === 0
      && counts.events === 0
      && counts.populatedProvenancePlans === 0,
  };
}

function parseArgs(argv) {
  const options = {
    mode: 'plan',
    confirmLocalEphemeral: false,
    confirmEmpty: false,
  };
  for (const arg of argv) {
    if (arg === '--plan') options.mode = 'plan';
    else if (arg === '--apply') options.mode = 'apply';
    else if (arg === '--verify-local') options.mode = 'verify-local';
    else if (arg === '--drain-status-local') options.mode = 'drain-status-local';
    else if (arg === '--compensate-local') options.mode = 'compensate-local';
    else if (arg === '--confirm-local-ephemeral') options.confirmLocalEphemeral = true;
    else if (arg === '--confirm-empty') options.confirmEmpty = true;
    else throw new MigrationError('MIGRATION_ARGUMENT_INVALID');
  }
  return options;
}

async function openConfirmedLocalClient(options) {
  if (options.confirmLocalEphemeral !== true) {
    throw new MigrationError('MIGRATION_LOCAL_CONFIRMATION_REQUIRED');
  }
  const connectionString = process.env[MIGRATION_DATABASE_ENV];
  if (!connectionString) {
    throw new MigrationError('MIGRATION_DATABASE_ENV_MISSING');
  }
  const target = assertLocalEphemeralConnectionString(connectionString);
  const pg = await import('pg');
  const Client = pg.Client ?? pg.default?.Client;
  const client = new Client({ connectionString });
  await client.connect();
  return { client, target };
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.mode === 'plan') {
    return validateMigrationArtifacts();
  }

  if (options.mode === 'compensate-local' && options.confirmEmpty !== true) {
    throw new MigrationError('MIGRATION_EMPTY_COMPENSATION_CONFIRMATION_REQUIRED');
  }

  const { client, target } = await openConfirmedLocalClient(options);
  try {
    if (options.mode === 'apply') {
      const result = await applyMigrationWithClient(client);
      return { ...result, target, databaseConnected: true, databaseMutated: result.applied };
    }
    if (options.mode === 'verify-local') {
      const result = await verifyActionPlanExecutionSchemaWithClient(client);
      return { ...result, target, databaseConnected: true, databaseMutated: false };
    }
    if (options.mode === 'drain-status-local') {
      const result = await inspectMigrationDrainStateWithClient(client);
      return {
        ok: true,
        ...result,
        target,
        databaseConnected: true,
        databaseMutated: false,
      };
    }
    const result = await compensateMigrationWithClient(client);
    return { ...result, target, databaseConnected: true };
  } finally {
    await client.end();
  }
}

function stableFailureCode(error) {
  return error instanceof MigrationError
    ? error.code
    : 'ACTION_PLAN_EXECUTION_MIGRATION_FAILED';
}

const FAILURE_CODES_BEFORE_MUTATION = new Set([
  'MIGRATION_ARGUMENT_INVALID',
  'MIGRATION_LOCAL_CONFIRMATION_REQUIRED',
  'MIGRATION_EMPTY_COMPENSATION_CONFIRMATION_REQUIRED',
  'MIGRATION_DATABASE_ENV_MISSING',
  'MIGRATION_DATABASE_URL_INVALID',
  'MIGRATION_DATABASE_PROTOCOL_INVALID',
  'MIGRATION_DATABASE_OPTIONS_FORBIDDEN',
  'MIGRATION_DATABASE_NOT_LOOPBACK',
  'MIGRATION_DATABASE_NOT_EXPLICIT_EPHEMERAL',
  'MIGRATION_ARTIFACT_VALIDATION_FAILED',
  'MIGRATION_ADVISORY_LOCK_UNAVAILABLE',
  'MIGRATION_LEDGER_CHECKSUM_CONFLICT',
  'MIGRATION_LEDGER_PHASE_UNKNOWN',
  'MIGRATION_LEDGER_RECOVERY_PHASE_INVALID',
]);

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
    .then((result) => {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      process.exitCode = result.ok === false || result.ready === false ? 1 : 0;
    })
    .catch((error) => {
      const code = stableFailureCode(error);
      const failedBeforeMutation = FAILURE_CODES_BEFORE_MUTATION.has(code);
      process.stdout.write(`${JSON.stringify({
        ok: false,
        code,
        databaseMutated: failedBeforeMutation ? false : null,
        ...(failedBeforeMutation ? {} : { databaseMutationState: 'unknown_or_partial' }),
      }, null, 2)}\n`);
      process.exitCode = 2;
    });
}
