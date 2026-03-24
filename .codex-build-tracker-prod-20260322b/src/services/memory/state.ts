import type { MemoryEntry } from './types.js';

export const memoryState: {
  index: MemoryEntry[];
  loaded: boolean;
} = {
  index: [],
  loaded: false
};
