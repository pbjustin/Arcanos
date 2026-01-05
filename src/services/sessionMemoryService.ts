import sessionMemoryRepository from './sessionMemoryRepository.js';
import { recordConversationSnippet } from './webRag.js';
import { logger } from '../utils/structuredLogging.js';
import config from '../config/index.js';

const sessionMemoryLogger = logger.child({ module: 'sessionMemory' });

export async function saveMessage(sessionId: string, channel: string, message: any): Promise<void> {
  if (config.server.stateless) {
    return;
  }

  await sessionMemoryRepository.appendMessage(sessionId, channel, message);

  if (channel === 'conversations_core') {
    const content = typeof message === 'string' ? message : message?.content;
    if (typeof content !== 'string' || !content.trim()) {
      return;
    }

    const role = typeof message === 'object' && typeof message.role === 'string' ? message.role : 'user';
    const timestamp = typeof message === 'object' && typeof message.timestamp === 'number'
      ? message.timestamp
      : Date.now();

    const snippetMetadata: Record<string, unknown> = { channel };
    if (typeof message === 'object' && message) {
      if (typeof message.tokens === 'number' && Number.isFinite(message.tokens)) {
        snippetMetadata.tokens = message.tokens;
      }
      const auditTag = message.audit_tag || message.tag;
      if (typeof auditTag === 'string' && auditTag.trim()) {
        snippetMetadata.audit_tag = auditTag.trim();
      }
      if (typeof message.id === 'string' && message.id.trim()) {
        snippetMetadata.messageId = message.id.trim();
      }
    }

    try {
      await recordConversationSnippet({
        sessionId,
        role,
        content,
        timestamp,
        channel,
        metadata: snippetMetadata,
      });
    } catch (error) {
      sessionMemoryLogger.warn('Failed to mirror conversation message into RAG', {
        operation: 'saveMessage',
        sessionId,
        channel,
      }, undefined, error instanceof Error ? error : undefined);
    }
  }
}

export async function getChannel(sessionId: string, channel: string): Promise<any[]> {
  if (config.server.stateless) {
    return [];
  }

  return sessionMemoryRepository.getChannel(sessionId, channel);
}

export async function getConversation(sessionId: string): Promise<any[]> {
  if (config.server.stateless) {
    return [];
  }

  return sessionMemoryRepository.getConversation(sessionId);
}

export function getCachedSessions() {
  if (config.server.stateless) {
    return [];
  }

  return sessionMemoryRepository.getCachedSessions();
}
