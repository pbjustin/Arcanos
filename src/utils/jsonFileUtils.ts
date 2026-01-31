import fs from 'fs';

export interface JsonReadDependencies {
  fsModule: typeof fs;
  logError: (message: string, error: unknown) => void;
}

const defaultDependencies: JsonReadDependencies = {
  fsModule: fs,
  logError: (message: string, error: unknown) => {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error(message, errorMessage);
  }
};

/**
 * Read and parse a JSON file safely.
 * Purpose: Returns parsed JSON content or undefined when missing/invalid.
 * Inputs/Outputs: filePath string + optional dependencies; returns record or undefined.
 * Edge cases: Missing file or parse errors log and return undefined.
 */
export function readJsonFileSafely<T>(
  filePath: string,
  dependencies: JsonReadDependencies = defaultDependencies
): T | undefined {
  const { fsModule, logError } = dependencies;

  try {
    //audit Assumption: missing file should return undefined; risk: false negatives; invariant: no throw on missing; handling: exists check.
    if (!fsModule.existsSync(filePath)) {
      return undefined;
    }

    const raw = fsModule.readFileSync(filePath, 'utf8');
    //audit Assumption: non-empty content should parse; risk: invalid JSON; invariant: return undefined on parse failure; handling: try/catch.
    return raw ? (JSON.parse(raw) as Record<string, unknown>) : undefined;
  } catch (error: unknown) {
    //audit Assumption: read/parse errors should not crash caller; risk: masking issues; invariant: caller can continue; handling: log and return undefined.
    logError(`[JSON-UTIL] Failed to read JSON file ${filePath}`, error);
    return undefined;
  }
}
