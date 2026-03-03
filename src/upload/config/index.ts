import dotenv from "dotenv";
import { parseEnvBoolean, parseEnvInteger } from "@platform/runtime/envParsers.js";

dotenv.config();

/**
 * Purpose: Read upload-service runtime configuration from environment variables.
 * Inputs/Outputs: Uses process.env and returns a typed configuration object.
 * Edge cases: Invalid or missing values are normalized with explicit safe defaults.
 */
export const config = {
  PORT: parseEnvInteger(process.env.PORT, 3000, {
    minimum: 1
  }),
  SHUTDOWN_TIMEOUT_MS: parseEnvInteger(process.env.SHUTDOWN_TIMEOUT_MS, 10_000, {
    minimum: 1
  }),
  MAX_FILE_SIZE: parseEnvInteger(process.env.MAX_FILE_SIZE, 50_000_000, {
    minimum: 1
  }),
  UPLOAD_ROOT: process.env.UPLOAD_ROOT ?? "temp",
  RATE_LIMIT_WINDOW_MS: parseEnvInteger(process.env.RATE_LIMIT_WINDOW_MS, 60_000, {
    minimum: 1
  }),
  RATE_LIMIT_MAX: parseEnvInteger(process.env.RATE_LIMIT_MAX, 30, {
    minimum: 1
  }),
  ENABLE_CLAMAV: parseEnvBoolean(process.env.ENABLE_CLAMAV, false),
  CLAMAV_HOST: process.env.CLAMAV_HOST ?? "127.0.0.1",
  CLAMAV_PORT: parseEnvInteger(process.env.CLAMAV_PORT, 3310, {
    minimum: 1,
    maximum: 65535
  }),
  CLAMAV_TIMEOUT_MS: parseEnvInteger(process.env.CLAMAV_TIMEOUT_MS, 7_500, {
    minimum: 1
  }),
  CLAMAV_FAIL_OPEN: parseEnvBoolean(process.env.CLAMAV_FAIL_OPEN, false),
  MAX_ZIP_ENTRIES: parseEnvInteger(process.env.MAX_ZIP_ENTRIES, 1_000, {
    minimum: 1
  }),
  MAX_UNCOMPRESSED_SIZE: parseEnvInteger(process.env.MAX_UNCOMPRESSED_SIZE, 200_000_000, {
    minimum: 1
  }),
};
