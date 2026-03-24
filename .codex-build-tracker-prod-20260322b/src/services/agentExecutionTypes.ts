/**
 * Shared types for the capability-planner execution layer above the CEF.
 */

import type { CommandName } from './commandCenter.js';

export type AgentRequestedExecutionMode = 'auto' | 'serial' | 'dag';
export type AgentResolvedExecutionMode = 'serial' | 'dag';
export type AgentExecutionStatus = 'completed' | 'failed';
export type AgentStepExecutionStatus = 'completed' | 'failed' | 'skipped';
export type AgentTraceLevel = 'info' | 'warn' | 'error';

export interface AgentGoalExecutionRequest {
  goal: string;
  executionMode?: AgentRequestedExecutionMode;
  preferredCapabilities?: string[];
  payload?: Record<string, unknown>;
  sharedState?: Record<string, unknown>;
  sessionId?: string;
  traceId?: string;
}

export interface AgentCapabilityPlanningContext {
  goal: string;
  requestPayload: Record<string, unknown>;
}

export interface CapabilityRegistryEntry {
  capabilityId: string;
  label: string;
  description: string;
  cefCommandName: CommandName;
  buildCapabilityPayload(context: AgentCapabilityPlanningContext): Record<string, unknown>;
}

export interface AgentPlannedCapabilityStep {
  stepId: string;
  capabilityId: string;
  reason: string;
  dependsOnStepIds: string[];
  capabilityPayload: Record<string, unknown>;
}

export interface AgentExecutionPlan {
  planId: string;
  goal: string;
  executionMode: AgentResolvedExecutionMode;
  selectedCapabilityIds: string[];
  steps: AgentPlannedCapabilityStep[];
}

export interface AgentExecutionTraceEvent {
  timestamp: string;
  level: AgentTraceLevel;
  message: string;
  metadata: Record<string, unknown>;
}

export interface AgentCommandStepExecutionResult {
  stepId: string;
  capabilityId: string;
  commandName: CommandName;
  status: AgentStepExecutionStatus;
  success: boolean;
  message: string;
  output: unknown | null;
  commandMetadata: Record<string, unknown> | null;
  startedAt: string;
  completedAt: string;
  error: string | null;
}

export interface AgentDagExecutionSummary {
  dagId: string;
  status: 'success' | 'failed' | 'cancelled';
  failedNodeIds: string[];
  skippedNodeIds: string[];
  cancelledNodeIds: string[];
  tokenBudgetUsed: number;
  totalAiCalls: number;
  totalRetries: number;
  maxParallelNodesObserved: number;
  startedAt: string;
  completedAt: string;
}

export interface AgentGoalExecutionResponse {
  executionId: string;
  traceId: string;
  goal: string;
  planner: {
    planId: string;
    executionMode: AgentResolvedExecutionMode;
    selectedCapabilityIds: string[];
    steps: Array<{
      stepId: string;
      capabilityId: string;
      reason: string;
      dependsOnStepIds: string[];
      capabilityPayload: Record<string, unknown>;
    }>;
  };
  execution: {
    status: AgentExecutionStatus;
    startedAt: string;
    completedAt: string;
    steps: AgentCommandStepExecutionResult[];
    dagSummary: AgentDagExecutionSummary | null;
    finalOutput: unknown | null;
  };
  logs: AgentExecutionTraceEvent[];
}
