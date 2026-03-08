interface MemoryShortcutTelemetryParams {
  memoryOperation: string;
  memorySessionId: string;
}

interface MemoryShortcutTelemetry {
  requestId: string;
  timestamp: string;
  module: 'memory-dispatcher';
  activeModel: 'memory-dispatcher';
  fallbackFlag: false;
  routingStages: ['MEMORY-DISPATCH'];
  auditSafe: {
    mode: false;
    overrideUsed: false;
    auditFlags: ['MEMORY_SHORTCUT_ACTIVE'];
    processedSafely: true;
  };
  memoryContext: {
    entriesAccessed: 0;
    contextSummary: string;
    memoryEnhanced: false;
    maxRelevanceScore: number;
    averageRelevanceScore: number;
  };
  taskLineage: {
    requestId: string;
    logged: false;
  };
}

/**
 * Build the shared telemetry envelope for deterministic memory-shortcut responses.
 * Inputs/outputs: memory operation + session id -> stable response telemetry shared by compatibility routes.
 * Edge cases: legacy routes can opt into zeroed relevance metrics without duplicating the base structure.
 */
export function buildMemoryShortcutTelemetry(
  params: MemoryShortcutTelemetryParams
): MemoryShortcutTelemetry {
  const requestId = `memory_${Date.now()}`;
  const timestamp = new Date().toISOString();
  return {
    requestId,
    timestamp,
    module: 'memory-dispatcher',
    activeModel: 'memory-dispatcher',
    fallbackFlag: false,
    routingStages: ['MEMORY-DISPATCH'],
    auditSafe: {
      mode: false,
      overrideUsed: false,
      auditFlags: ['MEMORY_SHORTCUT_ACTIVE'],
      processedSafely: true,
    },
    memoryContext: {
      entriesAccessed: 0,
      contextSummary: `Memory dispatcher ${params.memoryOperation} for session ${params.memorySessionId}.`,
      memoryEnhanced: false,
      maxRelevanceScore: 0,
      averageRelevanceScore: 0,
    },
    taskLineage: {
      requestId,
      logged: false,
    },
  };
}
