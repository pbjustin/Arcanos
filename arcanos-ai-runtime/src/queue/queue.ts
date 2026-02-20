import { Queue, type JobsOptions } from "bullmq";
import { runtimeEnv } from "../config/env";
import type { AIJobPayload } from "../jobs/types";

export const AI_QUEUE_NAME = "ai-jobs";

export const queueConnection = {
  host: runtimeEnv.REDIS_HOST,
  port: runtimeEnv.REDIS_PORT
};

const defaultJobOptions: JobsOptions = {
  removeOnComplete: {
    age: runtimeEnv.JOB_RETENTION_SECONDS,
    count: runtimeEnv.MAX_COMPLETED_JOBS
  },
  removeOnFail: {
    age: runtimeEnv.JOB_RETENTION_SECONDS,
    count: runtimeEnv.MAX_FAILED_JOBS
  }
};

export const aiQueue = new Queue<AIJobPayload>(AI_QUEUE_NAME, {
  connection: queueConnection,
  defaultJobOptions
});
