import type { User, Session, MemoryEntry, APIRequest, SystemEvent } from '../types';
export declare class MemoryStorage {
    private users;
    private sessions;
    private memories;
    private requests;
    private cache;
    private logs;
    private events;
    private readonly SALT_ROUNDS;
    private readonly MAX_MEMORY_ENTRIES;
    private readonly MAX_LOG_ENTRIES;
    private readonly CACHE_TTL;
    constructor();
    private initializeDefaultUsers;
    private startCleanupTimer;
    createUser(username: string, password: string, role?: User['role']): Promise<User>;
    authenticateUser(username: string, password: string): Promise<User | null>;
    getUserById(id: string): Promise<User | undefined>;
    getUserByUsername(username: string): Promise<User | undefined>;
    createSession(userId: string, metadata?: Session['metadata']): Promise<Session>;
    getSession(sessionId: string): Promise<Session | undefined>;
    storeMemory(userId: string, sessionId: string, type: MemoryEntry['type'], key: string, value: any, tags?: string[], ttl?: number): Promise<MemoryEntry>;
    getMemoriesByUser(userId: string, type?: MemoryEntry['type']): Promise<MemoryEntry[]>;
    logRequest(request: Omit<APIRequest, 'id'>): Promise<APIRequest>;
    getRequests(limit?: number): Promise<APIRequest[]>;
    setCache<T>(key: string, value: T, ttl?: number): Promise<void>;
    getCache<T>(key: string): Promise<T | undefined>;
    logEvent(type: SystemEvent['type'], source: string, userId?: string, data?: Record<string, any>): Promise<SystemEvent>;
    private cleanupExpiredSessions;
    private cleanupExpiredMemories;
    private cleanupOldMemories;
    private cleanupOldLogs;
    private cleanupCache;
    getStorageStats(): {
        users: number;
        sessions: number;
        activeSessions: number;
        memories: number;
        requests: number;
        cacheEntries: number;
        logs: number;
        events: number;
        memoryUsage: NodeJS.MemoryUsage;
    };
}
//# sourceMappingURL=memory-storage.d.ts.map