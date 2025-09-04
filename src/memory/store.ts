import { randomUUID } from 'crypto';

export interface SessionMetadata {
  topic?: string;
  tags?: string[];
  summary?: string;
}

export interface SessionEntry {
  sessionId: string;
  conversations_core: any;
  metadata?: SessionMetadata;
}

class MemoryStore {
  private sessions: SessionEntry[] = [];

  getAllSessions(): SessionEntry[] {
    return this.sessions;
  }

  saveSession(entry: SessionEntry): SessionEntry {
    const existingIndex = this.sessions.findIndex(s => s.sessionId === entry.sessionId);
    if (existingIndex >= 0) {
      this.sessions[existingIndex] = entry;
      return entry;
    }
    const session = entry.sessionId ? entry : { ...entry, sessionId: randomUUID() };
    this.sessions.push(session);
    return session;
  }
}

const memoryStore = new MemoryStore();
export default memoryStore;
