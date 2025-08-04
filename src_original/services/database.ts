import { Pool, PoolClient } from 'pg';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export interface MemoryStateEntry {
  id: string;
  memory_key: string;
  memory_value: any;
  container_id: string;
  created_at: Date;
  updated_at: Date;
}

export interface SaveMemoryRequest {
  memory_key: string;
  memory_value: any;
  container_id?: string;
}

export interface LoadMemoryRequest {
  memory_key: string;
  container_id?: string;
}

export class DatabaseService {
  private pool: Pool;
  private isInitialized = false;
  private connectionRetryCount = 0;
  private maxRetries = 5;
  private retryDelay = 2000; // Start with 2 seconds
  private isConnected = false;

  constructor() {
    const databaseUrl = process.env.DATABASE_URL;
    
    if (!databaseUrl) {
      console.warn('⚠️ DATABASE_URL not configured, memory service will use fallback in-memory storage');
      this.pool = null as any;
      return;
    }

    this.pool = new Pool({
      connectionString: databaseUrl,
      ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
      max: 10,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 5000, // Increased for recovery scenarios
    });

    // Test connection on startup with retry logic
    this.connectWithRetry();
  }

  private async connectWithRetry(): Promise<void> {
    while (this.connectionRetryCount < this.maxRetries && !this.isConnected) {
      try {
        await this.testConnection();
        this.isConnected = true;
        this.connectionRetryCount = 0; // Reset on successful connection
        console.log('✅ Database connection established successfully');
        return;
      } catch (error: any) {
        this.connectionRetryCount++;
        const delay = this.retryDelay * Math.pow(2, this.connectionRetryCount - 1); // Exponential backoff
        
        console.log(`⚠️ Database connection attempt ${this.connectionRetryCount}/${this.maxRetries} failed: ${error.message}`);
        
        if (this.connectionRetryCount >= this.maxRetries) {
          console.error('❌ Max database connection retries exceeded. Running in degraded mode.');
          break;
        }
        
        console.log(`🔄 Retrying database connection in ${delay}ms...`);
        await this.sleep(delay);
      }
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  private async testConnection(): Promise<void> {
    if (!this.pool) {
      throw new Error('Database pool not initialized');
    }

    try {
      const client = await this.pool.connect();
      await client.query('SELECT NOW()');
      client.release();
      this.isConnected = true;
    } catch (error: any) {
      this.isConnected = false;
      // Check if this is a recovery-related error
      if (error.message.includes('recovery') || 
          error.message.includes('starting up') || 
          error.message.includes('not ready')) {
        console.log('🔄 Database is in recovery mode, waiting...');
      }
      throw new Error(`Database connection failed: ${error.message}`);
    }
  }

  private loadInitSQL(): string | null {
    try {
      const schemaPath = path.resolve(__dirname, '..', '..', 'sql', 'memory_state.sql');
      const schema = fs.readFileSync(schemaPath, 'utf8');
      console.log('✅ Loaded memory_state.sql');
      return schema;
    } catch (err) {
      console.warn('⚠️ Skipping SQL init: memory_state.sql not found.');
      return null;
    }
  }

  async initialize(): Promise<void> {
    if (this.isInitialized || !this.pool) {
      return;
    }

    try {
      const schema = this.loadInitSQL();

      if (schema) {
        const client = await this.pool.connect();
        await client.query(schema);
        client.release();

        console.log('✅ Database schema initialized');
      } else {
        console.warn('⚠️ Skipping database schema initialization.');
      }

      this.isInitialized = true;
    } catch (error) {
      console.error('❌ Failed to initialize database schema:', error);
      throw new Error('Database initialization failed');
    }
  }

  async saveMemory(request: SaveMemoryRequest): Promise<MemoryStateEntry> {
    if (!this.pool) {
      throw new Error('Database not configured');
    }

    const { memory_key, memory_value, container_id = 'default' } = request;
    
    const query = `
      INSERT INTO memory_state (memory_key, memory_value, container_id)
      VALUES ($1, $2, $3)
      ON CONFLICT (memory_key, container_id) 
      DO UPDATE SET 
        memory_value = EXCLUDED.memory_value,
        updated_at = CURRENT_TIMESTAMP
      RETURNING *
    `;
    
    try {
      const client = await this.pool.connect();
      const result = await client.query(query, [memory_key, JSON.stringify(memory_value), container_id]);
      client.release();
      
      const row = result.rows[0];
      return {
        id: row.id,
        memory_key: row.memory_key,
        memory_value: row.memory_value,
        container_id: row.container_id,
        created_at: row.created_at,
        updated_at: row.updated_at
      };
    } catch (error: any) {
      console.error('❌ Failed to save memory:', error.message);
      
      // Check if this is a connection issue during recovery
      if (this.isRecoveryError(error)) {
        console.log('🔄 Database appears to be in recovery, attempting reconnection...');
        await this.attemptReconnection();
        throw new Error('Database temporarily unavailable during recovery');
      }
      
      throw new Error(`Failed to save memory: ${error.message}`);
    }
  }

  async loadMemory(request: LoadMemoryRequest): Promise<MemoryStateEntry | null> {
    if (!this.pool) {
      throw new Error('Database not configured');
    }

    const { memory_key, container_id = 'default' } = request;
    
    const query = `
      SELECT * FROM memory_state 
      WHERE memory_key = $1 AND container_id = $2
      ORDER BY updated_at DESC
      LIMIT 1
    `;
    
    try {
      const client = await this.pool.connect();
      const result = await client.query(query, [memory_key, container_id]);
      client.release();
      
      if (result.rows.length === 0) {
        return null;
      }
      
      const row = result.rows[0];
      return {
        id: row.id,
        memory_key: row.memory_key,
        memory_value: row.memory_value,
        container_id: row.container_id,
        created_at: row.created_at,
        updated_at: row.updated_at
      };
    } catch (error: any) {
      console.error('❌ Failed to load memory:', error.message);
      
      if (this.isRecoveryError(error)) {
        console.log('🔄 Database appears to be in recovery, attempting reconnection...');
        await this.attemptReconnection();
        throw new Error('Database temporarily unavailable during recovery');
      }
      
      throw new Error(`Failed to load memory: ${error.message}`);
    }
  }

  async loadAllMemory(container_id = 'default'): Promise<MemoryStateEntry[]> {
    if (!this.pool) {
      throw new Error('Database not configured');
    }

    const query = `
      SELECT * FROM memory_state 
      WHERE container_id = $1
      ORDER BY updated_at DESC
    `;
    
    try {
      const client = await this.pool.connect();
      const result = await client.query(query, [container_id]);
      client.release();
      
      return result.rows.map((row: any) => ({
        id: row.id,
        memory_key: row.memory_key,
        memory_value: row.memory_value,
        container_id: row.container_id,
        created_at: row.created_at,
        updated_at: row.updated_at
      }));
    } catch (error: any) {
      console.error('❌ Failed to load all memory:', error.message);
      
      if (this.isRecoveryError(error)) {
        console.log('🔄 Database appears to be in recovery, attempting reconnection...');
        await this.attemptReconnection();
        throw new Error('Database temporarily unavailable during recovery');
      }
      
      throw new Error(`Failed to load all memory: ${error.message}`);
    }
  }

  async clearMemory(container_id = 'default'): Promise<{ cleared: number }> {
    if (!this.pool) {
      throw new Error('Database not configured');
    }

    const query = `DELETE FROM memory_state WHERE container_id = $1`;
    
    try {
      const client = await this.pool.connect();
      const result = await client.query(query, [container_id]);
      client.release();
      
      return { cleared: result.rowCount || 0 };
    } catch (error: any) {
      console.error('❌ Failed to clear memory:', error.message);
      
      if (this.isRecoveryError(error)) {
        console.log('🔄 Database appears to be in recovery, attempting reconnection...');
        await this.attemptReconnection();
        throw new Error('Database temporarily unavailable during recovery');
      }
      
      throw new Error(`Failed to clear memory: ${error.message}`);
    }
  }

  private isRecoveryError(error: any): boolean {
    const errorMessage = error.message.toLowerCase();
    return errorMessage.includes('recovery') ||
           errorMessage.includes('starting up') ||
           errorMessage.includes('not ready') ||
           errorMessage.includes('connection terminated') ||
           errorMessage.includes('server closed the connection') ||
           error.code === 'ECONNRESET' ||
           error.code === 'ECONNREFUSED';
  }

  private async attemptReconnection(): Promise<void> {
    console.log('🔄 Attempting database reconnection...');
    this.isConnected = false;
    this.connectionRetryCount = 0;
    
    // Don't wait for full retry cycle, just attempt a quick reconnection
    try {
      await this.testConnection();
      console.log('✅ Database reconnection successful');
    } catch (error) {
      console.log('⚠️ Quick reconnection failed, will retry on next operation');
    }
  }

  async healthCheck(): Promise<{ status: string; database: boolean; timestamp: string; recovery?: boolean }> {
    const timestamp = new Date().toISOString();
    
    if (!this.pool) {
      return {
        status: 'degraded',
        database: false,
        timestamp
      };
    }

    try {
      const client = await this.pool.connect();
      await client.query('SELECT 1');
      client.release();
      
      this.isConnected = true;
      return {
        status: 'healthy',
        database: true,
        timestamp
      };
    } catch (error: any) {
      console.error('❌ Database health check failed:', error.message);
      
      const isRecovering = this.isRecoveryError(error);
      this.isConnected = false;
      
      return {
        status: isRecovering ? 'recovering' : 'unhealthy',
        database: false,
        timestamp,
        recovery: isRecovering
      };
    }
  }

  async close(): Promise<void> {
    if (this.pool) {
      await this.pool.end();
    }
  }
}

// Singleton instance
export const databaseService = new DatabaseService();