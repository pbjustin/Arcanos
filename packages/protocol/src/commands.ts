/**
 * Lists every protocol-visible command identifier in Arcanos Protocol v1.
 * Inputs: none.
 * Outputs: readonly command identifier arrays for validation and discovery.
 * Edge cases: unimplemented commands still remain listed so clients can reason about forward-compatible surfaces.
 */
export const ARCANOS_PROTOCOL_COMMAND_IDS = [
  "task.create",
  "plan.generate",
  "exec.start",
  "exec.status",
  "exec.resume",
  "patch.create",
  "patch.apply",
  "run.start",
  "context.inspect",
  "daemon.capabilities",
  "tool.registry",
  "tool.describe",
  "tool.invoke",
  "event.stream",
  "artifact.store",
  "artifact.fetch",
  "state.snapshot"
] as const;

/**
 * Lists the command identifiers that have concrete request and response schemas in the initial scaffold.
 * Inputs: none.
 * Outputs: readonly command identifier array.
 * Edge cases: callers should treat commands outside this list as unsupported until a matching schema exists.
 */
export const ARCANOS_PROTOCOL_IMPLEMENTED_COMMAND_IDS = [
  "artifact.store",
  "context.inspect",
  "daemon.capabilities",
  "tool.registry",
  "tool.describe",
  "tool.invoke",
  "exec.start",
  "exec.status",
  "state.snapshot"
] as const;
