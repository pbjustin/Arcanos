import express, { type Request, type Response } from 'express';

import { TRINITY_CORE_DAG_TEMPLATE_NAME } from '@dag/templates.js';
import { arcanosDagRunService } from '@services/arcanosDagRunService.js';
import { generateRequestId } from '@shared/idGenerator.js';
import { isRecord } from '@shared/typeGuards.js';
import {
  classifyDispatchIntent,
  DAG_DISPATCH_CONFIDENCE_THRESHOLD,
  isDagDispatchAction,
  normalizeDispatchAction,
  normalizeDispatchExecutionMode,
  normalizeDispatchGptId,
  normalizeDispatchPrompt,
  normalizeDispatchTarget,
  type DispatchExecutionMode,
  type DispatchTarget,
} from '@shared/dispatch/universalDispatch.js';

import { routeGptRequest, type AskEnvelope } from './_core/gptDispatch.js';

const router = express.Router();
const DEFAULT_DISPATCH_GPT_ID = 'arcanos-core';

type DispatchBody = Record<string, unknown>;
type RequestLogger = {
  error?: (message: string, meta?: Record<string, unknown>) => void;
  info?: (message: string, meta?: Record<string, unknown>) => void;
  warn?: (message: string, meta?: Record<string, unknown>) => void;
};
type DispatchRequestContext = Request & {
  requestId?: string;
  logger?: RequestLogger;
};

function dispatchRequestContext(req: Request): DispatchRequestContext {
  return req as DispatchRequestContext;
}

function readDispatchBody(req: Request): DispatchBody {
  return isRecord(req.body) ? req.body : {};
}

function readPayload(body: DispatchBody): Record<string, unknown> {
  return isRecord(body.payload) ? body.payload : {};
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0
    ? value.trim()
    : null;
}

function readPositiveInteger(value: unknown): number | null {
  if (typeof value === 'number') {
    return Number.isInteger(value) && value > 0 ? value : null;
  }

  if (typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) {
    return null;
  }

  const parsed = Number(trimmed);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function buildGptBody(input: {
  body: DispatchBody;
  action: string;
  prompt: string;
  payload: Record<string, unknown>;
}): Record<string, unknown> {
  const body: Record<string, unknown> = {
    ...input.body,
    action: input.action,
  };

  if (input.prompt) {
    body.prompt = input.prompt;
  }

  if (Object.keys(input.payload).length > 0) {
    body.payload = input.payload;
  }

  delete body.target;
  delete body.gptId;
  return body;
}

function gptStatusCode(envelope: AskEnvelope): number {
  if (envelope.ok) {
    return 200;
  }

  const code = envelope.error.code;
  if (code === 'UNKNOWN_GPT') {
    return 404;
  }
  if (code === 'SYSTEM_STATE_CONFLICT') {
    return 409;
  }
  if (code === 'MODULE_TIMEOUT') {
    return 504;
  }
  return 400;
}

async function runGptDispatch(
  req: Request,
  res: Response,
  input: {
    gptId: string | null;
    action: string;
    prompt: string;
    payload: Record<string, unknown>;
    body: DispatchBody;
    target: DispatchTarget;
    executionMode: DispatchExecutionMode;
    reason: string;
  }
) {
  const gptId = input.gptId ?? DEFAULT_DISPATCH_GPT_ID;
  const requestContext = dispatchRequestContext(req);
  const envelope = await routeGptRequest({
    gptId,
    body: buildGptBody(input),
    requestId: requestContext.requestId,
    logger: requestContext.logger,
    request: req,
    bypassIntentRouting: true,
  });

  return res.status(gptStatusCode(envelope)).json({
    ...envelope,
    target: 'gpt',
    routeFamily: 'dispatch',
    gptId,
    action: input.action,
    executionMode: 'gpt',
    _dispatch: {
      target: input.target,
      executionMode: input.executionMode,
      reason: input.reason,
    },
  });
}

function buildDagInput(prompt: string, payload: Record<string, unknown>): Record<string, unknown> {
  const explicitInput = isRecord(payload.input) ? { ...payload.input } : {};
  const goal = readString(payload.goal) ?? prompt.trim();

  if (goal && !Object.prototype.hasOwnProperty.call(explicitInput, 'goal')) {
    explicitInput.goal = goal;
  }

  return explicitInput;
}

function buildDagOptions(payload: Record<string, unknown>) {
  const explicitOptions = isRecord(payload.options) ? payload.options : {};
  const maxConcurrency = readPositiveInteger(explicitOptions.maxConcurrency ?? payload.maxConcurrency);
  const allowRecursiveSpawning = explicitOptions.allowRecursiveSpawning ?? payload.allowRecursiveSpawning;
  const debug = explicitOptions.debug ?? payload.debug;

  return {
    ...(maxConcurrency !== null
      ? { maxConcurrency }
      : {}),
    ...(typeof allowRecursiveSpawning === 'boolean'
      ? { allowRecursiveSpawning }
      : {}),
    ...(typeof debug === 'boolean' ? { debug } : {}),
  };
}

async function runDagDispatch(
  req: Request,
  res: Response,
  input: {
    gptId: string | null;
    action: string;
    prompt: string;
    payload: Record<string, unknown>;
    target: DispatchTarget;
    executionMode: DispatchExecutionMode;
    reason: string;
  }
) {
  const operation = isDagDispatchAction(input.action) ? input.action : 'dag.run.create';
  if (operation !== 'dag.run.create') {
    return res.status(400).json({
      ok: false,
      code: 'DAG_ACTION_UNSUPPORTED',
      message: `Unsupported DAG dispatch action '${input.action}'.`,
      routeFamily: 'dispatch',
      target: 'dag',
      action: input.action,
    });
  }

  const dagInput = buildDagInput(input.prompt, input.payload);
  const requestContext = dispatchRequestContext(req);
  if (Object.keys(dagInput).length === 0) {
    return res.status(400).json({
      ok: false,
      code: 'DAG_INPUT_REQUIRED',
      message: 'DAG dispatch requires payload.input, payload.goal, or prompt.',
      routeFamily: 'dispatch',
      target: 'dag',
      action: input.action,
    });
  }

  const run = await arcanosDagRunService.createRun({
    sessionId:
      readString(input.payload.sessionId) ??
      requestContext.requestId ??
      generateRequestId('dispatch-dag'),
    template: readString(input.payload.template) ?? TRINITY_CORE_DAG_TEMPLATE_NAME,
    input: dagInput,
    options: buildDagOptions(input.payload),
  });

  return res.status(202).json({
    ok: true,
    target: 'dag',
    routeFamily: 'dispatch',
    gptId: input.gptId,
    action: input.action,
    operation,
    executionMode: 'dag',
    result: { run },
    _dispatch: {
      target: input.target,
      executionMode: input.executionMode,
      reason: input.reason,
    },
  });
}

function rejectMcpDispatch(res: Response, input: {
  target: DispatchTarget;
  action: string;
  executionMode: DispatchExecutionMode;
}) {
  return res.status(400).json({
    ok: false,
    code: 'MCP_CONTROL_REQUIRES_MCP_API',
    message: 'MCP and tool execution must use POST /mcp.',
    routeFamily: 'dispatch',
    target: input.target,
    action: input.action,
    executionMode: input.executionMode,
    canonical: {
      mcp: '/mcp',
    },
  });
}

export async function universalDispatch(req: Request, res: Response): Promise<Response | void> {
  const body = readDispatchBody(req);
  const payload = readPayload(body);
  const target = normalizeDispatchTarget(body.target);
  const gptId = normalizeDispatchGptId(body.gptId);
  const action = normalizeDispatchAction(body.action);
  const executionMode = normalizeDispatchExecutionMode(body.executionMode);
  const prompt = normalizeDispatchPrompt(body.prompt);

  try {
    if (target === 'dag') {
      return runDagDispatch(req, res, {
        gptId,
        action,
        prompt,
        payload,
        target,
        executionMode,
        reason: 'explicit_target_dag',
      });
    }

    if (target === 'gpt') {
      return runGptDispatch(req, res, {
        gptId,
        action,
        prompt,
        payload,
        body,
        target,
        executionMode,
        reason: 'explicit_target_gpt',
      });
    }

    if (target === 'mcp' || target === 'tool') {
      return rejectMcpDispatch(res, { target, action, executionMode });
    }

    if (gptId) {
      return runGptDispatch(req, res, {
        gptId,
        action,
        prompt,
        payload,
        body,
        target,
        executionMode,
        reason: 'explicit_gpt_id',
      });
    }

    if (isDagDispatchAction(action) || executionMode === 'dag') {
      return runDagDispatch(req, res, {
        gptId,
        action,
        prompt,
        payload,
        target,
        executionMode,
        reason: isDagDispatchAction(action) ? 'explicit_dag_action' : 'explicit_execution_mode_dag',
      });
    }

    if (executionMode === 'tool') {
      return rejectMcpDispatch(res, { target: 'tool', action, executionMode });
    }

    if (executionMode === 'gpt') {
      return runGptDispatch(req, res, {
        gptId,
        action,
        prompt,
        payload,
        body,
        target,
        executionMode,
        reason: 'explicit_execution_mode_gpt',
      });
    }

    if (executionMode === 'auto') {
      const decision = classifyDispatchIntent({ prompt, action, payload });
      if (decision.mode === 'dag' && decision.confidence >= DAG_DISPATCH_CONFIDENCE_THRESHOLD) {
        return runDagDispatch(req, res, {
          gptId,
          action,
          prompt,
          payload,
          target,
          executionMode,
          reason: `${decision.reason}:${decision.confidence}`,
        });
      }
    }

    return runGptDispatch(req, res, {
      gptId,
      action,
      prompt,
      payload,
      body,
      target,
      executionMode,
      reason: 'safe_fallback_gpt',
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    dispatchRequestContext(req).logger?.error?.('dispatch.universal.failed', {
      target,
      gptId,
      action,
      executionMode,
      error: message,
    });
    return res.status(500).json({
      ok: false,
      code: 'DISPATCH_FAILED',
      message,
      routeFamily: 'dispatch',
      target,
      action,
      executionMode,
    });
  }
}

router.post('/dispatch', universalDispatch);

export default router;
