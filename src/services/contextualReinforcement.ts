/**
 * Contextual Reinforcement Service
 * 
 * Implements a learning system that tracks AI interactions, prompt patterns,
 * and model responses to build contextual awareness and improve future predictions.
 * 
 * Features:
 * - Context window tracking for recent interactions
 * - Audit history for compliance and debugging
 * - Trace event logging for request lifecycle analysis
 * - Pattern-based bias scoring for reinforcement learning
 * - System prompt augmentation based on learned context
 * 
 * All tracking respects the configured reinforcement mode (reinforcement, audit-only, disabled).
 * 
 * @module contextualReinforcement
 */

import { randomUUID } from 'crypto';
import config from '../config/index.js';
import { aiLogger } from '../utils/structuredLogging.js';
import { generateRequestId } from '../utils/idGenerator.js';
import type {
  AuditRecord,
  ReinforcementConfig,
  ReinforcementContextEntry,
  ReinforcementHealth,
  ReinforcementTraceEvent
} from '../types/reinforcement.js';

/**
 * In-memory context window storing recent reinforcement entries.
 */
const contextWindow: ReinforcementContextEntry[] = [];

/**
 * Audit history for compliance and debugging.
 */
const auditHistory: AuditRecord[] = [];

/**
 * Trace history for request lifecycle analysis.
 */
const traceHistory: ReinforcementTraceEvent[] = [];

/**
 * Maximum number of trace events to retain in memory.
 */
const MAX_TRACE_HISTORY = 200;

/**
 * Checks if reinforcement tracking is enabled based on configuration.
 * 
 * @returns True if mode is 'reinforcement', false otherwise
 */
function shouldRecord(): boolean {
  return config.reinforcement.mode === 'reinforcement';
}

/**
 * Limits a queue to a maximum size by removing oldest entries.
 * 
 * @param queue - Array to limit
 * @param limit - Maximum allowed size
 */
function limitQueue<T>(queue: T[], limit: number): void {
  while (queue.length > limit) {
    queue.shift();
  }
}

/**
 * Truncates text to a maximum length, appending ellipsis if truncated.
 * 
 * @param text - Text to limit
 * @param maxLength - Maximum character length (default 320)
 * @returns Truncated text with ellipsis if needed
 */
function limitText(text: string, maxLength: number = 320): string {
  if (text.length <= maxLength) {
    return text;
  }
  return `${text.slice(0, maxLength - 3)}...`;
}

/**
 * Creates a complete context entry from partial data.
 * Auto-generates ID and timestamp if not provided.
 * 
 * @param partial - Partial context entry with optional ID and timestamp
 * @returns Complete reinforcement context entry
 */
function createContextEntry(partial: Omit<ReinforcementContextEntry, 'id' | 'timestamp'> & {
  id?: string;
  timestamp?: number;
}): ReinforcementContextEntry {
  return {
    id: partial.id ?? randomUUID(),
    timestamp: partial.timestamp ?? Date.now(),
    source: partial.source,
    summary: partial.summary,
    requestId: partial.requestId,
    metadata: partial.metadata,
    bias: partial.bias,
    score: partial.score,
    patternId: partial.patternId
  };
}

/**
 * Retrieves the current reinforcement configuration.
 * 
 * @returns Copy of the reinforcement configuration object
 */
export function getReinforcementConfig(): ReinforcementConfig {
  return { ...config.reinforcement };
}

/**
 * Registers a new context entry in the reinforcement window.
 * Only records if reinforcement mode is enabled. Automatically manages window size limits.
 * 
 * @param entry - Partial context entry with optional ID and timestamp
 * @returns The complete registered entry, or null if recording is disabled
 */
export function registerContextEntry(entry: Omit<ReinforcementContextEntry, 'id' | 'timestamp'> & {
  id?: string;
  timestamp?: number;
}): ReinforcementContextEntry | null {
  if (!shouldRecord()) {
    return null;
  }

  const record = createContextEntry(entry);
  contextWindow.push(record);
  limitQueue(contextWindow, config.reinforcement.window);

  aiLogger.debug('Contextual reinforcement entry stored', {
    operation: 'contextualReinforcement:register',
    source: record.source,
    requestId: record.requestId,
    bias: record.bias,
    score: record.score,
    patternId: record.patternId
  });

  return record;
}

/**
 * Tracks a user prompt for reinforcement learning.
 * Stores truncated prompt text with neutral bias for pattern analysis.
 * 
 * @param prompt - User's input prompt
 * @param metadata - Optional metadata including requestId
 */
export function trackPromptUsage(prompt: string, metadata: Record<string, unknown> = {}): void {
  registerContextEntry({
    source: 'prompt',
    summary: `User prompt: ${limitText(prompt)}`,
    metadata,
    requestId: typeof metadata.requestId === 'string' ? (metadata.requestId as string) : undefined,
    bias: 'neutral'
  });
}

/**
 * Tracks an AI model response for reinforcement learning.
 * Stores truncated output with positive bias to reinforce successful patterns.
 * 
 * @param output - Model's generated output
 * @param metadata - Optional metadata including requestId
 */
export function trackModelResponse(output: string, metadata: Record<string, unknown> = {}): void {
  registerContextEntry({
    source: 'reinforce',
    summary: `Model output: ${limitText(output)}`,
    metadata,
    requestId: typeof metadata.requestId === 'string' ? (metadata.requestId as string) : undefined,
    bias: 'positive'
  });
}

export function registerAuditRecord(record: AuditRecord): void {
  if (!shouldRecord()) {
    return;
  }

  auditHistory.push(record);
  limitQueue(auditHistory, config.reinforcement.window);

  const auditSummary = `CLEAR score ${record.clearScore.toFixed(2)} for pattern ${record.patternId ?? 'n/a'} (${record.accepted ? 'accepted' : 'rejected'})`;

  registerContextEntry({
    id: record.patternId ?? record.id,
    timestamp: record.timestamp,
    source: 'audit',
    summary: auditSummary,
    requestId: record.requestId,
    bias: record.accepted ? 'positive' : 'negative',
    score: record.clearScore,
    patternId: record.patternId
  });

  aiLogger.info('CLEAR feedback recorded', {
    operation: 'contextualReinforcement:audit',
    requestId: record.requestId,
    patternId: record.patternId,
    score: record.clearScore,
    accepted: record.accepted
  });
}

export function registerTraceEvent(event: ReinforcementTraceEvent): void {
  if (!config.tracing.audit.enabled) {
    return;
  }

  traceHistory.push(event);
  limitQueue(traceHistory, MAX_TRACE_HISTORY);

  registerContextEntry({
    id: event.traceId,
    timestamp: Date.parse(event.timestamp) || Date.now(),
    source: 'trace',
    summary: `Trace ${event.method} ${event.path} → ${event.statusCode} (${event.durationMs}ms)`,
    requestId: event.requestId,
    metadata: { traceId: event.traceId },
    bias: event.statusCode >= 400 ? 'negative' : 'neutral'
  });
}

export function buildContextualSystemPrompt(basePrompt: string): string {
  if (!shouldRecord()) {
    return basePrompt;
  }

  if (contextWindow.length === 0) {
    return `${basePrompt}\n\n[ARCANOS Contextual Reinforcement]\nMode: ${config.reinforcement.mode}\nWindow: ${config.reinforcement.window}\nMinimum CLEAR score: ${config.reinforcement.minimumClearScore}`;
  }

  const effectiveWindow = Math.min(contextWindow.length, config.reinforcement.window);
  const recentEntries = contextWindow.slice(-effectiveWindow);

  const digest = recentEntries
    .map((entry, index) => {
      const position = index + 1;
      const header = `[${entry.source.toUpperCase()}]`;
      const scoreSegment = entry.score !== undefined ? ` score=${entry.score.toFixed(2)}` : '';
      const biasSegment = entry.bias ? ` bias=${entry.bias}` : '';
      const patternSegment = entry.patternId ? ` pattern=${entry.patternId}` : '';
      return `${position}. ${header}${patternSegment}${scoreSegment}${biasSegment} → ${entry.summary}`;
    })
    .join('\n');

  const lastAudit = auditHistory[auditHistory.length - 1];

  return (
    `${basePrompt}\n\n[ARCANOS Contextual Reinforcement]\n` +
    `Mode: ${config.reinforcement.mode}\n` +
    `Window: ${config.reinforcement.window}\n` +
    `Minimum CLEAR score: ${config.reinforcement.minimumClearScore}\n` +
    `Recent context digest:\n${digest}` +
    (lastAudit ? `\nLast CLEAR score: ${lastAudit.clearScore.toFixed(2)} (${lastAudit.patternId ?? 'n/a'})` : '')
  );
}

export function getContextWindow(): ReinforcementContextEntry[] {
  return [...contextWindow];
}

export function getAuditHistory(): AuditRecord[] {
  return [...auditHistory];
}

export function getTraceHistory(): ReinforcementTraceEvent[] {
  return [...traceHistory];
}

export function createAuditRecord(options: {
  requestId: string;
  clearScore: number;
  patternId?: string;
  accepted: boolean;
  payload: Record<string, unknown>;
}): AuditRecord {
  return {
    id: generateRequestId('audit'),
    requestId: options.requestId,
    timestamp: Date.now(),
    clearScore: options.clearScore,
    patternId: options.patternId,
    accepted: options.accepted,
    payload: options.payload
  };
}

export function getReinforcementHealth(): ReinforcementHealth {
  const lastAudit = auditHistory[auditHistory.length - 1];
  return {
    status: shouldRecord() ? 'ok' : 'disabled',
    mode: config.reinforcement.mode,
    window: config.reinforcement.window,
    digestSize: config.reinforcement.digestSize,
    storedContexts: contextWindow.length,
    audits: auditHistory.length,
    minimumClearScore: config.reinforcement.minimumClearScore,
    lastAudit: lastAudit ? new Date(lastAudit.timestamp).toISOString() : undefined
  };
}
