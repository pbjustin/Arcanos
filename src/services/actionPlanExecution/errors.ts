export const ACTION_PLAN_EXECUTION_ERRORS = {
  protocolDisabled: [503, 'ACTION_PLAN_EXECUTION_PROTOCOL_DISABLED', 'ActionPlan execution protocol is unavailable.'],
  resultEndpointRequired: [409, 'ACTION_PLAN_RESULT_ENDPOINT_REQUIRED', 'Use the dedicated ActionPlan execution result endpoint.'],
  requestInvalid: [400, 'ACTION_PLAN_EXECUTION_REQUEST_INVALID', 'ActionPlan execution request is invalid.'],
  executorUnavailable: [409, 'ACTION_PLAN_EXECUTOR_UNAVAILABLE', 'No authorized executor is available for this ActionPlan.'],
  realmUnavailable: [503, 'ACTION_PLAN_REALM_UNAVAILABLE', 'ActionPlan execution realm is unavailable.'],
  provenanceUnavailable: [409, 'ACTION_PLAN_PROVENANCE_UNAVAILABLE', 'ActionPlan execution provenance is unavailable.'],
  legacyStateUnresolved: [409, 'ACTION_PLAN_LEGACY_EXECUTION_STATE_UNRESOLVED', 'Legacy ActionPlan execution evidence must be resolved first.'],
  legacyResultUnavailable: [409, 'ACTION_PLAN_LEGACY_RESULT_VIEW_UNAVAILABLE', 'Use the authoritative ActionPlan execution result endpoint.'],
  active: [409, 'ACTION_PLAN_EXECUTION_ACTIVE', 'An ActionPlan execution attempt is already active.'],
  commandIdempotencyConflict: [409, 'ACTION_PLAN_EXECUTION_IDEMPOTENCY_CONFLICT', 'ActionPlan execution idempotency key conflicts with an existing request.'],
  notFound: [404, 'ACTION_PLAN_EXECUTION_NOT_FOUND', 'ActionPlan execution was not found.'],
  claimConflict: [409, 'ACTION_PLAN_EXECUTION_CLAIM_CONFLICT', 'ActionPlan execution claim conflicts with its current owner.'],
  stateConflict: [409, 'ACTION_PLAN_EXECUTION_STATE_CONFLICT', 'ActionPlan execution state does not permit this operation.'],
  generationConflict: [409, 'ACTION_PLAN_EXECUTION_GENERATION_CONFLICT', 'ActionPlan execution evidence is stale.'],
  snapshotUnavailable: [422, 'ACTION_PLAN_ACTION_SNAPSHOT_UNAVAILABLE', 'A safe ActionPlan action snapshot could not be created.'],
  snapshotConflict: [409, 'ACTION_PLAN_ACTION_SNAPSHOT_CONFLICT', 'ActionPlan action snapshot does not match the authorized execution.'],
  resultIdempotencyConflict: [409, 'ACTION_PLAN_RESULT_IDEMPOTENCY_CONFLICT', 'ActionPlan result conflicts with previously accepted evidence.'],
  persistenceFailed: [503, 'ACTION_PLAN_EXECUTION_PERSISTENCE_FAILED', 'ActionPlan execution persistence is unavailable.'],
  incompatible: [409, 'ACTION_PLAN_EXECUTION_PROTOCOL_INCOMPATIBLE', 'ActionPlan execution protocol is incompatible.'],
} as const;

type ErrorDefinition = typeof ACTION_PLAN_EXECUTION_ERRORS[keyof typeof ACTION_PLAN_EXECUTION_ERRORS];

export class ActionPlanExecutionError extends Error {
  readonly httpStatus: number;
  readonly code: ErrorDefinition[1];
  readonly retryable: boolean;

  constructor(definition: ErrorDefinition, options: { retryable?: boolean; cause?: unknown } = {}) {
    super(definition[2], options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'ActionPlanExecutionError';
    this.httpStatus = definition[0];
    this.code = definition[1];
    this.retryable = options.retryable ?? definition[0] >= 500;
  }
}

export function isActionPlanExecutionError(error: unknown): error is ActionPlanExecutionError {
  return error instanceof ActionPlanExecutionError;
}
