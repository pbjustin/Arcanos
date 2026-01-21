export type ReinforcementMode = 'off' | 'reinforcement';
export type ClearScoreScale = '0-1' | '0-10';

export interface ReinforcementConfig {
  mode: ReinforcementMode;
  window: number;
  digestSize: number;
  minimumClearScore: number;
}

export type ReinforcementSource = 'prompt' | 'reinforce' | 'audit' | 'trace';

export interface ReinforcementContextEntry {
  id: string;
  timestamp: number;
  source: ReinforcementSource;
  summary: string;
  requestId?: string;
  metadata?: Record<string, unknown>;
  bias?: 'positive' | 'negative' | 'neutral';
  score?: number;
  patternId?: string;
}

export interface ReinforcementTraceEvent {
  traceId: string;
  requestId?: string;
  method: string;
  path: string;
  statusCode: number;
  durationMs: number;
  timestamp: string;
}

export interface ClearFeedbackPayload {
  system: string;
  requestId: string;
  payload: {
    CLEAR_score?: number;
    scores?: {
      clarity: number;
      leverage: number;
      efficiency: number;
      alignment: number;
      resilience: number;
    };
    asset?: string;
    revision?: string;
    recommendations?: string[];
    score_scale?: ClearScoreScale;
    pattern_id?: string;
    [key: string]: unknown;
  };
}

export interface AuditRecord {
  id: string;
  requestId: string;
  timestamp: number;
  clearScore: number;
  normalizedClearScore: number;
  scoreScale: ClearScoreScale;
  patternId?: string;
  accepted: boolean;
  payload: Record<string, unknown>;
}

export interface AuditResult {
  accepted: boolean;
  traceId: string;
  record: AuditRecord;
  delivered: boolean;
  deliveryMessage?: string;
}

export interface MemoryDigestEntry {
  id: string;
  source: ReinforcementSource;
  summary: string;
  timestamp: string;
  score?: number;
  patternId?: string;
}

export interface MemoryDigestResponse {
  mode: ReinforcementMode;
  window: number;
  digest: string[];
  entries: MemoryDigestEntry[];
  last_audit?: string;
}

export interface ReinforcementHealth {
  status: 'ok' | 'disabled';
  mode: ReinforcementMode;
  window: number;
  digestSize: number;
  storedContexts: number;
  audits: number;
  minimumClearScore: number;
  lastAudit?: string;
}
