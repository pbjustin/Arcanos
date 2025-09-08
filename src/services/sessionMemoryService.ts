import { saveMemory, loadMemory } from '../db.js';

// Fallback in-memory store
const memoryStore: Record<string, any[]> = {};

function makeKey(sessionId: string, channel: string): string {
  return `session:${sessionId}:${channel}`;
}

export async function saveMessage(sessionId: string, channel: string, message: any): Promise<void> {
  const key = makeKey(sessionId, channel);
  let messages: any[] = [];
  try {
    messages = (await loadMemory(key)) || [];
  } catch {
    messages = memoryStore[key] || [];
  }
  messages.push(message);
  try {
    await saveMemory(key, messages);
  } catch {
    memoryStore[key] = messages;
  }
}

export async function getChannel(sessionId: string, channel: string): Promise<any[]> {
  const key = makeKey(sessionId, channel);
  try {
    return (await loadMemory(key)) || [];
  } catch {
    return memoryStore[key] || [];
  }
}

export async function getConversation(sessionId: string): Promise<any[]> {
  const [core, meta] = await Promise.all([
    getChannel(sessionId, 'conversations_core'),
    getChannel(sessionId, 'system_meta')
  ]);

  const metaMap = new Map((meta as any[]).map((m: any) => [m.id, m]));

  return (core as any[])
    .map((msg: any) => ({
      ...msg,
      meta: metaMap.get(msg.id) || {}
    }))
    .sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
}

export async function getMessage(
  sessionId: string,
  messageId: string
): Promise<any | undefined> {
  const [core, meta] = await Promise.all([
    getChannel(sessionId, 'conversations_core'),
    getChannel(sessionId, 'system_meta')
  ]);

  const msg = (core as any[]).find((m: any) => m.id === messageId);
  if (!msg) return undefined;
  const metaEntry = (meta as any[]).find((m: any) => m.id === messageId) || {};
  return { ...msg, meta: metaEntry };
}
