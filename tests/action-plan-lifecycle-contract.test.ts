import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from '@jest/globals';

import { evaluateActionPlanLifecycle } from '../src/services/actionPlanLifecycle.js';

type ExpectedSemantic = {
  classification: string;
  reasonCode: string;
  operationAllowed: boolean;
  policyRecheckAllowed: boolean;
  statusTransitionAllowed: boolean;
  targetStatus: string | null;
};

type LifecycleCase = {
  name: string;
  plan: { status?: unknown; expiry: string };
  operation: string;
  policy: { kind: string; provenance: string };
  expectedSemantic: ExpectedSemantic;
  expectedEffects: Record<string, Record<string, boolean>>;
};

type LifecycleContract = {
  schemaVersion: number;
  observedStatuses: string[];
  effectKeys: string[];
  cases: LifecycleCase[];
  unsupportedScenarios: Array<{
    name: string;
    expectedCategory: string;
    support: string;
    mustNotAuthorize: boolean;
  }>;
};

const contract = JSON.parse(readFileSync(
  join(process.cwd(), 'tests', 'fixtures', 'action-plan-lifecycle-contract.json'),
  'utf8',
)) as LifecycleContract;

describe('ActionPlan cross-language lifecycle contract', () => {
  it('records the exact repository vocabulary and deterministic case names', () => {
    expect(contract.schemaVersion).toBe(1);
    expect(contract.observedStatuses).toEqual([
      'planned',
      'awaiting_confirmation',
      'approved',
      'in_progress',
      'completed',
      'failed',
      'expired',
      'blocked',
    ]);
    expect(new Set(contract.cases.map(testCase => testCase.name)).size).toBe(contract.cases.length);
    expect(new Set(contract.unsupportedScenarios.map(testCase => testCase.name)).size)
      .toBe(contract.unsupportedScenarios.length);
  });

  it('uses complete, explicit effect matrices', () => {
    for (const testCase of contract.cases) {
      for (const adapter of ['typescript', 'python']) {
        expect(Object.keys(testCase.expectedEffects[adapter] ?? {}).sort())
          .toEqual([...contract.effectKeys].sort());
      }
    }
  });

  it.each(contract.cases)('$name', testCase => {
    const statusPresent = Object.hasOwn(testCase.plan, 'status');
    expect(evaluateActionPlanLifecycle({
      operation: testCase.operation,
      statusPresent,
      status: testCase.plan.status,
      policyKind: testCase.policy.kind,
      policyProvenance: testCase.policy.provenance,
      expiry: testCase.plan.expiry,
    })).toEqual(testCase.expectedSemantic);
  });

  it('marks version, confirmation, and race guarantees as unavailable or characterized', () => {
    expect(contract.unsupportedScenarios.length).toBeGreaterThanOrEqual(8);
    for (const scenario of contract.unsupportedScenarios) {
      expect(scenario.mustNotAuthorize).toBe(true);
      expect(scenario.support).toMatch(/^(unavailable_|characterized_)/);
      expect(scenario.expectedCategory).toMatch(/^ACTION_PLAN_/);
    }
  });
});
