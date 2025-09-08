import { saveMessage, getConversation } from '../src/services/sessionMemoryService';

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
});

