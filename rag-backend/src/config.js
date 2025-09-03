import dotenv from "dotenv";

dotenv.config();

export const CHUNK_SIZE = parseInt(process.env.CHUNK_SIZE || "800", 10);
export const TOP_K = parseInt(process.env.TOP_K || "5", 10);
export const EMBEDDING_MODEL = process.env.OPENAI_EMBEDDING_MODEL || "text-embedding-3-small";
export const CHAT_MODEL = process.env.OPENAI_MODEL;
export const SYSTEM_PROMPT =
  process.env.SYSTEM_PROMPT || "You are ARCANOS, answering with retrieved context.";
export const DEFAULT_PORT = 3000;
export const PORT = parseInt(process.env.PORT || DEFAULT_PORT.toString(), 10);
