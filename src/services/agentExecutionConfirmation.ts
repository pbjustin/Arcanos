/**
 * Confirmation intent and per-step CEF permits for one frozen agent plan.
 */

import {
  issueCefExecutionPermit,
  type CefExecutionPermit,
} from './cef/executionPermit.js';
import {
  validateCommandForExecution,
  type CommandExecutionContext,
} from './commandCenter.js';
import { getCapabilityRegistryEntry } from './agentCapabilityRegistry.js';
import { planGoalExecution } from './agentGoalPlanner.js';
import { AgentPlanningValidationError } from './agentPlanningErrors.js';
import type {
  AgentExecutionPlan,
  AgentGoalExecutionRequest,
} from './agentExecutionTypes.js';

export type AgentExecutionPermitsByStepId = ReadonlyMap<
  string,
  CefExecutionPermit
>;

function cloneAndFreezeJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return Object.freeze(value.map(entry => cloneAndFreezeJsonValue(entry)));
  }
  if (value && typeof value === 'object') {
    return Object.freeze(
      Object.fromEntries(
        Object.entries(value as Record<string, unknown>).map(([key, entry]) => [
          key,
          cloneAndFreezeJsonValue(entry),
        ])
      )
    );
  }
  return value;
}

function freezeAgentExecutionPlan(plan: AgentExecutionPlan): AgentExecutionPlan {
  return Object.freeze({
    planId: plan.planId,
    goal: plan.goal,
    executionMode: plan.executionMode,
    selectedCapabilityIds: Object.freeze([...plan.selectedCapabilityIds]),
    steps: Object.freeze(
      plan.steps.map(step => Object.freeze({
        stepId: step.stepId,
        capabilityId: step.capabilityId,
        reason: step.reason,
        dependsOnStepIds: Object.freeze([...step.dependsOnStepIds]),
        capabilityPayload: cloneAndFreezeJsonValue(
          step.capabilityPayload
        ) as Record<string, unknown>,
      }))
    ),
  }) as AgentExecutionPlan;
}

/**
 * Plan once, validate every resulting CEF payload, and freeze the exact plan.
 */
export function prepareAgentExecutionPlan(
  request: AgentGoalExecutionRequest
): AgentExecutionPlan {
  const plan = planGoalExecution(request);
  const canonicalSteps = plan.steps.map(step => {
    const capability = getCapabilityRegistryEntry(step.capabilityId);
    if (!capability) {
      throw new AgentPlanningValidationError(
        'AGENT_UNKNOWN_CAPABILITY',
        `Unknown capability "${step.capabilityId}".`
      );
    }
    const validation = validateCommandForExecution(
      capability.cefCommandName,
      step.capabilityPayload
    );
    if (!validation.ok) {
      throw new AgentPlanningValidationError(
        'AGENT_INVALID_COMMAND_PAYLOAD',
        `Capability "${step.capabilityId}" produced an invalid CEF payload.`,
        {
          stepId: step.stepId,
          command: capability.cefCommandName,
        }
      );
    }
    return {
      ...step,
      capabilityPayload: validation.payload,
    };
  });

  return freezeAgentExecutionPlan({
    ...plan,
    steps: canonicalSteps,
  });
}

/**
 * Build stable confirmation intent without random plan/execution identifiers.
 */
export function buildAgentPlanConfirmationIntent(
  plan: AgentExecutionPlan
): Record<string, unknown> {
  return {
    protocol: 'cef-agent-plan-confirmation-v1',
    goal: plan.goal,
    executionMode: plan.executionMode,
    selectedCapabilityIds: [...plan.selectedCapabilityIds],
    steps: plan.steps.map(step => {
      const capability = getCapabilityRegistryEntry(step.capabilityId);
      if (!capability) {
        throw new AgentPlanningValidationError(
          'AGENT_UNKNOWN_CAPABILITY',
          `Unknown capability "${step.capabilityId}".`
        );
      }
      return {
        stepId: step.stepId,
        capabilityId: step.capabilityId,
        command: capability.cefCommandName,
        dependsOnStepIds: [...step.dependsOnStepIds],
        payload: step.capabilityPayload,
      };
    }),
  };
}

/**
 * Derive one non-serializable, single-use permit per confirmed plan step.
 */
export function issueAgentPlanExecutionPermits(
  plan: AgentExecutionPlan
): AgentExecutionPermitsByStepId {
  const permitsByStepId = new Map<string, CefExecutionPermit>();

  for (const step of plan.steps) {
    const capability = getCapabilityRegistryEntry(step.capabilityId);
    if (!capability) {
      throw new AgentPlanningValidationError(
        'AGENT_UNKNOWN_CAPABILITY',
        `Unknown capability "${step.capabilityId}".`
      );
    }
    const permitContext: CommandExecutionContext = {
      source: 'agent-execution-service',
      capabilityId: step.capabilityId,
      stepId: step.stepId,
    };
    permitsByStepId.set(
      step.stepId,
      issueCefExecutionPermit(
        capability.cefCommandName,
        step.capabilityPayload,
        permitContext
      )
    );
  }

  return permitsByStepId;
}
