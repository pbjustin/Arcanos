import dotenv from "dotenv";
dotenv.config();

export const config = {
  PORT: Number(process.env.PORT ?? 3000),
  MAX_FILE_SIZE: Number(process.env.MAX_FILE_SIZE ?? 50_000_000),
  UPLOAD_ROOT: process.env.UPLOAD_ROOT ?? "temp",
  RATE_LIMIT_WINDOW_MS: Number(process.env.RATE_LIMIT_WINDOW_MS ?? 60_000),
  RATE_LIMIT_MAX: Number(process.env.RATE_LIMIT_MAX ?? 30),
  ENABLE_CLAMAV: process.env.ENABLE_CLAMAV === "true"
};
