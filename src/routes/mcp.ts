import express, { type Request, type Response } from 'express';
import { mcpAuthMiddleware } from '../mcp/auth.js';
import {
  buildMcpRequestContext,
  createMcpRequestContextProxy,
  runWithMcpRequestContext,
} from '../mcp/context.js';
import { resolveErrorMessage } from '@core/lib/errors/index.js';

const router = express.Router();

// The MCP transport handler needs raw JSON body.
router.use(express.json({ limit: process.env.MCP_HTTP_BODY_LIMIT ?? '1mb' }));
router.use(mcpAuthMiddleware);

let sharedMcpServerPromise: Promise<{ server: any; transport: any }> | null = null;

async function getSharedMcpServer() {
  if (!sharedMcpServerPromise) {
    sharedMcpServerPromise = (async () => {
      const proxyContext = createMcpRequestContextProxy();
      const { buildMcpServer } = await import('../mcp/server.js');
      return buildMcpServer(proxyContext);
    })().catch((error) => {
      sharedMcpServerPromise = null;
      throw error;
    });
  }

  return sharedMcpServerPromise;
}

router.post('/mcp', async (req: Request, res: Response) => {
  try {
    const ctx = buildMcpRequestContext(req);
    const { transport } = await getSharedMcpServer();

    await runWithMcpRequestContext(ctx, async () => {
      await transport.handleRequest(req, res, req.body);
    });
  } catch (error) {
    const message = resolveErrorMessage(error);
    res.status(500).json({ error: message });
  }
});

router.get('/mcp', (_req: Request, res: Response) => {
  res.status(405).set('Allow', 'POST').send('Method Not Allowed');
});

export default router;
