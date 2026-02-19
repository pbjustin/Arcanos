function requireEnv(key: string): string {
  const value = process.env[key];
  if (!value) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return value;
}

export const config = {
  openaiApiKey: requireEnv("OPENAI_API_KEY"),
  redisHost: requireEnv("REDIS_HOST"),
  redisPort: Number(process.env.REDIS_PORT || 6379),
  apiKey: requireEnv("API_KEY"),
  port: Number(process.env.PORT || 3000),
} as const;

export const QUEUE_NAME = "ai-jobs";
