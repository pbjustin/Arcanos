import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const actual = await import('../src/shared/gpt/generativeModelPolicyCore.js');
const resolveModel = jest.fn(actual.resolveGenerativeModelFromConfig);
const assertIdentity = jest.fn(actual.assertGenerativeModelResponseIdentity);
jest.unstable_mockModule('../src/shared/gpt/generativeModelPolicyCore.js', () => ({
  ...actual,
  resolveGenerativeModelFromConfig: resolveModel,
  assertGenerativeModelResponseIdentity: assertIdentity
}));
const {
  assertGenerativeModelPolicyPreviewFixture,
  GENERATIVE_MODEL_POLICY_PREVIEW_VERSION
} = await import('../src/shared/gpt/generativeModelPolicyPreviewFixture.js');

const FAILURE = 'GENERATIVE_MODEL_POLICY_PREVIEW_FIXTURE_FAILED';
const authority = 'ft:synthetic:preview-authority';
const expectedReport = {
  proofVersion: 'shared-generative-model-policy/v1', synthetic: true,
  roleModels: {
    intake: 'gpt-6-luna', reasoning: 'gpt-6.1-sol', final: authority,
    'final-escalation': authority, audit: 'gpt-6-luna', 'audit-escalation': 'gpt-6.1-sol'
  },
  checks: {
    roleResolution: 6, matchingOverrides: 6, helperRolesWithoutAuthority: 4,
    unavailableAuthority: 10, overrideConflict: 18, acceptedReplyIdentity: 5,
    rejectedReplyIdentity: 11, deniedSyntheticTransportCalls: 0
  }
};

describe('sealed production generative model policy fixture', () => {
  beforeEach(() => {
    resolveModel.mockReset().mockImplementation(actual.resolveGenerativeModelFromConfig);
    assertIdentity.mockReset().mockImplementation(actual.assertGenerativeModelResponseIdentity);
  });

  it('runs the real policy and identity guard and emits a bounded immutable repeatable report', () => {
    const first = assertGenerativeModelPolicyPreviewFixture();
    const second = assertGenerativeModelPolicyPreviewFixture();
    expect(first).toEqual(expectedReport);
    expect(second).toEqual(expectedReport);
    expect(second).not.toBe(first);
    expect(first.roleModels).not.toBe(second.roleModels);
    expect(GENERATIVE_MODEL_POLICY_PREVIEW_VERSION).toBe(expectedReport.proofVersion);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.roleModels)).toBe(true);
    expect(Object.isFrozen(first.checks)).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(first))).toBeLessThan(4096);
    expect(resolveModel).toHaveBeenCalledTimes(88);
    expect(assertIdentity).toHaveBeenCalledTimes(32);
  });

  it('withholds proof if a helper replaces final authority', () => {
    resolveModel.mockImplementation((config, role, requested) => role === 'final'
      ? config.trinityReasoningModel
      : actual.resolveGenerativeModelFromConfig(config, role, requested));
    expect(assertGenerativeModelPolicyPreviewFixture).toThrow(FAILURE);
    expect(assertIdentity).not.toHaveBeenCalled();
  });

  it('withholds proof if missing authority receives a helper fallback', () => {
    resolveModel.mockImplementation((config, role, requested) =>
      (role === 'final' || role === 'final-escalation') && !config.trinityFinalModel.trim()
        ? config.trinityReasoningModel
        : actual.resolveGenerativeModelFromConfig(config, role, requested));
    expect(assertGenerativeModelPolicyPreviewFixture).toThrow(FAILURE);
    expect(assertIdentity).not.toHaveBeenCalled();
  });

  it('withholds proof if conflicting overrides reach synthetic downstream admission', () => {
    resolveModel.mockImplementation((config, role) => actual.resolveGenerativeModelFromConfig(config, role));
    expect(assertGenerativeModelPolicyPreviewFixture).toThrow(FAILURE);
    expect(assertIdentity).not.toHaveBeenCalled();
  });

  it('withholds proof if fine-tune identity becomes case insensitive', () => {
    assertIdentity.mockImplementation((response, expected) => {
      const model = typeof response.model === 'string' ? response.model.trim() : '';
      if (expected.startsWith('ft:') && model.toLowerCase() === expected.trim().toLowerCase()) return model;
      return actual.assertGenerativeModelResponseIdentity(response, expected);
    });
    expect(assertGenerativeModelPolicyPreviewFixture).toThrow(FAILURE);
  });

  it('withholds proof if missing raw model identity is backfilled from the requested model', () => {
    assertIdentity.mockImplementation((response, expected) => response.model === undefined
      ? expected
      : actual.assertGenerativeModelResponseIdentity(response, expected));
    expect(assertGenerativeModelPolicyPreviewFixture).toThrow(FAILURE);
  });

  it('withholds proof if a helper family prefix accepts an unrelated identifier', () => {
    assertIdentity.mockImplementation((response, expected) => {
      const model = typeof response.model === 'string' ? response.model.trim() : '';
      if (!expected.startsWith('ft:') && model.startsWith(expected)) return model;
      return actual.assertGenerativeModelResponseIdentity(response, expected);
    });
    expect(assertGenerativeModelPolicyPreviewFixture).toThrow(FAILURE);
  });

  it('redacts unexpected configured data and original error text on failure', () => {
    const privateFailure = 'synthetic-private-model-metadata-do-not-emit';
    resolveModel.mockImplementation(() => { throw new Error(privateFailure); });
    let failure: unknown;
    try {
      assertGenerativeModelPolicyPreviewFixture();
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toBe(FAILURE);
    expect((failure as Error).cause).toBeUndefined();
    expect(String(failure)).not.toContain(privateFailure);
  });
});
