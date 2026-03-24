import { TRINITY_CORE_DAG_TEMPLATE_NAME } from '../dag/templates.js';
import { generateRequestId } from '../shared/idGenerator.js';
import type {
  CreateDagRunRequest,
  DagRunOptions
} from '../shared/types/arcanos-verification-contract.types.js';
import { logger } from '@platform/logging/structuredLogging.js';
import { arcanosDagRunService } from './arcanosDagRunService.js';
import type { ModuleDef } from './moduleLoader.js';

interface ArcanosBuildPayload {
  sessionId?: string;
  template?: string;
  input?: Record<string, unknown>;
  options?: DagRunOptions;
  goal?: string;
  task?: string;
  prompt?: string;
  topic?: string;
  message?: string;
  userInput?: string;
  content?: string;
  text?: string;
  query?: string;
  plannerPrompt?: string;
  researchPrompt?: string;
  buildPrompt?: string;
  auditPrompt?: string;
  writerPrompt?: string;
  maxConcurrency?: number;
  allowRecursiveSpawning?: boolean;
  debug?: boolean;
}

const BUILD_INPUT_KEYS = [
  'goal',
  'task',
  'prompt',
  'topic',
  'plannerPrompt',
  'researchPrompt',
  'buildPrompt',
  'auditPrompt',
  'writerPrompt'
] as const;

const BUILD_PROMPT_ALIAS_KEYS = ['message', 'userInput', 'content', 'text', 'query'] as const;

const ArcanosBuild: ModuleDef = {
  name: 'ARCANOS:BUILD',
  description: 'Trinity DAG build launcher for implementation-oriented workflows.',
  gptIds: ['arcanos-build', 'build'],
  defaultAction: 'run',
  defaultTimeoutMs: 60000,
  actions: {
    async run(payload: unknown) {
      const request = buildCreateDagRunRequest(payload);
      const run = await arcanosDagRunService.createRun(request);

      logger.info('arcanos.build.run.created', {
        module: 'arcanos-build',
        runId: run.runId,
        sessionId: run.sessionId,
        template: run.template,
        status: run.status
      });

      return { run };
    }
  }
};

export default ArcanosBuild;

function normalizeBuildPayload(payload: unknown): ArcanosBuildPayload {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return typeof payload === 'string' ? { prompt: payload } : {};
  }

  return payload as ArcanosBuildPayload;
}

function buildCreateDagRunRequest(payload: unknown): CreateDagRunRequest {
  const normalizedPayload = normalizeBuildPayload(payload);
  const input = buildDagInput(normalizedPayload);

  if (Object.keys(input).length === 0) {
    throw new Error(
      'ARCANOS:BUILD run requires input data or prompt-style text.'
    );
  }

  return {
    sessionId: extractBuildSessionId(normalizedPayload),
    template: extractBuildTemplate(normalizedPayload),
    input,
    options: buildDagRunOptions(normalizedPayload)
  };
}

function buildDagInput(payload: ArcanosBuildPayload): Record<string, unknown> {
  const input = isRecord(payload.input) ? { ...payload.input } : {};

  for (const key of BUILD_INPUT_KEYS) {
    const value = payload[key];
    if (typeof value === 'string' && value.trim().length > 0) {
      input[key] = value.trim();
    }
  }

  if (typeof input.prompt !== 'string' || input.prompt.trim().length === 0) {
    for (const key of BUILD_PROMPT_ALIAS_KEYS) {
      const value = payload[key];
      if (typeof value === 'string' && value.trim().length > 0) {
        input.prompt = value.trim();
        break;
      }
    }
  }

  return input;
}

function buildDagRunOptions(payload: ArcanosBuildPayload): DagRunOptions | undefined {
  const options: DagRunOptions = isRecord(payload.options) ? { ...payload.options } : {};

  if (typeof payload.maxConcurrency === 'number' && Number.isInteger(payload.maxConcurrency) && payload.maxConcurrency > 0) {
    options.maxConcurrency = payload.maxConcurrency;
  }

  if (typeof payload.allowRecursiveSpawning === 'boolean') {
    options.allowRecursiveSpawning = payload.allowRecursiveSpawning;
  }

  if (typeof payload.debug === 'boolean') {
    options.debug = payload.debug;
  }

  return Object.keys(options).length > 0 ? options : undefined;
}

function extractBuildSessionId(payload: ArcanosBuildPayload): string {
  if (typeof payload.sessionId === 'string' && payload.sessionId.trim().length > 0) {
    return payload.sessionId.trim();
  }

  return generateRequestId('dagsession');
}

function extractBuildTemplate(payload: ArcanosBuildPayload): string {
  if (typeof payload.template === 'string' && payload.template.trim().length > 0) {
    return payload.template.trim();
  }

  return TRINITY_CORE_DAG_TEMPLATE_NAME;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
