import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { NATIVE_PR_PREVIEW_E2E_CONTRACT } from '../scripts/native-pr-preview-contract.mjs';

const actual = await import('../src/core/logic/trinityStructuredOutput.js');
const createValidator = jest.fn(actual.createTrinityStructuredOutputValidator);
jest.unstable_mockModule('../src/core/logic/trinityStructuredOutput.js', () => ({
  ...actual, createTrinityStructuredOutputValidator: createValidator,
}));
const direct = await import('../src/core/logic/trinityDirectAnswerMode.js');
const applyDirectContract = jest.fn(direct.applyTrinityDirectAnswerOutputContract);
jest.unstable_mockModule('../src/core/logic/trinityDirectAnswerMode.js', () => ({
  ...direct, applyTrinityDirectAnswerOutputContract: applyDirectContract,
}));
const { assertTrinityFinalOutputPreviewFixture } = await import('../src/shared/gpt/trinityFinalOutputPreviewFixture.js');
const contract = NATIVE_PR_PREVIEW_E2E_CONTRACT.finalOutputIntegrity;
const FAILURE = 'TRINITY_FINAL_OUTPUT_PREVIEW_ASSERTION_FAILED';

describe('sealed production final-output integrity component fixture', () => {
  beforeEach(() => {
    createValidator.mockReset().mockImplementation(actual.createTrinityStructuredOutputValidator);
    applyDirectContract.mockReset().mockImplementation(direct.applyTrinityDirectAnswerOutputContract);
  });

  it('executes real shared validation and preserves ordinary prose/list behavior with a fixed bounded report', () => {
    const report = assertTrinityFinalOutputPreviewFixture();
    expect(report).toEqual({ proofVersion: contract.proofVersion, synthetic: true,
      delivered: contract.delivered, rejected: contract.rejected, proseUnchanged: true, listUnchanged: true });
    expect(Object.isFrozen(report)).toBe(true);
    expect(Object.isFrozen(report.delivered)).toBe(true);
    expect(Object.isFrozen(report.rejected)).toBe(true);
    expect(createValidator).toHaveBeenCalledTimes(3);
    expect(applyDirectContract).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(report).length).toBeLessThan(contract.maxReportChars);
    expect(JSON.stringify(report)).not.toContain('function accept');
    expect(assertTrinityFinalOutputPreviewFixture()).toEqual(report);
  });

  it('withholds proof if valid structured output is rewritten', () => {
    createValidator.mockImplementation(input => {
      const validate = actual.createTrinityStructuredOutputValidator(input);
      return (...args) => `${validate(...args)} `;
    });
    expect(assertTrinityFinalOutputPreviewFixture).toThrow(FAILURE);
  });

  it.each(['invalid_json', 'schema_mismatch', 'unsupported_claim', 'missing_required_limitation'] as const)(
    'withholds proof if a required %s rejection becomes false success', reason => {
      createValidator.mockImplementation(input => {
        const validate = actual.createTrinityStructuredOutputValidator(input);
        return (...args) => {
          try { return validate(...args); } catch (error) {
            if (error instanceof actual.TrinityStructuredOutputError && error.reason === reason) return args[0];
            throw error;
          }
        };
      });
      expect(assertTrinityFinalOutputPreviewFixture).toThrow(FAILURE);
    }
  );

  it('withholds proof if the ordinary direct/list normalizer changes', () => {
    applyDirectContract.mockImplementation(() => 'Changed ordinary answer.');
    expect(assertTrinityFinalOutputPreviewFixture).toThrow(FAILURE);
  });

  it('never exposes dependency errors or candidate contents when a shared component fails', () => {
    createValidator.mockImplementation(() => { throw new Error('private dependency data'); });
    expect(assertTrinityFinalOutputPreviewFixture).toThrow(new Error(FAILURE));
  });
});
