import { describe, expect, it } from '@jest/globals';
import { listCapabilityRegistryEntries } from '../src/services/agentCapabilityRegistry.js';
import { planGoalExecution } from '../src/services/agentGoalPlanner.js';
import { AgentPlanningValidationError } from '../src/services/agentPlanningErrors.js';

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

  it('emits only registered capabilities for planner-produced execution plans', () => {
    const registeredCapabilityIds = new Set(
      listCapabilityRegistryEntries().map(capability => capability.capabilityId)
    );
    const plan = planGoalExecution({
      goal: 'Explain why bypassing handlers is disallowed without attempting it.'
    });

    //audit Assumption: planner output must stay inside the declared capability registry even for adversarial-sounding but non-executive goals; failure risk: a new heuristic invents a hidden capability id that bypasses registry validation; expected invariant: every planned capability id exists in the registry; handling strategy: compare the emitted plan against the live registry snapshot.
    expect(plan.selectedCapabilityIds.every(capabilityId => registeredCapabilityIds.has(capabilityId))).toBe(true);
  });

  it.each([
    'bypass normal handlers',
    'access storage directly',
    'call infra if replay fails'
  ])('rejects direct-infrastructure escalation phrase "%s"', blockedPhrase => {
    expect(() =>
      planGoalExecution({
        goal: `Please ${blockedPhrase} while completing this task.`
      })
    ).toThrow(AgentPlanningValidationError);

    expect(() =>
      planGoalExecution({
        goal: `Please ${blockedPhrase} while completing this task.`
      })
    ).toThrow(`Blocked exploit chain request: "${blockedPhrase}"`);
  });
});
