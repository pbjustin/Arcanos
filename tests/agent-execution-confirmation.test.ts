import { describe, expect, it, jest } from '@jest/globals';

const mockValidateCommandForExecution = jest.fn(
  (command: string, payload: Record<string, unknown>) => ({
    ok: true as const,
    command,
    payload: {
      prompt: `canonical:${String(payload.prompt)}`,
    },
  })
);

jest.unstable_mockModule('@services/commandCenter.js', () => ({
  listAvailableCommands: () => [
    { name: 'audit-safe:set-mode' },
    { name: 'audit-safe:interpret' },
    { name: 'ai:prompt' },
  ],
  validateCommandForExecution: mockValidateCommandForExecution,
}));

const {
  buildAgentPlanConfirmationIntent,
  issueAgentPlanExecutionPermits,
  prepareAgentExecutionPlan,
} = await import('../src/services/agentExecutionConfirmation.js');
const {
  consumeCefExecutionPermit,
} = await import('../src/services/cef/executionPermit.js');

describe('agent execution confirmation canonicalization', () => {
  it('freezes, fingerprints, and permits the schema-canonical step payload', () => {
    const plan = prepareAgentExecutionPlan({
      goal: 'Summarize status.',
    });
    const step = plan.steps[0]!;
    const canonicalPayload = {
      prompt: 'canonical:Summarize status.',
    };

    expect(mockValidateCommandForExecution).toHaveBeenCalledWith(
      'ai:prompt',
      { prompt: 'Summarize status.' }
    );
    expect(step.capabilityPayload).toEqual(canonicalPayload);
    expect(Object.isFrozen(plan)).toBe(true);
    expect(Object.isFrozen(step.capabilityPayload)).toBe(true);

    const intent = buildAgentPlanConfirmationIntent(plan);
    expect(intent.steps).toEqual([
      expect.objectContaining({
        command: 'ai:prompt',
        payload: canonicalPayload,
      }),
    ]);

    const permits = issueAgentPlanExecutionPermits(plan);
    expect(consumeCefExecutionPermit(
      permits.get(step.stepId),
      'ai:prompt',
      canonicalPayload,
      {
        source: 'agent-execution-service',
        capabilityId: step.capabilityId,
        stepId: step.stepId,
      }
    )).toBe(true);
  });
});
