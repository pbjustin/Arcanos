interface ValidationSuccess<T> {
  isValid: true;
  value: T;
}

interface ValidationFailure {
  isValid: false;
  error: string;
}

export type ValidationResult<T> = ValidationSuccess<T> | ValidationFailure;

export interface RegisterPayload {
  agentId: string;
  version: string;
}

export interface HeartbeatPayload {
  agentId: string;
  state: string;
  health: number;
}

export interface GetTaskPayload {
  agentId: string;
}

export interface SubmitResultPayload {
  agentId: string;
  taskId: string;
  result: Record<string, unknown>;
}

function valid<T>(value: T): ValidationSuccess<T> {
  return { isValid: true, value };
}

function invalid(error: string): ValidationFailure {
  return { isValid: false, error };
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readNonEmptyString(
  source: Record<string, unknown>,
  fieldName: string,
  maxLength = 256
): ValidationResult<string> {
  const candidate = source[fieldName];
  //audit assumption: user-controlled fields can be arbitrary types; we validate type/shape before use.
  if (typeof candidate !== "string") {
    return invalid(`${fieldName} must be a string`);
  }

  const trimmed = candidate.trim();
  //audit invariant: persisted identifiers and states must be bounded and non-empty.
  if (trimmed.length === 0 || trimmed.length > maxLength) {
    return invalid(`${fieldName} must be between 1 and ${maxLength} characters`);
  }

  return valid(trimmed);
}

function readNumberInRange(
  source: Record<string, unknown>,
  fieldName: string,
  min: number,
  max: number
): ValidationResult<number> {
  const candidate = source[fieldName];
  //audit assumption: numeric input may include NaN/Infinity from malformed JSON parsers or coercion.
  if (typeof candidate !== "number" || !Number.isFinite(candidate)) {
    return invalid(`${fieldName} must be a finite number`);
  }

  //audit strategy: hard bounds prevent invalid health/state metrics from corrupting runtime assumptions.
  if (candidate < min || candidate > max) {
    return invalid(`${fieldName} must be between ${min} and ${max}`);
  }

  return valid(candidate);
}

/**
 * Validates a register-agent payload.
 * Input: unknown request body.
 * Output: normalized register payload on success.
 * Edge case behavior: fails when body is missing, non-object, or fields are malformed.
 */
export function validateRegisterPayload(input: unknown): ValidationResult<RegisterPayload> {
  //audit assumption: request body is untrusted and must be object-shaped before field access.
  if (!isObjectRecord(input)) {
    return invalid("Request body must be a JSON object");
  }

  const agentIdResult = readNonEmptyString(input, "agentId", 128);
  if (!agentIdResult.isValid) {
    return agentIdResult;
  }

  const versionResult = readNonEmptyString(input, "version", 64);
  if (!versionResult.isValid) {
    return versionResult;
  }

  return valid({ agentId: agentIdResult.value, version: versionResult.value });
}

/**
 * Validates a heartbeat payload.
 * Input: unknown request body.
 * Output: normalized heartbeat payload on success.
 * Edge case behavior: rejects missing agent, malformed state, and health outside [0, 1].
 */
export function validateHeartbeatPayload(input: unknown): ValidationResult<HeartbeatPayload> {
  //audit assumption: request body is untrusted and must be object-shaped before field access.
  if (!isObjectRecord(input)) {
    return invalid("Request body must be a JSON object");
  }

  const agentIdResult = readNonEmptyString(input, "agentId", 128);
  if (!agentIdResult.isValid) {
    return agentIdResult;
  }

  const stateResult = readNonEmptyString(input, "state", 64);
  if (!stateResult.isValid) {
    return stateResult;
  }

  const healthResult = readNumberInRange(input, "health", 0, 1);
  if (!healthResult.isValid) {
    return healthResult;
  }

  return valid({
    agentId: agentIdResult.value,
    state: stateResult.value,
    health: healthResult.value
  });
}

/**
 * Validates a get-task payload.
 * Input: unknown request body.
 * Output: normalized get-task payload on success.
 * Edge case behavior: rejects empty or non-string agent identifiers.
 */
export function validateGetTaskPayload(input: unknown): ValidationResult<GetTaskPayload> {
  //audit assumption: request body is untrusted and must be object-shaped before field access.
  if (!isObjectRecord(input)) {
    return invalid("Request body must be a JSON object");
  }

  const agentIdResult = readNonEmptyString(input, "agentId", 128);
  if (!agentIdResult.isValid) {
    return agentIdResult;
  }

  return valid({ agentId: agentIdResult.value });
}

/**
 * Validates a submit-result payload.
 * Input: unknown request body.
 * Output: normalized submit-result payload on success.
 * Edge case behavior: rejects malformed IDs and non-object result payloads.
 */
export function validateSubmitResultPayload(input: unknown): ValidationResult<SubmitResultPayload> {
  //audit assumption: request body is untrusted and must be object-shaped before field access.
  if (!isObjectRecord(input)) {
    return invalid("Request body must be a JSON object");
  }

  const agentIdResult = readNonEmptyString(input, "agentId", 128);
  if (!agentIdResult.isValid) {
    return agentIdResult;
  }

  const taskIdResult = readNonEmptyString(input, "taskId", 128);
  if (!taskIdResult.isValid) {
    return taskIdResult;
  }

  const resultCandidate = input.result;
  //audit invariant: task results must be JSON-object shaped for downstream persistence and querying.
  if (!isObjectRecord(resultCandidate)) {
    return invalid("result must be a JSON object");
  }

  return valid({
    agentId: agentIdResult.value,
    taskId: taskIdResult.value,
    result: resultCandidate
  });
}
