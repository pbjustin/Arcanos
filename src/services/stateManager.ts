/**
 * System State Management Service
 * Handles persistence and synchronization of system state
 */

import fs from 'fs';
import path from 'path';

const STATE_FILE = path.join(process.cwd(), 'systemState.json');

export interface SystemState {
  status: string;
  version: string;
  lastSync: string | null;
  [key: string]: any; // Allow additional properties
}

/**
 * Load system state from file
 */
export function loadState(): SystemState {
  try {
    if (fs.existsSync(STATE_FILE)) {
      const data = fs.readFileSync(STATE_FILE, 'utf8');
      return JSON.parse(data);
    }
  } catch (error) {
    console.error('[STATE] Error loading state file:', error);
  }
  
  // Return default state
  return { 
    status: 'unknown', 
    version: '0.0.0', 
    lastSync: null 
  };
}

/**
 * Update system state with new data
 */
export function updateState(newData: Partial<SystemState>): SystemState {
  try {
    const currentState = loadState();
    const updatedState: SystemState = { 
      ...currentState, 
      ...newData, 
      lastSync: new Date().toISOString() 
    };
    
    fs.writeFileSync(STATE_FILE, JSON.stringify(updatedState, null, 2));
    return updatedState;
  } catch (error) {
    console.error('[STATE] Error updating state file:', error);
    throw error;
  }
}

/**
 * Get current system state (for GPT sync)
 */
import config from '../config/index.js';

export async function getBackendState(port: number = config.server.port): Promise<SystemState> {
  try {
    const response = await fetch(`http://localhost:${port}/status`);
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }
    return await response.json();
  } catch (error) {
    console.error('[STATE] Error fetching backend state:', error);
    // Fallback to file-based state
    return loadState();
  }
}