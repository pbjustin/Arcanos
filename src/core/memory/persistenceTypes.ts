export interface SessionMetadata {
  topic?: string;
  tags?: string[];
  summary?: string;
  [key: string]: unknown;
}

export interface SessionEntry {
  sessionId: string;
  conversations_core: unknown[];
  metadata?: SessionMetadata;
  updatedAt: number;
}

export interface SessionUpsert {
  sessionId?: string;
  conversations_core?: unknown[];
  metadata?: SessionMetadata;
}

export interface SessionPersistenceAdapter {
  initialize(): Promise<void>;
  loadSessions(): Promise<SessionEntry[]>;
  persistSession(session: SessionEntry): Promise<void>;
  removeSession(sessionId: string): Promise<void>;
  purgeExpired(cutoff: Date): Promise<void>;
}
