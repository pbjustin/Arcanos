export interface ServiceHealth {
  ok: boolean;
  latency: number;
}

export interface HealthSnapshot {
  [service: string]: ServiceHealth | undefined;
  redis?: ServiceHealth;
  postgres?: ServiceHealth;
  api?: ServiceHealth;
}

export interface PolicyEvaluation {
  allow: boolean;
  primaryAvailable: boolean;
  backupAvailable: boolean;
  rationale: string;
}

export type RouteName = 'primary' | 'backup' | 'reject';

export interface RouteSelection {
  name: RouteName;
  reason: string;
}

export interface DecideInput {
  intent?: string;
  [key: string]: unknown;
}

export interface RouteExecutionResult {
  route: RouteName;
  input: string;
  output?: string;
  model?: string;
  cached?: boolean;
  error?: string;
  metadata?: Record<string, unknown>;
}

export interface DecisionRecord {
  id: string;
  ok: boolean;
  policy: PolicyEvaluation;
  route: RouteSelection;
  response: RouteExecutionResult;
  meta: {
    latencyMs: number;
    timestamp: string;
  };
}

export interface LogEntry {
  timestamp: string;
  input?: unknown;
  decision?: DecisionRecord;
  context?: string;
  error?: string;
}
