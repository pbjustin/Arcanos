import { z } from 'zod';
import {
  getActiveIntentSnapshot,
  getLastRoutingUsed,
  updateIntentWithOptimisticLock,
  type IntentConflict
} from '@routes/ask/intent_store.js';

const systemStatePatchSchema = z.object({
  confidence: z.number().min(0).max(1).optional(),
  phase: z.enum(['exploration', 'execution']).optional(),
  status: z.enum(['active', 'paused', 'completed']).optional(),
  label: z.string().min(1).max(200).optional()
});

export type SystemStatePatch = z.infer<typeof systemStatePatchSchema>;

export interface GovernedSystemStateResponse {
  mode: 'system_state';
  intent: {
    intentId: string | null;
    label: string | null;
    status: 'active' | 'paused' | 'completed' | null;
    phase: 'exploration' | 'execution' | null;
    confidence: number;
    version: number;
    lastTouchedAt: string | null;
  };
  routing: {
    preferred: 'backend';
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
    backend: 'fresh';
    lastValidatedAt: string;
  };
  limits: {
    rateLimited: false;
    remainingRequests: number;
  };
  generatedAt: string;
  confidence: number;
}

export class SystemStateConflictError extends Error {
  readonly code = 'SYSTEM_STATE_CONFLICT';

  constructor(readonly conflict: IntentConflict) {
    super('system_state update conflict');
  }
}

function nowIso(): string {
  return new Date().toISOString();
}

export function buildSystemStateResponse(sessionId?: string): GovernedSystemStateResponse {
  const now = nowIso();
  const activeIntent = getActiveIntentSnapshot(sessionId);
  const lastTouchedAt = activeIntent?.lastTouchedAt ?? null;
  const isIntentFresh =
    !!lastTouchedAt && Date.now() - Date.parse(lastTouchedAt) <= 15 * 60 * 1000;

  return {
    mode: 'system_state',
    intent: {
      intentId: activeIntent?.intentId ?? null,
      label: activeIntent?.label ?? null,
      status: activeIntent?.status ?? null,
      phase: activeIntent?.phase ?? null,
      confidence: activeIntent?.confidence ?? 0,
      version: activeIntent?.version ?? 1,
      lastTouchedAt
    },
    routing: {
      preferred: 'backend',
      lastUsed: getLastRoutingUsed(sessionId),
      confidenceGate: 0.75
    },
    backend: {
      connected: true,
      registryAvailable: true,
      lastHeartbeatAt: now
    },
    stateFreshness: {
      intent: isIntentFresh ? 'fresh' : 'stale',
      backend: 'fresh',
      lastValidatedAt: now
    },
    limits: {
      rateLimited: false,
      remainingRequests: 0
    },
    generatedAt: now,
    confidence: 0.99
  };
}

export function executeSystemStateRequest(payload: unknown): GovernedSystemStateResponse {
  const record =
    payload && typeof payload === 'object' && !Array.isArray(payload)
      ? (payload as Record<string, unknown>)
      : {};

  const sessionId =
    typeof record.sessionId === 'string' && record.sessionId.trim().length > 0
      ? record.sessionId.trim()
      : undefined;

  const expectedVersion =
    typeof record.expectedVersion === 'number' && Number.isInteger(record.expectedVersion)
      ? record.expectedVersion
      : undefined;

  const parsedPatch =
    record.patch === undefined
      ? undefined
      : systemStatePatchSchema.safeParse(record.patch);

  if (record.patch !== undefined && !parsedPatch?.success) {
    throw new Error(
      `system_state patch invalid: ${parsedPatch?.error.issues.map((issue) => issue.message).join('; ')}`
    );
  }

  if ((expectedVersion !== undefined) !== (parsedPatch?.success === true)) {
    throw new Error("system_state updates require both 'expectedVersion' and 'patch'");
  }

  if (expectedVersion !== undefined && parsedPatch?.success) {
    const updateResult = updateIntentWithOptimisticLock(expectedVersion, parsedPatch.data, sessionId);
    if (!updateResult.ok) {
      throw new SystemStateConflictError(updateResult.conflict);
    }
  }

  return buildSystemStateResponse(sessionId);
}
