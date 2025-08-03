/**
 * Memory Worker - Handles memory-related operations and data persistence
 * Integrated with AI dispatcher for intelligent memory management
 */

import { createServiceLogger } from '../utils/logger.js';
import { normalizeMemoryUsage } from '../utils/memory-normalizer.js';
import fs from 'fs';
import path from 'path';

const logger = createServiceLogger('MemoryWorker');

export interface MemoryTask {
  action: 'store' | 'retrieve' | 'delete' | 'sync' | 'snapshot';
  key?: string;
  data?: any;
  options?: {
    persistent?: boolean;
    ttl?: number;
    compress?: boolean;
  };
}

export interface MemoryResponse {
  success: boolean;
  data?: any;
  error?: string;
  metadata?: {
    timestamp: string;
    memoryUsage?: any;
    operationTime?: number;
  };
}

/**
 * Main memory worker handler function
 */
export async function handle(task: MemoryTask): Promise<MemoryResponse> {
  const startTime = Date.now();
  logger.info('Processing memory task', { action: task.action, key: task.key });

  try {
    let result: any;

    switch (task.action) {
      case 'store':
        result = await storeMemoryData(task.key!, task.data, task.options);
        break;
      
      case 'retrieve':
        result = await retrieveMemoryData(task.key!, task.options);
        break;
      
      case 'delete':
        result = await deleteMemoryData(task.key!);
        break;
      
      case 'sync':
        result = await syncMemory();
        break;
      
      case 'snapshot':
        result = await createMemorySnapshot();
        break;
      
      default:
        throw new Error(`Unknown memory action: ${task.action}`);
    }

    const operationTime = Date.now() - startTime;
    logger.success(`Memory task completed in ${operationTime}ms`, { action: task.action });

    return {
      success: true,
      data: result,
      metadata: {
        timestamp: new Date().toISOString(),
        memoryUsage: process.memoryUsage(),
        operationTime
      }
    };

  } catch (error: any) {
    const operationTime = Date.now() - startTime;
    logger.error('Memory task failed', { action: task.action, error: error.message, operationTime });

    return {
      success: false,
      error: error.message,
      metadata: {
        timestamp: new Date().toISOString(),
        operationTime
      }
    };
  }
}

/**
 * Store data in memory system
 */
async function storeMemoryData(key: string, data: any, options: any = {}): Promise<any> {
  const storageDir = path.join(process.cwd(), 'storage', 'memory');
  if (!fs.existsSync(storageDir)) {
    fs.mkdirSync(storageDir, { recursive: true });
  }

  const filePath = path.join(storageDir, `${key}.json`);
  const payload = {
    key,
    data,
    timestamp: new Date().toISOString(),
    options,
    ttl: options.ttl ? Date.now() + options.ttl : null
  };

  fs.writeFileSync(filePath, JSON.stringify(payload, null, 2));
  logger.info('Memory data stored', { key, size: JSON.stringify(data).length });

  return { stored: true, key, timestamp: payload.timestamp };
}

/**
 * Retrieve data from memory system
 */
async function retrieveMemoryData(key: string, options: any = {}): Promise<any> {
  const storageDir = path.join(process.cwd(), 'storage', 'memory');
  const filePath = path.join(storageDir, `${key}.json`);

  if (!fs.existsSync(filePath)) {
    throw new Error(`Memory key not found: ${key}`);
  }

  const payload = JSON.parse(fs.readFileSync(filePath, 'utf8'));

  // Check TTL expiration
  if (payload.ttl && Date.now() > payload.ttl) {
    fs.unlinkSync(filePath);
    throw new Error(`Memory key expired: ${key}`);
  }

  logger.info('Memory data retrieved', { key, age: Date.now() - new Date(payload.timestamp).getTime() });
  return payload.data;
}

/**
 * Delete data from memory system
 */
async function deleteMemoryData(key: string): Promise<any> {
  const storageDir = path.join(process.cwd(), 'storage', 'memory');
  const filePath = path.join(storageDir, `${key}.json`);

  if (fs.existsSync(filePath)) {
    fs.unlinkSync(filePath);
    logger.info('Memory data deleted', { key });
    return { deleted: true, key };
  } else {
    throw new Error(`Memory key not found: ${key}`);
  }
}

/**
 * Sync memory across systems (placeholder for distributed sync)
 */
async function syncMemory(): Promise<any> {
  logger.info('Performing memory sync operation');
  
  // This would integrate with distributed memory systems in production
  const memoryUsage = process.memoryUsage();
  const timestamp = new Date().toISOString();
  
  return {
    synced: true,
    timestamp,
    memoryUsage: {
      heapUsedMB: Math.round(memoryUsage.heapUsed / 1024 / 1024),
      heapTotalMB: Math.round(memoryUsage.heapTotal / 1024 / 1024),
      rssMB: Math.round(memoryUsage.rss / 1024 / 1024)
    }
  };
}

/**
 * Create memory snapshot for backup/analysis
 */
async function createMemorySnapshot(): Promise<any> {
  const storageDir = path.join(process.cwd(), 'storage', 'memory-snapshots');
  if (!fs.existsSync(storageDir)) {
    fs.mkdirSync(storageDir, { recursive: true });
  }

  const memoryUsage = process.memoryUsage();
  const normalized = normalizeMemoryUsage(memoryUsage);
  const timestamp = new Date().toISOString();
  const id = `mem_${Date.now()}`;

  const snapshot = {
    id,
    type: 'system',
    timestamp,
    nodeVersion: process.version,
    normalized: {
      memory: normalized
    }
  };

  const snapshotFile = path.join(storageDir, `memory-snapshot-${Date.now()}.json`);
  fs.writeFileSync(snapshotFile, JSON.stringify(snapshot, null, 2));

  logger.info('Memory snapshot created', { file: snapshotFile });
  return { snapshot: true, file: snapshotFile, timestamp };
}