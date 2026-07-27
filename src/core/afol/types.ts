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

export interface AfolPersistedDecisionRecord {
  kind: 'decision';
  id: string;
  timestamp: string;
  ok: boolean;
  route: RouteName;
  latencyMs: number;
  cached: boolean;
  degraded: boolean;
}

export type AfolErrorCategory =
  | 'decision_failed'
  | 'persistence_failed'
  | 'internal_failure';

export interface AfolPersistedErrorRecord {
  kind: 'error';
  timestamp: string;
  category: AfolErrorCategory;
}

export type AfolPersistenceRecord =
  | AfolPersistedDecisionRecord
  | AfolPersistedErrorRecord;

/**
 * Historical name retained for consumers of the AFOL log reader. New records
 * are the strict metadata-only persistence union above.
 */
export type AfolLogEntry = AfolPersistenceRecord;
