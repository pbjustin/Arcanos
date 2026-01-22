const store: Record<string, unknown> = {};

/**
 * In-memory key/value store.
 *
 * Purpose:
 *   Provide simple get/set operations for request handlers.
 * Inputs/Outputs:
 *   get returns stored value; set stores value.
 * Edge cases:
 *   Missing keys return undefined.
 */
const memory = {
  get: (key: string) => {
    // //audit Assumption: key is string. Risk: runtime mismatch. Invariant: lookup by key. Handling: return undefined if missing.
    return store[key];
  },
  set: (key: string, value: unknown) => {
    // //audit Assumption: key/value acceptable. Risk: overwriting existing value. Invariant: store updated. Handling: assign value.
    store[key] = value;
  },
};

export default memory;
