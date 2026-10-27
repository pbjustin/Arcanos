import {
  createTrinityStructuredOutputValidator,
  TrinityStructuredOutputError,
} from '@core/logic/trinityStructuredOutput.js';
import {
  createDefaultTrinityReasoningHonesty,
  deriveTrinityCapabilityFlags,
  deriveTrinityOutputControls,
  enforceFinalStageHonestyAndMinimalism,
} from '@core/logic/trinityHonesty.js';
import { applyTrinityDirectAnswerOutputContract } from '@core/logic/trinityDirectAnswerMode.js';

export const TRINITY_FINAL_OUTPUT_PREVIEW_VERSION = 'shared-final-output-integrity/v1';
const FAILURE = 'TRINITY_FINAL_OUTPUT_PREVIEW_ASSERTION_FAILED';

export interface TrinityFinalOutputPreviewReport {
  readonly proofVersion: typeof TRINITY_FINAL_OUTPUT_PREVIEW_VERSION;
  readonly synthetic: true;
  readonly delivered: readonly string[];
  readonly rejected: Readonly<Record<string, TrinityStructuredOutputError['reason']>>;
  readonly proseUnchanged: true;
  readonly listUnchanged: true;
}

function requireProof(condition: unknown): asserts condition {
  if (!condition) throw new Error(FAILURE);
}

/** Fixed synthetic component proof. No provider, normal caller, or effects run. */
export function assertTrinityFinalOutputPreviewFixture(): TrinityFinalOutputPreviewReport {
  try {
    const capabilities = deriveTrinityCapabilityFlags();
    const honesty = createDefaultTrinityReasoningHonesty();
    requireProof(Object.values(capabilities).every(value => value === false));
    requireProof(honesty.evidenceTags.length === 0);
    const validateAnswer = createTrinityStructuredOutputValidator({
      name: 'preview_answer', schema: {
        type: 'object', additionalProperties: false, required: ['answer'],
        properties: { answer: { type: 'string', minLength: 1 } },
      },
    });
    const validateFlag = createTrinityStructuredOutputValidator({
      name: 'preview_flag', schema: {
        type: 'object', additionalProperties: false, required: ['verified'],
        properties: { verified: { type: 'boolean' } },
      },
    });
    const validateObject = createTrinityStructuredOutputValidator({ name: 'preview_object', schema: { type: 'object' } });
    const delivered: string[] = [];
    const rejected: Record<string, TrinityStructuredOutputError['reason']> = {};
    const reject = (id: string, action: () => unknown, reason: TrinityStructuredOutputError['reason']) => {
      let failure: unknown;
      try { action(); } catch (error) { failure = error; }
      requireProof(failure instanceof TrinityStructuredOutputError && failure.reason === reason);
      rejected[id] = failure.reason;
    };

    for (const [id, raw] of [
      ['json-bytes', ' \n{"answer":"Keep `value`, **text**, and \\"quotes\\".\\nUnicode café."}\t '],
      ['code-comment', JSON.stringify({ answer: 'function accept(input: unknown) {\n//audit Assumption: check that input is a string before use.\nreturn typeof input === "string";\n}' })],
      ['verification-denial', JSON.stringify({ answer: 'The migration has not been validated.' })],
    ] as const) {
      requireProof(validateAnswer(raw, capabilities, honesty) === raw);
      delivered.push(id);
    }
    const flag = '{"verified": false}';
    requireProof(validateFlag(flag, capabilities, honesty) === flag);
    delivered.push('structural-false-flag');
    const metadata = JSON.stringify({ checked: null, reviewed: false, nested: [{ validated: null }] });
    requireProof(validateObject(metadata, capabilities, honesty) === metadata);
    delivered.push('structural-metadata');

    reject('invalid-json', () => validateAnswer('{"answer":"unfinished"', capabilities, honesty), 'invalid_json');
    reject('schema-mismatch', () => validateAnswer('{"answer":42}', capabilities, honesty), 'schema_mismatch');
    reject('schema-flag-type', () => validateFlag('{"verified":"false"}', capabilities, honesty), 'schema_mismatch');
    reject('affirmative-flag', () => validateFlag('{"verified":true}', capabilities, honesty), 'unsupported_claim');
    for (const [id, claim] of [
      ['deployment-claim', 'I deployed the app.'],
      ['backend-write-claim', 'I saved the record in the backend database.'],
      ['verification-claim', 'I verified the live deployment status.'],
      ['npm-execution-claim', 'I ran npm test.'],
    ] as const) {
      reject(id, () => validateAnswer(JSON.stringify({ answer: claim }), capabilities, honesty), 'unsupported_claim');
    }
    reject('descriptive-claim-key', () => validateObject('{"I deployed the app":false}', capabilities, honesty), 'unsupported_claim');
    reject('nested-string-claim', () => validateObject('{"verified":[{"checked":"I ran npm test."}]}', capabilities, honesty), 'unsupported_claim');
    reject('missing-limitation', () => validateAnswer('{"answer":"The outline has two steps."}', capabilities, {
      ...honesty, responseMode: 'partial_refusal', blockedSubtasks: ['verify live status'],
      userVisibleCaveats: ["I can't verify live status here."],
    }), 'missing_required_limitation');

    const prose = 'Use the supplied outline.';
    const list = '1. Read the supplied outline.\n2. Summarize its two steps.';
    for (const [text, userPrompt] of [
      [prose, 'Give a short answer using the supplied outline.'],
      [list, 'Return exactly two numbered bullets using the supplied outline.'],
    ] as const) {
      const enforced = enforceFinalStageHonestyAndMinimalism({ text, userPrompt, capabilityFlags: capabilities,
        reasoningHonesty: honesty, outputControls: deriveTrinityOutputControls(userPrompt, { answerMode: 'direct' }) });
      requireProof(enforced.text === text && enforced.blockedOrRewrittenClaims.length === 0);
      requireProof(applyTrinityDirectAnswerOutputContract(enforced.text, userPrompt) === text);
    }
    requireProof(Object.values(capabilities).every(value => value === false) && honesty.evidenceTags.length === 0);
    return Object.freeze({ proofVersion: TRINITY_FINAL_OUTPUT_PREVIEW_VERSION, synthetic: true,
      delivered: Object.freeze(delivered), rejected: Object.freeze(rejected), proseUnchanged: true, listUnchanged: true });
  } catch {
    // Candidate text, dependency errors and unexpected metadata never leave this fixture.
    throw new Error(FAILURE);
  }
}
