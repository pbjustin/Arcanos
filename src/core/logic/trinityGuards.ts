/**
 * Trinity pipeline guard rails: concurrency, watchdog, invocation budget,
 * token cap, session token auditor, retry lineage, downgrade detection, telemetry.
 * Integrated from standalone trinity module into the core pipeline.
 */

import { Semaphore } from 'async-mutex';
import { logger } from "@platform/logging/structuredLogging.js";
import { recordLogEvent, recordTraceEvent } from "@platform/logging/telemetry.js";
import type { Tier } from './trinityTier.js';
import { TRINITY_HARD_TOKEN_CAP } from './trinityConstants.js';
import type { RuntimeBudget } from '../../runtime/runtimeBudget.js';
import { assertBudgetAvailable, getSafeRemainingMs } from '../../runtime/runtimeBudget.js';

// --- Concurrency Governor ---

const tierSemaphores: Record<Tier, Semaphore> = {
  simple: new Semaphore(100),
  complex: new Semaphore(40),
  critical: new Semaphore(10)
};

export async function acquireTierSlot(tier: Tier): Promise<[() => void]> {
  const [, release] = await tierSemaphores[tier].acquire();
  recordTraceEvent('trinity.concurrency.acquired', { tier });
  return [release];
}

// --- Watchdog ---

const WATCHDOG_BASE_SOFT_CAP_MS = 25_000;
const WATCHDOG_TIER_MULTIPLIERS: Record<Tier, number> = {
  simple: 1.0,
  complex: 1.4,
  critical: 1.8
};
const WATCHDOG_ESCALATION_MULTIPLIER = 1.3;

export function computeTierSoftCap(tier: Tier, escalated: boolean): number {
  const tierMultiplier = WATCHDOG_TIER_MULTIPLIERS[tier];
  const escalationMultiplier = escalated ? WATCHDOG_ESCALATION_MULTIPLIER : 1.0;
  return WATCHDOG_BASE_SOFT_CAP_MS * tierMultiplier * escalationMultiplier;
}

export interface TrinityWatchdog {
  watchdog: Watchdog;
  tierSoftCap: number;
  remainingBudgetMs: number;
  effectiveLimit: number;
}

export function createTrinityWatchdog(
  tier: Tier,
  runtimeBudget: RuntimeBudget,
  escalated: boolean
): TrinityWatchdog {
  assertBudgetAvailable(runtimeBudget);

  const tierSoftCap = computeTierSoftCap(tier, escalated);
  const remainingBudgetMs = getSafeRemainingMs(runtimeBudget);
  const effectiveLimit = Math.min(tierSoftCap, remainingBudgetMs);

  return {
    watchdog: new Watchdog(effectiveLimit),
    tierSoftCap,
    remainingBudgetMs,
    effectiveLimit
  };
}

export class Watchdog {
  private start = Date.now();
  private limitMs: number;
  private wasTriggered = false;

  constructor(limitMs = 28_000) {
    this.limitMs = limitMs;
  }

  updateLimit(newLimitMs: number): void {
    this.limitMs = newLimitMs;
  }

  check(globalRemainingMs?: number): void {
    const elapsed = Date.now() - this.start;
    const isLocalExceeded = elapsed > this.limitMs;
    const isGlobalExceeded = typeof globalRemainingMs === 'number' && globalRemainingMs <= 0;

    if (isLocalExceeded || isGlobalExceeded) {
      this.wasTriggered = true;
      const activeLimit = isGlobalExceeded ? elapsed : this.limitMs;
      logger.error('Watchdog threshold exceeded', {
        module: 'trinity', operation: 'watchdog',
        elapsed,
        limit: activeLimit,
        type: isGlobalExceeded ? 'global' : 'local'
      });
      throw new Error(`Execution exceeded watchdog threshold (${elapsed}ms > ${activeLimit}ms)`);
    }
  }
    const elapsed = Date.now() - this.start;
    if (elapsed > activeLimit) {
      this.wasTriggered = true;
      logger.error('Watchdog threshold exceeded', {
        module: 'trinity', operation: 'watchdog',
        elapsed,
        limit: activeLimit,
        configuredLimit: this.limitMs
      });
      throw new Error(`Execution exceeded watchdog threshold (${elapsed}ms > ${activeLimit}ms)`);
    }
  }

  elapsed(): number {
    return Date.now() - this.start;
  }

  limit(): number {
    return this.limitMs;
  }

  triggered(): boolean {
    return this.wasTriggered;
  }
}

// --- Token Cap ---

export function enforceTokenCap(requested?: number): number {
  return Math.min(requested ?? TRINITY_HARD_TOKEN_CAP, TRINITY_HARD_TOKEN_CAP);
}

// --- Session Token Auditor ---

const SESSION_TOKEN_LIMIT = 20_000;
const MAX_TRACKED_SESSIONS = 10_000;
const sessionUsage: Map<string, number> = new Map();

export function recordSessionTokens(sessionId: string, tokens: number): void {
  const current = (sessionUsage.get(sessionId) ?? 0) + tokens;

  // Evict oldest entry if at capacity and this is a new session
  if (sessionUsage.size >= MAX_TRACKED_SESSIONS && !sessionUsage.has(sessionId)) {
    const oldestKey = sessionUsage.keys().next().value;
    if (oldestKey !== undefined) sessionUsage.delete(oldestKey);
  }

  sessionUsage.set(sessionId, current);

  if (current > SESSION_TOKEN_LIMIT) {
    logger.error('Session token limit exceeded', {
      module: 'trinity', operation: 'session-audit',
      sessionId, tokens: current, limit: SESSION_TOKEN_LIMIT
    });
    throw new Error(`Session token limit exceeded (${current} > ${SESSION_TOKEN_LIMIT})`);
  }
}

export function getSessionTokenUsage(sessionId: string): number {
  return sessionUsage.get(sessionId) ?? 0;
}

// --- Retry Lineage ---

const MAX_RETRIES = 3;
const MAX_TRACKED_LINEAGES = 10_000;
const lineageRetries: Map<string, number> = new Map();

export function registerRetry(lineageId: string): void {
  const count = (lineageRetries.get(lineageId) ?? 0) + 1;

  // Evict oldest entry if at capacity and this is a new lineage
  if (lineageRetries.size >= MAX_TRACKED_LINEAGES && !lineageRetries.has(lineageId)) {
    const oldestKey = lineageRetries.keys().next().value;
    if (oldestKey !== undefined) lineageRetries.delete(oldestKey);
  }

  lineageRetries.set(lineageId, count);

  if (count > MAX_RETRIES) {
    logger.error('Retry limit exceeded', {
      module: 'trinity', operation: 'retry-lineage',
      lineageId, count, limit: MAX_RETRIES
    });
    throw new Error(`Retry limit exceeded for lineage ${lineageId}`);
  }
}

// --- Invocation Budget ---

export class InvocationBudget {
  private count = 0;
  constructor(private max: number) {}

  increment(): void {
    this.count++;
    if (this.count > this.max) {
      throw new Error(`Model invocation budget exceeded (${this.count} > ${this.max})`);
    }
  }

  used(): number { return this.count; }
  limit(): number { return this.max; }
}

// --- Downgrade Detector ---

export function detectDowngrade(requested: string, actual: string): boolean {
  const downgraded = requested !== actual;
  if (downgraded) {
    recordLogEvent({
      timestamp: new Date().toISOString(),
      level: 'warn',
      message: 'Model downgrade detected',
      context: { module: 'trinity', requested, actual }
    });
  }
  return downgraded;
}

// --- Trinity Telemetry ---

export function logTrinityTelemetry(data: {
  tier: Tier;
  totalTokens: number;
  downgradeDetected: boolean;
  latencyMs: number;
  reflectionApplied: boolean;
  requestId: string;
}): void {
  recordLogEvent({
    timestamp: new Date().toISOString(),
    level: 'info',
    message: 'Trinity pipeline telemetry',
    context: {
      module: 'trinity',
      operation: 'pipeline-complete',
      ...data
    }
  });
}
