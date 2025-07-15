export interface User {
  id: string;
  username: string;
  password: string;
  role: 'user' | 'admin' | 'superadmin';
  createdAt: Date;
  lastLogin?: Date;
  sessions: string[];
  preferences: UserPreferences;
}

export interface UserPreferences {
  theme: 'light' | 'dark';
  language: string;
  timezone: string;
  notifications: boolean;
  apiAccess: boolean;
}

export interface Session {
  id: string;
  userId: string;
  createdAt: Date;
  lastActivity: Date;
  isActive: boolean;
  metadata: Record<string, any>;
}

export interface MemoryEntry {
  id: string;
  userId: string;
  sessionId: string;
  type: 'conversation' | 'preference' | 'context' | 'system' | 'temporary';
  key: string;
  value: any;
  timestamp: Date;
  ttl?: number;
  tags: string[];
  metadata: {
    importance: 'low' | 'medium' | 'high';
    category: string;
    source: 'user' | 'system' | 'ai';
    version: number;
    encrypted: boolean;
  };
}

export interface APIRequest {
  id: string;
  method: string;
  endpoint: string;
  userId?: string;
  sessionId?: string;
  timestamp: Date;
  responseTime: number;
  statusCode: number;
  userAgent?: string;
  ipAddress?: string;
  requestSize: number;
  responseSize: number;
  cached: boolean;
}

export interface CacheEntry<T = any> {
  key: string;
  value: T;
  createdAt: Date;
  expiresAt?: Date;
  accessCount: number;
  lastAccessed: Date;
  size: number;
}

export interface LogEntry {
  id: string;
  level: 'debug' | 'info' | 'warn' | 'error';
  message: string;
  timestamp: Date;
  source: string;
  userId?: string;
  sessionId?: string;
  metadata: Record<string, any>;
}

export interface SystemEvent {
  id: string;
  type: string;
  timestamp: Date;
  source: string;
  userId?: string;
  data: Record<string, any>;
  metadata: {
    version: string;
    environment: string;
  };
}

export interface RAGDocument {
  id: string;
  content: string;
  metadata: {
    title: string;
    source: string;
    domain: string;
    language: string;
    tags: string[];
    version: string;
  };
  embeddings: number[];
  chunks: DocumentChunk[];
  lastUpdated: Date;
}

export interface DocumentChunk {
  id: string;
  content: string;
  startIndex: number;
  endIndex: number;
  embeddings: number[];
  score?: number;
}

export interface QueryContext {
  query: string;
  userId?: string;
  sessionId?: string;
  domain?: string;
  metadata?: Record<string, any>;
}

export interface RAGResponse {
  answer: string;
  sources: DocumentChunk[];
  confidence: number;
  reasoning: string;
  metadata: {
    processingTime: number;
    tokensUsed: number;
    model: string;
  };
}

export interface HRCValidation {
  isValid: boolean;
  confidence: number;
  warnings: string[];
  corrections: string[];
  metadata: {
    checks: string[];
    processingTime: number;
    model: string;
  };
}

export interface ArcanosModule {
  name: string;
  version: string;
  status: 'active' | 'inactive' | 'error';
  dependencies: string[];
  initialize(): Promise<void>;
  shutdown(): Promise<void>;
}

export interface ModuleResponse<T = any> {
  success: boolean;
  data?: T;
  error?: string;
  metadata: {
    module: string;
    timestamp: Date;
    processingTime: number;
  };
}