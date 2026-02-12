import { mkdirSync } from 'fs';
import { join } from 'path';
import { getEnv } from "@platform/runtime/env.js";
import { APPLICATION_CONSTANTS } from "@shared/constants.js";

// Memory storage paths
// Use config layer for env access (adapter boundary pattern)
const MEMORY_DIR = getEnv('ARC_MEMORY_PATH') || APPLICATION_CONSTANTS.DEFAULT_MEMORY_PATH;
// Ensure memory directory exists at runtime
mkdirSync(MEMORY_DIR, { recursive: true });

export const MEMORY_INDEX_FILE = join(MEMORY_DIR, 'index.json');
export const MEMORY_LOG_FILE = join(MEMORY_DIR, 'memory.log');
export const SUPPRESSION_LOG_FILE = join(MEMORY_DIR, 'suppressed.log');
