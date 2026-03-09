/**
 * Goal planner that converts user goals into capability-backed CEF command plans.
 */

import { generateRequestId } from '@shared/idGenerator.js';
import {
  getCapabilityRegistryEntry,
  hasResolvableAuditSafeModeGoal,
  isAuditInstructionGoal,
  shouldPlanGoalFulfillmentCapability
} from './agentCapabilityRegistry.js';
import type {
  AgentCapabilityPlanningContext,
  AgentExecutionPlan,
  AgentGoalExecutionRequest,
  AgentPlannedCapabilityStep,
  AgentResolvedExecutionMode
} from './agentExecutionTypes.js';

function createPlanningContext(request: AgentGoalExecutionRequest): AgentCapabilityPlanningContext {
  return {
    goal: request.goal,
    requestPayload: request.payload ?? {}
  };
}

function deduplicateCapabilityIds(capabilityIds: string[]): string[] {
  return Array.from(new Set(capabilityIds));
}

function resolveCapabilityIdsForGoal(request: AgentGoalExecutionRequest): string[] {
  const planningContext = createPlanningContext(request);

  if (Array.isArray(request.preferredCapabilities) && request.preferredCapabilities.length > 0) {
    return deduplicateCapabilityIds(request.preferredCapabilities.map(capabilityId => capabilityId.trim()).filter(Boolean));
  }

  const inferredCapabilityIds: string[] = [];

  if (hasResolvableAuditSafeModeGoal(planningContext)) {
    inferredCapabilityIds.push('audit-safe-mode-control');
  } else if (isAuditInstructionGoal(planningContext)) {
    inferredCapabilityIds.push('audit-safe-instruction-routing');
  }

  if (shouldPlanGoalFulfillmentCapability(planningContext, inferredCapabilityIds)) {
    inferredCapabilityIds.push('goal-fulfillment');
  }

  //audit Assumption: every executable goal must resolve to at least one capability-backed step; failure risk: the planner emits an empty plan that appears valid but performs no work; expected invariant: fallback planning always schedules at least the prompt capability; handling strategy: append `goal-fulfillment` when no other capability was selected.
  if (inferredCapabilityIds.length === 0) {
    inferredCapabilityIds.push('goal-fulfillment');
  }

  return deduplicateCapabilityIds(inferredCapabilityIds);
}

function resolveExecutionMode(
  request: AgentGoalExecutionRequest,
  plannedStepCount: number
): AgentResolvedExecutionMode {
  if (request.executionMode === 'serial') {
    return 'serial';
  }

  if (request.executionMode === 'dag') {
    return 'dag';
  }

  //audit Assumption: multi-step goals benefit from DAG scheduling even when the first implementation still produces a mostly linear plan; failure risk: future parallelizable steps never use the DAG path under auto mode; expected invariant: one-step plans stay serial and multi-step plans default to DAG execution; handling strategy: auto-select DAG whenever more than one step is present.
  return plannedStepCount > 1 ? 'dag' : 'serial';
}

function buildStepReason(capabilityId: string): string {
  switch (capabilityId) {
    case 'audit-safe-mode-control':
      return 'The goal explicitly requests a direct audit-safe mode change.';
    case 'audit-safe-instruction-routing':
      return 'The goal references audit-safe instruction handling rather than a direct mode value.';
    case 'goal-fulfillment':
    default:
      return 'The goal requires execution through the core AI prompt CEF command.';
  }
}

function buildPlannedSteps(
  capabilityIds: string[],
  request: AgentGoalExecutionRequest
): AgentPlannedCapabilityStep[] {
  const planningContext = createPlanningContext(request);
  const steps: AgentPlannedCapabilityStep[] = [];
  let previousAuditMutationStepId: string | null = null;

  capabilityIds.forEach((capabilityId, index) => {
    const capability = getCapabilityRegistryEntry(capabilityId);

    //audit Assumption: preferred capability ids must map to a registered capability definition; failure risk: the planner emits a phantom step that cannot execute; expected invariant: every selected capability resolves to a registry entry; handling strategy: throw a precise planning error when a capability is unknown.
    if (!capability) {
      throw new Error(`Unknown capability "${capabilityId}".`);
    }

    const stepId = `step_${index + 1}`;
    const dependsOnStepIds: string[] = [];

    //audit Assumption: audit-safe mutating steps must remain ordered to avoid non-deterministic mode changes; failure risk: concurrent audit-mode commands race and leave the CEF in an unexpected state; expected invariant: audit mutations run serially and prompt execution waits for the last mutation; handling strategy: chain audit steps and make `goal-fulfillment` depend on the latest audit mutation when present.
    if (capability.capabilityId === 'goal-fulfillment' && previousAuditMutationStepId) {
      dependsOnStepIds.push(previousAuditMutationStepId);
    }

    if (
      capability.capabilityId === 'audit-safe-mode-control' ||
      capability.capabilityId === 'audit-safe-instruction-routing'
    ) {
      if (previousAuditMutationStepId) {
        dependsOnStepIds.push(previousAuditMutationStepId);
      }
      previousAuditMutationStepId = stepId;
    }

    steps.push({
      stepId,
      capabilityId: capability.capabilityId,
      reason: buildStepReason(capability.capabilityId),
      dependsOnStepIds,
      capabilityPayload: capability.buildCapabilityPayload(planningContext)
    });
  });

  return steps;
}

/**
 * Convert one goal request into a structured capability/command execution plan.
 *
 * Purpose:
 * - Translate a human goal into deterministic capability steps with explicit dependencies.
 *
 * Inputs/outputs:
 * - Input: goal execution request.
 * - Output: execution plan containing ordered capability ids and capability payloads.
 *
 * Edge case behavior:
 * - Throws when a preferred capability is unknown or when a selected capability cannot build a valid command payload.
 */
export function planGoalExecution(request: AgentGoalExecutionRequest): AgentExecutionPlan {
  const capabilityIds = resolveCapabilityIdsForGoal(request);
  const steps = buildPlannedSteps(capabilityIds, request);

  return {
    planId: generateRequestId('agentplan'),
    goal: request.goal,
    executionMode: resolveExecutionMode(request, steps.length),
    selectedCapabilityIds: capabilityIds,
    steps
  };
}
