import dotenv from "dotenv";
dotenv.config();

function safeInt(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  return Number.isNaN(parsed) ? fallback : parsed;
}

export const config = {
  PORT: safeInt(process.env.PORT, 3000),
  MAX_FILE_SIZE: safeInt(process.env.MAX_FILE_SIZE, 50_000_000),
  UPLOAD_ROOT: process.env.UPLOAD_ROOT ?? "temp",
  RATE_LIMIT_WINDOW_MS: safeInt(process.env.RATE_LIMIT_WINDOW_MS, 60_000),
  RATE_LIMIT_MAX: safeInt(process.env.RATE_LIMIT_MAX, 30),
  ENABLE_CLAMAV: process.env.ENABLE_CLAMAV === "true",
  MAX_ZIP_ENTRIES: safeInt(process.env.MAX_ZIP_ENTRIES, 1000),
  MAX_UNCOMPRESSED_SIZE: safeInt(process.env.MAX_UNCOMPRESSED_SIZE, 200_000_000),
};
