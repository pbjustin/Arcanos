import { Worker, type Job } from "bullmq";
import { executeAIJob } from "./ai/executeJob.js";
import { getJob, updateJob } from "./jobs/jobStore.js";
import { config, QUEUE_NAME } from "./config.js";

new Worker(
  QUEUE_NAME,
  async (job: Job) => {
    const aiJob = await getJob(job.data.jobId as string);
    if (!aiJob) return;

    await updateJob(aiJob.id, { status: "processing" });

    try {
      const result = await executeAIJob(aiJob);
      await updateJob(aiJob.id, { status: "completed", result });
    } catch (err) {
      await updateJob(aiJob.id, {
        status: "failed",
        error: err instanceof Error ? err.message : String(err),
      });
    }
  },
  {
    connection: {
      host: config.redisHost,
      port: config.redisPort,
    },
    concurrency: 3,
  }
);
