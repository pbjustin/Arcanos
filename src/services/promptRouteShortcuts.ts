import {
  tryExecuteNaturalLanguageMemoryRouteShortcut,
  type NaturalLanguageMemoryRouteShortcut
} from '@services/naturalLanguageMemoryRouteShortcut.js';
import {
  tryExecuteBackstageBookerRouteShortcut,
  type BackstageBookerRouteShortcut
} from '@services/backstageBookerRouteShortcut.js';

export interface PromptRouteShortcutRequest {
  prompt: string;
  sessionId?: string;
}

export interface PromptRouteShortcutResult {
  shortcutId: 'memory' | 'backstage-booker';
  resultText: string;
  response: {
    requestIdPrefix: string;
    module: string;
    activeModel: string;
    routingStage: string;
    auditFlag: string;
    sessionId: string;
    contextSummary: string;
  };
  dispatcher: {
    module: string;
    action: string;
    reason: string;
  };
}

function buildMemoryPromptRouteShortcutResult(
  shortcut: NaturalLanguageMemoryRouteShortcut
): PromptRouteShortcutResult {
  return {
    shortcutId: 'memory',
    resultText: shortcut.resultText,
    response: {
      requestIdPrefix: 'memory',
      module: 'memory-dispatcher',
      activeModel: 'memory-dispatcher',
      routingStage: 'MEMORY-DISPATCH',
      auditFlag: 'MEMORY_SHORTCUT_ACTIVE',
      sessionId: shortcut.memory.sessionId,
      contextSummary: `Memory dispatcher ${shortcut.memory.operation} for session ${shortcut.memory.sessionId}.`
    },
    dispatcher: {
      module: 'memory-dispatcher',
      action: shortcut.memory.operation,
      reason: shortcut.memory.intent
    }
  };
}

function buildBackstageBookerPromptRouteShortcutResult(
  shortcut: BackstageBookerRouteShortcut,
  request: PromptRouteShortcutRequest
): PromptRouteShortcutResult {
  const normalizedSessionId = request.sessionId?.trim() || 'global';
  return {
    shortcutId: 'backstage-booker',
    resultText: shortcut.resultText,
    response: {
      requestIdPrefix: 'booker',
      module: 'BACKSTAGE:BOOKER',
      activeModel: 'backstage-booker',
      routingStage: 'BACKSTAGE-BOOKER-DISPATCH',
      auditFlag: 'BACKSTAGE_BOOKER_SHORTCUT_ACTIVE',
      sessionId: normalizedSessionId,
      contextSummary: `Backstage Booker generated a booking response for session ${normalizedSessionId}. Trigger: ${shortcut.dispatcher.reason}.`
    },
    dispatcher: {
      module: shortcut.dispatcher.module,
      action: shortcut.dispatcher.action,
      reason: shortcut.dispatcher.reason
    }
  };
}

/**
 * Execute the shared deterministic prompt-shortcut registry for chat-style routes.
 * Inputs/outputs: prompt + optional session id -> first matching shortcut result, or null when normal AI routing should continue.
 * Edge cases: preserves ordered priority so exact memory commands always win before broader domain-specific shortcuts like backstage booking.
 */
export async function tryExecutePromptRouteShortcut(
  request: PromptRouteShortcutRequest
): Promise<PromptRouteShortcutResult | null> {
  const shortcutExecutors: Array<() => Promise<PromptRouteShortcutResult | null>> = [
    async () => {
      const memoryShortcut = await tryExecuteNaturalLanguageMemoryRouteShortcut(request);
      return memoryShortcut ? buildMemoryPromptRouteShortcutResult(memoryShortcut) : null;
    },
    async () => {
      const backstageBookerShortcut = await tryExecuteBackstageBookerRouteShortcut(request);
      return backstageBookerShortcut
        ? buildBackstageBookerPromptRouteShortcutResult(backstageBookerShortcut, request)
        : null;
    }
  ];

  for (const executeShortcut of shortcutExecutors) {
    const shortcutResult = await executeShortcut();
    //audit Assumption: prompt shortcuts must resolve deterministically in registry order; failure risk: overlapping detectors race and change route behavior between requests; expected invariant: the first matching shortcut becomes the only shortcut result; handling strategy: return immediately on the first non-null match.
    if (shortcutResult) {
      return shortcutResult;
    }
  }

  return null;
}
