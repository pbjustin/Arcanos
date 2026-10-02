import {
  assertGenerativeModelResponseIdentity,
  GenerativeModelPolicyError,
  resolveGenerativeModelFromConfig,
  type GenerativeModelRole,
  type GenerativeModelRoleConfig
} from './generativeModelPolicyCore.js';

export const GENERATIVE_MODEL_POLICY_PREVIEW_VERSION = 'shared-generative-model-policy/v1';
const FAILURE = 'GENERATIVE_MODEL_POLICY_PREVIEW_FIXTURE_FAILED';
const AUTHORITY = 'ft:synthetic:preview-authority';
const ROLES: readonly GenerativeModelRole[] = [
  'intake', 'reasoning', 'final', 'final-escalation', 'audit', 'audit-escalation'
];

export interface GenerativeModelPolicyPreviewReport {
  readonly proofVersion: typeof GENERATIVE_MODEL_POLICY_PREVIEW_VERSION;
  readonly synthetic: true;
  readonly roleModels: Readonly<Record<GenerativeModelRole, string>>;
  readonly checks: Readonly<{
    roleResolution: number;
    matchingOverrides: number;
    helperRolesWithoutAuthority: number;
    unavailableAuthority: number;
    overrideConflict: number;
    acceptedReplyIdentity: number;
    rejectedReplyIdentity: number;
    deniedSyntheticTransportCalls: number;
  }>;
}

function requireProof(condition: unknown): asserts condition {
  if (!condition) throw new Error(FAILURE);
}

function configuration(authority: string): GenerativeModelRoleConfig {
  return {
    trinityIntakeModel: 'gpt-6-luna', trinityReasoningModel: 'gpt-6.1-sol',
    trinityFinalModel: authority, trinityFinalEscalationModel: authority,
    clearAuditModel: 'gpt-6-luna', clearAuditEscalationModel: 'gpt-6.1-sol'
  };
}

/**
 * Exercise the production policy and raw identity guard with fixed synthetic
 * inputs. This component neither constructs a provider nor reads runtime state.
 */
export function assertGenerativeModelPolicyPreviewFixture(): GenerativeModelPolicyPreviewReport {
  try {
    const config = configuration(AUTHORITY);
    const expectedRoles: Record<GenerativeModelRole, string> = {
      intake: 'gpt-6-luna', reasoning: 'gpt-6.1-sol', final: AUTHORITY,
      'final-escalation': AUTHORITY, audit: 'gpt-6-luna', 'audit-escalation': 'gpt-6.1-sol'
    };
    const roleModels = {} as Record<GenerativeModelRole, string>;
    const checks = {
      roleResolution: 0, matchingOverrides: 0, helperRolesWithoutAuthority: 0,
      unavailableAuthority: 0, overrideConflict: 0, acceptedReplyIdentity: 0,
      rejectedReplyIdentity: 0, deniedSyntheticTransportCalls: 0
    };

    for (const role of ROLES) {
      const resolved = resolveGenerativeModelFromConfig(config, role);
      requireProof(resolved === expectedRoles[role]);
      roleModels[role] = resolved;
      checks.roleResolution += 1;
      requireProof(resolveGenerativeModelFromConfig(config, role, ` ${resolved} `) === resolved);
      checks.matchingOverrides += 1;
    }
    requireProof(roleModels.final === roleModels['final-escalation'] && roleModels.final === AUTHORITY);

    function requirePolicyDenial(
      candidate: GenerativeModelRoleConfig,
      role: GenerativeModelRole,
      requestedModel: string | undefined,
      code: GenerativeModelPolicyError['code']
    ): void {
      let failure: unknown;
      try {
        resolveGenerativeModelFromConfig(candidate, role, requestedModel);
        // This counter is the synthetic downstream admission boundary, never a provider call.
        checks.deniedSyntheticTransportCalls += 1;
      } catch (error) {
        failure = error;
      }
      requireProof(failure instanceof GenerativeModelPolicyError && failure.code === code);
      requireProof(failure.name === 'GenerativeModelPolicyError');
    }

    const noAuthority = configuration('');
    for (const role of ['intake', 'reasoning', 'audit', 'audit-escalation'] as const) {
      requireProof(resolveGenerativeModelFromConfig(noAuthority, role) === expectedRoles[role]);
      checks.helperRolesWithoutAuthority += 1;
    }
    for (const authority of ['', '  ', 'gpt-6.1-sol', 'ft:', 'ft:invalid authority']) {
      for (const role of ['final', 'final-escalation'] as const) {
        requirePolicyDenial(configuration(authority), role, undefined, 'FINAL_AUTHORITY_UNAVAILABLE');
        checks.unavailableAuthority += 1;
      }
    }
    for (const role of ROLES) {
      for (const override of ['gpt-4.1-mini', 'ft:synthetic:other-authority', `${expectedRoles[role]}-conflicting`]) {
        requirePolicyDenial(config, role, override, 'MODEL_OVERRIDE_CONFLICT');
        checks.overrideConflict += 1;
      }
    }

    const acceptedIdentities = [
      { actual: AUTHORITY, expected: AUTHORITY },
      { actual: ` ${AUTHORITY} `, expected: ` ${AUTHORITY} ` },
      { actual: 'gpt-6.1-sol-2026-10-01', expected: 'gpt-6.1-sol' },
      { actual: 'gpt-6-luna.snapshot', expected: 'gpt-6-luna' },
      { actual: 'GPT-6.1-SOL', expected: 'gpt-6.1-sol' }
    ];
    for (const { actual, expected } of acceptedIdentities) {
      requireProof(assertGenerativeModelResponseIdentity({ model: actual }, expected) === actual.trim());
      checks.acceptedReplyIdentity += 1;
    }
    const rejectedIdentities: ReadonlyArray<{ response: { model?: unknown }; expected: string }> = [
      { response: { model: 'gpt-6.1-sol' }, expected: AUTHORITY },
      { response: { model: 'ft:synthetic:other-authority' }, expected: AUTHORITY },
      { response: { model: `${AUTHORITY}-snapshot` }, expected: AUTHORITY },
      { response: { model: AUTHORITY.toUpperCase() }, expected: AUTHORITY },
      { response: {}, expected: AUTHORITY },
      { response: { model: '  ' }, expected: AUTHORITY },
      { response: { model: 7 }, expected: AUTHORITY },
      { response: { model: 'gpt-6-luna' }, expected: 'gpt-6.1-sol' },
      { response: { model: 'gpt-6.1-solany' }, expected: 'gpt-6.1-sol' },
      { response: {}, expected: 'gpt-6.1-sol' },
      { response: { model: 42 }, expected: 'gpt-6-luna' }
    ];
    for (const { response, expected } of rejectedIdentities) {
      let failure: unknown;
      try {
        assertGenerativeModelResponseIdentity(response, expected);
      } catch (error) {
        failure = error;
      }
      requireProof(failure instanceof Error && failure.message.includes('model'));
      checks.rejectedReplyIdentity += 1;
    }
    requireProof(checks.deniedSyntheticTransportCalls === 0);

    return Object.freeze({
      proofVersion: GENERATIVE_MODEL_POLICY_PREVIEW_VERSION,
      synthetic: true,
      roleModels: Object.freeze(roleModels),
      checks: Object.freeze(checks)
    });
  } catch {
    // Configured identities, provider metadata and original error text never escape this fixture.
    throw new Error(FAILURE);
  }
}
