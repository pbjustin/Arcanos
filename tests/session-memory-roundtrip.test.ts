import { saveMessage, getConversation } from '../src/services/sessionMemoryService';
import { SessionMemoryRepository } from '../src/services/sessionMemoryRepository';
import memoryStore from '../src/memory/store';

describe('session memory round trip', () => {
  it('stores and retrieves raw messages with metadata', async () => {
    const sessionId = 'test-session';

    await saveMessage(sessionId, 'conversations_core', {
      role: 'user',
      content: 'Hello',
      timestamp: 1
    });
    await saveMessage(sessionId, 'system_meta', {
      tokens: 1,
      audit_tag: 'test',
      timestamp: 1
    });

    await saveMessage(sessionId, 'conversations_core', {
      role: 'assistant',
      content: 'Hi there',
      timestamp: 2
    });
    await saveMessage(sessionId, 'system_meta', {
      tokens: 2,
      audit_tag: 'test',
      timestamp: 2
    });

    const convo = await getConversation(sessionId);
    expect(convo).toEqual([
      {
        role: 'user',
        content: 'Hello',
        timestamp: 1,
        meta: { tokens: 1, audit_tag: 'test', timestamp: 1 }
      },
      {
        role: 'assistant',
        content: 'Hi there',
        timestamp: 2,
        meta: { tokens: 2, audit_tag: 'test', timestamp: 2 }
      }
    ]);
  });

  it('falls back to process cache when persistent channels are unavailable', async () => {
    const sessionId = 'process-cache-session';
    const repository = new SessionMemoryRepository({ fallbackTtlMs: 0 });

    // Reset the in-process cache for a clean test run
    (memoryStore as any).sessions = new Map();

    memoryStore.saveSession({
      sessionId,
      conversations_core: [
        {
          role: 'user',
          content: 'Here is my Arcanos Gaming guide',
          timestamp: 123
        }
      ],
      metadata: {
        tokens: 42,
        audit_tag: 'guide',
        timestamp: 123
      }
    });

    const convo = await repository.getConversation(sessionId);
    expect(convo).toEqual([
      {
        role: 'user',
        content: 'Here is my Arcanos Gaming guide',
        timestamp: 123,
        meta: {
          tokens: 42,
          audit_tag: 'guide',
          timestamp: 123
        }
      }
    ]);
  });
});

