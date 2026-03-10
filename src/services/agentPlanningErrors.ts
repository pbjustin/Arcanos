/**
 * Shared planning-validation errors for the agent planner boundary.
 */

export type AgentPlanningValidationCode =
  | 'AGENT_BOUNDARY_VIOLATION'
  | 'AGENT_UNKNOWN_CAPABILITY'
  | 'AGENT_INVALID_AUDIT_MODE';

/**
 * Error type for planner-level validation failures.
 *
 * Purpose:
 * - Preserve a typed distinction between invalid human goals/capabilities and unexpected execution faults.
 *
 * Inputs/outputs:
 * - Input: validation code, human-readable message, and optional structured details.
 * - Output: `Error` instance with stable `code` and `details` fields.
 *
 * Edge case behavior:
 * - Defaults `details` to `null` so callers never need to branch on `undefined`.
 */
export class AgentPlanningValidationError extends Error {
  readonly code: AgentPlanningValidationCode;

  readonly details: Record<string, unknown> | null;

  constructor(
    code: AgentPlanningValidationCode,
    message: string,
    details?: Record<string, unknown>
  ) {
    super(message);
    this.name = 'AgentPlanningValidationError';
    this.code = code;
    this.details = details ?? null;
  }
}

/**
 * Detect whether a thrown value is one of the planner validation errors.
 *
 * Purpose:
 * - Let the HTTP and execution layers fail closed on rejected planner goals without relying on fragile message parsing.
 *
 * Inputs/outputs:
 * - Input: unknown thrown value.
 * - Output: boolean indicating whether the value is a typed planning validation error.
 *
 * Edge case behavior:
 * - Uses structural checks so cross-module `Error` instances still classify correctly after transpilation.
 */
export function isAgentPlanningValidationError(
  error: unknown
): error is AgentPlanningValidationError {
  if (error instanceof AgentPlanningValidationError) {
    return true;
  }

  //audit Assumption: planner validation errors may cross ESM module boundaries and lose direct prototype identity; failure risk: valid client-safe rejections degrade into 500 responses; expected invariant: objects carrying the planner validation name/code pair are still classified correctly; handling strategy: use a structural fallback after the nominal instanceof check.
  if (!error || typeof error !== 'object') {
    return false;
  }

  const candidate = error as Record<string, unknown>;
  return (
    candidate.name === 'AgentPlanningValidationError' &&
    typeof candidate.message === 'string' &&
    typeof candidate.code === 'string'
  );
}
