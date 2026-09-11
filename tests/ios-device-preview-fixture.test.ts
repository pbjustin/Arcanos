import { beforeEach, describe, expect, jest, test } from '@jest/globals';

const policy = await import('../src/shared/security/gptAccessDevicePolicyCore.js');
const canonical = await import('../src/services/actionPlanExecution/canonical.js');
const validateRecord = jest.fn(policy.validateGptAccessDeviceRecord);
const matchesOwner = jest.fn(policy.matchesGptAccessDeviceJobOwner);
const hashKey = jest.fn(canonical.hashLocalAgentIdempotencyKey);
jest.unstable_mockModule('../src/shared/security/gptAccessDevicePolicyCore.js', () => ({
  validateGptAccessDeviceRecord: validateRecord,
  matchesGptAccessDeviceJobOwner: matchesOwner,
}));
jest.unstable_mockModule('../src/services/actionPlanExecution/canonical.js', () => ({
  ...canonical, hashLocalAgentIdempotencyKey: hashKey,
}));
const { runIosDevicePolicyPreview } = await import('../src/shared/ios/iosDevicePreviewFixture.js');

beforeEach(() => {
  validateRecord.mockReset().mockImplementation(policy.validateGptAccessDeviceRecord);
  matchesOwner.mockReset().mockImplementation(policy.matchesGptAccessDeviceJobOwner);
  hashKey.mockReset().mockImplementation(canonical.hashLocalAgentIdempotencyKey);
});

describe('sealed device policy production-core proof', () => {
  test('returns the exact bounded proof only after real policy checks pass', () => {
    expect(runIosDevicePolicyPreview()).toEqual({
      ok: true, synthetic: true, proofVersion: 'ios-device-policy/v1',
      boundaries: { grantSchema: true, credentialStatePolicy: true, deviceJobOwnership: true, requesterIdempotency: true },
      checks: { grantAndOriginValidation: true, credentialExpiryAndRenewal: true, revocationAndAudience: true,
        ownerIsolation: true, missingOwnerDenied: true, requesterIdempotencyIsolation: true, operatorIdempotencyCompatibility: true },
      protectedEffectsEnabled: false,
    });
    expect(validateRecord).toHaveBeenCalledTimes(11);
    expect(matchesOwner).toHaveBeenCalledTimes(11);
    expect(hashKey).toHaveBeenCalledTimes(6);
  });

  test('withholds proof when credential state denials are bypassed', () => {
    validateRecord.mockImplementation(() => undefined);
    expect(runIosDevicePolicyPreview).toThrow('IOS_DEVICE_PREVIEW_FIXTURE_FAILED');
  });

  test.each(['deviceId', 'principalId', 'workspaceId'] as const)('withholds proof if ownership stops comparing %s', field => {
    matchesOwner.mockImplementation((owner, device) => {
      if (owner && typeof owner === 'object' && !Array.isArray(owner)) {
        return policy.matchesGptAccessDeviceJobOwner({ ...owner, [field]: device[field] }, device);
      }
      return false;
    });
    expect(runIosDevicePolicyPreview).toThrow('IOS_DEVICE_PREVIEW_FIXTURE_FAILED');
  });

  test('withholds proof if a missing owner is treated as readable', () => {
    matchesOwner.mockImplementation((owner, device) => owner == null || policy.matchesGptAccessDeviceJobOwner(owner, device));
    expect(runIosDevicePolicyPreview).toThrow('IOS_DEVICE_PREVIEW_FIXTURE_FAILED');
  });

  test('detects the original cross-device idempotency collision', () => {
    hashKey.mockImplementation(key => canonical.hashScopedOpaqueValue('local-agent-idempotency-key-v1', key));
    expect(runIosDevicePolicyPreview).toThrow('IOS_DEVICE_PREVIEW_FIXTURE_FAILED');
  });

  test('withholds proof if a requester retry stops being stable', () => {
    let call = 0;
    hashKey.mockImplementation((key, device) => canonical.hashLocalAgentIdempotencyKey(`${key}-${++call}`, device));
    expect(runIosDevicePolicyPreview).toThrow('IOS_DEVICE_PREVIEW_FIXTURE_FAILED');
  });

  test('withholds proof if legacy operator bindings change', () => {
    hashKey.mockImplementation((key, device) => canonical.hashLocalAgentIdempotencyKey(key, device || 'other'));
    expect(runIosDevicePolicyPreview).toThrow('IOS_DEVICE_PREVIEW_FIXTURE_FAILED');
  });

  test('replaces private policy errors without their message, stack or cause', () => {
    validateRecord.mockImplementation(() => { throw new Error('private-device-preview-diagnostic'); });
    let failure: unknown;
    try { runIosDevicePolicyPreview(); } catch (error) { failure = error; }
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toBe('IOS_DEVICE_PREVIEW_FIXTURE_FAILED');
    expect((failure as Error).stack).not.toContain('private-device-preview-diagnostic');
    expect(failure).not.toHaveProperty('cause');
  });
});
