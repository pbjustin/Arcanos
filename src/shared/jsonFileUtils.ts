import fs from 'fs';
import { resolveErrorMessage } from "@shared/errorUtils.js";

/** Maximum file size (10MB) to prevent DoS via memory exhaustion */
const MAX_FILE_SIZE_BYTES = 10 * 1024 * 1024;

export interface JsonReadDependencies {
  fsModule: typeof fs;
  logError: (message: string, error: unknown) => void;
  maxFileSizeBytes?: number;
}

export interface ProtectedJsonReadOptions {
  protectedConfigId?: ProtectedConfigId;
}

const defaultDependencies: JsonReadDependencies = {
  fsModule: fs,
  logError: (message: string, error: unknown) => {
    const errorMessage = resolveErrorMessage(error);
    console.error(message, errorMessage);
  },
  maxFileSizeBytes: MAX_FILE_SIZE_BYTES
};

/**
 * Read and parse a JSON file safely.
 * Purpose: Returns parsed JSON content or undefined when missing/invalid/too large.
 * Inputs/Outputs: filePath string + optional dependencies; returns T or undefined.
 * Edge cases: Missing file, parse errors, or files exceeding size limit log and return undefined.
 */
export function readJsonFileSafely<T>(
  filePath: string,
  dependencies: JsonReadDependencies = defaultDependencies,
  options: ProtectedJsonReadOptions = {}
): T | undefined {
  const { fsModule, logError, maxFileSizeBytes = MAX_FILE_SIZE_BYTES } = dependencies;

  try {
    //audit Assumption: missing file should return undefined; risk: false negatives; invariant: no throw on missing; handling: exists check.
    if (!fsModule.existsSync(filePath)) {
      return undefined;
    }

    //audit Assumption: large files should be rejected to prevent OOM; risk: false rejection; invariant: bounded memory; handling: size check.
    const stats = fsModule.statSync(filePath);
    if (stats.size > maxFileSizeBytes) {
      logError(`[JSON-UTIL] File exceeds size limit (${stats.size} > ${maxFileSizeBytes} bytes)`, filePath);
      return undefined;
    }

    const raw = fsModule.readFileSync(filePath, 'utf8');
    //audit Assumption: non-empty content should parse; risk: invalid JSON; invariant: return undefined on parse failure; handling: try/catch.
    const parsed = raw ? (JSON.parse(raw) as T) : undefined;
    //audit Assumption: protected config reads must pass integrity checks before returning parsed data; risk: silent semantic corruption; invariant: protected payload integrity validated; handling: fail closed by returning undefined after logged error.
    if (parsed !== undefined && options.protectedConfigId) {
      assertProtectedConfigIntegrity(options.protectedConfigId, parsed, {
        source: filePath
      });
    }
    return parsed;
  } catch (error: unknown) {
    //audit Assumption: read/parse errors should not crash caller; risk: masking issues; invariant: caller can continue; handling: log and return undefined.
    logError(`[JSON-UTIL] Failed to read JSON file ${filePath}`, error);
    return undefined;
  }
}
