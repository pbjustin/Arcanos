import type OpenAI from 'openai';
import { z } from 'zod';
import { getDefaultModel } from '@services/openai.js';
import { buildFunctionToolSet, type FunctionToolDefinition } from '@services/openai/functionTools.js';
import { getTokenParameter } from '@shared/tokenParameterHelper.js';
import { shouldStoreOpenAIResponses } from '@config/openaiStore.js';
import type { AskResponse } from './types.js';
import { parseToolArgumentsWithSchema } from '@services/safety/aiOutputBoundary.js';
import { extractResponseOutputText } from '@arcanos/openai/responseParsing';
import {
  buildInitialToolLoopTranscript,
  buildToolLoopContinuationRequest,
  type ToolLoopFunctionCallOutput
} from './toolLoop.js';
import {
  dispatchWorkerInput,
  getWorkerControlHealth,
  getLatestWorkerJobDetail,
  getWorkerControlStatus,
  getWorkerJobDetailById,
  healWorkerRuntime,
  queueWorkerAsk
} from '@services/workerControlService.js';

const WORKER_TOOL_SYSTEM_PROMPT = [
  'You are ARCANOS in worker-operations mode.',
  'Use worker control tools only when the operator is asking about worker status, queue state, jobs, dispatching work, or restarting/healing workers.',
  'Prefer inspecting status before mutating worker state when the request is ambiguous.',
  'Use queue_worker_ask when the operator wants the dedicated async worker service to handle a task in the background.',
  'Use dispatch_worker_task when the operator wants the main app to run a task immediately through the in-process worker runtime.',
  'Use heal_worker_runtime only for explicit restart, heal, or bootstrap requests.',
  'If the prompt is not about worker control, do not call any tools.'
].join(' ');

const workerControlToolDefinitions: FunctionToolDefinition[] = [
  {
    name: 'get_worker_health',
    description: 'Get the autonomous queue-worker health report, including alerts and persisted worker snapshots.',
    parameters: {
      type: 'object',
      properties: {}
    }
  },
  {
    name: 'get_worker_status',
    description: 'Get combined status for the main app worker runtime and the dedicated async worker queue.',
    parameters: {
      type: 'object',
      properties: {}
    }
  },
  {
    name: 'get_latest_worker_job',
    description: 'Get the latest queued worker job including output when available.',
    parameters: {
      type: 'object',
      properties: {}
    }
  },
  {
    name: 'get_worker_job',
    description: 'Get one queued worker job by identifier.',
    parameters: {
      type: 'object',
      properties: {
        jobId: {
          type: 'string',
          description: 'The job identifier to inspect.'
        }
      },
      required: ['jobId']
    }
  },
  {
    name: 'queue_worker_ask',
    description: 'Queue a new async ask job for the dedicated DB-backed worker service.',
    parameters: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'Prompt to queue for async worker execution.' },
        sessionId: { type: 'string', description: 'Optional session identifier.' },
        cognitiveDomain: {
          type: 'string',
          enum: ['diagnostic', 'code', 'creative', 'natural', 'execution'],
          description: 'Optional explicit cognitive domain override.'
        },
        overrideAuditSafe: {
          type: 'string',
          description: 'Optional audit-safe override flag.'
        },
        endpointName: {
          type: 'string',
          description: 'Optional source endpoint label for telemetry.'
        }
      },
      required: ['prompt']
    }
  },
  {
    name: 'dispatch_worker_task',
    description: 'Dispatch immediate work through the main app in-process worker runtime.',
    parameters: {
      type: 'object',
      properties: {
        input: { type: 'string', description: 'Prompt or command for immediate dispatch.' },
        sessionId: { type: 'string', description: 'Optional session identifier.' },
        cognitiveDomain: {
          type: 'string',
          enum: ['diagnostic', 'code', 'creative', 'natural', 'execution'],
          description: 'Optional explicit cognitive domain override.'
        },
        overrideAuditSafe: {
          type: 'string',
          description: 'Optional audit-safe override flag.'
        },
        attempts: { type: 'integer', minimum: 1, maximum: 10 },
        backoffMs: { type: 'integer', minimum: 0, maximum: 60000 },
        sourceEndpoint: {
          type: 'string',
          description: 'Optional endpoint label for worker telemetry.'
        }
      },
      required: ['input']
    }
  },
  {
    name: 'heal_worker_runtime',
    description: 'Restart or bootstrap the in-process worker runtime.',
    parameters: {
      type: 'object',
      properties: {
        force: {
          type: 'boolean',
          description: 'When true, force a restart. Defaults to true.'
        }
      }
    }
  }
];

const { chatCompletionTools: workerControlChatCompletionTools, responsesTools: workerControlResponsesTools } =
  buildFunctionToolSet(workerControlToolDefinitions);

const getWorkerJobArgsSchema = z.object({
  jobId: z.string().trim().min(1)
});

const queueWorkerAskArgsSchema = z.object({
  prompt: z.string().trim().min(1),
  sessionId: z.string().trim().min(1).max(100).optional(),
  cognitiveDomain: z.enum(['diagnostic', 'code', 'creative', 'natural', 'execution']).optional(),
  overrideAuditSafe: z.string().trim().min(1).max(50).optional(),
  endpointName: z.string().trim().min(1).max(64).optional()
});

const dispatchWorkerTaskArgsSchema = z.object({
  input: z.string().trim().min(1),
  sessionId: z.string().trim().min(1).max(100).optional(),
  cognitiveDomain: z.enum(['diagnostic', 'code', 'creative', 'natural', 'execution']).optional(),
  overrideAuditSafe: z.string().trim().min(1).max(50).optional(),
  attempts: z.number().int().min(1).max(10).optional(),
  backoffMs: z.number().int().min(0).max(60000).optional(),
  sourceEndpoint: z.string().trim().min(1).max(64).optional()
});

const healWorkerRuntimeArgsSchema = z.object({
  force: z.boolean().optional()
});

type WorkerControlToolCall = {
  name?: string;
  call_id?: string;
  arguments?: string;
};

interface DeterministicWorkerOperation {
  toolName:
    | 'get_worker_health'
    | 'get_worker_status'
    | 'get_latest_worker_job'
    | 'get_worker_job'
    | 'queue_worker_ask'
    | 'dispatch_worker_task'
    | 'heal_worker_runtime';
  matchIndex: number;
  rawArgs: string;
}

const latestWorkerJobPattern =
  /\b(?:latest|recent|most recent)\b[^.!?\n]{0,40}\bjob\b|\bjob\b[^.!?\n]{0,40}\b(?:latest|recent|most recent)\b/i;
const workerHealthPattern =
  /\b(?:worker|workers|queue)\b[^.!?\n]{0,40}\bhealth\b|\bhealth\b[^.!?\n]{0,40}\b(?:worker|workers|queue)\b/i;
const workerStatusPattern =
  /\b(?:worker|workers|queue)\b[^.!?\n]{0,40}\bstatus\b|\bstatus\b[^.!?\n]{0,40}\b(?:worker|workers|queue)\b/i;
const workerHealPattern =
  /\b(?:restart|heal|bootstrap)\b[^.!?\n]{0,40}\b(?:worker|workers|runtime)\b|\b(?:worker|workers|runtime)\b[^.!?\n]{0,40}\b(?:restart|heal|bootstrap)\b/i;
const workerJobIdPattern = /\bjob(?:\s+id)?\s*[:#]?\s*([0-9a-f]{8}[0-9a-f-]{0,})\b/i;
const queueWorkerPromptPattern = /\b(?:queue|enqueue)(?:\s+(?:this|prompt|ask|job))?\s*:\s*(.+)$/is;
const dispatchWorkerPromptPattern = /\b(?:dispatch|run directly|run now)(?:\s+(?:this|task|worker))?\s*:\s*(.+)$/is;

function looksLikeWorkerControlPrompt(prompt: string): boolean {
  const normalizedPrompt = prompt.toLowerCase();
  const workerControlPatterns = [
    /\bworker\b/,
    /\bworkers\b/,
    /\bjob\b/,
    /\bjobs\b/,
    /\bqueue\b/,
    /\brestart\b/,
    /\bheal\b/,
    /\bdispatch\b/,
    /\bstatus\b/,
    /\bpending\b/,
    /\brunning\b/,
    /\bfailed\b/,
    /\bbootstrap\b/
  ];

  return workerControlPatterns.some(pattern => pattern.test(normalizedPrompt));
}

/**
 * Build serialized tool arguments for deterministic worker operations.
 *
 * Purpose:
 * - Keep the deterministic fast-path aligned with the tool execution contract.
 *
 * Inputs/outputs:
 * - Input: optional argument payload.
 * - Output: JSON string consumed by `executeWorkerTool`.
 *
 * Edge case behavior:
 * - Omits undefined values so downstream schema parsing receives clean payloads.
 */
function buildDeterministicToolArguments(args: Record<string, unknown> = {}): string {
  const sanitizedEntries = Object.entries(args).filter(([, value]) => value !== undefined);
  return JSON.stringify(Object.fromEntries(sanitizedEntries));
}

/**
 * Append one deterministic worker operation when a pattern is present.
 *
 * Purpose:
 * - Collect stable worker-control actions without duplicating the same tool call.
 *
 * Inputs/outputs:
 * - Input: mutable operation list, regex match, tool name, and optional args.
 * - Output: mutates `operations` in place when a new operation is discovered.
 *
 * Edge case behavior:
 * - Duplicate tool names are ignored to keep execution idempotent for one prompt.
 */
function appendDeterministicWorkerOperation(
  operations: DeterministicWorkerOperation[],
  matchIndex: number | undefined,
  toolName: DeterministicWorkerOperation['toolName'],
  args: Record<string, unknown> = {}
): void {
  if (typeof matchIndex !== 'number') {
    return;
  }

  //audit Assumption: one prompt should execute each deterministic worker tool at most once; failure risk: duplicate mutations or noisy status calls; expected invariant: one tool call per inferred action; handling strategy: ignore repeated tool names after first match.
  if (operations.some(operation => operation.toolName === toolName)) {
    return;
  }

  operations.push({
    toolName,
    matchIndex,
    rawArgs: buildDeterministicToolArguments(args)
  });
}

/**
 * Extract a queueable worker prompt from structured operator syntax.
 *
 * Purpose:
 * - Support deterministic queue commands without relying on model tool selection.
 *
 * Inputs/outputs:
 * - Input: raw operator prompt.
 * - Output: queue payload text or `null`.
 *
 * Edge case behavior:
 * - Only colon-based syntax is accepted to avoid accidentally queueing prose requests.
 */
function extractQueueWorkerPrompt(prompt: string): { input: string; matchIndex: number } | null {
  const match = queueWorkerPromptPattern.exec(prompt);
  const extractedPrompt = match?.[1]?.trim();

  //audit Assumption: queue mutations should require explicit operator delimiting; failure risk: arbitrary status prose being enqueued as a job; expected invariant: only colon-delimited queue commands produce queued work; handling strategy: reject empty or missing captured payloads.
  if (!match || typeof match.index !== 'number' || !extractedPrompt) {
    return null;
  }

  return {
    input: extractedPrompt,
    matchIndex: match.index
  };
}

/**
 * Extract a direct-dispatch worker prompt from structured operator syntax.
 *
 * Purpose:
 * - Support deterministic direct dispatch for CLI or chat-style operator prompts.
 *
 * Inputs/outputs:
 * - Input: raw operator prompt.
 * - Output: direct-dispatch payload text or `null`.
 *
 * Edge case behavior:
 * - Only colon-based syntax is accepted so dispatch stays explicit.
 */
function extractDispatchWorkerPrompt(prompt: string): { input: string; matchIndex: number } | null {
  const match = dispatchWorkerPromptPattern.exec(prompt);
  const extractedPrompt = match?.[1]?.trim();

  //audit Assumption: direct dispatch should remain an explicit operator action; failure risk: executing free-form prose against the worker runtime; expected invariant: only colon-delimited dispatch commands produce immediate execution; handling strategy: require a captured payload after the command prefix.
  if (!match || typeof match.index !== 'number' || !extractedPrompt) {
    return null;
  }

  return {
    input: extractedPrompt,
    matchIndex: match.index
  };
}

/**
 * Infer deterministic worker operations from common operator phrases.
 *
 * Purpose:
 * - Make status and command prompts reliable even when model tool selection is skipped.
 *
 * Inputs/outputs:
 * - Input: operator prompt string.
 * - Output: ordered list of worker operations inferred from explicit patterns.
 *
 * Edge case behavior:
 * - Returns an empty list when no stable command pattern is found so the model-based tool path can still run.
 */
function collectDeterministicWorkerOperations(prompt: string): DeterministicWorkerOperation[] {
  const operations: DeterministicWorkerOperation[] = [];
  const jobIdMatch = workerJobIdPattern.exec(prompt);
  const workerHealthMatch = workerHealthPattern.exec(prompt);
  const workerStatusMatch = workerStatusPattern.exec(prompt);
  const latestWorkerJobMatch = latestWorkerJobPattern.exec(prompt);
  const workerHealMatch = workerHealPattern.exec(prompt);

  appendDeterministicWorkerOperation(
    operations,
    workerHealthMatch?.index,
    'get_worker_health'
  );
  appendDeterministicWorkerOperation(
    operations,
    workerStatusMatch?.index,
    'get_worker_status'
  );
  appendDeterministicWorkerOperation(
    operations,
    latestWorkerJobMatch?.index,
    'get_latest_worker_job'
  );
  appendDeterministicWorkerOperation(
    operations,
    workerHealMatch?.index,
    'heal_worker_runtime',
    { force: true }
  );

  if (jobIdMatch?.[1]) {
    appendDeterministicWorkerOperation(operations, jobIdMatch.index, 'get_worker_job', {
      jobId: jobIdMatch[1]
    });
  }

  const queuedPrompt = extractQueueWorkerPrompt(prompt);
  if (queuedPrompt) {
    appendDeterministicWorkerOperation(operations, queuedPrompt.matchIndex, 'queue_worker_ask', {
      prompt: queuedPrompt.input,
      endpointName: 'ask.worker-tools'
    });
  }

  const dispatchedPrompt = extractDispatchWorkerPrompt(prompt);
  if (dispatchedPrompt) {
    appendDeterministicWorkerOperation(operations, dispatchedPrompt.matchIndex, 'dispatch_worker_task', {
      input: dispatchedPrompt.input,
      sourceEndpoint: 'ask.worker-tools.dispatch'
    });
  }

  return operations.sort((left, right) => left.matchIndex - right.matchIndex);
}

/**
 * Execute deterministic worker operations without an OpenAI round-trip.
 *
 * Purpose:
 * - Provide a reliable fast-path for explicit operator commands in `/ask`.
 *
 * Inputs/outputs:
 * - Input: ordered deterministic operations inferred from the prompt.
 * - Output: worker-tool AskResponse summarizing executed actions.
 *
 * Edge case behavior:
 * - Returns `null` when no deterministic operations were inferred.
 */
async function executeDeterministicWorkerOperations(
  operations: DeterministicWorkerOperation[]
): Promise<AskResponse | null> {
  if (operations.length === 0) {
    return null;
  }

  const executionSummaries: string[] = [];

  for (const operation of operations) {
    const executed = await executeWorkerTool(operation.toolName, operation.rawArgs);
    executionSummaries.push(executed.summary);
  }

  return buildWorkerToolResponse(null, executionSummaries.join(' '));
}

function buildWorkerToolResponse(response: any, resultText: string): AskResponse {
  const usage = response?.usage;
  const tokens = usage
    ? {
        prompt_tokens: usage.prompt_tokens,
        completion_tokens: usage.completion_tokens,
        total_tokens: usage.total_tokens
      }
    : undefined;

  return {
    result: resultText,
    module: 'worker-tools',
    activeModel: response?.model,
    fallbackFlag: false,
    meta: {
      tokens,
      id: response?.id || `worker-tool-${Date.now()}`,
      created: typeof response?.created === 'number' ? response.created : Date.now()
    }
  };
}

function summarizeToolExecution(toolName: string, payload: Record<string, unknown>): string {
  switch (toolName) {
    case 'get_worker_health':
      return `Worker health: overall=${String(payload.overallStatus ?? 'unknown')}, alerts=${Array.isArray(payload.alerts) ? payload.alerts.length : 0}, tracked_workers=${Array.isArray(payload.workers) ? payload.workers.length : 0}.`;
    case 'get_worker_status': {
      const mainApp = payload.mainApp as Record<string, unknown> | undefined;
      const workerService = payload.workerService as Record<string, unknown> | undefined;
      const runtime = mainApp?.runtime as Record<string, unknown> | undefined;
      const queueSummary = workerService?.queueSummary as Record<string, unknown> | null | undefined;
      return `Worker status: started=${runtime?.started ?? 'unknown'}, listeners=${runtime?.activeListeners ?? 'unknown'}, pending=${queueSummary?.pending ?? 'unknown'}, running=${queueSummary?.running ?? 'unknown'}, failed=${queueSummary?.failed ?? 'unknown'}.`;
    }
    case 'get_latest_worker_job':
    case 'get_worker_job':
      return `Job status: id=${payload.id ?? 'unknown'}, status=${payload.status ?? 'unknown'}, type=${payload.job_type ?? 'unknown'}.`;
    case 'queue_worker_ask':
      return `Queued async worker job ${payload.jobId ?? 'unknown'} (${payload.status ?? 'pending'}).`;
    case 'dispatch_worker_task':
      return `Dispatched worker task with ${payload.resultCount ?? 0} result(s).`;
    case 'heal_worker_runtime': {
      const restart = payload.restart as Record<string, unknown> | undefined;
      return `Worker heal completed: ${String(restart?.message ?? 'restart requested')}`;
    }
    default:
      return `Executed ${toolName}.`;
  }
}

async function executeWorkerTool(
  toolName: string,
  rawArgs: string
): Promise<{ output: Record<string, unknown>; summary: string }> {
  switch (toolName) {
    case 'get_worker_health': {
      const output = await getWorkerControlHealth();
      return {
        output: output as unknown as Record<string, unknown>,
        summary: summarizeToolExecution(toolName, output as unknown as Record<string, unknown>)
      };
    }
    case 'get_worker_status': {
      const output = await getWorkerControlStatus();
      return {
        output: output as unknown as Record<string, unknown>,
        summary: summarizeToolExecution(toolName, output as unknown as Record<string, unknown>)
      };
    }
    case 'get_latest_worker_job': {
      const output = await getLatestWorkerJobDetail();
      const normalizedOutput = (output ?? { status: 'not_found' }) as Record<string, unknown>;
      return {
        output: normalizedOutput,
        summary: output
          ? summarizeToolExecution(toolName, normalizedOutput)
          : 'No worker jobs were found.'
      };
    }
    case 'get_worker_job': {
      const parsedArgs = parseToolArgumentsWithSchema(rawArgs, getWorkerJobArgsSchema, 'workerTools.get_worker_job');
      const output = await getWorkerJobDetailById(parsedArgs.jobId);
      const normalizedOutput = (output ?? { id: parsedArgs.jobId, status: 'not_found' }) as Record<string, unknown>;
      return {
        output: normalizedOutput,
        summary: output
          ? summarizeToolExecution(toolName, normalizedOutput)
          : `Worker job ${parsedArgs.jobId} was not found.`
      };
    }
    case 'queue_worker_ask': {
      const parsedArgs = parseToolArgumentsWithSchema(rawArgs, queueWorkerAskArgsSchema, 'workerTools.queue_worker_ask');
      const output = await queueWorkerAsk({
        prompt: parsedArgs.prompt,
        sessionId: parsedArgs.sessionId,
        cognitiveDomain: parsedArgs.cognitiveDomain,
        overrideAuditSafe: parsedArgs.overrideAuditSafe,
        endpointName: parsedArgs.endpointName || 'ask.worker-tools'
      });
      return {
        output: output as unknown as Record<string, unknown>,
        summary: summarizeToolExecution(toolName, output as unknown as Record<string, unknown>)
      };
    }
    case 'dispatch_worker_task': {
      const parsedArgs = parseToolArgumentsWithSchema(rawArgs, dispatchWorkerTaskArgsSchema, 'workerTools.dispatch_worker_task');
      const output = await dispatchWorkerInput({
        input: parsedArgs.input,
        sessionId: parsedArgs.sessionId,
        cognitiveDomain: parsedArgs.cognitiveDomain,
        overrideAuditSafe: parsedArgs.overrideAuditSafe,
        attempts: parsedArgs.attempts,
        backoffMs: parsedArgs.backoffMs,
        sourceEndpoint: parsedArgs.sourceEndpoint || 'ask.worker-tools.dispatch'
      });
      return {
        output: output as unknown as Record<string, unknown>,
        summary: summarizeToolExecution(toolName, output as unknown as Record<string, unknown>)
      };
    }
    case 'heal_worker_runtime': {
      const parsedArgs = parseToolArgumentsWithSchema(rawArgs, healWorkerRuntimeArgsSchema, 'workerTools.heal_worker_runtime');
      const output = await healWorkerRuntime(parsedArgs.force);
      return {
        output: output as unknown as Record<string, unknown>,
        summary: summarizeToolExecution(toolName, output as unknown as Record<string, unknown>)
      };
    }
    default:
      throw new Error(`Unsupported worker tool: ${toolName}`);
  }
}

/**
 * Attempt to let the backend AI control workers through tool-calling.
 *
 * Purpose:
 * - Give operators natural-language worker control through `/ask` while preserving normal Trinity fallback for non-worker prompts.
 *
 * Inputs/outputs:
 * - Input: OpenAI client and prompt text.
 * - Output: worker-tool AskResponse when tools execute; `null` when the prompt should continue through normal ask flow.
 *
 * Edge case behavior:
 * - Non-worker prompts return `null` so normal ask routing can continue unchanged.
 */
export async function tryDispatchWorkerTools(
  client: OpenAI,
  prompt: string
): Promise<AskResponse | null> {
  if (!looksLikeWorkerControlPrompt(prompt)) {
    return null;
  }

  const deterministicResponse = await executeDeterministicWorkerOperations(
    collectDeterministicWorkerOperations(prompt)
  );
  if (deterministicResponse) {
    return deterministicResponse;
  }

  const model = getDefaultModel();
  const tokenParams = getTokenParameter(model, 512) as Record<string, unknown>;
  const maxOutputTokens =
    (tokenParams as { max_completion_tokens?: number; max_tokens?: number }).max_completion_tokens ??
    (tokenParams as { max_completion_tokens?: number; max_tokens?: number }).max_tokens ??
    512;

  const responsesApi = (client as any)?.responses;
  const chatCompletionsApi = (client as any)?.chat?.completions;

  if (!responsesApi?.create && !chatCompletionsApi?.create) {
    throw new Error('OpenAI client does not expose responses.create or chat.completions.create');
  }

  if (!responsesApi?.create && chatCompletionsApi?.create) {
    const response = await chatCompletionsApi.create({
      model,
      messages: [
        { role: 'system', content: WORKER_TOOL_SYSTEM_PROMPT },
        { role: 'user', content: prompt }
      ],
      tools: workerControlChatCompletionTools,
      tool_choice: 'auto',
      ...tokenParams
    });

    const toolCalls = response?.choices?.[0]?.message?.tool_calls ?? [];
    if (!toolCalls.length) {
      return null;
    }

    const summaries: string[] = [];
    for (const toolCall of toolCalls) {
      if (toolCall.type !== 'function' || !toolCall.function?.name) {
        continue;
      }
      const executed = await executeWorkerTool(toolCall.function.name, toolCall.function.arguments || '{}');
      summaries.push(executed.summary);
    }

    return buildWorkerToolResponse(response, summaries.join(' '));
  }

  const MAX_TURNS = 8;
  const storeOpenAIResponses = shouldStoreOpenAIResponses();
  let toolLoopTranscript = buildInitialToolLoopTranscript(prompt);
  let response: any = await responsesApi.create({
    model,
    store: storeOpenAIResponses,
    instructions: WORKER_TOOL_SYSTEM_PROMPT,
    input: toolLoopTranscript,
    tools: workerControlResponsesTools,
    tool_choice: 'auto',
    max_output_tokens: maxOutputTokens
  });
  let lastText = extractResponseOutputText(response, '');
  const executionSummaries: string[] = [];

  for (let turn = 0; turn < MAX_TURNS; turn += 1) {
    const toolCalls = (Array.isArray(response?.output) ? response.output : []).filter(
      (item: unknown): item is WorkerControlToolCall & { type: string } =>
        Boolean(item) && typeof item === 'object' && (item as { type?: string }).type === 'function_call'
    );

    if (!toolCalls.length) {
      if (!lastText || lastText.trim().length === 0) {
        const summaryText = executionSummaries.join(' ');
        return summaryText ? buildWorkerToolResponse(response, summaryText) : null;
      }
      return buildWorkerToolResponse(response, lastText);
    }

    const functionCallOutputs: ToolLoopFunctionCallOutput[] = [];

    for (const toolCall of toolCalls) {
      const toolName = typeof toolCall.name === 'string' ? toolCall.name : '';
      const callId = typeof toolCall.call_id === 'string' ? toolCall.call_id : '';
      if (!toolName || !callId) {
        continue;
      }

      try {
        const executed = await executeWorkerTool(toolName, toolCall.arguments || '{}');
        executionSummaries.push(executed.summary);
        functionCallOutputs.push({
          type: 'function_call_output',
          call_id: callId,
          output: JSON.stringify({
            ok: true,
            ...executed.output
          })
        });
      } catch (error: unknown) {
        functionCallOutputs.push({
          type: 'function_call_output',
          call_id: callId,
          output: JSON.stringify({
            ok: false,
            error: error instanceof Error ? error.message : String(error)
          })
        });
      }
    }

    const continuationRequest = buildToolLoopContinuationRequest({
      instructions: WORKER_TOOL_SYSTEM_PROMPT,
      maxOutputTokens,
      model,
      previousResponse: response,
      storeResponses: storeOpenAIResponses,
      tools: workerControlResponsesTools,
      transcript: toolLoopTranscript,
      functionCallOutputs
    });
    toolLoopTranscript = continuationRequest.nextTranscript;
    response = await responsesApi.create(continuationRequest.request);
    lastText = extractResponseOutputText(response, lastText);
  }

  return executionSummaries.length > 0 ? buildWorkerToolResponse(response, executionSummaries.join(' ')) : null;
}
