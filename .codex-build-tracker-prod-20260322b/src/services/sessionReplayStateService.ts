import { getUserSessionDetail, type SessionDetail } from './sessionCatalogService.js';
import { getChannel, type SessionMessage } from './sessionMemoryService.js';

export interface SessionReplayRestoreTurn {
  index: number;
  role: string;
  content: string;
  timestamp: number | string | null;
  meta: Record<string, unknown>;
}

export interface SessionReplayRestoreState {
  sessionId: string;
  reconstructedAt: string;
  source: 'session-cache+memory-channels' | 'memory-channels';
  session: SessionDetail | null;
  channels: {
    conversations_core: SessionMessage[];
    system_meta: SessionMessage[];
  };
  state: {
    sessionId: string;
    updatedAt: string;
    versionId: string | null;
    monotonicTimestampMs: number | null;
    metadata: Record<string, unknown>;
    replayable: boolean;
    messageCount: number;
    droppedMessageCount: number;
    conversation: SessionReplayRestoreTurn[];
  };
  diagnostics: {
    conversationChannelCount: number;
    systemMetaCount: number;
    metadataSource: 'session-detail' | 'system-meta' | 'empty';
  };
}

/**
 * Build a restorable session snapshot from cached session detail and raw memory channels.
 * Inputs/outputs: session id -> reconstructed restore state or null when no persisted signals exist.
 * Edge cases: missing session-cache detail falls back to raw channel reconstruction so replay can still restore state.
 */
export async function buildSessionReplayRestoreState(sessionId: string): Promise<SessionReplayRestoreState | null> {
  const normalizedSessionId = normalizeSessionId(sessionId);
  //audit Assumption: restore-state reconstruction requires a stable explicit session id; failure risk: blank ids trigger ambiguous broad reads; expected invariant: bounded non-empty session id; handling strategy: reject invalid ids with null.
  if (!normalizedSessionId) {
    return null;
  }

  const [sessionDetail, conversationChannel, systemMetaChannel] = await Promise.all([
    getUserSessionDetail(normalizedSessionId),
    getChannel(normalizedSessionId, 'conversations_core'),
    getChannel(normalizedSessionId, 'system_meta')
  ]);

  const normalizedConversation = normalizeRestoreConversation(conversationChannel, systemMetaChannel);
  const metadataResolution = resolveRestoreMetadata(sessionDetail, systemMetaChannel);
  const updatedAt = sessionDetail?.updatedAt ?? resolveRestoreUpdatedAt(normalizedConversation.turns, systemMetaChannel);

  //audit Assumption: restore-state reconstruction can proceed from either a hydrated session row or raw channels alone; failure risk: replay works for transcripts but restore data disappears when session cache hydration lags; expected invariant: at least one persisted signal is enough to construct a restore payload; handling strategy: return null only when both session detail and raw channels are absent.
  if (!sessionDetail && conversationChannel.length === 0 && systemMetaChannel.length === 0 && normalizedConversation.turns.length === 0) {
    return null;
  }

  return {
    sessionId: normalizedSessionId,
    reconstructedAt: new Date().toISOString(),
    source: sessionDetail ? 'session-cache+memory-channels' : 'memory-channels',
    session: sessionDetail,
    channels: {
      conversations_core: conversationChannel,
      system_meta: systemMetaChannel
    },
    state: {
      sessionId: normalizedSessionId,
      updatedAt,
      versionId: sessionDetail?.versionId ?? null,
      monotonicTimestampMs: sessionDetail?.monotonicTimestampMs ?? null,
      metadata: metadataResolution.metadata,
      replayable: normalizedConversation.turns.length > 0,
      messageCount: normalizedConversation.turns.length,
      droppedMessageCount: normalizedConversation.droppedCount,
      conversation: normalizedConversation.turns
    },
    diagnostics: {
      conversationChannelCount: conversationChannel.length,
      systemMetaCount: systemMetaChannel.length,
      metadataSource: metadataResolution.source
    }
  };
}

function normalizeSessionId(sessionId: string): string | null {
  if (typeof sessionId !== 'string') {
    return null;
  }

  const normalized = sessionId.trim();
  return normalized.length > 0 ? normalized.slice(0, 100) : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }

  return value as Record<string, unknown>;
}

function resolveMessageContent(messageRecord: Record<string, unknown>): string | null {
  const candidates = [messageRecord.content, messageRecord.value, messageRecord.text];
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim().length > 0) {
      return candidate.trim();
    }
  }

  return null;
}

function resolveMessageTimestamp(
  messageRecord: Record<string, unknown>,
  meta: Record<string, unknown>
): number | string | null {
  const candidates = [messageRecord.timestamp, meta.timestamp];
  for (const candidate of candidates) {
    if (typeof candidate === 'number' && Number.isFinite(candidate)) {
      return candidate;
    }

    if (typeof candidate === 'string' && candidate.trim().length > 0) {
      return candidate.trim();
    }
  }

  return null;
}

function normalizeRestoreConversation(
  conversationChannel: SessionMessage[],
  systemMetaChannel: SessionMessage[]
): { turns: SessionReplayRestoreTurn[]; droppedCount: number } {
  const turns: SessionReplayRestoreTurn[] = [];
  let droppedCount = 0;

  for (let index = 0; index < conversationChannel.length; index += 1) {
    const rawConversationEntry = conversationChannel[index];
    const messageRecord =
      typeof rawConversationEntry === 'string'
        ? { value: rawConversationEntry }
        : asRecord(rawConversationEntry);
    if (!messageRecord) {
      droppedCount += 1;
      continue;
    }

    const content = resolveMessageContent(messageRecord);
    //audit Assumption: reconstructed restore conversations should only include visible text turns; failure risk: callers restore blank or malformed message items back into state; expected invariant: each reconstructed turn has non-empty content; handling strategy: skip malformed entries and track the dropped count.
    if (!content) {
      droppedCount += 1;
      continue;
    }

    const meta = asRecord(systemMetaChannel[index]) ?? {};
    turns.push({
      index,
      role:
        typeof messageRecord.role === 'string' && messageRecord.role.trim().length > 0
          ? messageRecord.role.trim()
          : 'user',
      content,
      timestamp: resolveMessageTimestamp(messageRecord, meta),
      meta
    });
  }

  return { turns, droppedCount };
}

function resolveRestoreMetadata(
  sessionDetail: SessionDetail | null,
  systemMetaChannel: SessionMessage[]
): { metadata: Record<string, unknown>; source: 'session-detail' | 'system-meta' | 'empty' } {
  if (sessionDetail) {
    return {
      metadata: sessionDetail.metadata,
      source: 'session-detail'
    };
  }

  const mergedMetadata: Record<string, unknown> = {};

  for (const rawEntry of systemMetaChannel) {
    const metadataRecord = asRecord(rawEntry);
    if (!metadataRecord) {
      continue;
    }

    if (typeof metadataRecord.topic === 'string' && metadataRecord.topic.trim().length > 0) {
      mergedMetadata.topic = metadataRecord.topic.trim();
    }

    if (typeof metadataRecord.summary === 'string' && metadataRecord.summary.trim().length > 0) {
      mergedMetadata.summary = metadataRecord.summary.trim();
    }

    if (Array.isArray(metadataRecord.tags)) {
      mergedMetadata.tags = metadataRecord.tags
        .filter((tag): tag is string => typeof tag === 'string' && tag.trim().length > 0)
        .map(tag => tag.trim());
    }

    const nestedMetadata = asRecord(metadataRecord.metadata);
    if (nestedMetadata) {
      Object.assign(mergedMetadata, nestedMetadata);
    }
  }

  if (Object.keys(mergedMetadata).length > 0) {
    return {
      metadata: mergedMetadata,
      source: 'system-meta'
    };
  }

  return {
    metadata: {},
    source: 'empty'
  };
}

function resolveRestoreUpdatedAt(
  conversationTurns: SessionReplayRestoreTurn[],
  systemMetaChannel: SessionMessage[]
): string {
  const numericTimestamps: number[] = [];
  const stringTimestamps: string[] = [];

  for (const turn of conversationTurns) {
    if (typeof turn.timestamp === 'number' && Number.isFinite(turn.timestamp)) {
      numericTimestamps.push(turn.timestamp);
    } else if (typeof turn.timestamp === 'string' && turn.timestamp.trim().length > 0) {
      stringTimestamps.push(turn.timestamp.trim());
    }
  }

  for (const rawEntry of systemMetaChannel) {
    const metadataRecord = asRecord(rawEntry);
    if (!metadataRecord) {
      continue;
    }

    const timestamp = metadataRecord.timestamp;
    if (typeof timestamp === 'number' && Number.isFinite(timestamp)) {
      numericTimestamps.push(timestamp);
    } else if (typeof timestamp === 'string' && timestamp.trim().length > 0) {
      stringTimestamps.push(timestamp.trim());
    }
  }

  //audit Assumption: restore payloads should carry the freshest known state timestamp; failure risk: clients treat stale epoch timestamps as the latest restore point; expected invariant: prefer numeric event timestamps when present, then valid string timestamps, else fall back to epoch; handling strategy: compute the max known timestamp across reconstructed channels.
  if (numericTimestamps.length > 0) {
    return new Date(Math.max(...numericTimestamps)).toISOString();
  }

  for (const timestamp of stringTimestamps) {
    const parsedTimestamp = Date.parse(timestamp);
    if (!Number.isNaN(parsedTimestamp)) {
      return new Date(parsedTimestamp).toISOString();
    }
  }

  return new Date(0).toISOString();
}
