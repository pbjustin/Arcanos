import { loadMemory, saveMemory } from "@core/db/index.js";
import { resolveErrorMessage } from "@core/lib/errors/index.js";
import { logger } from "@platform/logging/structuredLogging.js";
import { saveMessage } from "@services/sessionMemoryService.js";
import { Mutex } from "async-mutex";

const modulePersistenceLogger = logger.child({ module: "moduleConversationPersistence" });

const MODULE_HISTORY_LIMIT = 60;
const MODULE_SUMMARY_LIMIT = 20;
const TEXT_PREVIEW_LIMIT = 1800;
const persistenceLocks = new Map<string, Mutex>();

interface ModuleConversationPersistenceInput {
  moduleName: string;
  route?: string;
  action: string;
  gptId: string;
  sessionId?: string;
  requestId?: string;
  requestPayload: unknown;
  responsePayload: unknown;
}

interface ModuleInteractionSnapshot {
  interactionId: string;
  moduleName: string;
  route: string | null;
  action: string;
  gptId: string;
  sessionId: string;
  createdAt: string;
  promptPreview: string;
  responsePreview: string;
}

interface ModuleInteractionHistory {
  moduleName: string;
  route: string | null;
  sessionId: string;
  updatedAt: string;
  entries: ModuleInteractionSnapshot[];
}

interface ModuleSummaryState {
  moduleName: string;
  route: string | null;
  updatedAt: string;
  latestAction: string;
  latestResponsePreview: string;
  latestPromptPreview: string;
  recent: ModuleInteractionSnapshot[];
}

/**
 * Persist module conversation snapshots and summaries for cross-session recall.
 * Inputs: module routing/action metadata plus request/response payloads.
 * Output: resolves when best-effort persistence has completed.
 * Edge cases: never throws; logs warnings and continues when persistence is unavailable.
 */
export async function persistModuleConversation(
  input: ModuleConversationPersistenceInput
): Promise<void> {
  const now = new Date().toISOString();
  const normalizedRoute = normalizeModuleKeyPart(input.route || input.moduleName);
  const sessionId = resolveSessionId(input);
  const promptPreview = buildPromptPreview(input.requestPayload);
  const responsePreview = buildResponsePreview(input.responsePayload);
  const snapshot: ModuleInteractionSnapshot = {
    interactionId: input.requestId || `${Date.now()}-${Math.random().toString(16).slice(2, 10)}`,
    moduleName: input.moduleName,
    route: input.route || null,
    action: input.action,
    gptId: input.gptId,
    sessionId,
    createdAt: now,
    promptPreview,
    responsePreview
  };

  await persistSessionConversation(sessionId, snapshot, input.requestPayload, input.responsePayload);

  const historyKey = `module-history:${normalizedRoute}`;
  const summaryKey = `module-summary:${normalizedRoute}`;
  const lastSessionKey = `module-last-session:${normalizedRoute}`;

  await persistModuleHistory(historyKey, snapshot);
  await persistModuleSummary(summaryKey, snapshot);
  await saveMemory(lastSessionKey, {
    sessionId,
    moduleName: input.moduleName,
    route: input.route || null,
    updatedAt: now
  }).catch((error: unknown) => {
    //audit Assumption: last-session pointer is convenience metadata; failure risk: slower manual lookup; expected invariant: core history still persists; handling strategy: log warning and continue.
    modulePersistenceLogger.warn("Failed to persist module last-session pointer", {
      operation: "persistModuleConversation",
      key: lastSessionKey,
      error: resolveErrorMessage(error, "unknown")
    });
  });

  if (input.moduleName === "BACKSTAGE:BOOKER") {
    await persistBackstageBookerConvenienceKeys(input.action, input.requestPayload, input.responsePayload, now);
  }
}

/**
 * Persist conversational user/assistant turns into the session cache channel.
 * Inputs: resolved session id, interaction snapshot, raw request/response payloads.
 * Output: resolves once best-effort writes complete.
 * Edge cases: skips empty prompt/response text; logs failures without throwing.
 */
async function persistSessionConversation(
  sessionId: string,
  snapshot: ModuleInteractionSnapshot,
  requestPayload: unknown,
  responsePayload: unknown
): Promise<void> {
  const timestamp = Date.now();
  const promptText = buildPromptPreview(requestPayload);
  const responseText = buildResponsePreview(responsePayload);
  const channelName = `module:${normalizeModuleKeyPart(snapshot.route || snapshot.moduleName)}`;

  if (promptText) {
    await saveMessage(sessionId, "conversations_core", {
      role: "user",
      content: promptText,
      timestamp,
      module: snapshot.moduleName,
      action: snapshot.action,
      channel: channelName
    }).catch((error: unknown) => {
      //audit Assumption: session cache writes are best-effort; failure risk: missing per-session transcript; expected invariant: DB history still available; handling strategy: warn and continue.
      modulePersistenceLogger.warn("Failed to persist module user conversation entry", {
        operation: "persistSessionConversation",
        sessionId,
        moduleName: snapshot.moduleName,
        error: resolveErrorMessage(error, "unknown")
      });
    });
  }

  if (responseText) {
    await saveMessage(sessionId, "conversations_core", {
      role: "assistant",
      content: responseText,
      timestamp,
      module: snapshot.moduleName,
      action: snapshot.action,
      channel: channelName
    }).catch((error: unknown) => {
      //audit Assumption: assistant transcript persistence can fail independently; failure risk: partial conversation replay; expected invariant: request side may still be present; handling strategy: warn and continue.
      modulePersistenceLogger.warn("Failed to persist module assistant conversation entry", {
        operation: "persistSessionConversation",
        sessionId,
        moduleName: snapshot.moduleName,
        error: resolveErrorMessage(error, "unknown")
      });
    });
  }
}

/**
 * Append an interaction snapshot to module history state.
 * Inputs: memory key and latest snapshot.
 * Output: resolves when history key has been upserted.
 * Edge cases: legacy payload shapes are normalized into the current schema.
 */
async function persistModuleHistory(key: string, snapshot: ModuleInteractionSnapshot): Promise<void> {
  await withPersistenceLock(key, async () => {
    const existing = await loadMemory(key).catch((error: unknown) => {
      //audit Assumption: read failures should not block new history writes; failure risk: dropping prior entries; expected invariant: latest interaction still persisted; handling strategy: continue with empty baseline.
      modulePersistenceLogger.warn("Failed to load module history baseline", {
        operation: "persistModuleHistory",
        key,
        error: resolveErrorMessage(error, "unknown")
      });
      return null;
    });

    const baseline = normalizeHistoryState(existing, snapshot);
    baseline.entries = [snapshot, ...baseline.entries].slice(0, MODULE_HISTORY_LIMIT);
    baseline.updatedAt = snapshot.createdAt;

    await saveMemory(key, baseline).catch((error: unknown) => {
      //audit Assumption: history persistence may fail when DB is degraded; failure risk: interaction not queryable later; expected invariant: request path remains successful; handling strategy: warn and continue.
      modulePersistenceLogger.warn("Failed to persist module interaction history", {
        operation: "persistModuleHistory",
        key,
        moduleName: snapshot.moduleName,
        error: resolveErrorMessage(error, "unknown")
      });
    });
  });
}

/**
 * Upsert a compact latest-summary document for module interactions.
 * Inputs: summary key and latest snapshot.
 * Output: resolves when summary key is updated.
 * Edge cases: malformed legacy values are replaced with a fresh summary envelope.
 */
async function persistModuleSummary(key: string, snapshot: ModuleInteractionSnapshot): Promise<void> {
  await withPersistenceLock(key, async () => {
    const existing = await loadMemory(key).catch((error: unknown) => {
      //audit Assumption: summary read failures are recoverable; failure risk: recent list reset; expected invariant: latest summary still written; handling strategy: start fresh summary state.
      modulePersistenceLogger.warn("Failed to load module summary baseline", {
        operation: "persistModuleSummary",
        key,
        error: resolveErrorMessage(error, "unknown")
      });
      return null;
    });

    const baseline = normalizeSummaryState(existing, snapshot);
    baseline.latestAction = snapshot.action;
    baseline.latestPromptPreview = snapshot.promptPreview;
    baseline.latestResponsePreview = snapshot.responsePreview;
    baseline.updatedAt = snapshot.createdAt;
    baseline.recent = [snapshot, ...baseline.recent].slice(0, MODULE_SUMMARY_LIMIT);

    await saveMemory(key, baseline).catch((error: unknown) => {
      //audit Assumption: summary persistence is optional metadata; failure risk: no quick preview in new chats; expected invariant: history may still exist separately; handling strategy: warn and continue.
      modulePersistenceLogger.warn("Failed to persist module summary", {
        operation: "persistModuleSummary",
        key,
        moduleName: snapshot.moduleName,
        error: resolveErrorMessage(error, "unknown")
      });
    });
  });
}

/**
 * Persist convenience keys for Backstage Booker roster/storyline retrieval.
 * Inputs: action name, request payload, response payload, timestamp.
 * Output: resolves when applicable convenience keys are updated.
 * Edge cases: ignores malformed payloads and only writes when required fields exist.
 */
async function persistBackstageBookerConvenienceKeys(
  action: string,
  requestPayload: unknown,
  responsePayload: unknown,
  timestamp: string
): Promise<void> {
  const normalizedAction = action.trim();

  //audit Assumption: saveStoryline payload carries key/storyline fields; failure risk: missing direct lookup keys; expected invariant: valid storyline writes mirrored; handling strategy: conditional key extraction.
  if (normalizedAction === "saveStoryline") {
    const payloadRecord = asRecord(requestPayload);
    const key = typeof payloadRecord?.key === "string" ? payloadRecord.key.trim() : "";
    const storyline = typeof payloadRecord?.storyline === "string" ? payloadRecord.storyline.trim() : "";
    if (key && storyline) {
      await saveMemory(`backstage-storyline:${key}`, {
        key,
        storyline,
        savedAt: timestamp
      }).catch((error: unknown) => {
        modulePersistenceLogger.warn("Failed to persist Backstage storyline convenience key", {
          operation: "persistBackstageBookerConvenienceKeys",
          key,
          error: resolveErrorMessage(error, "unknown")
        });
      });
      await saveMemory("backstage-storyline:latest", {
        key,
        storyline,
        savedAt: timestamp
      }).catch((error: unknown) => {
        modulePersistenceLogger.warn("Failed to persist latest Backstage storyline convenience key", {
          operation: "persistBackstageBookerConvenienceKeys",
          key: "backstage-storyline:latest",
          error: resolveErrorMessage(error, "unknown")
        });
      });
    }
  }

  //audit Assumption: updateRoster returns canonical roster array; failure risk: stale roster recall; expected invariant: latest roster snapshot mirrored; handling strategy: save when array result present.
  if (normalizedAction === "updateRoster" && Array.isArray(responsePayload)) {
    await saveMemory("backstage-roster:latest", {
      roster: responsePayload,
      savedAt: timestamp
    }).catch((error: unknown) => {
      modulePersistenceLogger.warn("Failed to persist latest Backstage roster convenience key", {
        operation: "persistBackstageBookerConvenienceKeys",
        key: "backstage-roster:latest",
        error: resolveErrorMessage(error, "unknown")
      });
    });
  }

  //audit Assumption: trackStoryline returns chronological storyline collection; failure risk: no short-form recall in new chats; expected invariant: latest beat timeline mirrored; handling strategy: save when array result present.
  if (normalizedAction === "trackStoryline" && Array.isArray(responsePayload)) {
    await saveMemory("backstage-storybeats:latest", {
      beats: responsePayload,
      savedAt: timestamp
    }).catch((error: unknown) => {
      modulePersistenceLogger.warn("Failed to persist latest Backstage storyline beats convenience key", {
        operation: "persistBackstageBookerConvenienceKeys",
        key: "backstage-storybeats:latest",
        error: resolveErrorMessage(error, "unknown")
      });
    });
  }
}

function resolveSessionId(input: ModuleConversationPersistenceInput): string {
  const providedSessionId = typeof input.sessionId === "string" ? input.sessionId.trim() : "";
  if (providedSessionId) {
    return providedSessionId;
  }

  const normalizedRoute = normalizeModuleKeyPart(input.route || input.moduleName);
  //audit Assumption: module-global fallback session ids provide cross-chat continuity when callers omit sessionId; failure risk: mixed transcript between users sharing gptId; expected invariant: deterministic fallback key; handling strategy: namespace by module and gpt id.
  return `module:${normalizedRoute}:gpt:${normalizeModuleKeyPart(input.gptId)}`;
}

function normalizeModuleKeyPart(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "") || "unknown";
}

function normalizeHistoryState(existing: unknown, snapshot: ModuleInteractionSnapshot): ModuleInteractionHistory {
  const record = asRecord(existing);
  const entries = Array.isArray(record?.entries) ? record.entries.filter(isSnapshotLike).map(toSnapshot) : [];

  return {
    moduleName: snapshot.moduleName,
    route: snapshot.route,
    sessionId: snapshot.sessionId,
    updatedAt: typeof record?.updatedAt === "string" ? record.updatedAt : snapshot.createdAt,
    entries
  };
}

function normalizeSummaryState(existing: unknown, snapshot: ModuleInteractionSnapshot): ModuleSummaryState {
  const record = asRecord(existing);
  const recent = Array.isArray(record?.recent) ? record.recent.filter(isSnapshotLike).map(toSnapshot) : [];

  return {
    moduleName: snapshot.moduleName,
    route: snapshot.route,
    updatedAt: typeof record?.updatedAt === "string" ? record.updatedAt : snapshot.createdAt,
    latestAction: typeof record?.latestAction === "string" ? record.latestAction : snapshot.action,
    latestResponsePreview:
      typeof record?.latestResponsePreview === "string" ? record.latestResponsePreview : snapshot.responsePreview,
    latestPromptPreview:
      typeof record?.latestPromptPreview === "string" ? record.latestPromptPreview : snapshot.promptPreview,
    recent
  };
}

function isSnapshotLike(value: unknown): value is Record<string, unknown> {
  const record = asRecord(value);
  return Boolean(
    record &&
      typeof record.interactionId === "string" &&
      typeof record.moduleName === "string" &&
      typeof record.action === "string" &&
      typeof record.createdAt === "string"
  );
}

function toSnapshot(value: Record<string, unknown>): ModuleInteractionSnapshot {
  return {
    interactionId: String(value.interactionId),
    moduleName: String(value.moduleName),
    route: typeof value.route === "string" ? value.route : null,
    action: String(value.action),
    gptId: typeof value.gptId === "string" ? value.gptId : "unknown",
    sessionId: typeof value.sessionId === "string" ? value.sessionId : "unknown",
    createdAt: String(value.createdAt),
    promptPreview: typeof value.promptPreview === "string" ? value.promptPreview : "",
    responsePreview: typeof value.responsePreview === "string" ? value.responsePreview : ""
  };
}

function buildPromptPreview(payload: unknown): string {
  if (typeof payload === "string") {
    return trimPreview(payload);
  }

  const record = asRecord(payload);
  if (!record) {
    return "";
  }

  const candidates = [record.prompt, record.message, record.userInput, record.content, record.text, record.query];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim()) {
      return trimPreview(candidate);
    }
  }

  //audit Assumption: non-text payloads can still be summarized as JSON snippets; failure risk: losing context for action-only calls; expected invariant: deterministic preview string; handling strategy: stringify with cap.
  return trimPreview(safeStringify(record));
}

function buildResponsePreview(payload: unknown): string {
  if (typeof payload === "string") {
    return trimPreview(payload);
  }

  const record = asRecord(payload);
  if (record) {
    const directCandidates = [record.result, record.storyline, record.output, record.response, record.message];
    for (const candidate of directCandidates) {
      if (typeof candidate === "string" && candidate.trim()) {
        return trimPreview(candidate);
      }
    }
  }

  return trimPreview(safeStringify(payload));
}

function trimPreview(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length <= TEXT_PREVIEW_LIMIT) {
    return trimmed;
  }
  return `${trimmed.slice(0, TEXT_PREVIEW_LIMIT)}...`;
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function getPersistenceLock(key: string): Mutex {
  const existing = persistenceLocks.get(key);
  if (existing) {
    return existing;
  }

  const created = new Mutex();
  persistenceLocks.set(key, created);
  return created;
}

async function withPersistenceLock<T>(key: string, task: () => Promise<T>): Promise<T> {
  const lock = getPersistenceLock(key);
  return lock.runExclusive(task);
}
