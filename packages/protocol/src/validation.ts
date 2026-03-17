import { createRequire } from "node:module";
import type { AnySchema, ErrorObject, ValidateFunction } from "ajv";

import { ARCANOS_PROTOCOL_IMPLEMENTED_COMMAND_IDS } from "./commands.js";
import { ARCANOS_PROTOCOL_VERSION } from "./constants.js";
import { getProtocolSchemaCatalog } from "./schemaCatalog.js";
import type {
  ArtifactStoreResponseData,
  ContextInspectResponseData,
  DaemonCapabilitiesResponseData,
  ExecStartResponseData,
  ExecStatusResponseData,
  ImplementedProtocolCommandId,
  ProtocolCommandId,
  ProtocolRequest,
  ProtocolResponse,
  StateSnapshotResponseData,
  ToolDescribeResponseData,
  ToolInvokeResponseData,
  ToolRegistryResponseData,
  ValidationIssue,
  ValidationResult
} from "./types.js";

const schemaCatalog = getProtocolSchemaCatalog();
const require = createRequire(import.meta.url);
const AjvConstructor = require("ajv/dist/2020").default as typeof import("ajv").default;
const sharedSchemas: AnySchema[] = [
  schemaCatalog.envelope,
  ...Object.values(schemaCatalog.nouns),
  schemaCatalog.commands.artifactStore.request,
  schemaCatalog.commands.artifactStore.response,
  schemaCatalog.commands.contextInspect.request,
  schemaCatalog.commands.contextInspect.response,
  schemaCatalog.commands.daemonCapabilities.request,
  schemaCatalog.commands.daemonCapabilities.response,
  schemaCatalog.commands.execStart.request,
  schemaCatalog.commands.execStart.response,
  schemaCatalog.commands.execStatus.request,
  schemaCatalog.commands.execStatus.response,
  schemaCatalog.commands.stateSnapshot.request,
  schemaCatalog.commands.stateSnapshot.response,
  schemaCatalog.commands.toolDescribe.request,
  schemaCatalog.commands.toolDescribe.response,
  schemaCatalog.commands.toolInvoke.request,
  schemaCatalog.commands.toolInvoke.response,
  schemaCatalog.commands.toolRegistry.request,
  schemaCatalog.commands.toolRegistry.response,
  schemaCatalog.tools.repoList.input,
  schemaCatalog.tools.repoList.output,
  schemaCatalog.tools["repo.listTree"].input,
  schemaCatalog.tools["repo.listTree"].output,
  schemaCatalog.tools["repo.getDiff"].input,
  schemaCatalog.tools["repo.getDiff"].output,
  schemaCatalog.tools["repo.getLog"].input,
  schemaCatalog.tools["repo.getLog"].output,
  schemaCatalog.tools["repo.getStatus"].input,
  schemaCatalog.tools["repo.getStatus"].output,
  schemaCatalog.tools.repoReadFile.input,
  schemaCatalog.tools.repoReadFile.output,
  schemaCatalog.tools["repo.readFile"].input,
  schemaCatalog.tools["repo.readFile"].output,
  schemaCatalog.tools["repo.search"].input,
  schemaCatalog.tools["repo.search"].output
];

const commandRequestSchemas: Record<ImplementedProtocolCommandId, AnySchema> = {
  "artifact.store": schemaCatalog.commands.artifactStore.request,
  "context.inspect": schemaCatalog.commands.contextInspect.request,
  "daemon.capabilities": schemaCatalog.commands.daemonCapabilities.request,
  "exec.start": schemaCatalog.commands.execStart.request,
  "exec.status": schemaCatalog.commands.execStatus.request,
  "state.snapshot": schemaCatalog.commands.stateSnapshot.request,
  "tool.describe": schemaCatalog.commands.toolDescribe.request,
  "tool.invoke": schemaCatalog.commands.toolInvoke.request,
  "tool.registry": schemaCatalog.commands.toolRegistry.request
};

const commandResponseSchemas: Record<ImplementedProtocolCommandId, AnySchema> = {
  "artifact.store": schemaCatalog.commands.artifactStore.response,
  "context.inspect": schemaCatalog.commands.contextInspect.response,
  "daemon.capabilities": schemaCatalog.commands.daemonCapabilities.response,
  "exec.start": schemaCatalog.commands.execStart.response,
  "exec.status": schemaCatalog.commands.execStatus.response,
  "state.snapshot": schemaCatalog.commands.stateSnapshot.response,
  "tool.describe": schemaCatalog.commands.toolDescribe.response,
  "tool.invoke": schemaCatalog.commands.toolInvoke.response,
  "tool.registry": schemaCatalog.commands.toolRegistry.response
};

const protocolAjv = createProtocolAjv();
const requestEnvelopeValidator = protocolAjv.compile({
  $id: "https://schemas.arcanos.dev/protocol/v1/envelope-request.schema.json",
  allOf: [
    {
      $ref: "https://schemas.arcanos.dev/protocol/v1/envelope.schema.json#/$defs/request"
    }
  ]
});
const responseEnvelopeValidator = protocolAjv.compile({
  $id: "https://schemas.arcanos.dev/protocol/v1/envelope-response.schema.json",
  allOf: [
    {
      $ref: "https://schemas.arcanos.dev/protocol/v1/envelope.schema.json#/$defs/response"
    }
  ]
});
const requestPayloadValidators = compileCommandValidators(commandRequestSchemas);
const responseDataValidators = compileCommandValidators(commandResponseSchemas);

/**
 * Builds an Ajv instance loaded with every shared protocol schema.
 * Inputs: none.
 * Outputs: Ajv validator with Arcanos Protocol v1 schemas registered.
 * Edge cases: duplicate schema identifiers fail fast during startup instead of producing drift at runtime.
 */
export function createProtocolAjv() {
  const ajv = new AjvConstructor({ allErrors: true, strict: false, validateSchema: false });

  for (const schema of sharedSchemas) {
    ajv.addSchema(schema);
  }

  return ajv;
}

/**
 * Validates a protocol request envelope without applying command-specific payload rules.
 * Inputs: unknown request value.
 * Outputs: validation result with normalized issues.
 * Edge cases: unknown commands still pass envelope validation so clients can separate transport shape from capability support.
 */
export function validateProtocolRequestEnvelope(candidate: unknown): ValidationResult {
  return buildValidationResult(requestEnvelopeValidator, candidate);
}

/**
 * Validates a protocol response envelope without applying command-specific data rules.
 * Inputs: unknown response value.
 * Outputs: validation result with normalized issues.
 * Edge cases: failed responses can omit data and still validate as long as error fields are present.
 */
export function validateProtocolResponseEnvelope(candidate: unknown): ValidationResult {
  return buildValidationResult(responseEnvelopeValidator, candidate);
}

/**
 * Validates a request payload for a scaffolded command.
 * Inputs: command identifier and payload value.
 * Outputs: validation result with normalized issues.
 * Edge cases: unsupported commands fail closed so the caller cannot accidentally bypass schema review.
 */
export function validateProtocolCommandPayload(command: ProtocolCommandId, payload: unknown): ValidationResult {
  if (!isImplementedProtocolCommandId(command)) {
    return {
      ok: false,
      issues: [
        {
          instancePath: "/command",
          message: `No payload schema is registered for command "${command}".`
        }
      ]
    };
  }

  return buildValidationResult(requestPayloadValidators[command], payload ?? {});
}

/**
 * Validates response data for a scaffolded command.
 * Inputs: command identifier and response data value.
 * Outputs: validation result with normalized issues.
 * Edge cases: unsupported commands fail closed so response drift is visible during integration.
 */
export function validateProtocolCommandData(command: ProtocolCommandId, data: unknown): ValidationResult {
  if (!isImplementedProtocolCommandId(command)) {
    return {
      ok: false,
      issues: [
        {
          instancePath: "/command",
          message: `No response schema is registered for command "${command}".`
        }
      ]
    };
  }

  return buildValidationResult(responseDataValidators[command], data ?? {});
}

/**
 * Asserts that a request matches the shared protocol contract.
 * Inputs: protocol request candidate.
 * Outputs: the same request typed as a validated request.
 * Edge cases: throws a deterministic error when either envelope or payload validation fails.
 */
export function assertValidProtocolRequest<TPayload>(candidate: ProtocolRequest<TPayload>): ProtocolRequest<TPayload> {
  const envelopeResult = validateProtocolRequestEnvelope(candidate);

  if (!envelopeResult.ok) {
    throw new Error(formatValidationFailure("request envelope", envelopeResult.issues));
  }

  const payloadResult = validateProtocolCommandPayload(candidate.command, candidate.payload);

  if (!payloadResult.ok) {
    throw new Error(formatValidationFailure(`request payload for ${candidate.command}`, payloadResult.issues));
  }

  return candidate;
}

/**
 * Asserts that a response matches the shared protocol contract.
 * Inputs: command identifier and response candidate.
 * Outputs: the same response typed as a validated response.
 * Edge cases: failed responses skip command data validation because the envelope error object becomes the source of truth.
 */
export function assertValidProtocolResponse<TData>(command: ImplementedProtocolCommandId, candidate: ProtocolResponse<TData>): ProtocolResponse<TData> {
  const envelopeResult = validateProtocolResponseEnvelope(candidate);

  if (!envelopeResult.ok) {
    throw new Error(formatValidationFailure("response envelope", envelopeResult.issues));
  }

  if (!candidate.ok) {
    return candidate;
  }

  const dataResult = validateProtocolCommandData(command, candidate.data);

  if (!dataResult.ok) {
    throw new Error(formatValidationFailure(`response data for ${command}`, dataResult.issues));
  }

  return candidate;
}

/**
 * Creates a protocol request with the fixed protocol version.
 * Inputs: request fields except for the protocol literal.
 * Outputs: request envelope populated with `arcanos-v1`.
 * Edge cases: callers still need explicit validation because payload semantics depend on the command identifier.
 */
export function createProtocolRequest<TPayload>(request: Omit<ProtocolRequest<TPayload>, "protocol">): ProtocolRequest<TPayload> {
  return {
    protocol: ARCANOS_PROTOCOL_VERSION,
    ...request
  };
}

/**
 * Narrows a protocol command identifier to the implemented scaffold subset.
 * Inputs: any command identifier.
 * Outputs: boolean type guard.
 * Edge cases: future commands remain discoverable without being treated as implemented accidentally.
 */
export function isImplementedProtocolCommandId(command: ProtocolCommandId): command is ImplementedProtocolCommandId {
  return (ARCANOS_PROTOCOL_IMPLEMENTED_COMMAND_IDS as readonly string[]).includes(command);
}

/**
 * Narrows a successful command response to its scaffolded response type.
 * Inputs: command identifier and protocol response.
 * Outputs: typed response union for the implemented command set.
 * Edge cases: throws when the response does not validate against the command schema.
 */
export function assertTypedImplementedResponse(
  command: ImplementedProtocolCommandId,
  response: ProtocolResponse<unknown>
): ProtocolResponse<
  | ArtifactStoreResponseData
  | ContextInspectResponseData
  | DaemonCapabilitiesResponseData
  | ExecStartResponseData
  | ExecStatusResponseData
  | StateSnapshotResponseData
  | ToolDescribeResponseData
  | ToolInvokeResponseData
  | ToolRegistryResponseData
> {
  return assertValidProtocolResponse(command, response) as ProtocolResponse<
    | ArtifactStoreResponseData
    | ContextInspectResponseData
    | DaemonCapabilitiesResponseData
    | ExecStartResponseData
    | ExecStatusResponseData
    | StateSnapshotResponseData
    | ToolDescribeResponseData
    | ToolInvokeResponseData
    | ToolRegistryResponseData
  >;
}

function compileCommandValidators(commandSchemas: Record<ImplementedProtocolCommandId, AnySchema>): Record<ImplementedProtocolCommandId, ValidateFunction> {
  return {
    "artifact.store": protocolAjv.compile(commandSchemas["artifact.store"]),
    "context.inspect": protocolAjv.compile(commandSchemas["context.inspect"]),
    "daemon.capabilities": protocolAjv.compile(commandSchemas["daemon.capabilities"]),
    "exec.start": protocolAjv.compile(commandSchemas["exec.start"]),
    "exec.status": protocolAjv.compile(commandSchemas["exec.status"]),
    "state.snapshot": protocolAjv.compile(commandSchemas["state.snapshot"]),
    "tool.describe": protocolAjv.compile(commandSchemas["tool.describe"]),
    "tool.invoke": protocolAjv.compile(commandSchemas["tool.invoke"]),
    "tool.registry": protocolAjv.compile(commandSchemas["tool.registry"])
  };
}

function buildValidationResult(validator: ValidateFunction, candidate: unknown): ValidationResult {
  const ok = Boolean(validator(candidate));
  return {
    ok,
    issues: ok ? [] : normalizeAjvErrors(validator.errors ?? [])
  };
}

function normalizeAjvErrors(errors: ErrorObject[]): ValidationIssue[] {
  return errors.map((error) => ({
    instancePath: error.instancePath || "/",
    message: error.message ?? "Validation failed."
  }));
}

function formatValidationFailure(scope: string, issues: ValidationIssue[]): string {
  const renderedIssues = issues.map((issue) => `${issue.instancePath}: ${issue.message}`).join("; ");
  return `Invalid ${scope}. ${renderedIssues}`;
}
