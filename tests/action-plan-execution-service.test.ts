import { describe, expect, it, jest } from '@jest/globals';
import type {
  ActionPlanExecutionActor,
  ActionPlanExecutionRepository,
  ActionPlanExecutionRunRecord,
} from '../src/core/db/repositories/actionPlanExecutionRepository.js';
import { ActionPlanExecutionService } from '../src/services/actionPlanExecution/service.js';
import {
  ACTION_PLAN_EXECUTION_ERRORS,
  ActionPlanExecutionError,
} from '../src/services/actionPlanExecution/errors.js';

const requester: ActionPlanExecutionActor = {
  role: 'requester',
  principalId: 'requester-1',
};
const executor: ActionPlanExecutionActor = {
  role: 'executor',
  principalId: 'executor-1',
  executorInstanceId: 'instance-1',
  executorAgentId: 'agent-1',
};

function executionEnv(): NodeJS.ProcessEnv {
  return {
    NODE_ENV: 'test',
    ACTION_PLAN_EXECUTION_LOCAL_REALM: 'local-test',
    ACTION_PLAN_EXECUTION_PROTOCOL_V2_ENABLED: 'true',
    ACTION_PLAN_EXECUTION_ACCEPT_COMMANDS: 'true',
    ACTION_PLAN_EXECUTION_ASSIGN_REQUESTED: 'true',
    ACTION_PLAN_EXECUTION_DRAIN_ENABLED: 'true',
    ACTION_PLAN_REQUEST_TOKEN: 'r'.repeat(40),
    ACTION_PLAN_REQUEST_PRINCIPAL_ID: requester.principalId,
    ACTION_PLAN_EXECUTOR_TOKEN: 'e'.repeat(40),
    ACTION_PLAN_EXECUTOR_PRINCIPAL_ID: executor.principalId,
    ACTION_PLAN_EXECUTOR_INSTANCE_ID: executor.executorInstanceId,
    ACTION_PLAN_EXECUTOR_AGENT_ID: executor.executorAgentId,
  };
}

function run(overrides: Partial<ActionPlanExecutionRunRecord> = {}): ActionPlanExecutionRunRecord {
  const now = '2026-07-17T12:00:00.000Z';
  return {
    id: 'run-1',
    commandId: 'command-1',
    planId: 'plan-1',
    actionId: 'action-1',
    attempt: 1,
    state: 'REQUESTED',
    executorKind: 'python-daemon',
    assignedAgentId: 'agent-1',
    assignedExecutorPrincipalId: 'executor-1',
    assignedExecutorInstanceId: 'instance-1',
    claimedExecutorPrincipalId: null,
    claimedExecutorInstanceId: null,
    executionRealm: 'local-test',
    actionSnapshotId: 'snapshot-1',
    actionSnapshotSchemaVersion: 1,
    actionSnapshot: {
      snapshot_version: 'action-execution-snapshot-v1',
      plan_id: 'plan-1',
      action_id: 'action-1',
      agent_id: 'agent-1',
      capability: 'terminal.run',
      params: { command: 'synthetic-noop' },
      timeout_ms: 1_000,
      sort_order: 0,
      plan_execution_generation: 1,
      executor_kind: 'python-daemon',
      assigned_executor_principal_id: 'executor-1',
      agent_capability_fingerprint: 'a'.repeat(64),
    },
    claimIdempotencyKeyHash: null,
    claimFingerprint: null,
    startIdempotencyKeyHash: null,
    startFingerprint: null,
    resultIdempotencyKeyHash: null,
    resultFingerprint: null,
    policyCategory: 'ALLOW',
    policyEvidenceId: `clear-recheck-v1:${'a'.repeat(64)}`,
    policyEvaluatedAt: now,
    acceptanceReceipt: null,
    terminalCategory: null,
    resultOutput: null,
    resultError: null,
    eventSequence: 0,
    version: 0,
    requestedAt: now,
    claimedAt: null,
    startedAt: null,
    completedAt: null,
    cancelledAt: null,
    expiredAt: null,
    supersededAt: null,
    updatedAt: now,
    ...overrides,
  };
}

function readySchema() {
  return Promise.resolve({
    ready: true,
    code: 'ACTION_PLAN_EXECUTION_SCHEMA_READY' as const,
    version: '20260717_action_plan_execution_v2',
    schemaLabel: 'action-plan-execution-v1',
    protocolVersion: 2,
    snapshotSchemaVersion: 1,
    checksum: '0'.repeat(64),
    issues: [],
  });
}

function repository(overrides: Partial<ActionPlanExecutionRepository> = {}) {
  return {
    requestExecution: jest.fn(async () => ({
      disposition: 'created' as const,
      commandId: 'command-1',
      planId: 'plan-1',
      runs: [run()],
    })),
    replayExecution: jest.fn(async () => null),
    claimExecution: jest.fn(async () => null),
    startExecution: jest.fn(async () => ({ disposition: 'accepted' as const, run: run({ state: 'RUNNING' }) })),
    submitResult: jest.fn(async () => ({
      disposition: 'accepted' as const,
      run: run({
        state: 'SUCCEEDED',
        terminalCategory: 'SUCCEEDED',
        acceptanceReceipt: 'receipt-1',
        completedAt: '2026-07-17T12:01:00.000Z',
        resultOutput: { ok: true },
      }),
    })),
    readExecution: jest.fn(async () => ({
      command: {},
      run: run(),
    })),
    ...overrides,
  } as unknown as ActionPlanExecutionRepository;
}

function service(repo: ActionPlanExecutionRepository) {
  return new ActionPlanExecutionService({
    repository: repo,
    env: executionEnv(),
    verifySchema: readySchema,
  });
}

function serviceWithEnv(repo: ActionPlanExecutionRepository, env: NodeJS.ProcessEnv) {
  return new ActionPlanExecutionService({ repository: repo, env, verifySchema: readySchema });
}

const context = { sourceService: 'web' as const, requestId: 'request-1', traceId: 'trace-1' };
const policyExpectation = {
  decision: 'allow' as const,
  overall: 0.9,
  planExecutionGeneration: 1,
};

describe('Phase 2E ActionPlan execution service decisions', () => {
  it('maps one authoritative repository run without fabricating a legacy result or sibling run', async () => {
    const repo = repository();

    const response = await service(repo).requestExecution({
      planId: 'plan-1',
      actor: requester,
      idempotencyKey: 'command-key-1',
      policyExpectation,
      context,
    });

    expect(response).toMatchObject({
      ok: true,
      code: 'ACTION_PLAN_EXECUTION_COMMAND_ACCEPTED',
      command_id: 'command-1',
      plan_id: 'plan-1',
      disposition: 'COMMAND_CREATED',
      runs: [{ run_id: 'run-1', action_id: 'action-1', state: 'REQUESTED' }],
    });
    expect(response.runs).toHaveLength(1);
    expect(repo.requestExecution).toHaveBeenCalledTimes(1);
    expect(repo.claimExecution).not.toHaveBeenCalled();
    expect(repo.startExecution).not.toHaveBeenCalled();
    expect(repo.submitResult).not.toHaveBeenCalled();
    expect(JSON.stringify(response)).not.toContain('ExecutionResult');
    expect(JSON.stringify(response)).not.toContain('success records');
  });

  it('preserves command replay and idempotency conflict semantics from the authority repository', async () => {
    const replayRepo = repository({
      requestExecution: jest.fn(async () => ({
        disposition: 'idempotent-replay' as const,
        commandId: 'command-1',
        planId: 'plan-1',
        runs: [run()],
      })),
    });
    await expect(service(replayRepo).requestExecution({
      planId: 'plan-1', actor: requester, idempotencyKey: 'same-key', policyExpectation, context,
    })).resolves.toMatchObject({ disposition: 'COMMAND_REPLAY', command_id: 'command-1' });

    const conflictRepo = repository({
      requestExecution: jest.fn(async () => {
        throw new ActionPlanExecutionError(ACTION_PLAN_EXECUTION_ERRORS.commandIdempotencyConflict);
      }),
    });
    await expect(service(conflictRepo).requestExecution({
      planId: 'plan-1', actor: requester, idempotencyKey: 'conflicting-key', policyExpectation, context,
    })).rejects.toMatchObject({ code: 'ACTION_PLAN_EXECUTION_IDEMPOTENCY_CONFLICT' });
  });

  it('maps a committed replay without creating a command and returns null when the key is unknown', async () => {
    const replayRepo = repository({
      replayExecution: jest.fn(async () => ({
        disposition: 'idempotent-replay' as const,
        commandId: 'command-1',
        planId: 'plan-1',
        runs: [run({ state: 'SUCCEEDED' })],
      })),
    });
    await expect(service(replayRepo).replayExecution({
      planId: 'plan-1', actor: requester, idempotencyKey: 'same-key', context,
    })).resolves.toMatchObject({ disposition: 'COMMAND_REPLAY', command_id: 'command-1' });
    expect(replayRepo.requestExecution).not.toHaveBeenCalled();

    const missingRepo = repository();
    await expect(service(missingRepo).replayExecution({
      planId: 'plan-1', actor: requester, idempotencyKey: 'unknown-key', context,
    })).resolves.toBeNull();
    expect(missingRepo.requestExecution).not.toHaveBeenCalled();
  });

  it('allows exact same-owner CLAIMED recovery while assignment is disabled and drain remains enabled', async () => {
    const claimedRun = run({
      state: 'CLAIMED',
      claimedExecutorPrincipalId: 'executor-1',
      claimedExecutorInstanceId: 'instance-1',
      claimedAt: '2026-07-17T12:00:01.000Z',
    });
    const repo = repository({
      claimExecution: jest.fn(async () => ({
        disposition: 'idempotent-replay' as const,
        run: claimedRun,
        assignmentAvailable: true,
        planExecutionGeneration: 1,
        lifecycleStatus: 'approved' as const,
        expiresAt: null,
      })),
    });
    const env = { ...executionEnv(), ACTION_PLAN_EXECUTION_ASSIGN_REQUESTED: 'false' };

    const response = await serviceWithEnv(repo, env).claimExecution({
      planId: 'plan-1', runId: 'run-1', actor: executor,
      idempotencyKey: 'claim-key-1', context,
    });

    expect(response).toMatchObject({ disposition: 'CLAIM_REPLAY_NOT_STARTED', state: 'CLAIMED' });
    expect(repo.claimExecution).toHaveBeenCalledWith(expect.objectContaining({
      planId: 'plan-1', runId: 'run-1', recoveryOnly: true, realm: 'local-test',
    }));
  });

  it.each([
    ['succeeded', 'SUCCEEDED', { output: { value: 1 } }, undefined],
    ['failed', 'FAILED', undefined, { code: 'SYNTHETIC_FAILURE' }],
  ] as const)('keeps an accepted %s result bound to one run and action', async (outcome, state, output, error) => {
    const terminal = run({
      state,
      terminalCategory: state,
      acceptanceReceipt: 'receipt-1',
      completedAt: '2026-07-17T12:01:00.000Z',
      resultOutput: output ?? null,
      resultError: error ?? null,
    });
    const repo = repository({
      submitResult: jest.fn(async () => ({ disposition: 'accepted' as const, run: terminal })),
    });

    const response = await service(repo).submitResult({
      planId: 'plan-1',
      runId: 'run-1',
      actionId: 'action-1',
      snapshotId: 'snapshot-1',
      actor: executor,
      idempotencyKey: 'result-key-1',
      outcome,
      ...(output === undefined ? {} : { output }),
      ...(error === undefined ? {} : { error }),
      context,
    });

    expect(response).toMatchObject({
      plan_id: 'plan-1',
      run_id: 'run-1',
      action_id: 'action-1',
      state,
      disposition: 'RESULT_ACCEPTED',
    });
    expect(repo.submitResult).toHaveBeenCalledTimes(1);
    expect(repo.requestExecution).not.toHaveBeenCalled();
    expect(repo.claimExecution).not.toHaveBeenCalled();
    expect(repo.startExecution).not.toHaveBeenCalled();
  });

  it('rejects contradictory success/error and failure/output before authoritative persistence', async () => {
    const repo = repository();
    const base = {
      planId: 'plan-1', runId: 'run-1', actionId: 'action-1', snapshotId: 'snapshot-1',
      actor: executor, idempotencyKey: 'result-key-1', context,
    };

    await expect(service(repo).submitResult({
      ...base, outcome: 'succeeded', output: { ok: true }, error: { code: 'CONTRADICTION' },
    })).rejects.toMatchObject({ code: 'ACTION_PLAN_EXECUTION_REQUEST_INVALID' });
    await expect(service(repo).submitResult({
      ...base, outcome: 'failed', output: { impossible: true }, error: { code: 'FAILED' },
    })).rejects.toMatchObject({ code: 'ACTION_PLAN_EXECUTION_REQUEST_INVALID' });
    expect(repo.submitResult).not.toHaveBeenCalled();
  });

  it('returns an idempotent result replay without creating another effect', async () => {
    const repo = repository({
      submitResult: jest.fn(async () => ({
        disposition: 'idempotent-replay' as const,
        run: run({
          state: 'FAILED',
          terminalCategory: 'FAILED',
          acceptanceReceipt: 'receipt-original',
          completedAt: '2026-07-17T12:01:00.000Z',
          resultError: { code: 'SYNTHETIC_FAILURE' },
        }),
      })),
    });
    await expect(service(repo).submitResult({
      planId: 'plan-1', runId: 'run-1', actionId: 'action-1', snapshotId: 'snapshot-1',
      actor: executor, idempotencyKey: 'retry-after-response-loss', outcome: 'failed',
      error: { code: 'SYNTHETIC_FAILURE' }, context,
    })).resolves.toMatchObject({
      state: 'FAILED', disposition: 'RESULT_REPLAY', acceptance_receipt: 'receipt-original',
    });
    expect(repo.submitResult).toHaveBeenCalledTimes(1);
  });

  it('fails closed before repository access when the feature gate, realm, or schema is unavailable', async () => {
    const repo = repository();
    const disabled = new ActionPlanExecutionService({
      repository: repo,
      env: { ...executionEnv(), ACTION_PLAN_EXECUTION_ACCEPT_COMMANDS: 'false' },
      verifySchema: readySchema,
    });
    await expect(disabled.requestExecution({
      planId: 'plan-1', actor: requester, idempotencyKey: 'key', policyExpectation, context,
    })).rejects.toMatchObject({ code: 'ACTION_PLAN_EXECUTION_PROTOCOL_DISABLED' });

    const noRealm = new ActionPlanExecutionService({
      repository: repo,
      env: { ...executionEnv(), ACTION_PLAN_EXECUTION_LOCAL_REALM: undefined },
      verifySchema: readySchema,
    });
    await expect(noRealm.requestExecution({
      planId: 'plan-1', actor: requester, idempotencyKey: 'key', policyExpectation, context,
    })).rejects.toMatchObject({ code: 'ACTION_PLAN_REALM_UNAVAILABLE' });

    const noSchema = new ActionPlanExecutionService({
      repository: repo,
      env: executionEnv(),
      verifySchema: async () => ({ ...(await readySchema()), ready: false, code: 'ACTION_PLAN_EXECUTION_SCHEMA_INVALID' }),
    });
    await expect(noSchema.requestExecution({
      planId: 'plan-1', actor: requester, idempotencyKey: 'key', policyExpectation, context,
    })).rejects.toMatchObject({ code: 'ACTION_PLAN_EXECUTION_PROTOCOL_DISABLED' });
    expect(repo.requestExecution).not.toHaveBeenCalled();
  });
});
