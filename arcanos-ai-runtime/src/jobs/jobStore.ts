import { v4 as uuid } from "uuid";

interface Job {
  id: string;
  status: "queued" | "processing" | "completed" | "failed";
  model: string;
  messages: any[];
  maxTokens?: number;
  result?: any;
  error?: string;
}

const store = new Map<string, Job>();

export function createJob(data: any): Job {
  const job: Job = {
    id: uuid(),
    status: "queued",
    model: data.model,
    messages: data.messages,
    maxTokens: data.maxTokens
  };

  store.set(job.id, job);
  return job;
}

export function getJob(id: string) {
  return store.get(id);
}

export function updateJob(id: string, updates: Partial<Job>) {
  const job = store.get(id);
  if (!job) return;
  Object.assign(job, updates);
}
