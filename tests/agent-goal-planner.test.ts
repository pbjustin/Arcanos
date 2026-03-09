import { describe, expect, it } from '@jest/globals';
import { planGoalExecution } from '../src/services/agentGoalPlanner.js';

describe('planGoalExecution', () => {
  it('builds a single prompt-execution step for a general goal', () => {
    const plan = planGoalExecution({
      goal: 'Summarize the current system status.'
    });

    expect(plan.executionMode).toBe('serial');
    expect(plan.selectedCapabilityIds).toEqual(['goal-fulfillment']);
    expect(plan.steps).toHaveLength(1);
    expect(plan.steps[0]).toMatchObject({
      capabilityId: 'goal-fulfillment',
      dependsOnStepIds: [],
      capabilityPayload: {
        prompt: 'Summarize the current system status.'
      }
    });
  });

  it('builds an audit-safe step followed by a dependent prompt step for mixed goals', () => {
    const plan = planGoalExecution({
      goal: 'Enable audit safe mode and summarize the current system status.',
      payload: {
        mode: 'true'
      }
    });

    expect(plan.executionMode).toBe('dag');
    expect(plan.selectedCapabilityIds).toEqual([
      'audit-safe-mode-control',
      'goal-fulfillment'
    ]);
    expect(plan.steps).toHaveLength(2);
    expect(plan.steps[0]).toMatchObject({
      stepId: 'step_1',
      capabilityId: 'audit-safe-mode-control',
      dependsOnStepIds: [],
      capabilityPayload: {
        mode: 'true'
      }
    });
    expect(plan.steps[1]).toMatchObject({
      stepId: 'step_2',
      capabilityId: 'goal-fulfillment',
      dependsOnStepIds: ['step_1']
    });
  });

  it('rejects unknown preferred capabilities', () => {
    expect(() =>
      planGoalExecution({
        goal: 'Run an unsupported capability.',
        preferredCapabilities: ['does-not-exist']
      })
    ).toThrow('Unknown capability "does-not-exist".');
  });
});
