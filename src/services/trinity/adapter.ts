import {
  TRINITY_CORE_DAG_TEMPLATE_NAME,
  buildDagTemplate,
  resolvePublicDagTemplateName,
  type DagTemplateDefinition
} from '@dag/templates.js';
import type { DAGNode } from '@dag/dagNode.js';
import { createGptAccessAiJob, getGptAccessJobResult } from '@services/gptAccessGateway.js';
import { arcanosDagRunService } from '@services/arcanosDagRunService.js';
import { resolveErrorMessage } from '@core/lib/errors/index.js';
import { sleep } from '@shared/sleep.js';
import type {
  CreateDagRunRequest,
  DagRunOptions,
  DagRunSummary
} from '@shared/types/arcanos-verification-contract.types.js';

export const TRINITY_PIPELINE_ID = 'trinity';
export const DEFAULT_TRINITY_CORE_GPT_IDS = ['arcanos-core', 'core'] as const;

const DEFAULT_GPT_ACCESS_ACTOR_KEY = 'system:trinity-pipeline-adapter';
const DEFAULT_GPT_ACCESS_WAIT_FOR_RESULT_MS = 420_000;
const DEFAULT_GPT_ACCESS_POLL_INTERVAL_MS = 500;
const DEFAULT_MAX_OUTPUT_TOKENS = 2048;
const MIN_NESTED_GPT_ACCESS_WORKER_SLOTS = 2;

type GatewayResult = Awaited<ReturnType<typeof createGptAccessAiJob>>;
type GatewayJobResult = Awaited<ReturnType<typeof getGptAccessJobResult>>;

export interface TrinityPipelineAdapterConfig {
  defaultGptId?: string;
  allowedGptIds?: readonly string[];
  templateName?: string;
  actorKey?: string;
  requestId?: string;
  traceId?: string;
  waitForResultMs?: number;
  pollIntervalMs?: number;
  maxOutputTokens?: number;
  createAiJob?: (body: unknown, context: Parameters<typeof createGptAccessAiJob>[1]) => Promise<GatewayResult>;
  getJobResult?: (body: unknown) => Promise<GatewayJobResult>;
  createDagRun?: (request: CreateDagRunRequest) => Promise<DagRunSummary>;
}

export interface ResolveTrinityPipelineInput {
  pipelineId?: string;
  template?: string;
  gptId?: string;
  sessionId?: string;
  input?: Record<string, unknown>;
  options?: DagRunOptions;
}

export interface ResolvedTrinityPipeline {
  pipelineId: typeof TRINITY_PIPELINE_ID;
  template: typeof TRINITY_CORE_DAG_TEMPLATE_NAME;
  gptId: string;
  sessionId: string;
  input: Record<string, unknown>;
  options?: DagRunOptions;
  metadata: {
    pipeline: typeof TRINITY_PIPELINE_ID;
    template: typeof TRINITY_CORE_DAG_TEMPLATE_NAME;
    gptId: string;
  };
}

export interface CompiledTrinityDag {
  pipeline: ResolvedTrinityPipeline;
  createRunRequest: CreateDagRunRequest;
  templateDefinition: DagTemplateDefinition;
}

export interface EnqueueDagRunMetadata {
  requestId?: string;
  traceId?: string;
}

export interface CreateArcanosCoreJobInput {
  gptId?: string;
  task: string;
  input?: Record<string, unknown>;
  context?: string;
  maxOutputTokens?: number;
  idempotencyKey?: string;
}

export interface CreatedArcanosCoreJob {
  jobId: string;
  status: string;
  traceId: string | null;
  resultEndpoint: string;
  deduped: boolean;
  gptId: string;
}

export interface RouteDagNodeToGptAccessInput {
  prompt: string;
  gptId?: string;
  options: TrinityDagPromptOptions;
  node?: Pick<DAGNode, 'id' | 'executionKey' | 'metadata'>;
  config?: TrinityPipelineAdapterConfig;
}

export interface TrinityDagPromptOptions {
  sessionId?: string;
  tokenAuditSessionId?: string;
  overrideAuditSafe?: string;
  cognitiveDomain?: string;
  toolBackedCapabilities?: unknown;
  dagId?: string;
  nodeId?: string;
  executionKey?: string;
  nodeMetadata?: Record<string, unknown>;
  attempt?: number;
  sourceEndpoint: string;
}

export class TrinityPipelineAdapterError extends Error {
  readonly code: string;
  readonly statusCode?: number;

  constructor(code: string, message: string, options: { statusCode?: number } = {}) {
    super(message);
    this.name = 'TrinityPipelineAdapterError';
    this.code = code;
    this.statusCode = options.statusCode;
  }
}

function normalizeOptionalString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function normalizePositiveInteger(value: unknown, fallback: number): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function readPositiveInteger(value: unknown): number | null {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function hasNestedGptAccessWorkerCapacity(env: NodeJS.ProcessEnv): boolean {
  const workerSlots =
    readPositiveInteger(env.JOB_WORKER_CONCURRENCY) ??
    readPositiveInteger(env.WORKER_COUNT) ??
    1;

  return workerSlots >= MIN_NESTED_GPT_ACCESS_WORKER_SLOTS;
}

function normalizeAllowedGptIds(config: TrinityPipelineAdapterConfig): string[] {
  const configured = config.allowedGptIds?.length
    ? config.allowedGptIds
    : DEFAULT_TRINITY_CORE_GPT_IDS;

  return Array.from(
    new Set(
      configured
        .map((entry) => entry.trim().toLowerCase())
        .filter(Boolean)
    )
  );
}

function resolveAdapterGptId(
  requestedGptId: string | undefined,
  config: TrinityPipelineAdapterConfig
): string {
  const fallbackGptId = normalizeOptionalString(config.defaultGptId) ?? DEFAULT_TRINITY_CORE_GPT_IDS[0];
  const normalizedGptId = (normalizeOptionalString(requestedGptId) ?? fallbackGptId).toLowerCase();
  const allowedGptIds = normalizeAllowedGptIds(config);

  if (!allowedGptIds.includes(normalizedGptId)) {
    throw new TrinityPipelineAdapterError(
      'TRINITY_GPT_ID_NOT_ALLOWED',
      `Trinity pipeline requires an allowed GPT ID. Received "${normalizedGptId}".`
    );
  }

  return normalizedGptId;
}

function resolveAdapterTemplateName(
  requestedTemplate: string | undefined,
  config: TrinityPipelineAdapterConfig
): typeof TRINITY_CORE_DAG_TEMPLATE_NAME {
  const rawTemplate =
    normalizeOptionalString(requestedTemplate) ??
    normalizeOptionalString(config.templateName) ??
    TRINITY_CORE_DAG_TEMPLATE_NAME;
  const normalizedTemplate = resolvePublicDagTemplateName(rawTemplate);

  if (normalizedTemplate !== TRINITY_CORE_DAG_TEMPLATE_NAME) {
    throw new TrinityPipelineAdapterError(
      'TRINITY_PIPELINE_UNSUPPORTED',
      `Unsupported Trinity pipeline template "${rawTemplate}".`
    );
  }

  return TRINITY_CORE_DAG_TEMPLATE_NAME;
}

function buildSyntheticSessionId(traceId: string | undefined): string {
  return ['trinity', 'pipeline', traceId || 'local', Date.now().toString(36)].join(':');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function readGatewayPayload(payload: GatewayResult['payload'] | GatewayJobResult['payload']): Record<string, unknown> {
  if (!isRecord(payload)) {
    throw new TrinityPipelineAdapterError(
      'GPT_ACCESS_INVALID_RESPONSE',
      'GPT Access returned a non-object response payload.'
    );
  }

  return payload;
}

function readGatewayErrorMessage(payload: Record<string, unknown>, fallback: string): string {
  const error = isRecord(payload.error) ? payload.error : null;
  return typeof error?.message === 'string' && error.message.trim().length > 0
    ? error.message
    : fallback;
}

function unwrapCompletedGptAccessResult(result: unknown): unknown {
  if (isRecord(result) && result.ok === true && Object.prototype.hasOwnProperty.call(result, 'result')) {
    return result.result;
  }

  return result;
}

function buildDagNodeMetadata(
  options: TrinityDagPromptOptions,
  node?: Pick<DAGNode, 'id' | 'executionKey' | 'metadata'>
) {
  return {
    pipeline: TRINITY_PIPELINE_ID,
    template: TRINITY_CORE_DAG_TEMPLATE_NAME,
    ...(options.dagId ? { dagId: options.dagId } : {}),
    nodeId: node?.id ?? options.nodeId ?? null,
    executionKey: node?.executionKey ?? options.executionKey ?? null,
    attempt: typeof options.attempt === 'number' ? options.attempt : null,
    sourceEndpoint: options.sourceEndpoint,
    sessionId: options.sessionId ?? null,
    tokenAuditSessionId: options.tokenAuditSessionId ?? null,
    cognitiveDomain: options.cognitiveDomain ?? null,
    nodeMetadata: node?.metadata ?? options.nodeMetadata ?? null
  };
}

export function isTrinityDagGptAccessEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const rawValue =
    env.TRINITY_DAG_GPT_ACCESS_ENABLED ??
    env.TRINITY_PIPELINE_GPT_ACCESS_ENABLED;

  if (typeof rawValue !== 'string' || rawValue.trim().length === 0) {
    return hasNestedGptAccessWorkerCapacity(env);
  }

  return !['0', 'false', 'no', 'off'].includes(rawValue.trim().toLowerCase());
}

export function resolveTrinityPipeline(
  input: ResolveTrinityPipelineInput = {},
  config: TrinityPipelineAdapterConfig = {}
): ResolvedTrinityPipeline {
  const template = resolveAdapterTemplateName(input.template ?? input.pipelineId, config);
  const gptId = resolveAdapterGptId(input.gptId, config);
  const sessionId =
    normalizeOptionalString(input.sessionId) ??
    buildSyntheticSessionId(config.traceId ?? config.requestId);
  const pipelineInput = {
    ...(input.input ?? {}),
    pipeline: TRINITY_PIPELINE_ID,
    pipelineTemplate: template,
    gptId
  };

  return {
    pipelineId: TRINITY_PIPELINE_ID,
    template,
    gptId,
    sessionId,
    input: pipelineInput,
    ...(input.options ? { options: input.options } : {}),
    metadata: {
      pipeline: TRINITY_PIPELINE_ID,
      template,
      gptId
    }
  };
}

export function compilePipelineToDag(
  pipeline: ResolvedTrinityPipeline
): CompiledTrinityDag {
  const createRunRequest: CreateDagRunRequest = {
    sessionId: pipeline.sessionId,
    template: pipeline.template,
    input: pipeline.input,
    ...(pipeline.options ? { options: pipeline.options } : {})
  };

  return {
    pipeline,
    createRunRequest,
    templateDefinition: buildDagTemplate(createRunRequest)
  };
}

export async function enqueueDagRun(
  dag: CompiledTrinityDag,
  metadata: EnqueueDagRunMetadata = {},
  config: TrinityPipelineAdapterConfig = {}
): Promise<DagRunSummary> {
  const createDagRun = config.createDagRun ?? arcanosDagRunService.createRun.bind(arcanosDagRunService);
  const request: CreateDagRunRequest = {
    ...dag.createRunRequest,
    input: {
      ...dag.createRunRequest.input,
      ...(metadata.requestId ? { requestId: metadata.requestId } : {}),
      ...(metadata.traceId ? { traceId: metadata.traceId } : {})
    }
  };

  return createDagRun(request);
}

export async function createArcanosCoreJob(
  input: CreateArcanosCoreJobInput,
  config: TrinityPipelineAdapterConfig = {}
): Promise<CreatedArcanosCoreJob> {
  const gptId = resolveAdapterGptId(input.gptId, config);
  const createAiJob = config.createAiJob ?? createGptAccessAiJob;
  const traceId = normalizeOptionalString(config.traceId) ?? undefined;
  const result = await createAiJob({
    gptId,
    task: input.task,
    input: input.input ?? {},
    ...(input.context ? { context: input.context } : {}),
    maxOutputTokens: normalizePositiveInteger(
      input.maxOutputTokens ?? config.maxOutputTokens,
      DEFAULT_MAX_OUTPUT_TOKENS
    ),
    ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {})
  }, {
    actorKey: normalizeOptionalString(config.actorKey) ?? DEFAULT_GPT_ACCESS_ACTOR_KEY,
    requestId: config.requestId,
    traceId,
    idempotencyKey: input.idempotencyKey ?? null
  });
  const payload = readGatewayPayload(result.payload);

  if (result.statusCode >= 400 || payload.ok !== true) {
    throw new TrinityPipelineAdapterError(
      'GPT_ACCESS_JOB_CREATE_FAILED',
      readGatewayErrorMessage(payload, 'GPT Access failed to create the Arcanos core job.'),
      { statusCode: result.statusCode }
    );
  }

  const jobId = normalizeOptionalString(payload.jobId);
  if (!jobId) {
    throw new TrinityPipelineAdapterError(
      'GPT_ACCESS_INVALID_RESPONSE',
      'GPT Access job creation did not return a jobId.',
      { statusCode: result.statusCode }
    );
  }

  return {
    jobId,
    gptId,
    status: normalizeOptionalString(payload.status) ?? 'queued',
    traceId: normalizeOptionalString(payload.traceId),
    resultEndpoint: normalizeOptionalString(payload.resultEndpoint) ?? '/gpt-access/jobs/result',
    deduped: payload.deduped === true
  };
}

export async function routeDagNodeToGptAccess(
  input: RouteDagNodeToGptAccessInput
): Promise<unknown> {
  const config = input.config ?? {};
  const nodeMetadata = buildDagNodeMetadata(input.options, input.node);
  const createdJob = await createArcanosCoreJob({
    gptId: input.gptId,
    task: input.prompt,
    input: {
      ...nodeMetadata,
      ...(input.options.overrideAuditSafe ? { overrideAuditSafe: input.options.overrideAuditSafe } : {}),
      ...(input.options.toolBackedCapabilities
        ? { toolBackedCapabilities: input.options.toolBackedCapabilities }
        : {})
    },
    context: `Trinity DAG node routed through ${nodeMetadata.sourceEndpoint}.`,
    maxOutputTokens: config.maxOutputTokens
  }, config);

  const waitForResultMs = normalizePositiveInteger(
    config.waitForResultMs,
    DEFAULT_GPT_ACCESS_WAIT_FOR_RESULT_MS
  );
  const pollIntervalMs = normalizePositiveInteger(
    config.pollIntervalMs,
    DEFAULT_GPT_ACCESS_POLL_INTERVAL_MS
  );
  const getJobResult = config.getJobResult ?? getGptAccessJobResult;
  const startedAtMs = Date.now();

  while (Date.now() - startedAtMs <= waitForResultMs) {
    const result = await getJobResult({
      jobId: createdJob.jobId,
      ...(config.traceId ? { traceId: config.traceId } : {})
    });
    const payload = readGatewayPayload(result.payload);
    if (payload.ok !== true) {
      throw new TrinityPipelineAdapterError(
        'GPT_ACCESS_JOB_RESULT_FAILED',
        readGatewayErrorMessage(payload, 'GPT Access failed to read the Arcanos core job result.'),
        { statusCode: result.statusCode }
      );
    }

    const status = normalizeOptionalString(payload.status);
    if (status === 'completed') {
      return unwrapCompletedGptAccessResult(payload.result);
    }
    if (status === 'failed' || status === 'expired' || status === 'not_found') {
      throw new TrinityPipelineAdapterError(
        'GPT_ACCESS_JOB_TERMINAL_FAILURE',
        readGatewayErrorMessage(payload, `Arcanos core job ${createdJob.jobId} ended with status ${status}.`),
        { statusCode: result.statusCode }
      );
    }

    await sleep(pollIntervalMs);
  }

  throw new TrinityPipelineAdapterError(
    'GPT_ACCESS_JOB_TIMEOUT',
    `Timed out after ${waitForResultMs}ms waiting for Arcanos core job ${createdJob.jobId}.`
  );
}

export function formatTrinityPipelineAdapterError(error: unknown): string {
  if (error instanceof TrinityPipelineAdapterError) {
    return `${error.code}: ${error.message}`;
  }

  return resolveErrorMessage(error);
}
