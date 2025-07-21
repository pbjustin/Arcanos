import { Pool, PoolClient } from 'pg';
import * as fs from 'fs';
import * as path from 'path';

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
      connectionTimeoutMillis: 2000,
    });

    // Test connection on startup
    this.testConnection();
  }

  private async testConnection(): Promise<void> {
    try {
      const client = await this.pool.connect();
      await client.query('SELECT NOW()');
      client.release();
      console.log('✅ Database connection established');
    } catch (error) {
      console.error('❌ Database connection failed:', error);
      throw new Error('Failed to connect to database');
    }
  }

  async initialize(): Promise<void> {
    if (this.isInitialized || !this.pool) {
      return;
    }

    try {
      const schemaPath = path.join(__dirname, '../../sql/memory_state.sql');
      const schema = fs.readFileSync(schemaPath, 'utf-8');
      
      const client = await this.pool.connect();
      await client.query(schema);
      client.release();
      
      this.isInitialized = true;
      console.log('✅ Database schema initialized');
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
    } catch (error) {
      console.error('❌ Failed to save memory:', error);
      throw new Error('Failed to save memory');
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
    } catch (error) {
      console.error('❌ Failed to load memory:', error);
      throw new Error('Failed to load memory');
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
    } catch (error) {
      console.error('❌ Failed to load all memory:', error);
      throw new Error('Failed to load all memory');
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
    } catch (error) {
      console.error('❌ Failed to clear memory:', error);
      throw new Error('Failed to clear memory');
    }
  }

  async healthCheck(): Promise<{ status: string; database: boolean; timestamp: string }> {
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
      
      return {
        status: 'healthy',
        database: true,
        timestamp
      };
    } catch (error) {
      console.error('❌ Database health check failed:', error);
      return {
        status: 'unhealthy',
        database: false,
        timestamp
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