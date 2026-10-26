import { Ajv } from 'ajv';
import type {
  TrinityCapabilityFlags,
  TrinityReasoningHonesty,
  TrinityStructuredOutputContract,
  TrinityOutputControls,
} from './trinityTypes.js';
import {
  deriveTrinityOutputControls,
  enforceFinalStageHonesty,
  enforceFinalStageHonestyAndMinimalism,
  readIntentMode,
} from './trinityHonesty.js';

export type { TrinityStructuredOutputContract } from './trinityTypes.js';

export class TrinityStructuredOutputError extends Error {
  readonly code = 'TRINITY_STRUCTURED_OUTPUT_INVALID';

  constructor(readonly reason: 'invalid_contract' | 'invalid_json' | 'schema_mismatch' | 'unsupported_claim'
    | 'missing_required_limitation' | 'provider_incomplete' | 'content_filtered' | 'empty_output') {
    super(`Trinity structured output rejected: ${reason}`);
    this.name = 'TrinityStructuredOutputError';
  }
}

/** Compile before provider work. Reject unsafe JSON; never repair or rewrite it. */
export function createTrinityStructuredOutputValidator(contract: TrinityStructuredOutputContract) {
  let validate: ReturnType<Ajv['compile']>;
  try {
    if (!contract || !/^[A-Za-z0-9_-]{1,64}$/.test(contract.name)
      || !contract.schema || typeof contract.schema !== 'object' || Array.isArray(contract.schema)) {
      throw new Error('Invalid final output contract');
    }
    // Snapshot caller state. Ajv must not coerce types, remove fields or use defaults.
    validate = new Ajv({ strict: true }).compile(JSON.parse(JSON.stringify(contract.schema)));
    if ('$async' in validate && validate.$async) throw new Error('Async schema');
  } catch {
    throw new TrinityStructuredOutputError('invalid_contract');
  }

  return (text: string, capabilities: TrinityCapabilityFlags, honesty: TrinityReasoningHonesty,
    context: { userPrompt: string; outputControls: TrinityOutputControls } = {
      userPrompt: '', outputControls: deriveTrinityOutputControls('', {}),
    }): string => {
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      throw new TrinityStructuredOutputError('invalid_json');
    }
    if (!validate(value)) throw new TrinityStructuredOutputError('schema_mismatch');

    // Inspect fields independently: one field's limitation cannot excuse a
    // different claim, and a vocabulary key cannot supply another field's subject.
    const stringValues: string[] = [];
    const inspect = (entry: unknown, isValue = true): void => {
      if (typeof entry === 'string') {
        if (isValue) stringValues.push(entry);
        const filtered = enforceFinalStageHonesty(entry, honesty, capabilities,
          readIntentMode(context.outputControls), true, context.outputControls.instructionalVerificationPolicy);
        const enforced = enforceFinalStageHonestyAndMinimalism({
          text: entry, userPrompt: context.userPrompt, capabilityFlags: capabilities,
          outputControls: context.outputControls, reasoningHonesty: honesty,
          preservePresentation: true,
        });
        if (filtered.blocked || enforced.blockedOrRewrittenClaims.length > 0) {
          throw new TrinityStructuredOutputError('unsupported_claim');
        }
      } else if (entry !== null && typeof entry === 'object') {
        for (const [key, field] of Object.entries(entry)) {
          inspect(key, false);
          inspect(field);
        }
      }
    };
    inspect(value);
    if (honesty.responseMode !== 'answer') {
      // A caveat can live in a dedicated field. Require it across the response,
      // rather than appending prose to JSON or demanding it in every field.
      const combined = stringValues.join('\n');
      const withRequiredLimitation = enforceFinalStageHonesty(combined, honesty, capabilities,
        readIntentMode(context.outputControls), true, context.outputControls.instructionalVerificationPolicy);
      if (withRequiredLimitation.text !== combined.trim()) {
        throw new TrinityStructuredOutputError(withRequiredLimitation.blocked
          ? 'unsupported_claim' : 'missing_required_limitation');
      }
    }
    return text;
  };
}
