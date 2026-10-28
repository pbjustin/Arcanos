import { IncomingMessage, ServerResponse } from 'node:http';
import { Socket } from 'node:net';
import express, { type Request, type Response } from 'express';
import { getRequestAbortSignal } from '@arcanos/runtime';
import { type ChatGptPrincipal } from './auth.js';
import { bookerPrincipalActorKey, hasBookerPermission } from './bookerAuth.js';
import {
  establishBookerMcpRequestAuthentication, clearBookerMcpRequestAuthentication,
  type BookerGptAction,
} from './bookerRequestAuth.js';

export type { BookerGptAction } from './bookerRequestAuth.js';
export interface BookerGptResult { statusCode: number; result: Record<string, unknown> }
export interface BookerGptOptions { requestId?: string; traceId?: string; idempotencyKey?: string; logger?: Request['logger'] }

const actions = new Set<BookerGptAction>(['queryContinuity', 'generateBooking', 'generateBookingWithHRC', 'simulateMatch']);
const RESPONSE_LIMIT_BYTES = 4 * 1024 * 1024;


/**
 * Reuse the canonical four-action HTTP execution chain in process. No listener,
 * HTTP request, legacy credential, arbitrary path, or module selector is used.
 */
export async function invokeBookerGptAction(principal: ChatGptPrincipal, action: BookerGptAction,
  payload: Record<string, unknown>, options: BookerGptOptions = {}): Promise<BookerGptResult> {
  if (!actions.has(action) || typeof payload.universeId !== 'string'
    || !hasBookerPermission(principal, action !== 'queryContinuity', payload.universeId)) {
    throw new Error('BOOKER_PERMISSION_DENIED');
  }
  const signal = getRequestAbortSignal();
  signal?.throwIfAborted();
  const { default: router } = await import('../routes/gptRouter.js');
  signal?.throwIfAborted();
  const body = Object.freeze({ action, payload: structuredClone(payload), executionMode: 'sync' });
  const socket = new Socket();
  const request = new IncomingMessage(socket) as Request;
  request.method = 'POST';
  request.url = '/gpt/backstage-booker';
  request.headers = { 'content-type': 'application/json' };
  if (options.idempotencyKey) request.headers['idempotency-key'] = options.idempotencyKey;
  request.body = body;
  request.requestId = options.requestId;
  request.traceId = options.traceId;
  request.logger = options.logger;
  request.authenticatedActorKey = bookerPrincipalActorKey(principal, payload.universeId);
  establishBookerMcpRequestAuthentication(request, principal);
  const response = new ServerResponse(request);
  const app = express();
  app.disable('x-powered-by');
  app.use('/gpt', router);
  try {
    return await new Promise<BookerGptResult>((resolve, reject) => {
      let settled = false;
      const chunks: Buffer[] = [];
      let size = 0;
      const finish = (error?: unknown, result?: BookerGptResult) => {
        if (settled) return;
        settled = true;
        signal?.removeEventListener('abort', abort);
        if (error) reject(error); else resolve(result!);
      };
      const append = (chunk: unknown, encoding?: unknown) => {
        if (chunk === undefined || chunk === null) return;
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), typeof encoding === 'string' ? encoding as BufferEncoding : 'utf8');
        size += bytes.length;
        if (size > RESPONSE_LIMIT_BYTES) throw new Error('BOOKER_OUTPUT_INVALID');
        chunks.push(bytes);
      };
      const abort = () => {
        request.emit('aborted');
        response.emit('close');
        finish(new Error('BOOKER_ABORTED'));
      };
      response.write = ((chunk: unknown, encoding?: unknown) => {
        try { append(chunk, encoding); return true; } catch (error) { finish(error); return false; }
      }) as typeof response.write;
      response.end = ((chunk?: unknown, encoding?: unknown, callback?: () => void) => {
        try {
          append(chunk, encoding);
          const result: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error('BOOKER_OUTPUT_INVALID');
          response.finished = true;
          response.emit('finish');
          finish(undefined, { statusCode: response.statusCode, result: result as Record<string, unknown> });
          if (typeof callback === 'function') callback();
        } catch (error) { finish(error); }
        return response;
      }) as typeof response.end;
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) { abort(); return; }
      app(request, response as Response, (error?: unknown) => finish(error ?? new Error('BOOKER_ROUTE_UNAVAILABLE')));
    });
  } finally {
    // An aborted backend operation may still be draining. Keep its protected
    // lane marker until completion or garbage collection, never downgrade it.
    if (response.finished) clearBookerMcpRequestAuthentication(request);
    socket.destroy();
  }
}
