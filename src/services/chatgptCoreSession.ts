import { loadChatGptCoreSessionMemory, saveChatGptCoreSessionMemory } from '@core/db/repositories/memoryRepository.js';
import { getRequestAbortSignal } from '@arcanos/runtime';
import { buildSessionContextFromStoredTurns } from '@shared/memory/sessionContextCore.js';
import { isRecord } from '@shared/typeGuards.js';
import { coreRecordHash, openCoreRecord, sealCoreRecord } from './chatgptCoreStorage.js';

interface CoreNote { keyHash: string; text: string }
export interface CoreTurn { prompt: string; answer: string }
interface SessionData { notes: CoreNote[] }
interface CoreSession extends SessionData { revision: string }

const MAX_NOTES = 16;
const MAX_UPDATE_ATTEMPTS = 5;

export async function readCoreSession(key: Buffer, owner: string, sessionId: string): Promise<CoreSession | null> {
  const entry = await loadChatGptCoreSessionMemory(sessionId);
  if (!isRecord(entry) || entry.owner !== owner) return null;
  const { revision, envelope } = entry;
  if (typeof revision !== 'string' || !/^[1-9][0-9]{0,18}$/u.test(revision)) {
    throw new Error('CORE_STORAGE_UNAVAILABLE');
  }
  const data = openCoreRecord(key, 'session', owner, `${sessionId}:${revision}`, envelope);
  if (!isRecord(data) || !Array.isArray(data.notes)) {
    throw new Error('CORE_STORAGE_UNAVAILABLE');
  }
  // A version-authenticated record is always produced by writeCoreSession.
  return { revision, notes: data.notes as CoreNote[] };
}

async function writeCoreSession(
  key: Buffer, owner: string, sessionId: string, revision: string, data: SessionData,
): Promise<boolean> {
  getRequestAbortSignal()?.throwIfAborted();
  const envelope = sealCoreRecord(key, 'session', owner, `${sessionId}:${revision}`, data);
  return Boolean(await saveChatGptCoreSessionMemory(sessionId, { owner, revision, envelope }, revision));
}

/** Retry-safe empty session creation with a stable owner-bound handle. */
export async function startCoreSession(key: Buffer, owner: string, idempotencyKey: string): Promise<string> {
  const sessionId = coreRecordHash(['core-session-v1', owner, idempotencyKey]);
  if (!await readCoreSession(key, owner, sessionId)
    && !await writeCoreSession(key, owner, sessionId, '1', { notes: [] })
    && !await readCoreSession(key, owner, sessionId)) {
    throw new Error('CORE_STORAGE_UNAVAILABLE');
  }
  return sessionId;
}

async function updateCoreSession(
  key: Buffer, owner: string, sessionId: string, update: (session: CoreSession) => SessionData | null,
): Promise<boolean> {
  for (let attempt = 0; attempt < MAX_UPDATE_ATTEMPTS; attempt++) {
    const session = await readCoreSession(key, owner, sessionId);
    if (!session) return false;
    const next = update(session);
    if (next === null || await writeCoreSession(key, owner, sessionId, String(BigInt(session.revision) + 1n), next)) {
      return true;
    }
  }
  throw new Error('CORE_STORAGE_UNAVAILABLE');
}

export function findCoreNote(session: CoreSession, idempotencyKey: string): CoreNote | undefined {
  const keyHash = coreRecordHash(['core-note-v1', idempotencyKey]);
  return session.notes.find(note => note.keyHash === keyHash);
}

export async function appendCoreNote(key: Buffer, owner: string, sessionId: string, idempotencyKey: string, text: string) {
  return updateCoreSession(key, owner, sessionId, session => {
    const prior = findCoreNote(session, idempotencyKey);
    if (prior) {
      if (prior.text !== text) throw new Error('CORE_IDEMPOTENCY_CONFLICT');
      return null;
    }
    if (session.notes.length >= MAX_NOTES) throw new Error('CORE_MEMORY_LIMIT_REACHED');
    const note = { keyHash: coreRecordHash(['core-note-v1', idempotencyKey]), text };
    return { notes: [...session.notes, note] };
  });
}

export function renderCoreSession(sessionId: string, session: CoreSession, turns: readonly CoreTurn[]): string | undefined {
  const history = turns.flatMap(turn => [
    { role: 'user', content: turn.prompt.slice(0, 6_000) },
    { role: 'assistant', content: turn.answer.slice(0, 6_000) },
  ]);
  const notes = session.notes.slice(-4).map(note => ({ role: 'user', content: `Saved memory: ${note.text}` }));
  return buildSessionContextFromStoredTurns(
    sessionId, [...history, ...notes], { maxTurns: 20, maxChars: 16_000 },
  ).renderedContext || undefined;
}
