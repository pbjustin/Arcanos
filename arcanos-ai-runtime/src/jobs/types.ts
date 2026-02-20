export type RuntimeJobStatus =
  | "queued"
  | "processing"
  | "completed"
  | "failed";

export interface CreateJobInput {
  model: string;
  messages: Array<Record<string, unknown>>;
  maxTokens?: number;
}

export interface AIJobPayload extends CreateJobInput {
  principalId: string;
}
