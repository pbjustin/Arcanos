import express, { type Request, type Response } from 'express';
import { mcpAuthMiddleware } from '../mcp/auth.js';
import {
  buildMcpRequestContext,
  createMcpRequestContextProxy,
  runWithMcpRequestContext,
} from '../mcp/context.js';
import {
  createRateLimitMiddleware,
  getRequestActorKey
} from '@platform/runtime/security.js';
import { sendInternalErrorPayload } from '@shared/http/index.js';
import { apiLogger } from '@platform/logging/structuredLogging.js';

const router = express.Router();
const mcpHttpRateLimit = createRateLimitMiddleware({
  bucketName: 'mcp-http',
  maxRequests: 300,
  windowMs: 15 * 60 * 1000,
  keyGenerator: (req) => `${getRequestActorKey(req)}:transport:http`
});

function safeThrownClass(error: unknown): string {
  if (error instanceof TypeError) return 'TypeError';
  if (error instanceof RangeError) return 'RangeError';
  if (error instanceof SyntaxError) return 'SyntaxError';
  if (error instanceof Error) return 'Error';
  if (error === null) return 'ThrownNull';
  if (error === undefined) return 'ThrownUndefined';
  if (typeof error === 'string') return 'ThrownString';
  if (typeof error === 'number') return 'ThrownNumber';
  if (typeof error === 'boolean') return 'ThrownBoolean';
  return 'ThrownObject';
}

function logMcpTransportFailure(req: Request, error: unknown): void {
  try {
    apiLogger.error('MCP transport failed', {
      module: 'mcp',
      errorCode: 'MCP_OPERATION_FAILED',
      operation: 'mcp.http.request',
      errorClass: safeThrownClass(error),
      requestId: req.requestId ?? 'unknown',
      traceId: req.traceId ?? req.requestId ?? 'unknown',
      retryable: false,
    });
  } catch {
    // Diagnostics must not mask the stable transport response.
  }
}

// The MCP transport handler needs raw JSON body.
router.use(express.json({ limit: process.env.MCP_HTTP_BODY_LIMIT ?? '1mb' }));

/**
 * Build an isolated MCP server/transport pair for a single HTTP request.
 *
 * Purpose: avoid cross-request transport state leakage in streamable HTTP mode.
 * Inputs/outputs: no inputs; returns a new MCP server + transport pair.
 * Edge cases: throws import/build errors to caller for standardized error handling.
 */
async function buildMcpServerForRequest() {
  const proxyContext = createMcpRequestContextProxy();
  const { buildMcpServer } = await import('../mcp/server.js');
  return buildMcpServer(proxyContext);
}

router.post('/mcp', mcpAuthMiddleware, mcpHttpRateLimit, async (req: Request, res: Response) => {
  try {
    const ctx = buildMcpRequestContext(req);
    //audit Assumption: streamable transport instances are request-scoped; risk: shared transport state causes subsequent MCP calls to fail; invariant: each request gets a fresh transport; handling: build isolated server/transport pair per request.
    const { transport } = await buildMcpServerForRequest();

    await runWithMcpRequestContext(ctx, async () => {
      await transport.handleRequest(req, res, req.body);
    });
  } catch (error) {
    logMcpTransportFailure(req, error);
    if (!res.headersSent) {
      sendInternalErrorPayload(res, {
        error: 'MCP_OPERATION_FAILED',
        message: 'MCP operation failed.',
      });
    }
  }
});

router.get('/mcp', (_req: Request, res: Response) => {
  res.status(405).set('Allow', 'POST').send('Method Not Allowed');
});

export default router;
