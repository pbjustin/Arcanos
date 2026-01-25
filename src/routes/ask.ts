import express, { Request, Response } from 'express';
import OpenAI from 'openai';
import { runThroughBrain } from '../logic/trinity.js';
import { validateAIRequest, handleAIError, logRequestFeedback } from '../utils/requestHandler.js';
import { confirmGate } from '../middleware/confirmGate.js';
import { createRateLimitMiddleware, securityHeaders, validateInput } from '../utils/security.js';
import { buildValidationErrorResponse } from '../utils/errorResponse.js';
import type { AIRequestDTO, AIResponseDTO, ClientContextDTO, ErrorResponseDTO } from '../types/dto.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { queueDaemonCommandForInstance } from './api-daemon.js';
import { getDefaultModel } from '../services/openai.js';
import { getTokenParameter } from '../utils/tokenParameterHelper.js';

const router = express.Router();

// Apply security middleware
router.use(securityHeaders);
router.use(createRateLimitMiddleware(60, 15 * 60 * 1000)); // 60 requests per 15 minutes

const ASK_TEXT_FIELDS = ['prompt', 'userInput', 'content', 'text', 'query'] as const;

// Enhanced validation schema for ask requests that accepts multiple text field aliases
const askValidationSchema = {
  prompt: { type: 'string' as const, minLength: 1, maxLength: 10000, sanitize: true },
  userInput: { type: 'string' as const, minLength: 1, maxLength: 10000, sanitize: true },
  content: { type: 'string' as const, minLength: 1, maxLength: 10000, sanitize: true },
  text: { type: 'string' as const, minLength: 1, maxLength: 10000, sanitize: true },
  query: { type: 'string' as const, minLength: 1, maxLength: 10000, sanitize: true },
  model: { type: 'string' as const, maxLength: 100, sanitize: true },
  temperature: { type: 'number' as const },
  max_tokens: { type: 'number' as const },
  clientContext: { type: 'object' as const },
  sessionId: { type: 'string' as const, maxLength: 100, sanitize: true },
  overrideAuditSafe: { type: 'string' as const, maxLength: 50, sanitize: true },
  metadata: { type: 'object' as const }
};

/**
 * Validate and sanitize ask request payloads.
 *
 * @param req - Express request.
 * @param res - Express response used for validation errors.
 * @param next - Express next handler.
 * @edgeCases Rejects requests missing any supported text field aliases.
 */
export const askValidationMiddleware = (req: Request, res: Response, next: () => void) => {
  const rawSource = req.method === 'GET' ? req.query : req.body;
  const source =
    req.method === 'GET'
      ? Object.fromEntries(
          Object.entries(rawSource).map(([key, value]) => [key, Array.isArray(value) ? value[0] : value])
        )
      : rawSource;

  const validation = validateInput(source, askValidationSchema);

  if (!validation.isValid) {
    //audit Assumption: validation errors are safe to expose; risk: leaking schema expectations; invariant: only validation errors returned; handling: standardized payload.
    return res.status(400).json(buildValidationErrorResponse(validation.errors));
  }

  const hasTextField = ASK_TEXT_FIELDS.some(field => {
    const value = validation.sanitized[field];
    return typeof value === 'string' && value.trim().length > 0;
  });

  if (!hasTextField) {
    //audit Assumption: a text payload is required; risk: rejecting valid requests; invariant: at least one text field must be present; handling: return accepted fields.
    return res
      .status(400)
      .json(
        buildValidationErrorResponse([`Request must include one of ${ASK_TEXT_FIELDS.join(', ')} fields`], {
          acceptedFields: ASK_TEXT_FIELDS,
          maxLength: 10000
        })
      );
  }

  req.body = validation.sanitized;
  next();
};

export type AskRequest = AIRequestDTO & {
  prompt: string;
  sessionId?: string;
  overrideAuditSafe?: string;
  clientContext?: ClientContextDTO;
};

export interface AskResponse extends AIResponseDTO {
  routingStages?: string[];
  gpt5Used?: boolean;
  auditSafe?: {
    mode: boolean;
    overrideUsed: boolean;
    overrideReason?: string;
    auditFlags: string[];
    processedSafely: boolean;
  };
  memoryContext?: {
    entriesAccessed: number;
    contextSummary: string;
    memoryEnhanced: boolean;
  };
  taskLineage?: {
    requestId: string;
    logged: boolean;
  };
  clientContext?: ClientContextDTO;
}

type DaemonMetadata = {
  source?: string;
  instanceId?: string;
};

const DAEMON_TOOLS: OpenAI.Chat.Completions.ChatCompletionTool[] = [
  {
    type: 'function',
    function: {
      name: 'run_command',
      description: 'Run a command on the user machine via the connected daemon.',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'The command to execute.' }
        },
        required: ['command']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'capture_screen',
      description: 'Capture and analyze the user screen or camera via the connected daemon.',
      parameters: {
        type: 'object',
        properties: {
          use_camera: { type: 'boolean', description: 'Set true to use the camera instead of the screen.' }
        }
      }
    }
  }
];

const DAEMON_TOOL_SYSTEM_PROMPT = [
  'A daemon is connected to the user machine.',
  'When the user asks to run a command, call run_command with the command string.',
  'When the user asks to see the screen or camera, call capture_screen with use_camera true for camera, false otherwise.',
  'If neither is requested, respond normally without tool calls.'
].join(' ');

function extractDaemonMetadata(metadata?: Record<string, unknown>): DaemonMetadata {
  if (!metadata || typeof metadata !== 'object') {
    //audit Assumption: metadata optional; risk: missing daemon linkage; invariant: undefined fields; handling: return empty.
    return {};
  }

  const source = typeof metadata.source === 'string' ? metadata.source : undefined;
  const instanceId = typeof metadata.instanceId === 'string' ? metadata.instanceId : undefined;
  return { source, instanceId };
}

async function tryDispatchDaemonTools(
  client: OpenAI,
  prompt: string,
  metadata?: Record<string, unknown>
): Promise<AskResponse | null> {
  const { source, instanceId } = extractDaemonMetadata(metadata);

  if (source !== 'daemon' || !instanceId) {
    //audit Assumption: daemon tools only when daemon-linked; risk: unintended commands; invariant: daemon metadata required; handling: skip.
    return null;
  }

  const model = getDefaultModel();
  const tokenParams = getTokenParameter(model, 256);

  const response = await client.chat.completions.create({
    model,
    messages: [
      { role: 'system', content: DAEMON_TOOL_SYSTEM_PROMPT },
      { role: 'user', content: prompt }
    ],
    tools: DAEMON_TOOLS,
    tool_choice: 'auto',
    ...tokenParams
  });

  const toolCalls = response.choices[0]?.message?.tool_calls ?? [];
  if (!toolCalls.length) {
    //audit Assumption: no tool calls means standard chat path; risk: missed tool action; invariant: fall back to trinity; handling: return null.
    return null;
  }

  const queuedIds: string[] = [];
  let toolErrors = 0;

  for (const call of toolCalls) {
    if (call.type !== 'function' || !call.function?.name) {
      //audit Assumption: tool calls should be functions; risk: unexpected tool type; invariant: skip invalid; handling: count error.
      toolErrors += 1;
      continue;
    }

    const toolName = call.function.name;
    const rawArgs = call.function.arguments || '{}';
    let args: Record<string, unknown> = {};
    try {
      args = JSON.parse(rawArgs) as Record<string, unknown>;
    } catch {
      //audit Assumption: tool args must be JSON; risk: invalid payload; invariant: skip invalid; handling: count error.
      toolErrors += 1;
      continue;
    }

    if (toolName === 'run_command') {
      const command = typeof args.command === 'string' ? args.command.trim() : '';
      if (!command) {
        //audit Assumption: command required; risk: empty execution; invariant: skip; handling: count error.
        toolErrors += 1;
        continue;
      }
      const commandId = queueDaemonCommandForInstance(instanceId, 'run', { command });
      if (!commandId) {
        //audit Assumption: missing token prevents queueing; risk: orphan instanceId; invariant: skip; handling: count error.
        toolErrors += 1;
        continue;
      }
      queuedIds.push(commandId);
      continue;
    }

    if (toolName === 'capture_screen') {
      const useCamera = Boolean(args.use_camera);
      const commandId = queueDaemonCommandForInstance(instanceId, 'see', { use_camera: useCamera });
      if (!commandId) {
        //audit Assumption: missing token prevents queueing; risk: orphan instanceId; invariant: skip; handling: count error.
        toolErrors += 1;
        continue;
      }
      queuedIds.push(commandId);
      continue;
    }

    //audit Assumption: unknown tool names should be ignored; risk: unsupported calls; invariant: skip; handling: count error.
    toolErrors += 1;
  }

  let resultText = '';
  if (queuedIds.length > 0) {
    //audit Assumption: queued commands should be acknowledged; risk: user uncertainty; invariant: confirmation returned; handling: summarize queue.
    const plural = queuedIds.length === 1 ? 'action' : 'actions';
    resultText = `Queued ${queuedIds.length} daemon ${plural}.`;
    if (toolErrors > 0) {
      resultText += ' Some requests could not be queued.';
    }
  } else {
    //audit Assumption: zero queued actions is a failure; risk: silent no-op; invariant: user notified; handling: return fallback text.
    resultText = 'Unable to queue daemon actions. Please try again.';
  }

  const usage = response.usage;
  const tokens = usage
    ? {
        prompt_tokens: usage.prompt_tokens,
        completion_tokens: usage.completion_tokens,
        total_tokens: usage.total_tokens
      }
    : undefined;
  const responseId = response.id || `daemon-tool-${Date.now()}`;
  const created = typeof response.created === 'number' ? response.created : Date.now();

  return {
    result: resultText,
    module: 'daemon-tools',
    activeModel: response.model,
    fallbackFlag: false,
    meta: {
      tokens,
      id: responseId,
      created
    }
  };
}

/**
 * Shared handler for both ask and brain endpoints
 * Handles AI request processing with standardized error handling and validation
 */
export const handleAIRequest = async (
  req: Request<{}, AskResponse | ErrorResponseDTO, AskRequest>,
  res: Response<AskResponse | ErrorResponseDTO>,
  endpointName: string
) => {
  const { sessionId, overrideAuditSafe, metadata } = req.body;

  // Use shared validation logic
  const validation = validateAIRequest(req, res, endpointName);
  if (!validation) return; // Response already sent

  const { client: openai, input: prompt } = validation;

  console.log(`[📨 ${endpointName.toUpperCase()}] Processing with sessionId: ${sessionId || 'none'}, auditOverride: ${overrideAuditSafe || 'none'}`);

  // Log request for feedback loop
  logRequestFeedback(prompt, endpointName);

  try {
    const daemonToolResponse = await tryDispatchDaemonTools(openai, prompt, metadata);
    if (daemonToolResponse) {
      //audit Assumption: daemon tool response is terminal; risk: skipping trinity; invariant: tool actions queued; handling: return early.
      return res.json({ ...daemonToolResponse, clientContext: req.body.clientContext });
    }

    // runThroughBrain now unconditionally routes through GPT-5.1 before final ARCANOS processing
    const output = await runThroughBrain(openai, prompt, sessionId, overrideAuditSafe);
    return res.json({ ...(output as AskResponse), clientContext: req.body.clientContext });
  } catch (err) {
    handleAIError(err, prompt, endpointName, res);
  }
};

// Primary ask endpoint routed through the Trinity brain (no confirmation required)
router.post('/ask', askValidationMiddleware, asyncHandler((req, res) => handleAIRequest(req, res, 'ask')));
router.get('/ask', askValidationMiddleware, asyncHandler((req, res) => handleAIRequest(req, res, 'ask')));

// Brain endpoint (alias for ask with same functionality) still requires confirmation
router.post('/brain', askValidationMiddleware, confirmGate, asyncHandler((req, res) => handleAIRequest(req, res, 'brain')));
router.get('/brain', askValidationMiddleware, confirmGate, asyncHandler((req, res) => handleAIRequest(req, res, 'brain')));

export default router;
