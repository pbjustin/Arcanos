interface BackstageBookerShortcutTelemetryParams {
  reason: string;
  sessionId: string;
}

interface BackstageBookerShortcutTelemetry {
  requestId: string;
  timestamp: string;
  module: 'BACKSTAGE:BOOKER';
  activeModel: 'backstage-booker';
  fallbackFlag: false;
  routingStages: ['BACKSTAGE-BOOKER-DISPATCH'];
  auditSafe: {
    mode: false;
    overrideUsed: false;
    auditFlags: ['BACKSTAGE_BOOKER_SHORTCUT_ACTIVE'];
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
 * Build the shared telemetry envelope for deterministic backstage-booker shortcut responses.
 * Inputs/outputs: shortcut reason + session id -> stable response telemetry shared by compatibility routes.
 * Edge cases: sessionless requests are normalized upstream so this helper always emits a concrete session marker.
 */
export function buildBackstageBookerShortcutTelemetry(
  params: BackstageBookerShortcutTelemetryParams
): BackstageBookerShortcutTelemetry {
  const requestId = `booker_${Date.now()}`;
  const timestamp = new Date().toISOString();
  return {
    requestId,
    timestamp,
    module: 'BACKSTAGE:BOOKER',
    activeModel: 'backstage-booker',
    fallbackFlag: false,
    routingStages: ['BACKSTAGE-BOOKER-DISPATCH'],
    auditSafe: {
      mode: false,
      overrideUsed: false,
      auditFlags: ['BACKSTAGE_BOOKER_SHORTCUT_ACTIVE'],
      processedSafely: true
    },
    memoryContext: {
      entriesAccessed: 0,
      contextSummary: `Backstage Booker generated a booking response for session ${params.sessionId}. Trigger: ${params.reason}.`,
      memoryEnhanced: false,
      maxRelevanceScore: 0,
      averageRelevanceScore: 0
    },
    taskLineage: {
      requestId,
      logged: false
    }
  };
}
