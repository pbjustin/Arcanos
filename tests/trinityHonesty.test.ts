import { describe, expect, it } from '@jest/globals';

import { countWords } from '../src/shared/text/countWords.js';
import {
  createDefaultTrinityReasoningHonesty,
  deriveTrinityCapabilityFlags,
  deriveTrinityOutputControls,
  enforceFinalStageHonesty,
  enforceFinalStageHonestyAndMinimalism,
  readIntentMode,
  resolveIntentMode,
  shouldExposePipelineDebug,
  type TrinityReasoningHonesty
} from '../src/core/logic/trinityHonesty.js';

describe('Trinity honesty controls', () => {
  it('defaults every capability flag to false unless explicitly tool-backed', () => {
    expect(deriveTrinityCapabilityFlags()).toEqual({
      canBrowse: false,
      canVerifyProvidedData: false,
      canVerifyLiveData: false,
      canConfirmExternalState: false,
      canPersistData: false,
      canCallBackend: false
    });

    expect(deriveTrinityCapabilityFlags({
      browse: true,
      verifyProvidedData: true,
      verifyLiveData: true,
      confirmExternalState: true,
      persistData: true,
      callBackend: true
    })).toEqual({
      canBrowse: true,
      canVerifyProvidedData: true,
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

  it('allows structural verification wording for provided dependency outputs without permitting live runtime claims', () => {
    const result = enforceFinalStageHonesty(
      'I validated the provided dependency outputs and confirmed the DAG is structurally consistent.',
      createDefaultTrinityReasoningHonesty(),
      deriveTrinityCapabilityFlags({
        verifyProvidedData: true
      })
    );

    expect(result.blocked).toBe(false);
    expect(result.text).toBe('I validated the provided dependency outputs and confirmed the DAG is structurally consistent.');
  });

  it('still blocks runtime-state verification claims when only provided-data verification is enabled', () => {
    const result = enforceFinalStageHonesty(
      'I verified the runtime behavior and confirmed the current deployment status is healthy.',
      createDefaultTrinityReasoningHonesty(),
      deriveTrinityCapabilityFlags({
        verifyProvidedData: true
      })
    );

    expect(result.blocked).toBe(true);
    expect(result.blockedCategories).toEqual(expect.arrayContaining(['live_verification', 'current_external_state']));
    expect(result.text).toContain('I can help with general guidance, but I cannot verify live or current external information here.');
    expect(result.text).not.toContain('current deployment status is healthy');
  });

  it('preserves explicit live-runtime limitation caveats instead of rewriting them into a generic refusal', () => {
    const result = enforceFinalStageHonesty(
      'Live system behavior, runtime enforcement, and regression checks remain unverified. This audit can only check the structure and consistency of what you provide, not live behavior.',
      {
        responseMode: 'partial_refusal',
        achievableSubtasks: ['Check internal consistency of the described output contract'],
        blockedSubtasks: ['Verify behaviour of a live or deployed DAG implementation'],
        userVisibleCaveats: ['This audit can only check the structure and consistency of what you provide, not live behavior.'],
        evidenceTags: []
      },
      deriveTrinityCapabilityFlags({
        verifyProvidedData: true
      })
    );

    expect(result.blocked).toBe(false);
    expect(result.text).toContain('Live system behavior, runtime enforcement, and regression checks remain unverified.');
    expect(result.text).toContain('This audit can only check the structure and consistency of what you provide, not live behavior.');
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
    expect(outputControls.intentMode).toBe('EXECUTE_TASK');
  });

  it.each([
    'Generate a prompt for Codex to update my documentation in my repo.',
    'Write instructions for another agent to inspect the repo and verify the API responses.',
    'Draft a spec for Codex to audit the transport layer and update docs.',
    'Help me make Codex fix my repo.',
    'Generate something that lets another AI update docs.',
    'Give me something I can hand to Codex to fix this.',
    'Write what I should send another model.',
    'Draft the tasking for an AI to handle this.',
    'Make the instructions another tool would follow.',
  ])('classifies "%s" as prompt generation intent', (prompt) => {
    const outputControls = deriveTrinityOutputControls(prompt, {});

    expect(outputControls.intentMode).toBe('PROMPT_GENERATION');
  });

  it.each([
    'Fix this.',
    'Inspect the repo.',
    'Update the docs.',
    'Verify the deployment config.',
  ])('keeps direct execution phrasing "%s" in execute-task mode', (prompt) => {
    const outputControls = deriveTrinityOutputControls(prompt, {});

    expect(outputControls.intentMode).toBe('EXECUTE_TASK');
  });

  it('exports shared intent-mode helpers for callers that need consistent resolution', () => {
    expect(resolveIntentMode('Write a prompt for Codex to inspect the repo.', {})).toBe('PROMPT_GENERATION');
    expect(resolveIntentMode('Inspect the repo.', { intentMode: 'PROMPT_GENERATION' })).toBe('PROMPT_GENERATION');
    expect(resolveIntentMode('Inspect the repo.', { requestIntent: 'PROMPT_GENERATION' })).toBe('PROMPT_GENERATION');
    expect(readIntentMode({ requestedVerbosity: 'normal', maxWords: null, answerMode: 'explained', debugPipeline: false, strictUserVisibleOutput: true, intentMode: 'PROMPT_GENERATION' })).toBe('PROMPT_GENERATION');
    expect(readIntentMode(undefined)).toBe('EXECUTE_TASK');
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

  it('keeps qualified live-runtime caveats during final minimalism enforcement for DAG audits', () => {
    const enforcementResult = enforceFinalStageHonestyAndMinimalism({
      text: [
        'The output contract is internally consistent with clear logic for response_mode, subtasks, and verification rules.',
        'Live system behavior, runtime enforcement, and regression checks remain unverified.',
        'This audit can only check the structure and consistency of what you provide, not live behavior.'
      ].join(' '),
      userPrompt: 'Validate the planned work using only the provided dependency outputs.',
      capabilityFlags: deriveTrinityCapabilityFlags({
        verifyProvidedData: true
      }),
      outputControls: {
        requestedVerbosity: 'normal',
        maxWords: null,
        answerMode: 'audit',
        debugPipeline: false,
        strictUserVisibleOutput: true
      },
      reasoningHonesty: {
        responseMode: 'partial_refusal',
        achievableSubtasks: ['Check internal consistency of the described output contract'],
        blockedSubtasks: ['Verify behaviour of a live or deployed DAG implementation'],
        userVisibleCaveats: ['This audit can only check the structure and consistency of what you provide, not live behavior.'],
        evidenceTags: []
      }
    });

    expect(enforcementResult.text).toContain('The output contract is internally consistent with clear logic for response_mode, subtasks, and verification rules.');
    expect(enforcementResult.text).toContain('This audit can only check the structure and consistency of what you provide, not live behavior.');
    expect(enforcementResult.text).not.toContain('I can help with general guidance, but I cannot verify live or current external information here.');
    expect(enforcementResult.blockedOrRewrittenClaims).toEqual([]);
  });

  it('preserves prompt-generation instructions that mention repo inspection without injecting capability disclaimers', () => {
    const outputControls = deriveTrinityOutputControls(
      'Generate a prompt for Codex to update my documentation in my repo.',
      {}
    );
    const enforcementResult = enforceFinalStageHonestyAndMinimalism({
      text: [
        "I can't inspect your repo from here.",
        'Prompt for Codex:',
        'Inspect the repository, identify outdated documentation, update the affected docs, and run the relevant checks before summarizing the changes.'
      ].join(' '),
      userPrompt: 'Generate a prompt for Codex to update my documentation in my repo.',
      capabilityFlags: deriveTrinityCapabilityFlags(),
      outputControls,
      reasoningHonesty: {
        responseMode: 'partial_refusal',
        achievableSubtasks: ['write a prompt for Codex'],
        blockedSubtasks: ['inspect the repository directly'],
        userVisibleCaveats: ["I can't inspect your repo from here."],
        evidenceTags: []
      }
    });

    expect(outputControls.intentMode).toBe('PROMPT_GENERATION');
    expect(enforcementResult.text).toContain('Prompt for Codex:');
    expect(enforcementResult.text).toContain('Inspect the repository');
    expect(enforcementResult.text).not.toContain("I can't inspect your repo from here.");
    expect(enforcementResult.blockedOrRewrittenClaims).toEqual([]);
  });

  it('preserves prompt-generation instructions that mention API verification for the downstream executor', () => {
    const outputControls = deriveTrinityOutputControls(
      'Write instructions for another agent to verify the API and fix any documentation drift.',
      {}
    );
    const enforcementResult = enforceFinalStageHonestyAndMinimalism({
      text: [
        'Current API behavior is unverified here.',
        'Write a prompt for Codex that verifies the live API responses, compares them with the docs, updates any mismatches, and reports the exact commands and evidence used.'
      ].join(' '),
      userPrompt: 'Write instructions for another agent to verify the API and fix any documentation drift.',
      capabilityFlags: deriveTrinityCapabilityFlags(),
      outputControls,
      reasoningHonesty: {
        responseMode: 'partial_refusal',
        achievableSubtasks: ['write instructions for another agent'],
        blockedSubtasks: ['verify live API behavior here'],
        userVisibleCaveats: ['Current API behavior is unverified here.'],
        evidenceTags: []
      }
    });

    expect(enforcementResult.text).toContain('verifies the live API responses');
    expect(enforcementResult.text).not.toContain('unverified here');
    expect(enforcementResult.text).not.toContain('cannot verify live or current external information here');
  });

  it('preserves GPT-5.1 version tokens inside partial-refusal leads without orphaning numeric fragments', () => {
    const auditReasoningHonesty: TrinityReasoningHonesty = {
      responseMode: 'partial_refusal',
      achievableSubtasks: [
        'Define structural audit checks for planner output vs evidence',
        'Specify how to flag unverifiable or overreaching claims',
        'Align audit behavior with capability constraints',
        'Map audit results into the required schema fields'
      ],
      blockedSubtasks: [
        'Perform real runtime validation of planner correctness',
        'Confirm deployment or execution in an actual GPT-5.1 system'
      ],
      userVisibleCaveats: [
        'This logic only checks structure and internal consistency, not real-world truth',
        'Live systems, external state, and deployment cannot be verified here'
      ],
      evidenceTags: []
    };
    const writerReasoningHonesty: TrinityReasoningHonesty = {
      responseMode: 'partial_refusal',
      achievableSubtasks: [
        'Describe how to structurally merge audit, build, and research outputs into a single DAG contract',
        'Provide a concise example of a generic merged DAG output schema',
        'Explain how to isolate unverifiable or inferred sections in the contract',
        'Clarify how to respect capability flags and verification constraints in the merged structure'
      ],
      blockedSubtasks: [
        'Perform an actual merge on real audit, build, and research outputs',
        'Verify that any specific concrete contract matches a hidden or external schema',
        'Confirm runtime executability of the contract in a real GPT-5.1 pipeline'
      ],
      userVisibleCaveats: [
        'No real node outputs were provided, so the merged contract is a generic template, not project-specific truth',
        'Nothing in the example is verified against a live schema or runtime',
        'You must replace all illustrative fields with your actual audit, build, and research outputs'
      ],
      evidenceTags: []
    };

    const auditHonestyResult = enforceFinalStageHonesty(
      'The audit logic validates planner output against provided evidence, flags unverifiable or overreaching claims, and enforces capability constraints within a structured schema. Real-world verification and deployment confirmation remain out of scope. This logic only checks structure and internal consistency, not real-world truth.',
      auditReasoningHonesty,
      deriveTrinityCapabilityFlags({
        verifyProvidedData: true
      })
    );
    const auditEnforcementResult = enforceFinalStageHonestyAndMinimalism({
      text: auditHonestyResult.text,
      userPrompt: 'Validate the planned work using only the provided dependency outputs. Check correctness, risks, regressions, and output-contract compliance for: Verify the DAG output contract and report any formatting or verification-stage issues.',
      capabilityFlags: deriveTrinityCapabilityFlags({
        verifyProvidedData: true
      }),
      outputControls: {
        requestedVerbosity: 'normal',
        maxWords: null,
        answerMode: 'audit',
        debugPipeline: false,
        strictUserVisibleOutput: true
      },
      reasoningHonesty: auditReasoningHonesty
    });
    const writerHonestyResult = enforceFinalStageHonesty(
      'The merged DAG contract structurally links audit, build, and research outputs into a single JSON schema with clear nodes, a consolidated merged_view, and meta capabilities reflecting all verification limits. Unverifiable sections are explicitly labeled, and all fields remain illustrative until replaced by your actual pipeline data. No real node outputs were provided, so the merged contract is a generic template, not project-specific truth.',
      writerReasoningHonesty,
      deriveTrinityCapabilityFlags()
    );
    const writerEnforcementResult = enforceFinalStageHonestyAndMinimalism({
      text: writerHonestyResult.text,
      userPrompt: 'Merge the dependency outputs from audit, build, and research into a single DAG output contract.',
      capabilityFlags: deriveTrinityCapabilityFlags(),
      outputControls: {
        requestedVerbosity: 'normal',
        maxWords: null,
        answerMode: 'audit',
        debugPipeline: false,
        strictUserVisibleOutput: true
      },
      reasoningHonesty: writerReasoningHonesty
    });

    expect(auditEnforcementResult.text).toContain('Live systems, external state, and deployment cannot be verified here.');
    expect(auditEnforcementResult.text).not.toContain('1 system here.');
    expect(auditEnforcementResult.text).toContain('The audit logic validates planner output against provided evidence');
    expect(writerEnforcementResult.text).toContain('Nothing in the example is verified against a live schema or runtime.');
    expect(writerEnforcementResult.text).not.toContain('1 pipeline here.');
    expect(writerEnforcementResult.text).toContain('The merged DAG contract structurally links audit, build, and research outputs');
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
