import express, { type RequestHandler } from 'express';
import { createHash } from 'node:crypto';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema, type Tool } from '@modelcontextprotocol/sdk/types.js';
import { chatGptTutorInputSchema, chatGptTutorOutputSchema } from '@arcanos/protocol';
import { runWithRequestAbortTimeout } from '@arcanos/runtime';
import { createClientDisconnectAbortScope } from '@shared/http/clientDisconnectAbort.js';
import { createRateLimitMiddleware } from '@platform/runtime/security.js';
import { config as runtimeConfig } from '@platform/runtime/config.js';
import { publicProviderRateLimit, resolvePublicProviderClientIdentity } from '@transport/http/middleware/publicProviderAdmission.js';
import { hasUnsafeBlockingConditions } from '@services/safety/runtimeState.js';
import {
  CHATGPT_MCP_PATH, CHATGPT_RESOURCE_METADATA_PATH, CHATGPT_TUTOR_SCOPE,
  readChatGptAuthConfiguration, createChatGptTokenVerifier,
  buildChatGptProtectedResourceMetadata, buildChatGptAuthChallenge, hasChatGptTutorPermission,
  type ChatGptAuthConfiguration, type ChatGptPrincipal,
} from '../chatgpt/auth.js';
import { executeTutorPilot, isTutorInput, TutorPilotError } from '../chatgpt/tutor.js';

const TOOL_NAME = 'arcanos_tutor';
const TOOL_TIMEOUT_MS = 60_000;
const schema = [{ type: 'oauth2', scopes: [CHATGPT_TUTOR_SCOPE] }];
const tool = {
  name: TOOL_NAME,
  title: 'Ask ARCANOS Tutor',
  description: 'Tutor one learning question through ARCANOS:TUTOR. No backend memory, references, jobs, administrative actions or saved progress. A mock response is explicitly identified in metadata.',
  inputSchema: chatGptTutorInputSchema,
  outputSchema: chatGptTutorOutputSchema,
  securitySchemes: schema,
  _meta: { securitySchemes: schema },
  annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true, idempotentHint: false },
} as Tool;

/** Narrow route is mounted before the global parser; test seams never come from HTTP input. */
export function createChatGptMcpRouter(options: {
  configuration?: ChatGptAuthConfiguration;
  verification?: Parameters<typeof createChatGptTokenVerifier>[1];
  execute?: typeof executeTutorPilot;
  timeoutMs?: number;
  providerAdmission?: RequestHandler;
} = {}) {
  const router = express.Router();
  const config = options.configuration ?? readChatGptAuthConfiguration();
  const verify = config.status === 'ready' ? createChatGptTokenVerifier(config, options.verification) : undefined;
  const execute = options.execute ?? executeTutorPilot;
  const providerAdmission = options.providerAdmission ?? publicProviderRateLimit;
  const timeoutMs = Math.min(TOOL_TIMEOUT_MS, Math.max(1, options.timeoutMs ?? TOOL_TIMEOUT_MS));
  const principals = new WeakMap<express.Request, ChatGptPrincipal>();
  const ipLimit = createRateLimitMiddleware({
    bucketName: 'chatgpt-mcp-client', maxRequests: 120, windowMs: 60_000,
    keyGenerator: req => resolvePublicProviderClientIdentity(req, {
      trustRailwayRealIp: runtimeConfig.limits.publicProviderTrustRailwayRealIp,
    }),
  });
  const principalLimit = createRateLimitMiddleware({
    bucketName: 'chatgpt-mcp-principal', maxRequests: 30, windowMs: 60_000,
    keyGenerator: req => {
      const identity = principals.get(req)!;
      return createHash('sha256').update(JSON.stringify([identity.issuer, identity.subject])).digest('hex');
    },
  });
  router.get(CHATGPT_RESOURCE_METADATA_PATH, (_req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    if (config.status !== 'ready') {
      res.status(config.status === 'disabled' ? 404 : 503).json({ error: 'CHATGPT_INTEGRATION_UNAVAILABLE' });
      return;
    }
    res.json(buildChatGptProtectedResourceMetadata(config));
  });

  const authenticate: RequestHandler = async (req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    if (config.status !== 'ready' || !verify) {
      res.status(config.status === 'disabled' ? 404 : 503).json({ error: 'CHATGPT_INTEGRATION_UNAVAILABLE' });
      return;
    }
    const origin = req.header('origin');
    if (origin && origin !== new URL(config.resource).origin) {
      res.status(403).json({ error: 'CHATGPT_ORIGIN_DENIED' });
      return;
    }
    const auth = await verify(req.header('authorization'));
    if (!auth.ok) {
      res.setHeader('WWW-Authenticate', buildChatGptAuthChallenge(config, auth.error));
      res.status(auth.status).json({ error: 'CHATGPT_AUTHORIZATION_REQUIRED' });
      return;
    }
    principals.set(req, auth.principal);
    next();
  };
  const parse = express.json({ limit: 16_384, strict: true, inflate: false });
  const boundedParser: RequestHandler = (req, res, next) => {
    if (!req.is('application/json')) { res.status(415).json({ error: 'CHATGPT_REQUEST_INVALID' }); return; }
    parse(req, res, error => {
      if (!error) { next(); return; }
      res.status(error.status === 413 ? 413 : 400).json({ error: 'CHATGPT_REQUEST_INVALID' });
    });
  };
  router.all(CHATGPT_MCP_PATH, ipLimit, authenticate, principalLimit);
  const admitExecution: RequestHandler = (req, res, next) => {
    if (Array.isArray(req.body)) {
      res.status(400).json({ error: 'CHATGPT_BATCH_UNSUPPORTED' });
      return;
    }
    if (req.body?.method !== 'tools/call' || req.body?.params?.name !== TOOL_NAME
      || !isTutorInput(req.body?.params?.arguments)) {
      next();
      return;
    }
    if (hasUnsafeBlockingConditions()) {
      res.status(503).json({ error: 'TUTOR_UNAVAILABLE' });
      return;
    }
    // Reuse the deployment-wide provider budget and store readiness boundary.
    // Its errors are projected here rather than exposing diagnostics to clients.
    providerAdmission(req, res, error => {
      if (error) { res.status(503).json({ error: 'TUTOR_UNAVAILABLE' }); return; }
      next();
    });
  };
  router.post(CHATGPT_MCP_PATH, boundedParser, admitExecution, async (req, res) => {
    const principal = principals.get(req)!;
    const disconnect = createClientDisconnectAbortScope(req, res, 'Tutor client disconnected.');
    // Low-level SDK handlers preserve the canonical JSON schemas and per-tool
    // securitySchemes supported by ChatGPT but absent in this SDK's registerTool type.
    const server = new Server({ name: 'arcanos-tutor-pilot', version: '1.0.0' }, {
      capabilities: { tools: {} },
      instructions: 'Only arcanos_tutor is supported. Backend memory and saved progress are unavailable. Do not automatically retry failed generation.',
    });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: hasChatGptTutorPermission(principal) ? [tool] : [],
    }));
    server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
      if (!hasChatGptTutorPermission(principal)) {
        return {
          isError: true, content: [{ type: 'text', text: 'TUTOR_PERMISSION_DENIED' }],
          _meta: { 'mcp/www_authenticate': [buildChatGptAuthChallenge(config as Extract<ChatGptAuthConfiguration, { status: 'ready' }>, 'invalid_token')] },
        };
      }
      if (request.params.name !== TOOL_NAME) {
        return { isError: true, content: [{ type: 'text', text: 'TUTOR_TOOL_UNAVAILABLE' }] };
      }
      if (!isTutorInput(request.params.arguments)) {
        return { isError: true, content: [{ type: 'text', text: 'TUTOR_INPUT_INVALID' }] };
      }
      if (hasUnsafeBlockingConditions()) {
        return { isError: true, content: [{ type: 'text', text: 'TUTOR_UNAVAILABLE' }] };
      }
      const signal = AbortSignal.any([disconnect.signal, extra.signal]);
      let aborted = false;
      try {
        const output = await runWithRequestAbortTimeout({
          timeoutMs, parentSignal: signal, abortMessage: 'Tutor request timed out.',
          onAbort: () => { aborted = true; },
        }, () => execute(principal, request.params.arguments));
        return { structuredContent: { ...output }, content: [{ type: 'text', text: JSON.stringify(output) }] };
      } catch (error) {
        const code = aborted ? (signal.aborted ? 'TUTOR_CANCELLED' : 'TUTOR_TIMEOUT')
          : error instanceof TutorPilotError ? error.code : 'TUTOR_UNAVAILABLE';
        return { isError: true, content: [{ type: 'text', text: code }] };
      }
    });
    res.once('close', () => {
      disconnect.cleanup();
      void server.close().catch(() => {});
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch {
      if (!res.headersSent) res.status(500).json({ error: 'CHATGPT_REQUEST_FAILED' });
    }
  });
  router.all(CHATGPT_MCP_PATH, (_req, res) => {
    res.status(405).set('Allow', 'POST').json({ error: 'CHATGPT_METHOD_UNSUPPORTED' });
  });
  return router;
}
