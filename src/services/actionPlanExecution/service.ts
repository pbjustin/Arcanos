import {
  ACTION_PLAN_EXECUTION_PROTOCOL_VERSION,
  ACTION_PLAN_EXECUTION_SNAPSHOT_VERSION,
} from '@shared/types/actionPlanExecution.js';
import {
  getActionPlanExecutionRepository,
  type ActionPlanExecutionActor,
  type ActionPlanExecutionClaimResult,
  type ActionPlanExecutionCommandResult,
  type ActionPlanExecutionRepository,
  type ActionPlanExecutionRunRecord,
  type SubmitActionPlanExecutionResultInput,
} from '@core/db/repositories/actionPlanExecutionRepository.js';
import {
  verifyConfiguredActionPlanExecutionSchema,
  type ActionPlanExecutionSchemaVerification,
} from '@core/db/actionPlanExecutionSchema.js';
import {
  readActionPlanSnapshotSensitiveValues,
  resolveActionPlanExecutorServerBinding,
} from './auth.js';
import { deriveActionPlanExecutionRealm } from './realm.js';
import { resolveActionPlanExecutionRuntimeControls } from './runtime.js';
import { ACTION_PLAN_EXECUTION_ERRORS, ActionPlanExecutionError } from './errors.js';

interface ServiceDependencies {
  repository?: ActionPlanExecutionRepository;
  verifySchema?: () => Promise<ActionPlanExecutionSchemaVerification>;
  env?: NodeJS.ProcessEnv;
}

export interface ExecutionOperationContext {
  requestId?: string;
  traceId?: string;
  sourceService: 'web' | 'mcp' | 'python-daemon';
}

function iso(value: Date | string | null): string | null {
  if (value === null) return null;
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) {
    throw new ActionPlanExecutionError(ACTION_PLAN_EXECUTION_ERRORS.persistenceFailed);
  }
  return date.toISOString();
}

function runLocations(planId: string, runId: string) {
  const statusLocation = `/plans/${encodeURIComponent(planId)}/executions/${encodeURIComponent(runId)}`;
  return {
    status_location: statusLocation,
    result_location: `${statusLocation}/result`,
  };
}

function commandRun(run: ActionPlanExecutionRunRecord) {
  return {
    run_id: run.id,
    action_id: run.actionId,
    state: run.state,
    ...runLocations(run.planId, run.id),
  };
}

function assignment(run: ActionPlanExecutionRunRecord) {
  const snapshot = run.actionSnapshot;
  return {
    agent_id: snapshot.agent_id,
    capability: snapshot.capability,
    params: snapshot.params,
    timeout_ms: snapshot.timeout_ms,
    ...(snapshot.rollback_action === undefined ? {} : { rollback_action: snapshot.rollback_action }),
  };
}

function statusPayload(run: ActionPlanExecutionRunRecord) {
  const resultLocation = run.state === 'SUCCEEDED' || run.state === 'FAILED'
    ? runLocations(run.planId, run.id).result_location
    : null;
  return {
    ok: true as const,
    code: 'ACTION_PLAN_EXECUTION_STATUS' as const,
    protocol_version: ACTION_PLAN_EXECUTION_PROTOCOL_VERSION,
    execution_realm: run.executionRealm,
    command_id: run.commandId,
    plan_id: run.planId,
    run_id: run.id,
    action_id: run.actionId,
    snapshot_id: run.actionSnapshotId,
    state: run.state,
    terminal_category: run.terminalCategory ? run.terminalCategory.toLowerCase() : null,
    disposition: 'STATUS_CURRENT' as const,
    timestamps: {
      requested_at: iso(run.requestedAt),
      claimed_at: iso(run.claimedAt),
      started_at: iso(run.startedAt),
      completed_at: iso(run.completedAt),
      cancelled_at: iso(run.cancelledAt),
      expired_at: iso(run.expiredAt),
      superseded_at: iso(run.supersededAt),
    },
    acceptance_receipt: run.acceptanceReceipt,
    result_location: resultLocation,
  };
}

export class ActionPlanExecutionService {
  private readonly env: NodeJS.ProcessEnv;
  private readonly verifySchema: () => Promise<ActionPlanExecutionSchemaVerification>;

  constructor(private readonly dependencies: ServiceDependencies = {}) {
    this.env = dependencies.env ?? process.env;
    this.verifySchema = dependencies.verifySchema ?? verifyConfiguredActionPlanExecutionSchema;
  }

  private async ready(operation: 'command' | 'assignment' | 'drain' | 'read'): Promise<{
    realm: string;
    repository: ActionPlanExecutionRepository;
  }> {
    const controls = resolveActionPlanExecutionRuntimeControls(this.env);
    const controlAllowed = controls.protocolEnabled && (
      operation === 'command' ? controls.acceptCommands
        : operation === 'assignment' ? controls.assignRequested
          : operation === 'drain' ? controls.drainEnabled
            : controls.drainEnabled || controls.assignRequested || controls.acceptCommands
    );
    if (!controlAllowed) {
      throw new ActionPlanExecutionError(ACTION_PLAN_EXECUTION_ERRORS.protocolDisabled);
    }
    const realm = deriveActionPlanExecutionRealm(this.env);
    if (!realm) throw new ActionPlanExecutionError(ACTION_PLAN_EXECUTION_ERRORS.realmUnavailable);
    const verification = await this.verifySchema();
    if (!verification.ready) {
      throw new ActionPlanExecutionError(ACTION_PLAN_EXECUTION_ERRORS.protocolDisabled);
    }
    return { realm, repository: this.dependencies.repository ?? getActionPlanExecutionRepository() };
  }

  async capability(actor: ActionPlanExecutionActor) {
    const { realm } = await this.ready('read');
    const controls = resolveActionPlanExecutionRuntimeControls(this.env);
    const executor = resolveActionPlanExecutorServerBinding(this.env);
    const operations = actor.role === 'executor'
      ? [
        ...(controls.assignRequested ? ['claim-next'] as const : []),
        ...((controls.assignRequested || controls.drainEnabled) ? ['claim'] as const : []),
        ...(controls.drainEnabled ? ['start', 'submit-result', 'read-status', 'read-result'] as const : []),
      ]
      : [
        ...(controls.acceptCommands ? ['request-execution'] as const : []),
        ...((controls.acceptCommands || controls.drainEnabled) ? ['read-status', 'read-result'] as const : []),
      ];
    if (operations.length === 0 || (actor.role === 'executor' && !executor)) {
      throw new ActionPlanExecutionError(ACTION_PLAN_EXECUTION_ERRORS.protocolDisabled);
    }
    return {
      ok: true as const,
      code: 'ACTION_PLAN_EXECUTION_PROTOCOL_AVAILABLE' as const,
      protocol_version: ACTION_PLAN_EXECUTION_PROTOCOL_VERSION,
      execution_realm: realm,
      role: actor.role,
      ...(actor.role === 'executor' && executor ? {
        executor_principal_id: executor.principalId,
        executor_instance_id: executor.instanceId,
        assigned_agent_id: executor.agentId,
      } : {}),
      operations,
      schema_versions: {
        command: 'action-plan-execution-command-v1' as const,
        claim: 'action-plan-execution-claim-v1' as const,
        start: 'action-plan-execution-start-v1' as const,
        result: 'action-plan-execution-result-v1' as const,
        status: 'action-plan-execution-status-v1' as const,
        result_read: 'action-plan-execution-result-read-v1' as const,
      },
      locations: {
        ...(actor.role === 'requester' || actor.role === 'operator'
          ? { execute_template: '/plans/{planId}/execute' }
          : {}),
        ...(actor.role === 'executor' ? {
          claim_next: '/action-plan-executions/claim-next',
          claim_template: '/plans/{planId}/executions/{runId}/claim',
          start_template: '/plans/{planId}/executions/{runId}/start',
        } : {}),
        status_template: '/plans/{planId}/executions/{runId}',
        result_template: '/plans/{planId}/executions/{runId}/result',
      },
    };
  }

  async requestExecution(input: {
    planId: string;
    actor: ActionPlanExecutionActor;
    idempotencyKey: string;
    policyExpectation: {
      decision: 'allow' | 'confirm';
      overall: number | null;
      planExecutionGeneration: number;
    };
    context: ExecutionOperationContext;
  }) {
    const { realm, repository } = await this.ready('command');
    const executor = resolveActionPlanExecutorServerBinding(this.env);
    if (!executor) throw new ActionPlanExecutionError(ACTION_PLAN_EXECUTION_ERRORS.executorUnavailable);
    const result = await repository.requestExecution({
      ...input,
      realm,
      executor,
      sensitiveValues: readActionPlanSnapshotSensitiveValues(this.env),
    });
    return this.commandResponse(result);
  }

  async replayExecution(input: {
    planId: string;
    actor: ActionPlanExecutionActor;
    idempotencyKey: string;
    context: ExecutionOperationContext;
  }) {
    const { realm, repository } = await this.ready('read');
    const executor = resolveActionPlanExecutorServerBinding(this.env);
    if (!executor) throw new ActionPlanExecutionError(ACTION_PLAN_EXECUTION_ERRORS.executorUnavailable);
    const result = await repository.replayExecution({
      ...input,
      realm,
      executor,
      sensitiveValues: readActionPlanSnapshotSensitiveValues(this.env),
    });
    return result ? this.commandResponse(result) : null;
  }

  private commandResponse(result: ActionPlanExecutionCommandResult) {
    return {
      ok: true as const,
      code: 'ACTION_PLAN_EXECUTION_COMMAND_ACCEPTED' as const,
      protocol_version: ACTION_PLAN_EXECUTION_PROTOCOL_VERSION,
      command_id: result.commandId,
      plan_id: result.planId,
      disposition: result.disposition === 'created' ? 'COMMAND_CREATED' as const : 'COMMAND_REPLAY' as const,
      runs: result.runs.map(commandRun),
    };
  }

  async claimExecution(input: {
    planId?: string;
    runId?: string;
    actor: ActionPlanExecutionActor;
    idempotencyKey: string;
    context: ExecutionOperationContext;
  }) {
    const exactClaim = input.planId !== undefined && input.runId !== undefined;
    const controls = resolveActionPlanExecutionRuntimeControls(this.env);
    const recoveryOnly = exactClaim && !controls.assignRequested;
    const { realm, repository } = await this.ready(recoveryOnly ? 'drain' : 'assignment');
    const claimed = await repository.claimExecution({ ...input, realm, recoveryOnly });
    if (!claimed) return null;
    return this.claimResponse(claimed);
  }

  private claimResponse(claimed: ActionPlanExecutionClaimResult) {
    const run = claimed.run;
    const disposition = claimed.disposition === 'claimed'
      ? 'CLAIMED' as const
      : claimed.assignmentAvailable
        ? 'CLAIM_REPLAY_NOT_STARTED' as const
        : run.state === 'RUNNING'
          ? 'CLAIM_RECOVERY_RUNNING' as const
          : 'CLAIM_RECOVERY_TERMINAL' as const;
    return {
      ok: true as const,
      code: 'ACTION_PLAN_EXECUTION_CLAIMED' as const,
      protocol_version: ACTION_PLAN_EXECUTION_PROTOCOL_VERSION,
      execution_realm: run.executionRealm,
      command_id: run.commandId,
      plan_id: run.planId,
      run_id: run.id,
      action_id: run.actionId,
      snapshot_id: run.actionSnapshotId,
      snapshot_version: ACTION_PLAN_EXECUTION_SNAPSHOT_VERSION,
      state: run.state,
      disposition,
      ...(claimed.assignmentAvailable ? { assignment: assignment(run) } : {}),
      plan_execution_generation: claimed.planExecutionGeneration,
      lifecycle: {
        status: claimed.lifecycleStatus,
        expires_at: iso(claimed.expiresAt),
      },
      policy: {
        category: run.policyCategory,
        evidence_id: run.policyEvidenceId,
        evaluated_at: iso(run.policyEvaluatedAt),
      },
      ...runLocations(run.planId, run.id),
    };
  }

  async startExecution(input: {
    planId: string;
    runId: string;
    actor: ActionPlanExecutionActor;
    idempotencyKey: string;
    context: ExecutionOperationContext;
  }) {
    const { realm, repository } = await this.ready('drain');
    const result = await repository.startExecution({ ...input, realm });
    return {
      ok: true as const,
      code: 'ACTION_PLAN_EXECUTION_STARTED' as const,
      protocol_version: ACTION_PLAN_EXECUTION_PROTOCOL_VERSION,
      execution_realm: result.run.executionRealm,
      plan_id: result.run.planId,
      run_id: result.run.id,
      action_id: result.run.actionId,
      state: 'RUNNING' as const,
      disposition: result.disposition === 'accepted' ? 'STARTED' as const : 'START_REPLAY' as const,
      status_location: runLocations(result.run.planId, result.run.id).status_location,
    };
  }

  async submitResult(input: Omit<SubmitActionPlanExecutionResultInput, 'realm'>) {
    const { realm, repository } = await this.ready('drain');
    if (input.outcome === 'succeeded' && input.error !== undefined) {
      throw new ActionPlanExecutionError(ACTION_PLAN_EXECUTION_ERRORS.requestInvalid);
    }
    if (input.outcome === 'failed' && input.output !== undefined) {
      throw new ActionPlanExecutionError(ACTION_PLAN_EXECUTION_ERRORS.requestInvalid);
    }
    const result = await repository.submitResult({ ...input, realm });
    const run = result.run;
    return {
      ok: true as const,
      code: 'ACTION_PLAN_EXECUTION_RESULT_ACCEPTED' as const,
      protocol_version: ACTION_PLAN_EXECUTION_PROTOCOL_VERSION,
      execution_realm: run.executionRealm,
      plan_id: run.planId,
      run_id: run.id,
      action_id: run.actionId,
      snapshot_id: run.actionSnapshotId,
      state: run.state as 'SUCCEEDED' | 'FAILED',
      terminal_category: run.state === 'SUCCEEDED' ? 'succeeded' as const : 'failed' as const,
      disposition: result.disposition === 'accepted' ? 'RESULT_ACCEPTED' as const : 'RESULT_REPLAY' as const,
      acceptance_receipt: run.acceptanceReceipt!,
      ...runLocations(run.planId, run.id),
    };
  }

  async readStatus(input: {
    planId: string;
    runId: string;
    actor: ActionPlanExecutionActor;
  }) {
    const { realm, repository } = await this.ready('read');
    const { run } = await repository.readExecution({ ...input, realm });
    return statusPayload(run);
  }

  async readResult(input: {
    planId: string;
    runId: string;
    actor: ActionPlanExecutionActor;
  }) {
    const { realm, repository } = await this.ready('read');
    const { run } = await repository.readExecution({ ...input, realm });
    if ((run.state !== 'SUCCEEDED' && run.state !== 'FAILED') || !run.acceptanceReceipt) {
      throw new ActionPlanExecutionError(ACTION_PLAN_EXECUTION_ERRORS.stateConflict);
    }
    return {
      ok: true as const,
      code: 'ACTION_PLAN_EXECUTION_RESULT' as const,
      protocol_version: ACTION_PLAN_EXECUTION_PROTOCOL_VERSION,
      execution_realm: run.executionRealm,
      plan_id: run.planId,
      run_id: run.id,
      action_id: run.actionId,
      snapshot_id: run.actionSnapshotId,
      state: run.state,
      terminal_category: run.state === 'SUCCEEDED' ? 'succeeded' as const : 'failed' as const,
      outcome: run.state === 'SUCCEEDED' ? 'succeeded' as const : 'failed' as const,
      ...(run.resultOutput === null ? {} : { output: run.resultOutput }),
      ...(run.resultError === null ? {} : { error: run.resultError }),
      acceptance_receipt: run.acceptanceReceipt,
    };
  }
}

export function createActionPlanExecutionService(
  dependencies: ServiceDependencies = {},
): ActionPlanExecutionService {
  return new ActionPlanExecutionService(dependencies);
}
