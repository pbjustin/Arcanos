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
  ClearScoreScale,
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

function buildReinforcementSection(basePrompt: string, digest?: string, lastAudit?: AuditRecord): string {
  const reinforcementLines = [
    '[ARCANOS Contextual Reinforcement]',
    `Mode: ${config.reinforcement.mode}`,
    `Window: ${config.reinforcement.window}`,
    `Minimum CLEAR score: ${config.reinforcement.minimumClearScore}`
  ];

  if (digest) {
    //audit assumption: digest is non-empty string when present
    //audit failure risk: undefined digest reduces context clarity
    //audit expected invariant: digest lines are appended only when available
    //audit handling strategy: guard on digest presence
    reinforcementLines.push(`Recent context digest:\n${digest}`);
  }

  if (lastAudit) {
    //audit assumption: lastAudit exists when audit history is non-empty
    //audit failure risk: missing audit details for reviewers
    //audit expected invariant: lastAudit contains clearScore metadata
    //audit handling strategy: guard on lastAudit presence
    reinforcementLines.push(
      `Last CLEAR score: ${lastAudit.clearScore.toFixed(2)} (${lastAudit.scoreScale}, normalized ${lastAudit.normalizedClearScore.toFixed(2)}) (${lastAudit.patternId ?? 'n/a'})`
    );
  }

  return `${basePrompt}\n\n${reinforcementLines.join('\n')}`;
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
    //audit assumption: contextual recording can be disabled via config
    //audit failure risk: missing audit trail during disabled state
    //audit expected invariant: no entries recorded when disabled
    //audit handling strategy: return null to signal skip
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

/**
 * Register an audit record and mirror it into the contextual reinforcement window.
 *
 * @param record - Audit record with CLEAR score details.
 */
export function registerAuditRecord(record: AuditRecord): void {
  if (!shouldRecord()) {
    //audit assumption: contextual recording can be disabled via config
    //audit failure risk: audit trail missing when disabled
    //audit expected invariant: no audit records stored when disabled
    //audit handling strategy: return early
    return;
  }

  auditHistory.push(record);
  limitQueue(auditHistory, config.reinforcement.window);

  const auditSummary = `CLEAR score ${record.clearScore.toFixed(2)} (${record.scoreScale}, normalized ${record.normalizedClearScore.toFixed(2)}) for pattern ${record.patternId ?? 'n/a'} (${record.accepted ? 'accepted' : 'rejected'})`;

  registerContextEntry({
    id: record.patternId ?? record.id,
    timestamp: record.timestamp,
    source: 'audit',
    summary: auditSummary,
    requestId: record.requestId,
    metadata: {
      scoreScale: record.scoreScale,
      normalizedClearScore: record.normalizedClearScore
    },
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

/**
 * Register a trace event for request lifecycle auditing.
 *
 * @param event - Trace event metadata to persist.
 */
export function registerTraceEvent(event: ReinforcementTraceEvent): void {
  if (!config.tracing.audit.enabled) {
    //audit assumption: trace audit logging may be disabled via config
    //audit failure risk: missing trace history when disabled
    //audit expected invariant: no trace entries stored when disabled
    //audit handling strategy: return early
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

/**
 * Build the system prompt augmented with contextual reinforcement details.
 *
 * @param basePrompt - Primary system prompt text.
 * @returns Prompt with reinforcement context appended when enabled.
 */
export function buildContextualSystemPrompt(basePrompt: string): string {
  if (!shouldRecord()) {
    //audit assumption: reinforcement mode controls prompt enrichment
    //audit failure risk: missing context when reinforcement is disabled
    //audit expected invariant: basePrompt returned when disabled
    //audit handling strategy: return basePrompt
    return basePrompt;
  }

  if (contextWindow.length === 0) {
    //audit assumption: empty context window yields no digest
    //audit failure risk: prompt missing reinforcement header
    //audit expected invariant: reinforcement header still emitted
    //audit handling strategy: build header without digest
    return buildReinforcementSection(basePrompt);
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

  return buildReinforcementSection(basePrompt, digest, lastAudit);
}

/**
 * Get a copy of the current reinforcement context window.
 *
 * @returns Array copy of stored reinforcement entries.
 */
export function getContextWindow(): ReinforcementContextEntry[] {
  return [...contextWindow];
}

/**
 * Get a copy of the audit history records.
 *
 * @returns Array copy of audit history.
 */
export function getAuditHistory(): AuditRecord[] {
  return [...auditHistory];
}

/**
 * Get a copy of the trace history records.
 *
 * @returns Array copy of trace history.
 */
export function getTraceHistory(): ReinforcementTraceEvent[] {
  return [...traceHistory];
}

/**
 * Create a new audit record from validated inputs.
 *
 * @param options - Audit record fields to persist.
 * @returns Audit record ready for storage.
 */
export function createAuditRecord(options: {
  requestId: string;
  clearScore: number;
  normalizedClearScore: number;
  scoreScale: ClearScoreScale;
  patternId?: string;
  accepted: boolean;
  payload: Record<string, unknown>;
}): AuditRecord {
  return {
    id: generateRequestId('audit'),
    requestId: options.requestId,
    timestamp: Date.now(),
    clearScore: options.clearScore,
    normalizedClearScore: options.normalizedClearScore,
    scoreScale: options.scoreScale,
    patternId: options.patternId,
    accepted: options.accepted,
    payload: options.payload
  };
}

/**
 * Provide health information about the reinforcement subsystem.
 *
 * @returns Summary of reinforcement mode, window, and last audit.
 */
export function getReinforcementHealth(): ReinforcementHealth {
  const lastAudit = auditHistory[auditHistory.length - 1];
  //audit assumption: lastAudit may be undefined when no audits exist
  //audit failure risk: missing last audit timestamp
  //audit expected invariant: lastAudit is defined only when auditHistory has entries
  //audit handling strategy: return undefined lastAudit when history is empty
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
