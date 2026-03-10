import { Ajv, type ErrorObject, type ValidateFunction } from 'ajv';
import {
  CEF_COMMAND_SCHEMA_COVERAGE,
  CEF_SCHEMA_DEFINITIONS
} from './schemaDefinitions.js';

interface CefSchemaValidationIssue {
  path: string;
  message: string;
}

interface CefSchemaValidationResult<TValue> {
  success: boolean;
  data: TValue | null;
  issues: CefSchemaValidationIssue[];
}

type CefJsonSchema = Record<string, unknown> & { $id: string };

const ajv = new Ajv({
  allErrors: true,
  strict: false,
  validateFormats: false
});

const compiledValidatorsBySchemaName = new Map<string, ValidateFunction>();

function normalizeAjvErrors(errors: ErrorObject[] | null | undefined): CefSchemaValidationIssue[] {
  return (errors ?? []).map(error => ({
    //audit Assumption: Ajv v8 reports JSON pointer paths via `instancePath`; failure risk: schema failures lose field-level context after the security upgrade; expected invariant: callers still receive stable dotted field paths; handling strategy: normalize JSON pointer paths into the legacy dotted shape or fall back to `payload`.
    path: typeof error.instancePath === 'string' && error.instancePath.length > 0
      ? error.instancePath.replace(/^\//, '').replace(/\//g, '.')
      : 'payload',
    message: error.message ?? 'Schema validation failed.'
  }));
}

function registerCefSchema(schema: CefJsonSchema): void {
  const schemaName = schema.$id;

  //audit Assumption: each CEF schema name is globally unique within the registry; failure risk: one command silently overwrites another validator and corrupts runtime validation; expected invariant: `$id` collisions never pass registration; handling strategy: throw immediately when duplicate schema ids appear.
  if (compiledValidatorsBySchemaName.has(schemaName)) {
    throw new Error(`CEF schema "${schemaName}" is already registered.`);
  }

  ajv.addSchema(schema, schemaName);
  const validator = ajv.getSchema(schemaName);

  //audit Assumption: every registered JSON schema must compile successfully before command execution begins; failure risk: schema enforcement appears configured but never actually runs; expected invariant: registry lookups always return a compiled validator; handling strategy: fail registration when Ajv cannot compile or resolve the schema.
  if (!validator) {
    throw new Error(`CEF schema "${schemaName}" failed to compile.`);
  }

  compiledValidatorsBySchemaName.set(schemaName, validator);
}

for (const schemaDefinition of CEF_SCHEMA_DEFINITIONS) {
  registerCefSchema(schemaDefinition);
}

/**
 * Assert that one named CEF schema has been registered.
 *
 * Purpose:
 * - Fail fast when command definitions or handler modules reference a missing schema.
 *
 * Inputs/outputs:
 * - Input: schema name.
 * - Output: none.
 *
 * Edge case behavior:
 * - Throws immediately when the schema name is not in the registry.
 */
export function assertCefSchemaRegistered(schemaName: string): void {
  if (!compiledValidatorsBySchemaName.has(schemaName)) {
    throw new Error(`CEF schema "${schemaName}" is not registered.`);
  }
}

/**
 * Validate one runtime payload against a named CEF JSON schema.
 *
 * Purpose:
 * - Centralize Ajv-backed validation for command inputs, outputs, and error payloads.
 *
 * Inputs/outputs:
 * - Input: schema name and unknown runtime value.
 * - Output: validation success flag, normalized value, and schema issues.
 *
 * Edge case behavior:
 * - Throws when the schema is missing so callers cannot silently skip validation.
 */
export function validateCefSchema<TValue>(
  schemaName: string,
  value: unknown
): CefSchemaValidationResult<TValue> {
  assertCefSchemaRegistered(schemaName);
  const validator = compiledValidatorsBySchemaName.get(schemaName);

  //audit Assumption: registry assertion guarantees a validator exists; failure risk: undefined validators create false-positive successes; expected invariant: every registered schema resolves to a compiled validator; handling strategy: throw when a validator is unexpectedly missing.
  if (!validator) {
    throw new Error(`CEF schema validator "${schemaName}" is not available.`);
  }

  const isValid = validator(value);

  if (!isValid) {
    return {
      success: false,
      data: null,
      issues: normalizeAjvErrors(validator.errors)
    };
  }

  return {
    success: true,
    data: value as TValue,
    issues: []
  };
}

/**
 * Return the registered command-to-schema coverage map.
 *
 * Purpose:
 * - Expose deterministic schema coverage for tests, diagnostics, and final verification output.
 *
 * Inputs/outputs:
 * - Input: none.
 * - Output: command-to-schema mapping copy.
 *
 * Edge case behavior:
 * - Returns only registered static coverage and never infers extra commands.
 */
export function listRegisteredCommandSchemaCoverage(): Record<string, {
  inputSchemaName: string;
  outputSchemaName: string;
  errorSchemaName: string;
}> {
  return Object.fromEntries(
    Object.entries(CEF_COMMAND_SCHEMA_COVERAGE).map(([commandName, coverage]) => [
      commandName,
      {
        ...coverage
      }
    ])
  );
}
