import { existsSync, readFileSync, writeFileSync } from 'fs';
import { resolveErrorMessage } from "@core/lib/errors/index.js";
import { MEMORY_INDEX_FILE } from './paths.js';
import { memoryState } from './state.js';
import { sanitizeMemoryIndex } from './sanitizers.js';

/**
 * Initialize memory system
 */
export function initializeMemory() {
  if (memoryState.loaded) return;

  try {
    if (existsSync(MEMORY_INDEX_FILE)) {
      const data = readFileSync(MEMORY_INDEX_FILE, 'utf-8');
      memoryState.index = sanitizeMemoryIndex(JSON.parse(data));
      console.log(`🧠 [MEMORY] Loaded ${memoryState.index.length} memory entries`);
    } else {
      memoryState.index = [];
      saveMemoryIndex();
      console.log('🧠 [MEMORY] Initialized new memory system');
    }

    memoryState.loaded = true;
  } catch (error: unknown) {
    //audit Assumption: init failures should fall back to empty state
    console.error('❌ Failed to initialize memory:', resolveErrorMessage(error));
    memoryState.index = [];
    memoryState.loaded = true;
  }
}

/**
 * Save memory index to disk
 */
export function saveMemoryIndex() {
  try {
    writeFileSync(MEMORY_INDEX_FILE, JSON.stringify(memoryState.index, null, 2));
  } catch (error: unknown) {
    console.error('❌ Failed to save memory index:', resolveErrorMessage(error));
  }
}
