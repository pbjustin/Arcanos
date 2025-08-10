#!/usr/bin/env node
/**
 * ARCANOS Memory Worker
 * 
 * Handles persistent memory storage using database when available
 */

import dotenv from 'dotenv';
import { initializeDatabase, saveMemory, loadMemory, deleteMemory, getStatus, logExecution } from '../dist/db.js';

// Load environment variables
dotenv.config();

export const id = 'worker-memory';

// Verify database connectivity before processing jobs
await initializeDatabase(id);
await logExecution(id, 'info', 'db_connection_verified');

// Fallback memory store when database unavailable
const memoryStore = new Map();

/**
 * Store memory with database or fallback
 */
export async function store(key, value) {
  try {
    await saveMemory(key, value);
    await logExecution(id, 'info', `Memory stored: ${key}`);
    return true;
  } catch (error) {
    // Fallback to in-memory storage
    memoryStore.set(key, { value, timestamp: Date.now() });
    console.log(`[💾 WORKER-MEMORY] Fallback storage: ${key}`);
    return true;
  }
}

/**
 * Retrieve memory with database or fallback
 */
export async function retrieve(key) {
  try {
    const value = await loadMemory(key);
    if (value !== null) {
      await logExecution(id, 'info', `Memory retrieved: ${key}`);
      return value;
    }
    return null;
  } catch (error) {
    // Fallback to in-memory storage
    const stored = memoryStore.get(key);
    if (stored) {
      console.log(`[💾 WORKER-MEMORY] Fallback retrieval: ${key}`);
      return stored.value;
    }
    return null;
  }
}

/**
 * Remove memory with database or fallback
 */
export async function remove(key) {
  try {
    const deleted = await deleteMemory(key);
    if (deleted) {
      await logExecution(id, 'info', `Memory deleted: ${key}`);
    }
    return deleted;
  } catch (error) {
    // Fallback to in-memory storage
    const existed = memoryStore.has(key);
    memoryStore.delete(key);
    console.log(`[💾 WORKER-MEMORY] Fallback deletion: ${key}`);
    return existed;
  }
}

/**
 * List all keys (fallback only)
 */
export function listKeys() {
  const dbStatus = getStatus();
  
  if (!dbStatus.connected) {
    return Array.from(memoryStore.keys());
  }
  
  throw new Error('Database key listing not implemented - use database queries directly');
}

/**
 * Worker run function
 */
export async function run() {
  const dbStatus = getStatus();
  
  if (dbStatus.connected) {
    console.log('[💾 WORKER-MEMORY] ✅ Initialized with database storage');
  } else {
    console.log('[💾 WORKER-MEMORY] ⚠️  Initialized with memory fallback storage');
  }
  
  // Log initial startup
  try {
    await logExecution(id, 'info', 'Memory worker initialized', { 
      database: dbStatus.connected,
      fallbackMode: !dbStatus.connected 
    });
  } catch (error) {
    console.log('[💾 WORKER-MEMORY] Startup logging failed, using fallback');
  }
}

console.log(`[💾 WORKER-MEMORY] Module loaded: ${id}`);