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
import { webFetcher } from '../utils/webFetcher.js';

function buildStatusUrl(portOverride?: number): string {
  const statusEndpoint = config.server.statusEndpoint || '/status';

  if (statusEndpoint.startsWith('http')) {
    return statusEndpoint;
  }

  if (portOverride && portOverride !== config.server.port && !process.env.SERVER_URL) {
    return new URL(statusEndpoint, `http://127.0.0.1:${portOverride}`).toString();
  }

  const baseUrl = config.server.baseUrl || `http://127.0.0.1:${config.server.port}`;
  return new URL(statusEndpoint, baseUrl).toString();
}

export async function getBackendState(port: number = config.server.port): Promise<SystemState> {
  try {
    const statusUrl = buildStatusUrl(port);
    return await webFetcher<SystemState>(statusUrl);
  } catch (error) {
    console.error('[STATE] Error fetching backend state:', error);
    // Fallback to file-based state
    return loadState();
  }
}
