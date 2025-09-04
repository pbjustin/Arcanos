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
