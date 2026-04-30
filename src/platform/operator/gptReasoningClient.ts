import {
  APPROVED_GPT_REASONING_ENDPOINTS,
  assertNoUnsafeTransportFields,
  type GptAccessClientResult,
  type GptAccessTransport
} from './controlPlaneClient.js';

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export interface CreateReasoningJobRequest {
  gptId: string;
  task: string;
  input?: Record<string, JsonValue>;
  context?: string;
  maxOutputTokens?: number;
  idempotencyKey?: string;
}

export interface ReasoningJobResultRequest {
  jobId: string;
  traceId?: string;
}

export interface GptReasoningPort {
  createReasoningJob(input: CreateReasoningJobRequest): Promise<GptAccessClientResult>;
  getReasoningJobResult(input: ReasoningJobResultRequest): Promise<GptAccessClientResult>;
}

const GPT_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,127}$/i;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class OperatorGptReasoningRequestError extends Error {
  readonly code = 'OPERATOR_GPT_REASONING_REQUEST_REJECTED';

  constructor(message: string) {
    super(message);
    this.name = 'OperatorGptReasoningRequestError';
  }
}

function fail(message: string): never {
  throw new OperatorGptReasoningRequestError(message);
}

function assertValidGptId(gptId: string): void {
  if (!GPT_ID_PATTERN.test(gptId.trim())) {
    fail('gptId must be a non-empty registered GPT identifier.');
  }
}

function assertNonEmptyTask(task: string): void {
  if (task.trim().length === 0) {
    fail('task must be a non-empty operator reasoning request.');
  }
}

function assertUuid(value: string, label: string): void {
  if (!UUID_PATTERN.test(value.trim())) {
    fail(`${label} must be a UUID.`);
  }
}

export class OperatorGptReasoningClient implements GptReasoningPort {
  constructor(private readonly transport: GptAccessTransport) {}

  async createReasoningJob(input: CreateReasoningJobRequest): Promise<GptAccessClientResult> {
    assertNoUnsafeTransportFields(input, 'GPT reasoning job request');
    assertValidGptId(input.gptId);
    assertNonEmptyTask(input.task);

    return this.transport.request({
      method: 'POST',
      path: APPROVED_GPT_REASONING_ENDPOINTS.jobsCreate,
      body: {
        gptId: input.gptId.trim(),
        task: input.task.trim(),
        ...(input.input ? { input: input.input } : {}),
        ...(input.context ? { context: input.context } : {}),
        ...(typeof input.maxOutputTokens === 'number' ? { maxOutputTokens: input.maxOutputTokens } : {}),
        ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {})
      }
    });
  }

  async getReasoningJobResult(input: ReasoningJobResultRequest): Promise<GptAccessClientResult> {
    assertNoUnsafeTransportFields(input, 'GPT reasoning job result request');
    assertUuid(input.jobId, 'jobId');

    return this.transport.request({
      method: 'POST',
      path: APPROVED_GPT_REASONING_ENDPOINTS.jobsResult,
      body: {
        jobId: input.jobId.trim(),
        ...(input.traceId ? { traceId: input.traceId } : {})
      }
    });
  }
}

export function createGptReasoningClient(transport: GptAccessTransport): OperatorGptReasoningClient {
  return new OperatorGptReasoningClient(transport);
}
