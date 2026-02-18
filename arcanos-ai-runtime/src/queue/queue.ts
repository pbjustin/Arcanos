import { Queue } from "bullmq";

export const aiQueue = new Queue("ai-jobs", {
  connection: {
    host: process.env.REDIS_HOST!,
    port: Number(process.env.REDIS_PORT || 6379)
  }
});
