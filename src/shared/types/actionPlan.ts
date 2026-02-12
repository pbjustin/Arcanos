import { z } from 'zod';

// --- Status & Role Enums ---

export const PLAN_STATUSES = [
  'planned', 'awaiting_confirmation', 'approved', 'in_progress',
  'completed', 'failed', 'expired', 'blocked'
] as const;
export type PlanStatus = typeof PLAN_STATUSES[number];

export const PLAN_CREATORS = ['user', 'policy', 'system', 'recovery'] as const;
export type PlanCreator = typeof PLAN_CREATORS[number];

export const CLEAR_DECISIONS = ['allow', 'confirm', 'block'] as const;
export type ClearDecision = typeof CLEAR_DECISIONS[number];

export const AGENT_ROLES = ['executor', 'planner', 'observer'] as const;
export type AgentRole = typeof AGENT_ROLES[number];

export const AGENT_STATUSES = ['idle', 'busy', 'error'] as const;
export type AgentStatus = typeof AGENT_STATUSES[number];

export const EXECUTION_STATUSES = ['success', 'failure', 'replayed', 'rejected'] as const;
export type ExecutionStatus = typeof EXECUTION_STATUSES[number];

// --- Interfaces ---

export interface ClearScore {
  clarity: number;
  leverage: number;
  efficiency: number;
  alignment: number;
  resilience: number;
  overall: number;
  decision: ClearDecision;
  notes?: string;
}

export interface ActionDefinition {
  action_id?: string;
  agent_id: string;
  capability: string;
  params: Record<string, unknown>;
  timeout_ms?: number;
  rollback_action?: Omit<ActionDefinition, 'rollback_action'>;
}

export interface ActionPlanInput {
  created_by: PlanCreator;
  origin: string;
  confidence?: number;
  requires_confirmation?: boolean;
  idempotency_key: string;
  expires_at?: string;
  actions: ActionDefinition[];
}

export interface ActionPlanRecord {
  id: string;
  createdBy: string;
  origin: string;
  status: PlanStatus;
  confidence: number;
  requiresConfirmation: boolean;
  idempotencyKey: string;
  expiresAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  actions: ActionRecord[];
  clearScore: ClearScoreRecord | null;
  executionResults?: ExecutionResultRecord[];
}

export interface ActionRecord {
  id: string;
  planId: string;
  agentId: string;
  capability: string;
  params: unknown;
  timeoutMs: number;
  rollbackAction: unknown;
  sortOrder: number;
}

export interface ClearScoreRecord {
  id: string;
  planId: string;
  clarity: number;
  leverage: number;
  efficiency: number;
  alignment: number;
  resilience: number;
  overall: number;
  decision: string;
  notes: string | null;
  createdAt: Date;
}

export interface AgentRecord {
  id: string;
  role: string;
  capabilities: string[];
  publicKey: string | null;
  status: string;
  lastHeartbeat: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface AgentRegistration {
  role: AgentRole;
  capabilities: string[];
  public_key?: string;
}

export interface ExecutionResultRecord {
  id: string;
  planId: string;
  actionId: string;
  agentId: string;
  status: string;
  output: unknown;
  error: unknown;
  signature: string | null;
  clearDecision: string;
  createdAt: Date;
}

export interface ExecutionResultInput {
  action_id: string;
  agent_id: string;
  status: ExecutionStatus;
  output?: unknown;
  error?: unknown;
  signature?: string;
}

// --- Zod Schemas ---

export const actionDefinitionSchema = z.object({
  action_id: z.string().optional(),
  agent_id: z.string().min(1),
  capability: z.string().min(1),
  params: z.record(z.unknown()).default({}),
  timeout_ms: z.number().int().positive().optional().default(30000),
  rollback_action: z.object({
    agent_id: z.string().min(1),
    capability: z.string().min(1),
    params: z.record(z.unknown()).default({}),
    timeout_ms: z.number().int().positive().optional().default(30000),
  }).optional(),
});

export const actionPlanInputSchema = z.object({
  created_by: z.enum(PLAN_CREATORS),
  origin: z.string().min(1),
  confidence: z.number().min(0).max(1).optional().default(0),
  requires_confirmation: z.boolean().optional().default(true),
  idempotency_key: z.string().min(1),
  expires_at: z.string().datetime().optional(),
  actions: z.array(actionDefinitionSchema).min(1),
});

export const agentRegistrationSchema = z.object({
  role: z.enum(AGENT_ROLES),
  capabilities: z.array(z.string().min(1)).min(1),
  public_key: z.string().optional(),
});

export const executionResultInputSchema = z.object({
  action_id: z.string().min(1),
  agent_id: z.string().min(1),
  status: z.enum(EXECUTION_STATUSES),
  output: z.unknown().optional(),
  error: z.unknown().optional(),
  signature: z.string().optional(),
});

export const clearEvaluateInputSchema = z.object({
  actions: z.array(actionDefinitionSchema).min(1),
  origin: z.string().min(1),
  confidence: z.number().min(0).max(1).optional().default(0),
});
