export const DISPATCH_CONFIDENCE_THRESHOLD = 0.8;
export const DISPATCH_UTTERANCE_MAX_LENGTH = 1000;
export const INTENT_CLARIFICATION_REQUIRED = 'INTENT_CLARIFICATION_REQUIRED';

export type DispatchPlanSource = 'rules' | 'llm' | 'legacy';

export type DispatchPlan = {
  action: string;
  payload: unknown;
  confidence: number;
  source: DispatchPlanSource;
  requiresConfirmation: boolean;
  reason?: string;
  candidates?: Array<{
    action: string;
    confidence: number;
    reason?: string;
  }>;
};

export type DispatchRiskLevel = 'readonly' | 'privileged' | 'destructive';

export type DispatchRunner =
  | {
      kind: 'gpt-access-mcp';
      tool: string;
    }
  | {
      kind: 'gpt-access-diagnostics';
    }
  | {
      kind: 'gpt-access-capability';
      capabilityId: string;
      capabilityAction: string;
    };

export type DispatchRegistryAction = {
  action: string;
  description?: string;
  payload?: unknown;
  requiredScope?: string;
  risk: DispatchRiskLevel;
  requiresConfirmation?: boolean;
  runner: DispatchRunner;
};

export interface CapabilityRegistry {
  getAction(action: string): DispatchRegistryAction | null;
  hasAction(action: string): boolean;
  listActions(): readonly DispatchRegistryAction[];
}

export type DispatchPolicyStatus =
  | 'allowed'
  | 'blocked'
  | 'confirmation_required'
  | 'clarification_required';

export type DispatchPolicyDecision = {
  status: DispatchPolicyStatus;
  allowed: boolean;
  requiresConfirmation: boolean;
  shouldExecute: boolean;
  action: string;
  reason: string;
  code?: string;
  requiredScope?: string;
  registryAction?: DispatchRegistryAction;
};

export type ResolveDispatchPlanInput = {
  utterance: string;
  registry: CapabilityRegistry;
  llmRegistry?: CapabilityRegistry;
  context?: Record<string, unknown>;
};

export type DispatchExecutionResult = {
  statusCode: number;
  payload: unknown;
};
