import { describe, expect, it } from '@jest/globals';
import { createTrinityStructuredOutputValidator } from '../src/core/logic/trinityStructuredOutput.js';
import { createDefaultTrinityReasoningHonesty, deriveTrinityCapabilityFlags, deriveTrinityOutputControls } from '../src/core/logic/trinityHonesty.js';

const contract = {
  name: 'structured_answer', schema: {
    type: 'object', additionalProperties: false, required: ['answer'],
    properties: { answer: { type: 'string', minLength: 1 } },
  },
};
const flags = deriveTrinityCapabilityFlags();
const honesty = createDefaultTrinityReasoningHonesty();
const validate = createTrinityStructuredOutputValidator(contract);

describe('Trinity final JSON contract validation', () => {
  it('returns exact emitted bytes, including escaped newlines, quoted examples and Markdown data', () => {
    const raw = ' \n{"answer":"Keep `value`, **text**, and \\"quotes\\".\\nDo not reshape Unicode café."}\t ';
    expect(validate(raw, flags, honesty)).toBe(raw);
  });

  it.each(['', '{"answer":"truncated"', '```json\n{"answer":"ok"}\n```', '{"answer":"ok"} prose'])
    ('rejects invalid JSON without formatting repair: %p', raw => {
      expect(() => validate(raw, flags, honesty)).toThrow(expect.objectContaining({
        code: 'TRINITY_STRUCTURED_OUTPUT_INVALID', reason: 'invalid_json',
      }));
    });

  it.each(['{}', '{"answer":42}', '{"answer":"ok","extra":true}', 'null', '["ok"]'])
    ('rejects a schema violation without coercion: %p', raw => {
      expect(() => validate(raw, flags, honesty)).toThrow(expect.objectContaining({ reason: 'schema_mismatch' }));
    });

  it.each([
    { name: 'missing_schema', schema: undefined },
    { name: '', schema: contract.schema },
    { name: 'invalid_schema', schema: { type: 'unknown-type' } },
    { name: 'async_schema', schema: { ...contract.schema, $async: true } },
  ])('rejects an invalid caller contract before validating output: %p', invalid => {
    expect(() => createTrinityStructuredOutputValidator(invalid as typeof contract))
      .toThrow(expect.objectContaining({ reason: 'invalid_contract' }));
  });

  it.each([
    'I saved the record in the backend database.',
    'I called the backend API.',
    'I verified the live deployment status.',
    'I deployed the service and confirmed its current status.',
    'I ran npm test.',
    'I ran npm run build.',
  ])('preserves honesty blocking inside JSON: %s', claim => {
    expect(() => validate(JSON.stringify({ answer: claim }), flags, honesty))
      .toThrow(expect.objectContaining({ reason: 'unsupported_claim' }));
  });

  it.each([
    'If I ran npm test, I would inspect its output.',
    'Run npm test before changing the configuration.',
    '//audit: Run npm test before changing the configuration.',
  ])('does not mistake a named-command hypothetical or instruction for performed work: %s', text => {
    const raw = JSON.stringify({ answer: text });
    expect(validate(raw, flags, honesty)).toBe(raw);
  });

  it('does not let a safe limitation field excuse a separate fabricated action claim', () => {
    const validateNested = createTrinityStructuredOutputValidator({
      name: 'nested_claim', schema: { type: 'object', additionalProperties: { type: 'array', items: { type: 'string' } } },
    });
    const raw = JSON.stringify({ answers: ['The backend state is unverified.', 'I queried the backend record.'] });
    expect(() => validateNested(raw, flags, honesty)).toThrow(expect.objectContaining({ reason: 'unsupported_claim' }));
  });

  it.each([
    ['I ran the tests.', 'I deployed the app.'],
    ['I ran npm test.', 'I ran npm run build.'],
    ['I deployed the staging app.', 'I deployed the production app.'],
    ['I ran the tests.', 'I saved the record in the backend database.'],
    ['I saved the record in the backend database.', 'I deployed the app.'],
  ])('rejects a different completed action despite a verified tag: %s -> %s', (evidence, claim) => {
    const tagged = { ...honesty, evidenceTags: [{
      claimText: evidence, sourceType: 'tool' as const, verificationStatus: 'verified' as const,
      confidence: 'high' as const,
    }] };
    expect(() => validate(JSON.stringify({ answer: claim }), deriveTrinityCapabilityFlags({ callBackend: true }), tagged))
      .toThrow(expect.objectContaining({ reason: 'unsupported_claim' }));
  });

  it('preserves a matching completed command with the existing capability and evidence inputs', () => {
    const claim = 'I ran npm test.';
    const tagged = { ...honesty, evidenceTags: [{
      claimText: claim, sourceType: 'tool' as const, verificationStatus: 'verified' as const,
      confidence: 'high' as const,
    }] };
    const raw = JSON.stringify({ answer: claim });
    expect(validate(raw, deriveTrinityCapabilityFlags({ callBackend: true }), tagged)).toBe(raw);
  });

  it.each(['I verified the live deployment status', 'I called the backend API', 'verified'])(
    'does not let a property name carry an unsupported claim: %s', key => {
      const validateKeys = createTrinityStructuredOutputValidator({ name: 'claim_keys', schema: { type: 'object' } });
      expect(() => validateKeys(JSON.stringify({ [key]: true }), flags, honesty))
        .toThrow(expect.objectContaining({ reason: 'unsupported_claim' }));
    }
  );

  it('does not treat keys as a shared assertion subject for unrelated values', () => {
    const validateRecord = createTrinityStructuredOutputValidator({
      name: 'record', schema: { type: 'object', additionalProperties: { type: 'string' } },
    });
    const raw = JSON.stringify({ status: 'conflict', explanation: 'The supplied records name different current champions.' });
    expect(validateRecord(raw, flags, honesty)).toBe(raw);
  });

  it('preserves a legitimate source-code comment while retaining the caller schema', () => {
    const raw = JSON.stringify({ answer: "function makeId() {\n//audit: Return a unique value from the runtime API.\nreturn 'example';\n}" });
    expect(validate(raw, flags, honesty)).toBe(raw);
  });

  it('preserves review limitations and generated check comments across structured fields', () => {
    const validateFields = createTrinityStructuredOutputValidator({
      name: 'review_and_artifact_fields', schema: { type: 'object' },
    });
    const raw = JSON.stringify({
      summary: 'The migration is not validated.',
      assumptions: ['The migration has not been validated.'],
      snippets: [{
        description: 'The migration is not validated.',
        code: 'function accept(input: unknown) {\n//audit Assumption: check that input is a string before use.\nreturn typeof input === "string";\n}',
      }],
    });
    expect(validateFields(raw, flags, honesty)).toBe(raw);
  });

  it.each(['summary', 'description', 'assumptions', 'code'])(
    'still rejects fabricated claims in the %s field alongside legitimate non-claim text', field => {
      const validateFields = createTrinityStructuredOutputValidator({
        name: 'artifact_claim_boundary', schema: { type: 'object' },
      });
      for (const claim of [
        'I verified the tests pass.',
        'I saved the result to the backend database.',
        'I deployed the app.',
      ]) {
        const raw = JSON.stringify({ [field]: `The migration is not validated. ${claim}` });
        expect(() => validateFields(raw, flags, honesty))
          .toThrow(expect.objectContaining({ reason: 'unsupported_claim' }));
      }
    }
  );

  it('retains prompt-dependent current-external-state enforcement', () => {
    const userPrompt = 'What are the latest competitor pricing moves?';
    expect(() => validate(JSON.stringify({ answer: 'Competitors are lowering prices.' }), flags, honesty, {
      userPrompt, outputControls: deriveTrinityOutputControls(userPrompt, {}),
    })).toThrow(expect.objectContaining({ reason: 'unsupported_claim' }));
  });

  it('rejects omission of a required partial-refusal limitation instead of adding prose to JSON', () => {
    const partial = { ...honesty, responseMode: 'partial_refusal' as const,
      blockedSubtasks: ['verify live status'], userVisibleCaveats: ["I can't verify live status here."] };
    expect(() => validate('{"answer":"The supplied outline has two steps."}', flags, partial))
      .toThrow(expect.objectContaining({ reason: 'missing_required_limitation' }));
    const raw = '{"answer":"I cannot verify live status here. The supplied outline has two steps."}';
    expect(validate(raw, flags, partial)).toBe(raw);
    const validateFields = createTrinityStructuredOutputValidator({
      name: 'separate_limitation', schema: { type: 'object', additionalProperties: { type: 'string' } },
    });
    const separate = JSON.stringify({ caveat: 'The live status is unverified.', answer: 'The outline has two steps.' });
    expect(validateFields(separate, flags, partial)).toBe(separate);
  });
});
