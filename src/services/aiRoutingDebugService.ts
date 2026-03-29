export interface AiRoutingDebugSnapshot {
  requestId: string;
  timestamp: string;
  rawPrompt: string;
  normalizedPrompt: string;
  detectedIntent: 'RUNTIME_INSPECTION_REQUIRED' | 'STANDARD';
  routingDecision: string;
  toolsAvailable: string[];
  toolsSelected: string[];
  cliUsed: boolean;
  runtimeEndpointsQueried: string[];
  repoFallbackUsed: boolean;
  constraintViolations: string[];
}

type AiRoutingDebugGlobal = typeof globalThis & {
  __ARCANOS_AI_ROUTING_DEBUG__?: {
    byRequestId: Map<string, AiRoutingDebugSnapshot>;
    latestRequestId: string | null;
  };
};

const GLOBAL_KEY = '__ARCANOS_AI_ROUTING_DEBUG__';
const MAX_RECORDS = 100;

function getMutableState() {
  const runtime = globalThis as AiRoutingDebugGlobal;
  if (!runtime[GLOBAL_KEY]) {
    runtime[GLOBAL_KEY] = {
      byRequestId: new Map<string, AiRoutingDebugSnapshot>(),
      latestRequestId: null,
    };
  }

  return runtime[GLOBAL_KEY]!;
}

export function recordAiRoutingDebugSnapshot(snapshot: AiRoutingDebugSnapshot): void {
  const state = getMutableState();
  state.byRequestId.set(snapshot.requestId, { ...snapshot });
  state.latestRequestId = snapshot.requestId;

  while (state.byRequestId.size > MAX_RECORDS) {
    const firstKey = state.byRequestId.keys().next().value;
    if (typeof firstKey !== 'string') {
      break;
    }
    state.byRequestId.delete(firstKey);
  }
}

export function getLatestAiRoutingDebugSnapshot(requestId?: string): AiRoutingDebugSnapshot | null {
  const state = getMutableState();
  const resolvedRequestId = requestId ?? state.latestRequestId;
  if (!resolvedRequestId) {
    return null;
  }

  return state.byRequestId.get(resolvedRequestId) ?? null;
}

export function listAiRoutingDebugSnapshots(limit = 20): AiRoutingDebugSnapshot[] {
  const state = getMutableState();
  const normalizedLimit = Number.isFinite(limit)
    ? Math.max(1, Math.min(MAX_RECORDS, Math.trunc(limit)))
    : 20;

  return Array.from(state.byRequestId.values())
    .sort((left, right) => right.timestamp.localeCompare(left.timestamp))
    .slice(0, normalizedLimit)
    .map(snapshot => ({
      ...snapshot,
      toolsAvailable: [...snapshot.toolsAvailable],
      toolsSelected: [...snapshot.toolsSelected],
      runtimeEndpointsQueried: [...snapshot.runtimeEndpointsQueried],
      constraintViolations: [...snapshot.constraintViolations],
    }));
}

export function clearAiRoutingDebugSnapshotsForTest(): void {
  const state = getMutableState();
  state.byRequestId.clear();
  state.latestRequestId = null;
}
