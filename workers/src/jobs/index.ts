export type JobName =
  | 'OPENAI_COMPLETION'
  | 'OPENAI_EMBEDDING'
  | 'MEMORY_SET'
  | 'MEMORY_GET';

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

export type Job =
  | OpenAICompletionJob
  | OpenAIEmbeddingJob
  | MemorySetJob
  | MemoryGetJob;

export type JobResultMap = {
  OPENAI_COMPLETION: { response: string };
  OPENAI_EMBEDDING: { embedding: number[] };
  MEMORY_SET: { ok: true };
  MEMORY_GET: { value: string | null };
};

export type JobPayload<T extends JobName> = Extract<Job, { type: T }>['payload'];

export type JobHandler<T extends JobName> = (job: {
  type: T;
  payload: JobPayload<T>;
}) => Promise<JobResultMap[T]>;
