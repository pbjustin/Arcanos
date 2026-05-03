import { describe, expect, it } from '@jest/globals';

import {
  evaluateSelfHealOperatorApproval,
  readSelfHealOperatorApprovalFromEnv
} from '../src/services/selfImprove/operatorApproval.js';

describe('self-heal operator approval gate', () => {
  it('does not require approval for read-only or local actions', () => {
    expect(evaluateSelfHealOperatorApproval({
      action: 'read railway status',
      required: false
    })).toEqual({
      required: false,
      satisfied: true,
      gate: 'none',
      reason: null,
      approvedBy: null
    });
  });

  it('blocks privileged actions without explicit approval metadata', () => {
    const decision = evaluateSelfHealOperatorApproval({
      action: 'restart_service',
      required: true,
      approval: {
        approved: true,
        approvedBy: 'operator:test'
      }
    });

    expect(decision).toEqual(expect.objectContaining({
      required: true,
      satisfied: false,
      gate: 'self-heal-operator-approval'
    }));
    expect(decision.reason).toContain('requires explicit operator approval');
  });

  it('accepts explicit approval only when approvedBy and reason are present', () => {
    const decision = evaluateSelfHealOperatorApproval({
      action: 'redeploy_service',
      required: true,
      approval: {
        approved: true,
        approvedBy: 'operator:test',
        reason: 'manual incident response approval'
      }
    });

    expect(decision).toEqual({
      required: true,
      satisfied: true,
      gate: 'self-heal-operator-approval',
      reason: 'manual incident response approval',
      approvedBy: 'operator:test'
    });
  });

  it('reads explicit approval from the environment without exposing tokens', () => {
    const approval = readSelfHealOperatorApprovalFromEnv({
      SELF_HEAL_OPERATOR_ACTION_APPROVED: 'true',
      SELF_HEAL_OPERATOR_ACTION_APPROVED_BY: 'operator:test',
      SELF_HEAL_OPERATOR_ACTION_REASON: 'approved for controlled recovery'
    });

    expect(approval).toEqual({
      approved: true,
      approvedBy: 'operator:test',
      reason: 'approved for controlled recovery'
    });
  });
});
