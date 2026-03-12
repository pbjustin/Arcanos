import { describe, expect, it } from '@jest/globals';

import { countWords } from '../src/shared/text/countWords.js';
import {
  createDefaultTrinityReasoningHonesty,
  deriveTrinityCapabilityFlags,
  deriveTrinityOutputControls,
  enforceFinalStageHonesty,
  enforceFinalStageHonestyAndMinimalism,
  shouldExposePipelineDebug,
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
        },
        {
          claimText: 'Current competitor pricing was confirmed through tool evidence.',
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

  it('derives minimal direct output controls from hard word-limit prompts', () => {
    const outputControls = deriveTrinityOutputControls(
      'Answer directly under 80 words with no extra explanation.',
      {}
    );

    expect(outputControls.requestedVerbosity).toBe('minimal');
    expect(outputControls.maxWords).toBe(80);
    expect(outputControls.answerMode).toBe('direct');
    expect(outputControls.strictUserVisibleOutput).toBe(true);
    expect(outputControls.debugPipeline).toBe(false);
  });

  it('rewrites unsupported live-verification claims and strips unrequested meta sections', () => {
    const enforcementResult = enforceFinalStageHonestyAndMinimalism({
      text: [
        "I checked the latest competitor moves and confirmed they're still pricing aggressively.",
        'PM: Mon spec; Tue-Wed build/test; Thu QA; Fri staged launch.',
        'Audit notes: claim sounded verified.'
      ].join('\n\n'),
      userPrompt: 'Give me the launch plan, but keep it concise and do not verify current competitor moves.',
      capabilityFlags: deriveTrinityCapabilityFlags(),
      outputControls: deriveTrinityOutputControls('Give the launch plan and keep it concise.', {}),
      reasoningHonesty: {
        responseMode: 'partial_refusal',
        achievableSubtasks: ['Give the launch plan'],
        blockedSubtasks: ["I can't verify current competitor moves without live browsing"],
        userVisibleCaveats: ["I can't verify current competitor moves without live browsing."],
        evidenceTags: []
      }
    });

    expect(enforcementResult.text).toContain("I can't verify current competitor moves without live browsing.");
    expect(enforcementResult.text).toContain('PM: Mon spec; Tue-Wed build/test; Thu QA; Fri staged launch.');
    expect(enforcementResult.text).not.toContain('I checked the latest competitor moves');
    expect(enforcementResult.text).not.toContain('Audit notes');
    expect(enforcementResult.removedMetaSections).toHaveLength(1);
    expect(enforcementResult.blockedOrRewrittenClaims).toEqual([
      "I checked the latest competitor moves and confirmed they're still pricing aggressively."
    ]);
  });

  it('respects a hard word limit while keeping the main answer intact', () => {
    const enforcementResult = enforceFinalStageHonestyAndMinimalism({
      text: 'Deploy in three phases. Start with staging, then a small production canary, then full rollout after metrics stay stable.',
      userPrompt: 'Answer directly under 12 words.',
      capabilityFlags: deriveTrinityCapabilityFlags(),
      outputControls: {
        requestedVerbosity: 'minimal',
        maxWords: 12,
        answerMode: 'direct',
        debugPipeline: false,
        strictUserVisibleOutput: true
      },
      reasoningHonesty: {
        responseMode: 'answer',
        achievableSubtasks: ['Give deployment guidance'],
        blockedSubtasks: [],
        userVisibleCaveats: [],
        evidenceTags: []
      }
    });

    expect(countWords(enforcementResult.text)).toBeLessThanOrEqual(12);
    expect(enforcementResult.text).toContain('Deploy');
  });

  it('does not leak debug payloads while strict user-visible output is enabled', () => {
    expect(
      shouldExposePipelineDebug({
        requestedVerbosity: 'detailed',
        maxWords: null,
        answerMode: 'debug',
        debugPipeline: true,
        strictUserVisibleOutput: true
      })
    ).toBe(false);

    expect(
      shouldExposePipelineDebug({
        requestedVerbosity: 'detailed',
        maxWords: null,
        answerMode: 'debug',
        debugPipeline: true,
        strictUserVisibleOutput: false
      })
    ).toBe(true);
  });

  it('keeps normal answers natural when no refusal is needed', () => {
    const enforcementResult = enforceFinalStageHonestyAndMinimalism({
      text: 'Here is a concise answer: cache the parsed config and invalidate it on file change.',
      userPrompt: 'How should I handle config caching?',
      capabilityFlags: deriveTrinityCapabilityFlags(),
      outputControls: {
        requestedVerbosity: 'normal',
        maxWords: null,
        answerMode: 'explained',
        debugPipeline: false,
        strictUserVisibleOutput: true
      },
      reasoningHonesty: {
        responseMode: 'answer',
        achievableSubtasks: ['Answer the config question'],
        blockedSubtasks: [],
        userVisibleCaveats: [],
        evidenceTags: []
      }
    });

    expect(enforcementResult.text).toBe('cache the parsed config and invalidate it on file change.');
    expect(enforcementResult.blockedOrRewrittenClaims).toEqual([]);
  });

  it('removes duplicated limitation sentences and keeps a single clean caveat', () => {
    const enforcementResult = enforceFinalStageHonestyAndMinimalism({
      text: [
        "I can't verify current competitor moves without live browsing.",
        "I can't verify current competitor moves without live browsing.",
        'PM: Mon spec; Tue-Wed build/test; Thu QA; Fri staged launch.'
      ].join(' '),
      userPrompt: 'Give me the launch plan and say what you can about competitor moves.',
      capabilityFlags: deriveTrinityCapabilityFlags(),
      outputControls: deriveTrinityOutputControls('Keep it concise.', {}),
      reasoningHonesty: {
        responseMode: 'partial_refusal',
        achievableSubtasks: ['Give the launch plan'],
        blockedSubtasks: ['verify current competitor moves'],
        userVisibleCaveats: ["I can't verify current competitor moves without live browsing."],
        evidenceTags: []
      }
    });

    expect(enforcementResult.text).toContain("I can't verify current competitor moves without live browsing.");
    expect(enforcementResult.text.match(/I can't verify current competitor moves without live browsing\./g)).toHaveLength(1);
    expect(enforcementResult.text).toContain('PM: Mon spec; Tue-Wed build/test; Thu QA; Fri staged launch.');
  });

  it('removes unrequested qualifier insertions that drift beyond the prompt scope', () => {
    const enforcementResult = enforceFinalStageHonestyAndMinimalism({
      text: "I can't verify current competitor moves or your actual tooling without live browsing. Lead with differentiated positioning.",
      userPrompt: 'Give me the launch plan and note any limitation around competitor moves.',
      capabilityFlags: deriveTrinityCapabilityFlags(),
      outputControls: deriveTrinityOutputControls('Keep it direct.', {}),
      reasoningHonesty: {
        responseMode: 'partial_refusal',
        achievableSubtasks: ['Give the launch plan'],
        blockedSubtasks: ['verify current competitor moves'],
        userVisibleCaveats: ["I can't verify current competitor moves without live browsing."],
        evidenceTags: []
      }
    });

    expect(enforcementResult.text).toContain("I can't verify current competitor moves without live browsing.");
    expect(enforcementResult.text).not.toContain('actual tooling');
    expect(enforcementResult.text).not.toContain('or your');
  });

  it('keeps mixed doable and impossible requests tight without stacked disclaimers', () => {
    const enforcementResult = enforceFinalStageHonestyAndMinimalism({
      text: [
        'I can help with that.',
        "I can't verify current competitor moves without live browsing.",
        "I can't verify current competitor moves without live browsing.",
        'PM: Mon spec; Tue-Wed build/test; Thu QA; Fri staged launch. Risks: drift, latency. Fallback: rollback via flag.'
      ].join(' '),
      userPrompt: 'Give me the launch plan and note that you cannot verify current competitor moves.',
      capabilityFlags: deriveTrinityCapabilityFlags(),
      outputControls: deriveTrinityOutputControls('Be concise.', {}),
      reasoningHonesty: {
        responseMode: 'partial_refusal',
        achievableSubtasks: ['Give the launch plan'],
        blockedSubtasks: ['verify current competitor moves'],
        userVisibleCaveats: ["I can't verify current competitor moves without live browsing."],
        evidenceTags: []
      }
    });

    expect(enforcementResult.text.startsWith('I can help with that.')).toBe(false);
    expect(enforcementResult.text.match(/I can't verify current competitor moves without live browsing\./g)).toHaveLength(1);
    expect(enforcementResult.text).toContain('PM: Mon spec; Tue-Wed build/test; Thu QA; Fri staged launch.');
    expect(enforcementResult.text).toContain('Fallback: rollback via flag.');
  });

  it('keeps a concise mixed answer within a hard word limit without duplicating the limitation', () => {
    const enforcementResult = enforceFinalStageHonestyAndMinimalism({
      text: [
        "I can't verify current competitor moves without live browsing.",
        "I can't verify current competitor moves without live browsing.",
        'I can help with that.',
        'Roll out behind a feature flag.'
      ].join(' '),
      userPrompt: 'Direct answer only under 16 words: give the launch recommendation and any limitation.',
      capabilityFlags: deriveTrinityCapabilityFlags(),
      outputControls: {
        requestedVerbosity: 'minimal',
        maxWords: 16,
        answerMode: 'direct',
        debugPipeline: false,
        strictUserVisibleOutput: true
      },
      reasoningHonesty: {
        responseMode: 'partial_refusal',
        achievableSubtasks: ['Give the launch recommendation'],
        blockedSubtasks: ['verify current competitor moves'],
        userVisibleCaveats: ["I can't verify current competitor moves without live browsing."],
        evidenceTags: []
      }
    });

    expect(countWords(enforcementResult.text)).toBeLessThanOrEqual(16);
    expect(enforcementResult.text.match(/I can't verify current competitor moves without live browsing\./g)).toHaveLength(1);
    expect(enforcementResult.text).not.toContain('I can help with that.');
    expect(enforcementResult.text).toContain('Roll out behind a feature flag.');
  });
});
