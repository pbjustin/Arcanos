import { randomUUID } from 'crypto';
import bcrypt from 'bcrypt';
export class MemoryStorage {
    users = new Map();
    sessions = new Map();
    memories = new Map();
    requests = new Map();
    cache = new Map();
    logs = new Map();
    events = new Map();
    SALT_ROUNDS = 12;
    MAX_MEMORY_ENTRIES = 10000;
    MAX_LOG_ENTRIES = 5000;
    CACHE_TTL = 60 * 60 * 1000; // 1 hour
    constructor() {
        this.initializeDefaultUsers();
        this.startCleanupTimer();
    }
    async initializeDefaultUsers() {
        const adminUser = {
            id: 'admin-001',
            username: 'admin',
            password: await bcrypt.hash('arcanos2025', this.SALT_ROUNDS),
            role: 'superadmin',
            createdAt: new Date(),
            sessions: [],
            preferences: {
                theme: 'dark',
                language: 'en',
                timezone: 'UTC',
                notifications: true,
                apiAccess: true
            }
        };
        this.users.set(adminUser.id, adminUser);
        console.log('[MEMORY] Default admin user created');
    }
    startCleanupTimer() {
        setInterval(() => {
            this.cleanupExpiredSessions();
            this.cleanupExpiredMemories();
            this.cleanupOldLogs();
            this.cleanupCache();
        }, 30 * 60 * 1000);
    }
    // User Management
    async createUser(username, password, role = 'user') {
        const existingUser = Array.from(this.users.values()).find(u => u.username === username);
        if (existingUser) {
            throw new Error('Username already exists');
        }
        const hashedPassword = await bcrypt.hash(password, this.SALT_ROUNDS);
        const user = {
            id: randomUUID(),
            username,
            password: hashedPassword,
            role,
            createdAt: new Date(),
            sessions: [],
            preferences: {
                theme: 'light',
                language: 'en',
                timezone: 'UTC',
                notifications: true,
                apiAccess: role !== 'user'
            }
        };
        this.users.set(user.id, user);
        this.logEvent('user.created', 'system', undefined, { userId: user.id, username });
        return user;
    }
    async authenticateUser(username, password) {
        const user = Array.from(this.users.values()).find(u => u.username === username);
        if (!user)
            return null;
        const isValid = await bcrypt.compare(password, user.password);
        if (!isValid)
            return null;
        user.lastLogin = new Date();
        this.users.set(user.id, user);
        this.logEvent('user.login', 'auth', user.id, { username });
        return user;
    }
    async getUserById(id) {
        return this.users.get(id);
    }
    async getUserByUsername(username) {
        return Array.from(this.users.values()).find(u => u.username === username);
    }
    // Session Management
    async createSession(userId, metadata = {}) {
        const user = this.users.get(userId);
        if (!user)
            throw new Error('User not found');
        const session = {
            id: randomUUID(),
            userId,
            createdAt: new Date(),
            lastActivity: new Date(),
            isActive: true,
            metadata
        };
        this.sessions.set(session.id, session);
        user.sessions.push(session.id);
        this.users.set(userId, user);
        this.logEvent('session.created', 'session', userId, { sessionId: session.id });
        return session;
    }
    async getSession(sessionId) {
        return this.sessions.get(sessionId);
    }
    // Memory Management
    async storeMemory(userId, sessionId, type, key, value, tags = [], ttl) {
        if (this.memories.size >= this.MAX_MEMORY_ENTRIES) {
            this.cleanupOldMemories();
        }
        const memory = {
            id: randomUUID(),
            userId,
            sessionId,
            type,
            key,
            value,
            timestamp: new Date(),
            ttl,
            tags,
            metadata: {
                importance: 'medium',
                category: type,
                source: 'user',
                version: 1,
                encrypted: false
            }
        };
        this.memories.set(memory.id, memory);
        this.logEvent('memory.created', 'memory', userId, { memoryId: memory.id, key, type });
        return memory;
    }
    async getMemoriesByUser(userId, type) {
        const memories = Array.from(this.memories.values())
            .filter(m => {
            if (m.userId !== userId)
                return false;
            if (type && m.type !== type)
                return false;
            if (m.ttl && Date.now() - m.timestamp.getTime() > m.ttl) {
                this.memories.delete(m.id);
                return false;
            }
            return true;
        })
            .sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime());
        return memories;
    }
    // Request Logging
    async logRequest(request) {
        const fullRequest = {
            id: randomUUID(),
            ...request
        };
        this.requests.set(fullRequest.id, fullRequest);
        return fullRequest;
    }
    async getRequests(limit = 100) {
        return Array.from(this.requests.values())
            .sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime())
            .slice(0, limit);
    }
    // Cache Management
    async setCache(key, value, ttl = this.CACHE_TTL) {
        const entry = {
            key,
            value,
            createdAt: new Date(),
            expiresAt: new Date(Date.now() + ttl),
            accessCount: 0,
            lastAccessed: new Date(),
            size: JSON.stringify(value).length
        };
        this.cache.set(key, entry);
    }
    async getCache(key) {
        const entry = this.cache.get(key);
        if (!entry)
            return undefined;
        if (entry.expiresAt && entry.expiresAt.getTime() < Date.now()) {
            this.cache.delete(key);
            return undefined;
        }
        entry.accessCount++;
        entry.lastAccessed = new Date();
        this.cache.set(key, entry);
        return entry.value;
    }
    // Event Management
    async logEvent(type, source, userId, data = {}) {
        const event = {
            id: randomUUID(),
            type,
            timestamp: new Date(),
            source,
            userId,
            data,
            metadata: {
                version: '1.0.0',
                environment: process.env.NODE_ENV || 'development'
            }
        };
        this.events.set(event.id, event);
        return event;
    }
    // Cleanup methods
    cleanupExpiredSessions() {
        const expiredTime = Date.now() - (24 * 60 * 60 * 1000);
        let cleanedCount = 0;
        for (const [sessionId, session] of this.sessions) {
            if (session.lastActivity.getTime() < expiredTime) {
                session.isActive = false;
                this.sessions.set(sessionId, session);
                cleanedCount++;
            }
        }
        if (cleanedCount > 0) {
            console.log(`[MEMORY] Cleaned up ${cleanedCount} expired sessions`);
        }
    }
    cleanupExpiredMemories() {
        const now = Date.now();
        let cleanedCount = 0;
        for (const [id, memory] of this.memories) {
            if (memory.ttl && now - memory.timestamp.getTime() > memory.ttl) {
                this.memories.delete(id);
                cleanedCount++;
            }
        }
        if (cleanedCount > 0) {
            console.log(`[MEMORY] Cleaned up ${cleanedCount} expired memories`);
        }
    }
    cleanupOldMemories() {
        const memoriesArray = Array.from(this.memories.entries());
        memoriesArray.sort((a, b) => a[1].timestamp.getTime() - b[1].timestamp.getTime());
        const toRemove = memoriesArray.slice(0, memoriesArray.length - this.MAX_MEMORY_ENTRIES + 1000);
        for (const [id] of toRemove) {
            this.memories.delete(id);
        }
        console.log(`[MEMORY] Cleaned up ${toRemove.length} old memories`);
    }
    cleanupOldLogs() {
        const logsArray = Array.from(this.logs.entries());
        logsArray.sort((a, b) => a[1].timestamp.getTime() - b[1].timestamp.getTime());
        const toRemove = logsArray.slice(0, logsArray.length - this.MAX_LOG_ENTRIES + 1000);
        for (const [id] of toRemove) {
            this.logs.delete(id);
        }
        console.log(`[MEMORY] Cleaned up ${toRemove.length} old logs`);
    }
    cleanupCache() {
        const now = Date.now();
        let cleanedCount = 0;
        for (const [key, entry] of this.cache) {
            if (entry.expiresAt && entry.expiresAt.getTime() < now) {
                this.cache.delete(key);
                cleanedCount++;
            }
        }
        if (cleanedCount > 0) {
            console.log(`[MEMORY] Cleaned up ${cleanedCount} expired cache entries`);
        }
    }
    getStorageStats() {
        return {
            users: this.users.size,
            sessions: this.sessions.size,
            activeSessions: Array.from(this.sessions.values()).filter(s => s.isActive).length,
            memories: this.memories.size,
            requests: this.requests.size,
            cacheEntries: this.cache.size,
            logs: this.logs.size,
            events: this.events.size,
            memoryUsage: process.memoryUsage()
        };
    }
}
//# sourceMappingURL=memory-storage.js.map