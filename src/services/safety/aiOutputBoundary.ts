import { z } from 'zod';
import { emitSafetyAuditEvent } from './auditEvents.js';

export class AiOutputBoundaryError extends Error {
  constructor(message: string, readonly source: string) {
    super(message);
    this.name = 'AiOutputBoundaryError';
  }
}

interface ParseModelOutputOptions<T> {
  source: string;
  fallbackValue?: T;
  allowFallback?: boolean;
}

/**
 * Purpose: Parse AI JSON output under strict schema enforcement.
 * Inputs/Outputs: Raw JSON, Zod schema, and parse options; returns typed schema value.
 * Edge cases: Optional fallback is only used when explicitly enabled.
 */
export function parseModelOutputWithSchema<T>(
  rawJson: string,
  schema: z.ZodType<T>,
  options: ParseModelOutputOptions<T>
): T {
  let parsedUnknown: unknown;
  try {
    parsedUnknown = JSON.parse(rawJson);
  } catch (error) {
    //audit Assumption: malformed JSON must never directly drive actions; failure risk: schema bypass and undefined mutations; expected invariant: invalid JSON is rejected unless fallback explicitly enabled; handling strategy: throw or controlled fallback.
    if (options.allowFallback && options.fallbackValue !== undefined) {
      emitSafetyAuditEvent({
        event: 'ai_output_fallback_json_parse',
        severity: 'warn',
        details: {
          source: options.source,
          message: error instanceof Error ? error.message : String(error)
        }
      });
      return options.fallbackValue;
    }
    throw new AiOutputBoundaryError('AI output is not valid JSON.', options.source);
  }

  const validated = schema.safeParse(parsedUnknown);
  //audit Assumption: schema validation is mandatory trust boundary; failure risk: unsafe fields reaching execution paths; expected invariant: only schema-valid payload proceeds; handling strategy: fail closed unless explicit fallback enabled.
  if (!validated.success) {
    if (options.allowFallback && options.fallbackValue !== undefined) {
      emitSafetyAuditEvent({
        event: 'ai_output_fallback_schema',
        severity: 'warn',
        details: {
          source: options.source,
          issues: validated.error.issues.map(issue => issue.message)
        }
      });
      return options.fallbackValue;
    }

    throw new AiOutputBoundaryError(
      `AI output failed schema validation: ${validated.error.issues.map(issue => issue.message).join('; ')}`,
      options.source
    );
  }

  return validated.data;
}

/**
 * Purpose: Parse AI tool-call arguments with strict schema validation.
 * Inputs/Outputs: Raw tool arguments JSON, schema, and source label; returns typed args.
 * Edge cases: Always throws on invalid args to prevent partial execution.
 */
export function parseToolArgumentsWithSchema<T>(
  rawArguments: string,
  schema: z.ZodType<T>,
  source: string
): T {
  return parseModelOutputWithSchema(rawArguments, schema, {
    source,
    allowFallback: false
  });
}

/**
 * Purpose: Enforce deterministic confirmation for irreversible action paths.
 * Inputs/Outputs: action name and deterministic confirmation state; throws on missing confirmation.
 * Edge cases: Confirmation token must be a non-empty string when provided.
 */
export function assertDeterministicConfirmation(options: {
  action: string;
  deterministicConfirmation: boolean;
  confirmationToken?: string;
  source: string;
}): void {
  const confirmationReference = options.confirmationToken?.trim();
  const hasToken = typeof confirmationReference === 'string' && confirmationReference.length > 0;

  //audit Assumption: irreversible actions must require deterministic confirmation; failure risk: AI output mutates state without human intent; expected invariant: deterministicConfirmation=true and token present when applicable; handling strategy: throw boundary error.
  if (!options.deterministicConfirmation || (options.confirmationToken !== undefined && !hasToken)) {
    throw new AiOutputBoundaryError(
      `Irreversible action '${options.action}' blocked: deterministic confirmation missing.`,
      options.source
    );
  }
}
