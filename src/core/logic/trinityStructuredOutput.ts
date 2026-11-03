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
    | 'missing_required_limitation' | 'provider_incomplete' | 'content_filtered' | 'empty_output' | 'private_output') {
    super(`Trinity structured output rejected: ${reason}`);
    this.name = 'TrinityStructuredOutputError';
  }
}

/** Never promote an echoed internal reasoning envelope into a public answer. */
export function assertTrinityFinalOutputIsPublic(text: string, userPrompt = ''): void {
  // An exact quoted value already supplied by the current user is source data,
  // not permission to disclose a different envelope or a neighboring JSON field.
  const literal = text.trim();
  const quotedSource = literal.length > 0 && [JSON.stringify(literal), `'${literal}'`, `\`${literal}\``]
    .some(quoted => userPrompt.includes(quoted));
  let fence: { character: string; length: number } | undefined;
  for (const line of text.split(/\r\n?|\n/u)) {
    const match = /^ {0,3}(`{3,}|~{3,})(.*)$/u.exec(line);
    if (fence) {
      if (match && match[1]![0] === fence.character && match[1]!.length >= fence.length && !match[2]!.trim()) {
        fence = undefined;
      }
      continue;
    }
    if (match) {
      fence = { character: match[1]![0]!, length: match[1]!.length };
      continue;
    }
    // Fenced/indented source examples and inline mentions are ordinary content.
    // Reject an envelope prefix, including an unterminated one; unwrapping it
    // would incorrectly treat private reasoning as an authoritative final answer.
    if (/^ {0,3}(?:GPT-[\w.-]+[ \t]+analysis:[ \t]*)?<\/?analysis_output(?:[ \t>]|$)/iu.test(line)
      && !quotedSource) {
      throw new TrinityStructuredOutputError('private_output');
    }
  }
  // A JSON string remains answer content after decoding. Inspect each value
  // without changing the document or treating every mention of the tag as private.
  try {
    JSON.parse(text, (_key, value: unknown) => {
      if (typeof value === 'string') assertTrinityFinalOutputIsPublic(value, userPrompt);
      return value;
    });
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    // JSON validity and schema errors retain their existing contract boundary.
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
    assertTrinityFinalOutputIsPublic(text, context.userPrompt);

    // Inspect fields independently: one field's limitation cannot excuse a
    // different claim, and a vocabulary key cannot supply another field's subject.
    const stringValues: string[] = [];
    const inspect = (entry: unknown, isValue = true): void => {
      if (typeof entry === 'string') {
        if (isValue) stringValues.push(entry);
        const filtered = enforceFinalStageHonesty(entry, honesty, capabilities,
          readIntentMode(context.outputControls), true, context.outputControls.instructionalVerificationPolicy);
        const enforced = enforceFinalStageHonestyAndMinimalism({
          text: entry, userPrompt: isValue ? context.userPrompt : '', capabilityFlags: capabilities,
          outputControls: context.outputControls, reasoningHonesty: honesty,
          preservePresentation: true,
        });
        if (filtered.blocked || enforced.blockedOrRewrittenClaims.length > 0) {
          throw new TrinityStructuredOutputError('unsupported_claim');
        }
      } else if (entry !== null && typeof entry === 'object') {
        for (const [key, field] of Object.entries(entry)) {
          // Identifier keys describe fields; true can affirm the named status.
          // Descriptive keys still receive both honesty checks, even with false values.
          if (field === true || !/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key)) inspect(key, false);
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
