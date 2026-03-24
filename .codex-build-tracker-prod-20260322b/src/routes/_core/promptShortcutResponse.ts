import type { PromptRouteShortcutResult } from '@services/promptRouteShortcuts.js';

export interface PromptShortcutTelemetry {
  requestId: string;
  timestamp: string;
  module: string;
  activeModel: string;
  fallbackFlag: false;
  routingStages: [string];
  auditSafe: {
    mode: false;
    overrideUsed: false;
    auditFlags: [string];
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
 * Build the shared telemetry envelope for deterministic prompt-shortcut responses.
 * Inputs/outputs: normalized shortcut result -> stable response telemetry shared by route adapters.
 * Edge cases: every shortcut provides its own request-id prefix, routing stage, and audit flag so new shortcut types can reuse this builder without bespoke response scaffolding.
 */
export function buildPromptShortcutTelemetry(
  shortcut: PromptRouteShortcutResult
): PromptShortcutTelemetry {
  const requestId = `${shortcut.response.requestIdPrefix}_${Date.now()}`;
  const timestamp = new Date().toISOString();

  return {
    requestId,
    timestamp,
    module: shortcut.response.module,
    activeModel: shortcut.response.activeModel,
    fallbackFlag: false,
    routingStages: [shortcut.response.routingStage],
    auditSafe: {
      mode: false,
      overrideUsed: false,
      auditFlags: [shortcut.response.auditFlag],
      processedSafely: true
    },
    memoryContext: {
      entriesAccessed: 0,
      contextSummary: shortcut.response.contextSummary,
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
