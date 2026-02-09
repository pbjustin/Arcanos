/**
 * Backend-owned intent store for /ask system_state mode.
 *
 * Purpose: Keep a single active intent as the source of truth for CLI hydration.
 * Inputs/Outputs: exposes pure read/update helpers for chat and optimistic patch writes.
 * Edge cases: version mismatches return conflict metadata instead of mutating state.
 */

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
}

export interface IntentPatch {
  label?: string;
  status?: IntentStatus;
  phase?: IntentPhase;
  confidence?: number;
}

export interface IntentConflict {
  error: 'INTENT_VERSION_CONFLICT';
  currentVersion: number;
}

let activeIntent: StoredIntent | null = null;
let lastRoutingUsed: 'local' | 'backend' = 'backend';

const DEFAULT_INTENT_CONFIDENCE = 0.5;

function nowIso(): string {
  return new Date().toISOString();
}

function clampConfidence(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function normalizeLabelFromPrompt(prompt: string): string {
  const compact = prompt.trim().replace(/\s+/g, ' ');
  if (!compact) {
    return 'intent_system';
  }
  return compact.slice(0, 160);
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
export function getActiveIntentSnapshot(): StoredIntent | null {
  //audit Assumption: store must stay immutable to callers; failure risk: external mutation; expected invariant: internal state only changes through helpers; handling strategy: return clone.
  return activeIntent ? { ...activeIntent } : null;
}

/**
 * Purpose: Record chat activity and keep a single active intent.
 * Inputs/Outputs: chat prompt string; returns updated StoredIntent clone.
 * Edge cases: empty prompts still refresh timestamps using a stable fallback label.
 */
export function recordChatIntent(prompt: string): StoredIntent {
  //audit Assumption: first chat turn establishes intent; failure risk: null state; expected invariant: active intent always exists after chat record; handling strategy: lazy initialize.
  if (!activeIntent) {
    activeIntent = createIntentFromPrompt(prompt);
    return { ...activeIntent };
  }

  const nextLabel = normalizeLabelFromPrompt(prompt);
  activeIntent = {
    ...activeIntent,
    label: nextLabel,
    status: 'active',
    lastTouchedAt: nowIso(),
    version: activeIntent.version + 1
  };
  return { ...activeIntent };
}

/**
 * Purpose: Apply optimistic-lock updates to the active intent.
 * Inputs/Outputs: expectedVersion and patch object; returns updated intent or conflict.
 * Edge cases: no active intent returns a version conflict with currentVersion=0.
 */
export function updateIntentWithOptimisticLock(
  expectedVersion: number,
  patch: IntentPatch
): { ok: true; intent: StoredIntent } | { ok: false; conflict: IntentConflict } {
  //audit Assumption: updates require an existing record; failure risk: patching null state; expected invariant: conflict returned when missing; handling strategy: reject with currentVersion=0.
  if (!activeIntent) {
    return {
      ok: false,
      conflict: { error: 'INTENT_VERSION_CONFLICT', currentVersion: 0 }
    };
  }

  //audit Assumption: optimistic lock prevents stale writes; failure risk: lost update; expected invariant: version must match; handling strategy: reject with currentVersion.
  if (expectedVersion !== activeIntent.version) {
    return {
      ok: false,
      conflict: {
        error: 'INTENT_VERSION_CONFLICT',
        currentVersion: activeIntent.version
      }
    };
  }

  const nextConfidence =
    typeof patch.confidence === 'number'
      ? clampConfidence(patch.confidence)
      : activeIntent.confidence;

  const nextIntent: StoredIntent = {
    ...activeIntent,
    label: patch.label ?? activeIntent.label,
    status: patch.status ?? activeIntent.status,
    phase: patch.phase ?? activeIntent.phase,
    confidence: nextConfidence,
    lastTouchedAt: nowIso(),
    version: activeIntent.version + 1
  };

  activeIntent = nextIntent;
  return { ok: true, intent: { ...nextIntent } };
}

/**
 * Purpose: Track routing usage for system_state telemetry.
 * Inputs/Outputs: routing source label; no return value.
 * Edge cases: invalid inputs are narrowed by TypeScript union at compile time.
 */
export function setLastRoutingUsed(route: 'local' | 'backend'): void {
  lastRoutingUsed = route;
}

/**
 * Purpose: Read the last routing source used by /ask chat handling.
 * Inputs/Outputs: no input; returns routing label.
 * Edge cases: defaults to "backend" before first write to avoid null handling.
 */
export function getLastRoutingUsed(): 'local' | 'backend' {
  return lastRoutingUsed;
}

