import { Worker } from "bullmq";
import { executeAIJob } from "./ai/executeJob";
import type { AIJobPayload } from "./jobs/types";
import { AI_QUEUE_NAME, queueConnection } from "./queue/queue";

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
