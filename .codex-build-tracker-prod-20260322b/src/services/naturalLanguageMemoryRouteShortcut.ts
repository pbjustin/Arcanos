import {
  executeNaturalLanguageMemoryCommand,
  hasNaturalLanguageMemoryCue,
  parseNaturalLanguageMemoryCommand,
  type NaturalLanguageMemoryEntry,
  type NaturalLanguageMemoryResponse
} from '@services/naturalLanguageMemory.js';

export interface NaturalLanguageMemoryRouteShortcut {
  memory: NaturalLanguageMemoryResponse;
  resultText: string;
}

/**
 * Attempt to execute a deterministic memory shortcut for chat-style routes.
 * Inputs/outputs: prompt + optional session id -> rendered memory result or null when prompt should continue through normal AI routing.
 * Edge cases: generic "show/get" tutoring prompts are ignored unless they include explicit memory/session cues.
 */
export async function tryExecuteNaturalLanguageMemoryRouteShortcut(params: {
  prompt: string;
  sessionId?: string;
}): Promise<NaturalLanguageMemoryRouteShortcut | null> {
  const parsedCommand = parseNaturalLanguageMemoryCommand(params.prompt);

  //audit Assumption: only prompts with explicit memory cues should bypass Trinity/tutor execution; failure risk: normal educational prompts get hijacked by the memory layer; expected invariant: generic prompts continue through standard routing; handling strategy: require both a parsed command and an explicit memory cue.
  if (parsedCommand.intent === 'unknown' || !hasNaturalLanguageMemoryCue(params.prompt)) {
    return null;
  }

  const memory = await executeNaturalLanguageMemoryCommand({
    input: params.prompt,
    sessionId: params.sessionId
  });

  return {
    memory,
    resultText: renderNaturalLanguageMemoryRouteResult(memory)
  };
}

/**
 * Render memory command results into deterministic plain text for conversational routes.
 * Inputs/outputs: structured memory response -> stable plain-text result.
 * Edge cases: unknown payloads fall back to the memory layer message instead of invoking model interpretation.
 */
export function renderNaturalLanguageMemoryRouteResult(memory: NaturalLanguageMemoryResponse): string {
  const inspectionText = renderMemoryInspectionResult(memory);
  if (inspectionText) {
    return inspectionText;
  }

  const savedConfirmationText = renderSavedMemoryConfirmation(memory);
  if (savedConfirmationText) {
    return savedConfirmationText;
  }

  const primaryText = extractPrimaryMemoryText(memory);
  if (primaryText) {
    return primaryText;
  }

  if (Array.isArray(memory.entries) && memory.entries.length > 0) {
    return formatMemoryEntries(memory.entries);
  }

  return memory.message;
}

function renderSavedMemoryConfirmation(memory: NaturalLanguageMemoryResponse): string | null {
  if (memory.operation !== 'saved') {
    return null;
  }

  const persistedKeyText = typeof memory.key === 'string' && memory.key.trim().length > 0
    ? ` Key: ${memory.key}.`
    : '';

  //audit Assumption: `/ask` save shortcuts should confirm the write path rather than echoing the stored content; failure risk: callers misread the response as model paraphrase with no DB confirmation; expected invariant: save operations return stable confirmation text; handling strategy: synthesize a route-level receipt using the saved session and key.
  return `Memory save confirmed for session ${memory.sessionId}.${persistedKeyText} ${memory.message} Use POST /api/save-conversation for strict persistence receipts.`;
}

function renderMemoryInspectionResult(memory: NaturalLanguageMemoryResponse): string | null {
  if (memory.operation !== 'inspected') {
    return null;
  }

  return safeSerializeMemoryValue({
    sessionId: memory.sessionId,
    operation: memory.operation,
    message: memory.message,
    inspection: memory.inspection ?? null,
    entries: memory.entries ?? []
  });
}

function extractPrimaryMemoryText(memory: NaturalLanguageMemoryResponse): string | null {
  if (memory.operation === 'saved' || memory.operation === 'retrieved') {
    const directValueText = extractTextValue(memory.value);
    if (directValueText) {
      return directValueText;
    }
  }

  return null;
}

function formatMemoryEntries(entries: NaturalLanguageMemoryEntry[]): string {
  return entries
    .map((entry) => {
      const textValue = extractTextValue(entry.value);
      //audit Assumption: list/search responses should expose the persisted human-readable text when available; failure risk: clients receive opaque JSON blobs that re-trigger model interpretation; expected invariant: rendered lists stay deterministic and inspectable; handling strategy: prefer text payloads and fall back to compact JSON serialization.
      if (textValue) {
        return textValue;
      }

      return safeSerializeMemoryValue(entry.value);
    })
    .filter((value) => value.length > 0)
    .join('\n\n');
}

function extractTextValue(value: unknown): string | null {
  if (typeof value === 'string' && value.trim()) {
    return value.trim();
  }

  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    if (typeof record.text === 'string' && record.text.trim()) {
      return record.text.trim();
    }
  }

  return null;
}

function safeSerializeMemoryValue(value: unknown): string {
  try {
    const serialized = JSON.stringify(value, null, 2);
    return typeof serialized === 'string' ? serialized : String(value);
  } catch {
    return String(value ?? '');
  }
}
