/**
 * Backend-owned intent store for /ask system_state mode.
 *
 * Purpose: Keep a single active intent as the source of truth for CLI hydration.
 * Inputs/Outputs: exposes pure read/update helpers for chat and optimistic patch writes.
 * Edge cases: version mismatches return conflict metadata instead of mutating state.
 */

import type { CognitiveDomain } from '@shared/types/cognitiveDomain.js';

export type IntentStatus = 'active' | 'paused' | 'completed';
export type IntentPhase = 'exploration' | 'execution';

export interface StoredIntent {
  intentId: string;
  label: string;
  status: IntentStatus;
  phase: IntentPhase;
  confidence: number;
  version: number;
  lastTouchedAt: string;
  cognitiveDomain?: CognitiveDomain;
  domainConfidence?: number;
}

export interface IntentPatch {
  label?: string;
  status?: IntentStatus;
  phase?: IntentPhase;
  confidence?: number;
  cognitiveDomain?: CognitiveDomain;
  domainConfidence?: number;
}

export interface IntentConflict {
  error: 'INTENT_VERSION_CONFLICT';
  currentVersion: number;
}

// Use a session-scoped in-memory store to avoid global singletons in multi-user deployments.
const intentStore: Map<string, { intent: StoredIntent | null; lastRouting: 'local' | 'backend' }> = new Map();

function getStoreForSession(sessionId?: string) {
  const key = typeof sessionId === 'string' && sessionId.length > 0 ? sessionId : '__global__';
  if (!intentStore.has(key)) {
    intentStore.set(key, { intent: null, lastRouting: 'backend' });
  }
  return intentStore.get(key)!;
}

const DEFAULT_INTENT_CONFIDENCE = 0.5;

function nowIso(): string {
  return new Date().toISOString();
}

function clampConfidence(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function normalizeLabelFromPrompt(prompt: string): string {
  //audit Assumption: label must be safe for inclusion in system prompts; failure risk: prompt injection via stored label; expected invariant: label contains only safe printable chars and is reasonably short; handling strategy: produce slug + short hash.
  const compact = String(prompt || '').trim().replace(/\s+/g, ' ');
  if (!compact) {
    return 'intent_system';
  }
  // Create a short, safe slug from the start of the prompt and append an 8-char hash.
  const slug = compact
    .slice(0, 40)
    .toLowerCase()
    .replace(/[^a-z0-9\s-]+/g, '')
    .trim()
    .replace(/\s+/g, '-');
  // compute short hash
  try {
    // lazy import to stay compatible with various bundlers
    // @ts-ignore
    const { createHash } = require('crypto');
    const hash = createHash('sha256').update(compact).digest('hex').slice(0, 8);
    const label = `${slug || 'intent'}-${hash}`.slice(0, 160);
    return label;
  } catch (e) {
    // Fallback: safe truncated slug
    return (slug || 'intent_system').slice(0, 160);
  }
}

function createIntentFromPrompt(prompt: string): StoredIntent {
  const timestamp = Date.now();
  return {
    intentId: `int_${timestamp.toString(36)}`,
    label: normalizeLabelFromPrompt(prompt),
    status: 'active',
    phase: 'exploration',
    confidence: DEFAULT_INTENT_CONFIDENCE,
    version: 1,
    lastTouchedAt: nowIso()
  };
}

/**
 * Purpose: Return the current active intent snapshot.
 * Inputs/Outputs: no input; returns StoredIntent clone or null.
 * Edge cases: returns null when no chat activity has established intent yet.
 */
export function getActiveIntentSnapshot(sessionId?: string): StoredIntent | null {
  //audit Assumption: store must stay immutable to callers; failure risk: external mutation; expected invariant: internal state only changes through helpers; handling strategy: return clone.
  const s = getStoreForSession(sessionId);
  return s.intent ? { ...s.intent } : null;
}

/**
 * Purpose: Record chat activity and keep a single active intent.
 * Inputs/Outputs: chat prompt string; returns updated StoredIntent clone.
 * Edge cases: empty prompts still refresh timestamps using a stable fallback label.
 */
export function recordChatIntent(prompt: string, sessionId?: string): StoredIntent {
  //audit Assumption: first chat turn establishes intent; failure risk: null state; expected invariant: active intent always exists after chat record; handling strategy: lazy initialize per-session.
  const s = getStoreForSession(sessionId);
  if (!s.intent) {
    s.intent = createIntentFromPrompt(prompt);
    return { ...s.intent };
  }

  const nextLabel = normalizeLabelFromPrompt(prompt);
  s.intent = {
    ...s.intent,
    label: nextLabel,
    status: 'active',
    lastTouchedAt: nowIso(),
    version: s.intent.version + 1
  };
  return { ...s.intent };
}

/**
 * Purpose: Apply optimistic-lock updates to the active intent.
 * Inputs/Outputs: expectedVersion and patch object; returns updated intent or conflict.
 * Edge cases: no active intent returns a version conflict with currentVersion=0.
 */
export function updateIntentWithOptimisticLock(
  expectedVersion: number,
  patch: IntentPatch,
  sessionId?: string
): { ok: true; intent: StoredIntent } | { ok: false; conflict: IntentConflict } {
  //audit Assumption: updates require an existing record; failure risk: patching null state; expected invariant: conflict returned when missing; handling strategy: reject with currentVersion=0.
  const s = getStoreForSession(sessionId);
  if (!s.intent) {
    return {
      ok: false,
      conflict: { error: 'INTENT_VERSION_CONFLICT', currentVersion: 0 }
    };
  }

  //audit Assumption: optimistic lock prevents stale writes; failure risk: lost update; expected invariant: version must match; handling strategy: reject with currentVersion.
  if (expectedVersion !== s.intent.version) {
    return {
      ok: false,
      conflict: {
        error: 'INTENT_VERSION_CONFLICT',
        currentVersion: s.intent.version
      }
    };
  }

  const nextConfidence =
    typeof patch.confidence === 'number'
      ? clampConfidence(patch.confidence)
      : s.intent.confidence;

  const nextIntent: StoredIntent = {
    ...s.intent,
    label: patch.label ?? s.intent.label,
    status: patch.status ?? s.intent.status,
    phase: patch.phase ?? s.intent.phase,
    confidence: nextConfidence,
    cognitiveDomain: patch.cognitiveDomain ?? s.intent.cognitiveDomain,
    domainConfidence: typeof patch.domainConfidence === 'number'
      ? clampConfidence(patch.domainConfidence)
      : s.intent.domainConfidence,
    lastTouchedAt: nowIso(),
    version: s.intent.version + 1
  };

  s.intent = nextIntent;
  return { ok: true, intent: { ...nextIntent } };
}

/**
 * Purpose: Track routing usage for system_state telemetry.
 * Inputs/Outputs: routing source label; no return value.
 * Edge cases: invalid inputs are narrowed by TypeScript union at compile time.
 */
export function setLastRoutingUsed(route: 'local' | 'backend', sessionId?: string): void {
  const s = getStoreForSession(sessionId);
  s.lastRouting = route;
}

/**
 * Purpose: Read the last routing source used by /ask chat handling.
 * Inputs/Outputs: no input; returns routing label.
 * Edge cases: defaults to "backend" before first write to avoid null handling.
 */
export function getLastRoutingUsed(sessionId?: string): 'local' | 'backend' {
  const s = getStoreForSession(sessionId);
  return s.lastRouting;
}

