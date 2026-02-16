import dotenv from "dotenv";
dotenv.config();

/**
 * Purpose: Parse integer configuration values from environment variables.
 * Inputs/Outputs: Accepts an env var string and fallback number; returns a validated integer.
 * Edge cases: Missing, non-numeric, and non-finite values fall back safely.
 */
function parseIntegerFromEnv(rawValue: string | undefined, fallbackValue: number): number {
  //audit Assumption: environment values can be malformed and must be sanitized.
  //audit Failure risk: invalid numeric parsing could disable safeguards.
  //audit Invariant: returned value is always finite and integer-like.
  //audit Handling: fallback value is returned for invalid env input.
  if (rawValue === undefined) {
    return fallbackValue;
  }

  const parsedValue = Number(rawValue);
  if (!Number.isFinite(parsedValue)) {
    return fallbackValue;
  }

  return Math.trunc(parsedValue);
}

/**
 * Purpose: Parse boolean configuration values from environment variables.
 * Inputs/Outputs: Accepts an env var string and fallback boolean; returns normalized boolean.
 * Edge cases: Any value other than "true" or "false" falls back predictably.
 */
function parseBooleanFromEnv(rawValue: string | undefined, fallbackValue: boolean): boolean {
  //audit Assumption: boolean env vars are expressed as lowercase strings.
  //audit Failure risk: permissive parsing can unintentionally enable security flags.
  //audit Invariant: only explicit true/false strings are honored.
  //audit Handling: default fallback protects behavior under ambiguous input.
  if (rawValue === undefined) {
    return fallbackValue;
  }

  if (rawValue === "true") {
    return true;
  }

  if (rawValue === "false") {
    return false;
  }

  return fallbackValue;
}

export const config = {
  PORT: parseIntegerFromEnv(process.env.PORT, 3000),
  MAX_FILE_SIZE: parseIntegerFromEnv(process.env.MAX_FILE_SIZE, 50_000_000),
  UPLOAD_ROOT: process.env.UPLOAD_ROOT ?? "temp",
  RATE_LIMIT_WINDOW_MS: parseIntegerFromEnv(process.env.RATE_LIMIT_WINDOW_MS, 60_000),
  RATE_LIMIT_MAX: parseIntegerFromEnv(process.env.RATE_LIMIT_MAX, 30),
  ENABLE_CLAMAV: parseBooleanFromEnv(process.env.ENABLE_CLAMAV, false),
  CLAMAV_HOST: process.env.CLAMAV_HOST ?? "127.0.0.1",
  CLAMAV_PORT: parseIntegerFromEnv(process.env.CLAMAV_PORT, 3310),
  CLAMAV_TIMEOUT_MS: parseIntegerFromEnv(process.env.CLAMAV_TIMEOUT_MS, 7_500),
  CLAMAV_FAIL_OPEN: parseBooleanFromEnv(process.env.CLAMAV_FAIL_OPEN, false),
  MAX_ZIP_ENTRIES: parseIntegerFromEnv(process.env.MAX_ZIP_ENTRIES, 1_000),
  MAX_UNCOMPRESSED_SIZE: parseIntegerFromEnv(process.env.MAX_UNCOMPRESSED_SIZE, 200_000_000),
};
