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
import { resolveErrorMessage } from '@core/lib/errors/index.js';
import { sendInternalErrorPayload } from '@shared/http/index.js';

const router = express.Router();
const mcpHttpRateLimit = createRateLimitMiddleware({
  bucketName: 'mcp-http',
  maxRequests: 300,
  windowMs: 15 * 60 * 1000,
  keyGenerator: (req) => `${getRequestActorKey(req)}:transport:http`
});

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
    const message = resolveErrorMessage(error);
    sendInternalErrorPayload(res, { error: message });
  }
});

router.get('/mcp', (_req: Request, res: Response) => {
  res.status(405).set('Allow', 'POST').send('Method Not Allowed');
});

export default router;
