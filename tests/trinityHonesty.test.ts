import { describe, expect, it } from '@jest/globals';

import {
  createDefaultTrinityReasoningHonesty,
  deriveTrinityCapabilityFlags,
  enforceFinalStageHonesty,
  type TrinityReasoningHonesty
} from '../src/core/logic/trinityHonesty.js';

describe('Trinity honesty controls', () => {
  it('defaults every capability flag to false unless explicitly tool-backed', () => {
    expect(deriveTrinityCapabilityFlags()).toEqual({
      canBrowse: false,
      canVerifyLiveData: false,
      canConfirmExternalState: false,
      canPersistData: false,
      canCallBackend: false
    });

    expect(deriveTrinityCapabilityFlags({
      browse: true,
      verifyLiveData: true,
      confirmExternalState: true,
      persistData: true,
      callBackend: true
    })).toEqual({
      canBrowse: true,
      canVerifyLiveData: true,
      canConfirmExternalState: true,
      canPersistData: true,
      canCallBackend: true
    });
  });

  it('rewrites unsupported live-verification claims into partial-refusal language while keeping useful content', () => {
    const reasoningHonesty: TrinityReasoningHonesty = {
      responseMode: 'partial_refusal',
      achievableSubtasks: ['build the launch plan'],
      blockedSubtasks: ['verify the latest competitor moves'],
      userVisibleCaveats: ['Current competitor activity is unverified here.'],
      evidenceTags: [
        {
          claimText: 'Competitor reactions follow general market patterns.',
          sourceType: 'inference',
          confidence: 'low',
          verificationStatus: 'inferred'
        }
      ]
    };

    const result = enforceFinalStageHonesty(
      'I checked the latest competitor moves and verified they cut pricing today.\n\nHere is the launch plan: lead with differentiated positioning and a fast FAQ loop.',
      reasoningHonesty,
      deriveTrinityCapabilityFlags()
    );

    expect(result.blocked).toBe(true);
    expect(result.blockedCategories).toEqual(expect.arrayContaining(['live_verification', 'current_external_state']));
    expect(result.text).toContain("I can help with build the launch plan, but I can't verify the latest competitor moves here.");
    expect(result.text).toContain('I can help with general guidance, but I cannot verify live or current external information here.');
    expect(result.text).toContain('Here is the launch plan: lead with differentiated positioning and a fast FAQ loop.');
    expect(result.text).not.toMatch(/I checked|verified they cut pricing today/i);
  });

  it('preserves live-verification wording when tool-backed verified evidence exists', () => {
    const reasoningHonesty: TrinityReasoningHonesty = {
      ...createDefaultTrinityReasoningHonesty(),
      evidenceTags: [
        {
          claimText: 'Verified the latest competitor moves through tool evidence.',
          sourceType: 'tool',
          confidence: 'high',
          verificationStatus: 'verified'
        }
      ]
    };

    const result = enforceFinalStageHonesty(
      'I checked the latest competitor moves and verified they launched a pricing change today.',
      reasoningHonesty,
      deriveTrinityCapabilityFlags({
        verifyLiveData: true,
        confirmExternalState: true
      })
    );

    expect(result.blocked).toBe(false);
    expect(result.text).toBe('I checked the latest competitor moves and verified they launched a pricing change today.');
  });

  it('blocks backend success claims without executed evidence even when the capability exists', () => {
    const result = enforceFinalStageHonesty(
      'I saved this to your database and updated the backend record.',
      createDefaultTrinityReasoningHonesty(),
      deriveTrinityCapabilityFlags({
        persistData: true,
        callBackend: true
      })
    );

    expect(result.blocked).toBe(true);
    expect(result.blockedCategories).toEqual(['backend_action']);
    expect(result.text).toContain('I have not executed any backend or persistence action here.');
    expect(result.text).not.toMatch(/saved this|updated the backend/i);
  });
});
