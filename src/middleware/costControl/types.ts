import type { AuditLogger } from '../../utils/auditLogger.js';
import type { IdleManager } from '../../utils/idleManager.js';

export type IdleState = 'active' | 'idle' | 'critical';

export interface CacheEntry {
  prompt: string;
  response: unknown;
  timestamp: number;
}

export interface CostControlConfig {
  cacheTtlMs: number;
  batchWindowMs: number;
  rateLimitPerMinute: number;
  requestTimeoutMs: number;
  batchEndpointPath: string;
  defaultTokenLimit: number;
}

export interface IdleStateSnapshot {
  state: IdleState;
}

export interface IdleStateProvider {
  getState: () => IdleStateSnapshot;
  noteTraffic?: (meta?: Record<string, unknown>) => void;
}

export interface OpenAIRequestPayload {
  prompt: string;
  model?: string;
  maxTokens?: number;
  metadata?: Record<string, unknown>;
}

export interface OpenAIClient {
  call: (payload: OpenAIRequestPayload) => Promise<unknown>;
  batch: (payloads: OpenAIRequestPayload[]) => Promise<unknown[]>;
}

export interface CostControlDependencies {
  openaiClient?: OpenAIClient;
  idleStateProvider?: IdleStateProvider;
  audit?: AuditLogger;
  now?: () => number;
}

export interface BatchQueueItem {
  prompt: string;
  payload: OpenAIRequestPayload;
  respond: (result: unknown) => void;
  reject: (error: Error) => void;
}

export type IdleManagerLogger = {
  log: (message: string, metadata?: unknown) => void;
};

export type IdleManagerFactory = (logger: IdleManagerLogger) => IdleManager;
