import { Worker } from "bullmq";
import { executeAIJob } from "./ai/executeJob.js";
import type { AIJobPayload } from "./jobs/types.js";
import { AI_QUEUE_NAME, queueConnection } from "./queue/queue.js";

new Worker<AIJobPayload>(
  AI_QUEUE_NAME,
  async (job) => {
    return executeAIJob(job.data);
  },
  {
    connection: queueConnection,
    concurrency: 3
  }
);
