import sessionMemoryRepository from './sessionMemoryRepository.js';

export async function saveMessage(sessionId: string, channel: string, message: any): Promise<void> {
  await sessionMemoryRepository.appendMessage(sessionId, channel, message);
}

export async function getChannel(sessionId: string, channel: string): Promise<any[]> {
  return sessionMemoryRepository.getChannel(sessionId, channel);
}

export async function getConversation(sessionId: string): Promise<any[]> {
  return sessionMemoryRepository.getConversation(sessionId);
}

export function getCachedSessions() {
  return sessionMemoryRepository.getCachedSessions();
}
