import type OpenAI from 'openai';
import { z } from 'zod';
import { buildFunctionToolSet, type FunctionToolDefinition } from '@services/openai/functionTools.js';
import { parseToolArgumentsWithSchema } from '@services/safety/aiOutputBoundary.js';
import {
  dispatchWorkerInput,
  getWorkerControlHealth,
  getLatestWorkerJobDetail,
  getWorkerControlStatus,
  getWorkerJobDetailById,
  healWorkerRuntime,
  queueWorkerAsk
} from '@services/workerControlService.js';
import {
  appendUniqueDeterministicOperation,
  buildToolAskResponse,
  executeDeterministicToolOperations,
  runAskToolMode,
  type DeterministicToolOperation,
  type ToolExecutionResult
} from './toolRuntime.js';
import type { AskResponse } from './types.js';

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

const modelSelectableWorkerControlToolDefinitions = workerControlToolDefinitions.filter(
  toolDefinition => toolDefinition.name !== 'heal_worker_runtime'
);

const { chatCompletionTools: workerControlChatCompletionTools, responsesTools: workerControlResponsesTools } =
  buildFunctionToolSet(modelSelectableWorkerControlToolDefinitions);

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

type WorkerControlToolName =
  | 'get_worker_health'
  | 'get_worker_status'
  | 'get_latest_worker_job'
  | 'get_worker_job'
  | 'queue_worker_ask'
  | 'dispatch_worker_task'
  | 'heal_worker_runtime';

interface DeterministicWorkerOperation extends DeterministicToolOperation<WorkerControlToolName> {}

interface WorkerToolExecutionOptions {
  allowPrivilegedMutation?: boolean;
}

const latestWorkerJobPattern =
  /\b(?:latest|recent|most recent)\b[^.!?\n]{0,40}\bjob\b|\bjob\b[^.!?\n]{0,40}\b(?:latest|recent|most recent)\b/i;
const workerHealthPattern =
  /\b(?:worker|workers|queue)\b[^.!?\n]{0,40}\bhealth\b|\bhealth\b[^.!?\n]{0,40}\b(?:worker|workers|queue)\b/i;
const workerStatusPattern =
  /\b(?:worker|workers|queue)\b[^.!?\n]{0,40}\bstatus\b|\bstatus\b[^.!?\n]{0,40}\b(?:worker|workers|queue)\b/i;
const workerHealPattern =
  /\b(?:restart|heal|bootstrap)\b[^.!?\n]{0,40}\b(?:worker|workers|runtime)\b|\b(?:worker|workers|runtime)\b[^.!?\n]{0,40}\b(?:restart|heal|bootstrap)\b/i;
const workerHealExplicitGatePattern =
  /\b(?:confirm|confirmed|operator-approved|operator approved)\b[^.!?\n]{0,60}\b(?:restart|heal|bootstrap)\b[^.!?\n]{0,40}\b(?:worker|workers|runtime)\b|\b(?:restart|heal|bootstrap)\b[^.!?\n]{0,40}\b(?:worker|workers|runtime)\b[^.!?\n]{0,60}\b(?:confirm|confirmed|operator-approved|operator approved)\b/i;
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

function hasExplicitWorkerHealGate(prompt: string): boolean {
  return workerHealExplicitGatePattern.test(prompt);
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

  appendUniqueDeterministicOperation(
    operations,
    workerHealthMatch?.index,
    'get_worker_health'
  );
  appendUniqueDeterministicOperation(
    operations,
    workerStatusMatch?.index,
    'get_worker_status'
  );
  appendUniqueDeterministicOperation(
    operations,
    latestWorkerJobMatch?.index,
    'get_latest_worker_job'
  );
  appendUniqueDeterministicOperation(
    operations,
    workerHealMatch && hasExplicitWorkerHealGate(prompt) ? workerHealMatch.index : undefined,
    'heal_worker_runtime',
    { force: true }
  );

  if (jobIdMatch?.[1]) {
    appendUniqueDeterministicOperation(operations, jobIdMatch.index, 'get_worker_job', {
      jobId: jobIdMatch[1]
    });
  }

  const queuedPrompt = extractQueueWorkerPrompt(prompt);
  if (queuedPrompt) {
    appendUniqueDeterministicOperation(operations, queuedPrompt.matchIndex, 'queue_worker_ask', {
      prompt: queuedPrompt.input,
      endpointName: 'ask.worker-tools'
    });
  }

  const dispatchedPrompt = extractDispatchWorkerPrompt(prompt);
  if (dispatchedPrompt) {
    appendUniqueDeterministicOperation(operations, dispatchedPrompt.matchIndex, 'dispatch_worker_task', {
      input: dispatchedPrompt.input,
      sourceEndpoint: 'ask.worker-tools.dispatch'
    });
  }

  return operations.sort((left, right) => left.matchIndex - right.matchIndex);
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
  rawArgs: string,
  options: WorkerToolExecutionOptions = {}
): Promise<ToolExecutionResult> {
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
      if (!options.allowPrivilegedMutation) {
        throw new Error('Worker runtime heal requires an explicit operator gate.');
      }

      const parsedArgs = parseToolArgumentsWithSchema(rawArgs, healWorkerRuntimeArgsSchema, 'workerTools.heal_worker_runtime');
      const output = await healWorkerRuntime(parsedArgs.force, 'ask_tool');
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

  const deterministicSummary = await executeDeterministicToolOperations(
    collectDeterministicWorkerOperations(prompt),
    (toolName, rawArgs) => executeWorkerTool(toolName, rawArgs, {
      allowPrivilegedMutation: true
    })
  );
  if (deterministicSummary) {
    return buildToolAskResponse('worker-tools', null, deterministicSummary, 'worker-tool');
  }

  return runAskToolMode({
    client,
    prompt,
    instructions: WORKER_TOOL_SYSTEM_PROMPT,
    moduleName: 'worker-tools',
    responseIdPrefix: 'worker-tool',
    chatCompletionTools: workerControlChatCompletionTools,
    responsesTools: workerControlResponsesTools,
    executeTool: (toolName, rawArgs) => executeWorkerTool(toolName, rawArgs),
    maxOutputTokens: 512
  });
}
