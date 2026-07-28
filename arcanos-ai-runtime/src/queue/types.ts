import type { AIJobPayload } from "../jobs/types.js";

export interface RuntimeQueueJob {
  id?: string | number;
  data: AIJobPayload;
  timestamp: number;
  processedOn?: number;
  finishedOn?: number;
  returnvalue?: unknown;
  failedReason?: string;
  getState(): Promise<string>;
}

export interface RuntimeQueuePort {
  add(
    name: string,
    data: AIJobPayload,
    options: { jobId: string }
  ): Promise<unknown>;
  getJob(
    jobId: string
  ): Promise<RuntimeQueueJob | null | undefined>;
}
