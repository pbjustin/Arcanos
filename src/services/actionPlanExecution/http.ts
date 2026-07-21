import type { Request, Response } from 'express';
import {
  ACTION_PLAN_EXECUTION_ERRORS,
  ActionPlanExecutionError,
  isActionPlanExecutionError,
} from './errors.js';

export const ACTION_PLAN_EXECUTION_BODY_LIMIT = '64kb';
export const ACTION_PLAN_EXECUTION_BODY_LIMIT_BYTES = 64 * 1024;
export const ACTION_PLAN_IDEMPOTENCY_KEY_MAX_LENGTH = 256;

const IDEMPOTENCY_KEY_PATTERN = /^[\x21-\x7e]{1,256}$/u;

export function isActionPlanExecutionBoundedBodyRoute(method: string, path: string): boolean {
  if (method.toUpperCase() !== 'POST') return false;
  return /^\/action-plan-executions\/claim-next\/?$/u.test(path)
    || /^\/plans\/?$/u.test(path)
    || /^\/plans\/[^/]+\/(?:approve|block|expire|execute)\/?$/u.test(path)
    || /^\/plans\/[^/]+\/executions\/[^/]+\/(?:claim|start|result)\/?$/u.test(path)
    || /^\/agents(?:\/register)?\/?$/u.test(path)
    || /^\/agents\/[^/]+\/(?:heartbeat|capabilities\/grant)\/?$/u.test(path);
}

function countRawHeaders(req: Request, headerName: string): number {
  const rawHeaders = Array.isArray(req.rawHeaders) ? req.rawHeaders : [];
  let count = 0;
  for (let index = 0; index < rawHeaders.length; index += 2) {
    if (String(rawHeaders[index]).toLowerCase() === headerName.toLowerCase()) count += 1;
  }
  return count;
}

export function readActionPlanIdempotencyKey(req: Request): string {
  if (countRawHeaders(req, 'idempotency-key') > 1) {
    throw new ActionPlanExecutionError(ACTION_PLAN_EXECUTION_ERRORS.requestInvalid);
  }
  const value = req.header('idempotency-key');
  if (typeof value !== 'string' || !IDEMPOTENCY_KEY_PATTERN.test(value)) {
    throw new ActionPlanExecutionError(ACTION_PLAN_EXECUTION_ERRORS.requestInvalid);
  }
  return value;
}

export function setActionPlanNoStore(res: Response): void {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Pragma', 'no-cache');
}

/** Return a stable operation label without including plan, run, or agent identifiers. */
export function actionPlanRateLimitOperation(req: Request): string {
  const method = req.method.toUpperCase();
  const path = req.originalUrl.split('?', 1)[0] || req.path;
  if (/^\/action-plan-executions\/protocol\/?$/u.test(path)) return `${method}:protocol`;
  if (/^\/action-plan-executions\/claim-next\/?$/u.test(path)) return `${method}:claim-next`;
  const execution = /^\/plans\/[^/]+\/executions\/[^/]+(?:\/(claim|start|result))?\/?$/u.exec(path);
  if (execution) return `${method}:execution:${execution[1] ?? 'status'}`;
  if (/^\/clear\/[^/]+\/?$/u.test(path)) return `${method}:plan:clear-score`;
  const plan = /^\/plans(?:\/[^/]+(?:\/(approve|block|expire|execute|results))?)?\/?$/u.exec(path);
  if (plan) return `${method}:plan:${plan[1] ?? (path === '/plans' || path === '/plans/' ? 'collection' : 'item')}`;
  const agent = /^\/agents(?:\/[^/]+(?:\/(heartbeat|capabilities\/grant))?)?\/?$/u.exec(path);
  if (agent) return `${method}:agent:${agent[1] ?? (path === '/agents' || path === '/agents/' ? 'collection' : 'item')}`;
  return `${method}:action-plan-unknown`;
}

export function sendActionPlanExecutionError(
  res: Response,
  error: unknown,
  correlation: { requestId?: string; traceId?: string } = {},
): void {
  setActionPlanNoStore(res);
  const publicError = isActionPlanExecutionError(error)
    ? error
    : new ActionPlanExecutionError(ACTION_PLAN_EXECUTION_ERRORS.persistenceFailed, { retryable: true });
  res.status(publicError.httpStatus).json({
    ok: false,
    error: {
      code: publicError.code,
      message: publicError.message,
    },
    ...(correlation.requestId ? { request_id: correlation.requestId } : {}),
    ...(correlation.traceId ? { trace_id: correlation.traceId } : {}),
  });
}
