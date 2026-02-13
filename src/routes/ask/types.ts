import type {
  AIRequestDTO,
  AIResponseDTO,
  ClientContextDTO
} from "@shared/types/dto.js";

export type AskMode = 'chat' | 'system_review' | 'system_state';

export interface SchemaValidationBypassAuditFlag {
  auditFlag: 'SCHEMA_VALIDATION_BYPASS';
  reason: string;
  timestamp: string;
}

export type AskRequest = AIRequestDTO & {
  prompt?: string;
  message?: string;
  mode?: AskMode | string;
  subject?: string;
  expectedVersion?: number;
  patch?: {
    confidence?: number;
    phase?: 'exploration' | 'execution';
    status?: 'active' | 'paused' | 'completed';
    label?: string;
  };
  sessionId?: string;
  overrideAuditSafe?: string;
  clientContext?: ClientContextDTO;
};

export interface AskResponse extends AIResponseDTO {
  routingStages?: string[];
  gpt5Used?: boolean;
  auditSafe?: {
    mode: boolean;
    overrideUsed: boolean;
    overrideReason?: string;
    auditFlags: string[];
    processedSafely: boolean;
  };
  memoryContext?: {
    entriesAccessed: number;
    contextSummary: string;
    memoryEnhanced: boolean;
  };
  taskLineage?: {
    requestId: string;
    logged: boolean;
  };
  clientContext?: ClientContextDTO;
  auditFlag?: SchemaValidationBypassAuditFlag;
}

export interface SystemReviewRisk {
  level: 'low' | 'medium' | 'high';
  area: string;
  description: string;
  mitigation: string;
}

export interface SystemReviewRecommendation {
  priority: 'low' | 'medium' | 'high';
  action: string;
  rationale: string;
}

export interface SystemReviewResponse {
  mode: 'system_review';
  subject: 'intent_system';
  verdict: 'approved' | 'approved_with_risks' | 'blocked';
  summary: string;
  strengths: string[];
  risks: SystemReviewRisk[];
  gaps: string[];
  recommendations: SystemReviewRecommendation[];
  assumptions: string[];
  confidence: number;
  reviewedAt: string;
  reviewVersion: 1;
}

export interface SystemStateIntentDTO {
  intentId: string | null;
  label: string | null;
  status: 'active' | 'paused' | 'completed' | null;
  phase: 'exploration' | 'execution' | null;
  confidence: number;
  version: number;
  lastTouchedAt: string | null;
}

export interface SystemStateResponse {
  mode: 'system_state';
  intent: SystemStateIntentDTO;
  routing: {
    preferred: 'local' | 'backend';
    lastUsed: 'local' | 'backend';
    confidenceGate: number;
  };
  backend: {
    connected: true;
    registryAvailable: true;
    lastHeartbeatAt: string;
  };
  stateFreshness: {
    intent: 'fresh' | 'stale';
    backend: 'fresh' | 'degraded';
    lastValidatedAt: string;
  };
  limits: {
    rateLimited: boolean;
    remainingRequests: number;
  };
  generatedAt: string;
  confidence: number;
}
