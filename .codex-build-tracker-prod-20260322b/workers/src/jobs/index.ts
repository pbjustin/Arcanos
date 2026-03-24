export type JobName =
  | 'OPENAI_COMPLETION'
  | 'OPENAI_EMBEDDING'
  | 'MEMORY_SET'
  | 'MEMORY_GET'
  | 'MEMORY_SYNC';

export type OpenAICompletionJob = {
  type: 'OPENAI_COMPLETION';
  payload: {
    prompt: string;
    model?: string;
  };
};

export type OpenAIEmbeddingJob = {
  type: 'OPENAI_EMBEDDING';
  payload: {
    input: string;
    model?: string;
  };
};

export type MemorySetJob = {
  type: 'MEMORY_SET';
  payload: {
    key: string;
    value: string;
  };
};

export type MemoryGetJob = {
  type: 'MEMORY_GET';
  payload: {
    key: string;
  };
};

export type MemorySyncJob = {
  type: 'MEMORY_SYNC';
  payload: {
    key: string;
    value: unknown;
    embed?: boolean;
  };
};

export type Job =
  | OpenAICompletionJob
  | OpenAIEmbeddingJob
  | MemorySetJob
  | MemoryGetJob
  | MemorySyncJob;

export type JobResultMap = {
  OPENAI_COMPLETION: { response: string };
  OPENAI_EMBEDDING: { embedding: number[] };
  MEMORY_SET: { ok: true };
  MEMORY_GET: { value: string | null };
  MEMORY_SYNC: { status: string; key: string };
};

export type JobPayload<T extends JobName> = Extract<Job, { type: T }>['payload'];

export type JobHandler<T extends JobName> = (job: {
  type: T;
  payload: JobPayload<T>;
}) => Promise<JobResultMap[T]>;
