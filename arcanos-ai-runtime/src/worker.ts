import { Worker } from "bullmq";
import { executeAIJob } from "./ai/executeJob";
import { getJob, updateJob } from "./jobs/jobStore";

new Worker("ai-jobs", async (job) => {
  const aiJob = getJob(job.data.jobId);
  if (!aiJob) return;

  updateJob(aiJob.id, { status: "processing" });

  try {
    const result = await executeAIJob(aiJob);

    updateJob(aiJob.id, {
      status: "completed",
      result,
    });

  } catch (err: any) {
    updateJob(aiJob.id, {
      status: "failed",
      error: err.message
    });
  }
}, {
  connection: {
    host: process.env.REDIS_HOST!,
    port: Number(process.env.REDIS_PORT || 6379)
  },
  concurrency: 3
});
