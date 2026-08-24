/**
 * Trinity pipeline guard rails: concurrency, watchdog, invocation budget,
 * token cap, session token auditor, retry lineage, downgrade detection, telemetry.
 * Integrated from standalone trinity module into the core pipeline.
 */

import { logger } from "@platform/logging/structuredLogging.js";
import { recordLogEvent, recordTraceEvent } from "@platform/logging/telemetry.js";
import { resolveTimeout } from "@platform/runtime/watchdogConfig.js";
import type { Tier } from './trinityTier.js';
import {
  TRINITY_DIRECT_ANSWER_TOKEN_CAP_OVERRIDE_MAX,
  TRINITY_HARD_TOKEN_CAP
} from './trinityConstants.js';
import type { RuntimeBudget } from '@platform/resilience/runtimeBudget.js';
import { assertBudgetAvailable, getSafeRemainingMs } from '@platform/resilience/runtimeBudget.js';
import { createAbortError } from '@arcanos/runtime';

function readNumberEnv(name: string, fallback: number): number {
  const value = process.env[name];
  if (value === undefined) {
    return fallback;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

// --- Concurrency Governor ---

const MAX_NODE_TIMER_DELAY_MS = 2_147_483_647;

interface TierSlotAdmissionOptions {
  signal?: AbortSignal;
  deadlineAt?: number;
}

interface TierSlotWaiter {
  resolve: (release: () => void) => void;
  reject: (error: Error) => void;
  signal?: AbortSignal;
  deadlineAt?: number;
  onAbort?: () => void;
  deadlineHandle?: ReturnType<typeof setTimeout>;
  settled: boolean;
}

function resolveAdmissionAbortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : createAbortError('Trinity concurrency admission aborted');
}

class CancellationAwareTierSemaphore {
  private available: number;
  private readonly waiters: TierSlotWaiter[] = [];

  constructor(private readonly capacity: number) {
    this.available = capacity;
  }

  acquire(options: TierSlotAdmissionOptions = {}): Promise<() => void> {
    if (options.signal?.aborted) {
      return Promise.reject(resolveAdmissionAbortReason(options.signal));
    }
    if (this.hasExpired(options.deadlineAt)) {
      return Promise.reject(createAbortError('Trinity concurrency admission deadline exceeded'));
    }
    if (this.available > 0 && this.waiters.length === 0) {
      this.available--;
      return Promise.resolve(this.createReleaser());
    }

    return new Promise<() => void>((resolve, reject) => {
      const waiter: TierSlotWaiter = {
        resolve,
        reject,
        signal: options.signal,
        deadlineAt: options.deadlineAt,
        settled: false
      };
      this.waiters.push(waiter);

      if (waiter.signal) {
        waiter.onAbort = () => {
          this.cancelWaiter(waiter, resolveAdmissionAbortReason(waiter.signal as AbortSignal));
        };
        waiter.signal.addEventListener('abort', waiter.onAbort, { once: true });
      }

      this.scheduleDeadline(waiter);

      // Close the synchronous gap between the initial checks and listener setup.
      if (waiter.signal?.aborted) {
        this.cancelWaiter(waiter, resolveAdmissionAbortReason(waiter.signal));
      } else if (this.hasExpired(waiter.deadlineAt)) {
        this.cancelWaiter(
          waiter,
          createAbortError('Trinity concurrency admission deadline exceeded')
        );
      }
    });
  }

  private hasExpired(deadlineAt: number | undefined): boolean {
    return Number.isFinite(deadlineAt) && Date.now() >= (deadlineAt as number);
  }

  private scheduleDeadline(waiter: TierSlotWaiter): void {
    if (waiter.settled || !Number.isFinite(waiter.deadlineAt)) {
      return;
    }

    const remainingMs = (waiter.deadlineAt as number) - Date.now();
    if (remainingMs <= 0) {
      this.cancelWaiter(
        waiter,
        createAbortError('Trinity concurrency admission deadline exceeded')
      );
      return;
    }

    const timerDelayMs = Math.max(
      1,
      Math.min(MAX_NODE_TIMER_DELAY_MS, Math.trunc(remainingMs))
    );
    waiter.deadlineHandle = setTimeout(() => {
      waiter.deadlineHandle = undefined;
      if (this.hasExpired(waiter.deadlineAt)) {
        this.cancelWaiter(
          waiter,
          createAbortError('Trinity concurrency admission deadline exceeded')
        );
        return;
      }
      this.scheduleDeadline(waiter);
    }, timerDelayMs);
    waiter.deadlineHandle.unref?.();
  }

  private cancelWaiter(waiter: TierSlotWaiter, error: Error): void {
    if (waiter.settled) {
      return;
    }

    const waiterIndex = this.waiters.indexOf(waiter);
    if (waiterIndex >= 0) {
      this.waiters.splice(waiterIndex, 1);
    }
    waiter.settled = true;
    this.cleanupWaiter(waiter);
    waiter.reject(error);
  }

  private dispatch(): void {
    while (this.available > 0 && this.waiters.length > 0) {
      const waiter = this.waiters.shift() as TierSlotWaiter;
      if (waiter.settled) {
        continue;
      }
      if (waiter.signal?.aborted) {
        waiter.settled = true;
        this.cleanupWaiter(waiter);
        waiter.reject(resolveAdmissionAbortReason(waiter.signal));
        continue;
      }
      if (this.hasExpired(waiter.deadlineAt)) {
        waiter.settled = true;
        this.cleanupWaiter(waiter);
        waiter.reject(createAbortError('Trinity concurrency admission deadline exceeded'));
        continue;
      }

      waiter.settled = true;
      this.cleanupWaiter(waiter);
      this.available--;
      waiter.resolve(this.createReleaser());
    }
  }

  private cleanupWaiter(waiter: TierSlotWaiter): void {
    if (waiter.signal && waiter.onAbort) {
      waiter.signal.removeEventListener('abort', waiter.onAbort);
    }
    if (waiter.deadlineHandle) {
      clearTimeout(waiter.deadlineHandle);
    }
  }

  private createReleaser(): () => void {
    let released = false;
    return () => {
      if (released) {
        return;
      }
      released = true;
      this.available = Math.min(this.capacity, this.available + 1);
      this.dispatch();
    };
  }
}

const tierSemaphores: Record<Tier, CancellationAwareTierSemaphore> = {
  simple: new CancellationAwareTierSemaphore(100),
  complex: new CancellationAwareTierSemaphore(40),
  critical: new CancellationAwareTierSemaphore(10)
};

export async function acquireTierSlot(
  tier: Tier,
  options: TierSlotAdmissionOptions = {}
): Promise<[() => void]> {
  const release = await tierSemaphores[tier].acquire(options);
  try {
    recordTraceEvent('trinity.concurrency.acquired', { tier });
    return [release];
  } catch (error) {
    release();
    throw error;
  }
}

// --- Watchdog ---

export const TRINITY_BASE_SOFT_CAP_MS = readNumberEnv('TRINITY_BASE_SOFT_CAP_MS', 60_000);
export const TRINITY_MULTIPLIERS: Record<Tier, number> = {
  simple: readNumberEnv('TRINITY_MULT_SIMPLE', 1.0),
  complex: readNumberEnv('TRINITY_MULT_COMPLEX', 1.4),
  critical: readNumberEnv('TRINITY_MULT_CRITICAL', 1.8)
};

/**
 * Computes tier-specific soft cap for watchdog checks.
 * Input: tier level. Output: soft cap milliseconds before budget clamp.
 * Edge case: tier must exist in multiplier map.
 */
export function computeTierSoftCap(tier: Tier): number {
  return TRINITY_BASE_SOFT_CAP_MS * TRINITY_MULTIPLIERS[tier];
}

export interface TrinityWatchdog {
  watchdog: Watchdog;
  tierSoftCap: number;
  recoveryReserveMs: number;
  remainingBudgetMs: number;
  modelCapMs: number;
  effectiveLimit: number;
}

/**
 * Creates a watchdog constrained by both tier soft cap and runtime budget.
 * Input: tier and shared runtime budget. Output: TrinityWatchdog metadata and watchdog instance.
 * Edge case: throws when runtime budget is exhausted before watchdog creation.
 */
export function createTrinityWatchdog(
  tier: Tier,
  runtimeBudget: RuntimeBudget,
  model = 'gpt-5',
  modelTimeoutOverrideMs?: number,
  recoveryReserveMs = 0
): TrinityWatchdog {
  assertBudgetAvailable(runtimeBudget);

  const normalizedRecoveryReserveMs = Number.isFinite(recoveryReserveMs)
    && recoveryReserveMs > 0
    ? Math.min(45_000, Math.trunc(recoveryReserveMs))
    : 0;
  const tierSoftCap = computeTierSoftCap(tier)
    + normalizedRecoveryReserveMs;
  const remainingBudgetMs = getSafeRemainingMs(runtimeBudget);
  //audit Assumption: worker-originated Trinity calls may need a larger per-stage ceiling than request-path defaults; failure risk: long-running DAG nodes are clipped by the generic model timeout even when the worker budget is higher; expected invariant: explicit positive overrides win, otherwise model-specific defaults still apply; handling strategy: sanitize the override and clamp it again when computing the final effective limit.
  const modelCapMs =
    typeof modelTimeoutOverrideMs === 'number' &&
    Number.isFinite(modelTimeoutOverrideMs) &&
    modelTimeoutOverrideMs > 0
      ? Math.max(1, Math.trunc(modelTimeoutOverrideMs))
      : resolveTimeout(model);
  const effectiveLimit = Math.max(1, Math.min(tierSoftCap, remainingBudgetMs, modelCapMs));

  if (process.env.DEBUG_WATCHDOG === 'true') {
    logger.info('Trinity watchdog computed', {
      tier,
      tierSoftCap,
      recoveryReserveMs: normalizedRecoveryReserveMs,
      remainingBudgetMs,
      modelCapMs,
      effectiveLimitMs: effectiveLimit
    });
  }

  return {
    watchdog: new Watchdog(effectiveLimit),
    tierSoftCap,
    recoveryReserveMs: normalizedRecoveryReserveMs,
    remainingBudgetMs,
    modelCapMs,
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

  check(): void {
    const elapsed = Date.now() - this.start;
    const isLimitExceeded = elapsed > this.limitMs;

    //audit Assumption: watchdog enforces a single effective limit after budget clamp; risk: stage overruns local cap; invariant: elapsed remains <= limit while progressing; handling: fail-fast with telemetry.
    if (isLimitExceeded) {
      this.wasTriggered = true;
      logger.error('Watchdog threshold exceeded', {
        module: 'trinity', operation: 'watchdog',
        elapsed,
        limit: this.limitMs
      });
      throw new Error(`Execution exceeded watchdog threshold (${elapsed}ms > ${this.limitMs}ms)`);
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

export function resolveDirectAnswerTokenCap(override?: number): number {
  if (typeof override !== 'number' || !Number.isFinite(override) || override <= 0) {
    return TRINITY_HARD_TOKEN_CAP;
  }

  return Math.min(
    Math.max(1, Math.trunc(override)),
    TRINITY_DIRECT_ANSWER_TOKEN_CAP_OVERRIDE_MAX
  );
}

export function enforceDirectAnswerTokenCap(
  requested?: number,
  override?: number
): number {
  const effectiveCap = resolveDirectAnswerTokenCap(override);
  return Math.min(requested ?? effectiveCap, effectiveCap);
}

// --- Session Token Auditor ---

export const DEFAULT_TRINITY_SESSION_TOKEN_LIMIT = 250_000;
const SESSION_TOKEN_LIMIT = readNumberEnv(
  'TRINITY_SESSION_TOKEN_LIMIT',
  DEFAULT_TRINITY_SESSION_TOKEN_LIMIT
);
const MAX_TRACKED_SESSIONS = 10_000;
const sessionUsage: Map<string, number> = new Map();

/**
 * Return the effective Trinity session token limit after environment overrides.
 * Input: none. Output: positive token limit integer.
 * Edge case: invalid env overrides already fall back to the documented default.
 */
export function getConfiguredTrinitySessionTokenLimit(): number {
  return SESSION_TOKEN_LIMIT;
}

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
