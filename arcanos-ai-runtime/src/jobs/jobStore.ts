import { v4 as uuid } from "uuid";
import { redis } from "../redis.js";

interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface Job {
  id: string;
  status: "queued" | "processing" | "completed" | "failed";
  model: string;
  messages: ChatMessage[];
  maxTokens?: number;
  result?: unknown;
  error?: string;
}

export type JobInput = Pick<Job, "model" | "messages" | "maxTokens">;

const JOB_TTL_SECONDS = 60 * 60 * 24; // 24 hours

export async function createJob(data: JobInput): Promise<Job> {
  const job: Job = {
    id: uuid(),
    status: "queued",
    model: data.model,
    messages: data.messages,
    maxTokens: data.maxTokens,
  };
  await redis.set(`job:${job.id}`, JSON.stringify(job), "EX", JOB_TTL_SECONDS);
  return job;
}

export async function getJob(id: string): Promise<Job | null> {
  const raw = await redis.get(`job:${id}`);
  if (!raw) return null;
  return JSON.parse(raw) as Job;
}

export async function updateJob(id: string, updates: Partial<Job>): Promise<void> {
  const raw = await redis.get(`job:${id}`);
  if (!raw) return;
  const job = JSON.parse(raw) as Job;
  const updated: Job = { ...job, ...updates };
  await redis.set(`job:${id}`, JSON.stringify(updated), "EX", JOB_TTL_SECONDS);
}
