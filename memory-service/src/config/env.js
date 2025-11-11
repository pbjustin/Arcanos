import dotenv from "dotenv";

dotenv.config();

export const config = {
  port: process.env.PORT || 8080,
  env: process.env.NODE_ENV || "development",
  authToken: process.env.AUTH_TOKEN,
  openaiKey: process.env.OPENAI_API_KEY,
  audit: {
    level: process.env.AUDIT_LOG_LEVEL || "info"
  },
  storageProvider: process.env.STORAGE_PROVIDER || "in-memory"
};
