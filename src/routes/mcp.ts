import express, { type Request, type Response } from 'express';
import { mcpAuthMiddleware } from '../mcp/auth.js';
import { buildMcpRequestContext } from '../mcp/context.js';
import { resolveErrorMessage } from '@core/lib/errors/index.js';

const router = express.Router();

// The MCP transport handler needs raw JSON body.
router.use(express.json({ limit: process.env.MCP_HTTP_BODY_LIMIT ?? '1mb' }));
router.use(mcpAuthMiddleware);

router.post('/mcp', async (req: Request, res: Response) => {
  try {
    const ctx = buildMcpRequestContext(req);
    const { server, transport } = await (await import('../mcp/server.js')).buildMcpServer(ctx);

    await transport.handleRequest(req, res, req.body);

    res.on('close', () => {
      try { transport.close(); } catch {}
      try { server.close(); } catch {}
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

