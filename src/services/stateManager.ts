/**
 * System State Management Service
 * Handles persistence and synchronization of system state
 */

import fs from 'fs';
import path from 'path';
import { readJsonFileSafely } from '../utils/jsonFileUtils.js';

const STATE_FILE = path.join(process.cwd(), 'systemState.json');

export interface SystemState {
  status: string;
  version: string;
  lastSync: string | null;
  [key: string]: unknown; // Allow additional properties
}

/**
 * Load system state from file.
 * Purpose: Returns persisted system state or defaults when unavailable.
 * Inputs/Outputs: No inputs; returns SystemState object.
 * Edge cases: Missing/invalid file returns default state.
 */
export function loadState(): SystemState {
  //audit Assumption: state file presence indicates persisted state; risk: invalid JSON; invariant: fallback to default; handling: safe read.
  const parsedState = readJsonFileSafely<SystemState>(STATE_FILE);
  //audit Assumption: parsed state indicates valid structure; risk: partial data; invariant: return SystemState; handling: return or fallback.
  if (parsedState) {
    return parsedState;
  }
  
  // Return default state
  return { 
    status: 'unknown', 
    version: '0.0.0', 
    lastSync: null 
  };
}

/**
 * Update system state with new data.
 * Purpose: Merges new data into state and persists to disk.
 * Inputs/Outputs: Partial SystemState input; returns updated SystemState.
 * Edge cases: Write failures throw to caller.
 */
export function updateState(newData: Partial<SystemState>): SystemState {
  try {
    const currentState = loadState();
    const updatedState: SystemState = { 
      ...currentState, 
      ...newData, 
      lastSync: new Date().toISOString() 
    };
    
    //audit Assumption: JSON serialization is safe; risk: circular data; invariant: file writes succeed or throw; handling: try/catch.
    fs.writeFileSync(STATE_FILE, JSON.stringify(updatedState, null, 2));
    return updatedState;
  } catch (error: unknown) {
    //audit Assumption: write failure should surface to caller; risk: partial state; invariant: error thrown; handling: log and rethrow.
    console.error('[STATE] Error updating state file:', error instanceof Error ? error.message : error);
    throw error;
  }
}

/**
 * Get current system state (for GPT sync).
 * Purpose: Pull live backend state with file fallback.
 * Inputs/Outputs: Optional port override; returns SystemState.
 * Edge cases: Network errors fall back to file state.
 */
import config from '../config/index.js';
import { webFetcher } from '../utils/webFetcher.js';
import { getEnv } from '../config/env.js';

function buildStatusUrl(portOverride?: number): string {
  const statusEndpoint = config.server.statusEndpoint || '/status';

  //audit Assumption: absolute URL should be trusted; risk: misconfig; invariant: return valid URL string; handling: short-circuit.
  if (statusEndpoint.startsWith('http')) {
    return statusEndpoint;
  }

  // Use config layer for env access (adapter boundary pattern)
  const serverUrl = getEnv('SERVER_URL');
  //audit Assumption: port override only used when serverUrl unset; risk: wrong base; invariant: valid URL; handling: conditional check.
  if (portOverride && portOverride !== config.server.port && !serverUrl) {
    return new URL(statusEndpoint, `http://127.0.0.1:${portOverride}`).toString();
  }

  const baseUrl = config.server.baseUrl || `http://127.0.0.1:${config.server.port}`;
  return new URL(statusEndpoint, baseUrl).toString();
}

export async function getBackendState(port: number = config.server.port): Promise<SystemState> {
  try {
    const statusUrl = buildStatusUrl(port);
    return await webFetcher<SystemState>(statusUrl);
  } catch (error: unknown) {
    //audit Assumption: fetch failure should fall back to file state; risk: stale data; invariant: return cached state; handling: log and fallback.
    console.error('[STATE] Error fetching backend state:', error instanceof Error ? error.message : error);
    // Fallback to file-based state
    return loadState();
  }
}
