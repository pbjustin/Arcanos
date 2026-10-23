import express, { type RequestHandler } from 'express';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema, type Tool } from '@modelcontextprotocol/sdk/types.js';
import { getRequestAbortSignal, getRequestRemainingMs, runWithRequestAbortTimeout } from '@arcanos/runtime';
import { createClientDisconnectAbortScope } from '@shared/http/clientDisconnectAbort.js';
import { createRateLimitMiddleware } from '@platform/runtime/security.js';
import { config as runtimeConfig } from '@platform/runtime/config.js';
import { publicProviderRateLimit, resolvePublicProviderClientIdentity } from '@transport/http/middleware/publicProviderAdmission.js';
import {
  BOOKER_MCP_PATH, BOOKER_METADATA_PATH, bookerMcpTools, isBookerMcpToolName,
  isBookerMcpInput, isBookerMcpOutput, requiresBookerGenerationPermission,
} from '@shared/chatgpt/bookerMcpContract.js';
import { hasUnsafeBlockingConditions } from '@services/safety/runtimeState.js';
import {
  createBookerTokenVerifier, bookerAuthChallenge, bookerPrincipalActorKey, bookerProtectedResourceMetadata,
  hasBookerPermission, readBookerAuthConfiguration, type BookerAuthConfiguration,
} from '../chatgpt/bookerAuth.js';
import type { ChatGptPrincipal } from '../chatgpt/auth.js';
import { executeBookerMcp, BookerMcpError } from '../chatgpt/booker.js';
import { runWithBookerMcpProviderAdmission } from '../chatgpt/bookerRequestAuth.js';

const providerTools = new Set(['queryContinuity', 'generateBooking', 'generateBookingWithHRC', 'simulateMatch']);
const BOOKER_OPERATION_TIMEOUT_MS = 60_000;

/** Dedicated Booker transport; no generic dispatch or legacy bearer bridge. */
export function createChatGptBookerMcpRouter(options: {
  configuration?: BookerAuthConfiguration;
  verification?: Parameters<typeof createBookerTokenVerifier>[1];
  execute?: typeof executeBookerMcp;
  providerAdmission?: RequestHandler;
  timeoutMs?: number;
} = {}) {
  const router = express.Router();
  const configuration = options.configuration ?? readBookerAuthConfiguration();
  const verify = configuration.status === 'ready' ? createBookerTokenVerifier(configuration, options.verification) : undefined;
  const execute = options.execute ?? executeBookerMcp;
  const providerAdmission = options.providerAdmission ?? publicProviderRateLimit;
  const principals = new WeakMap<express.Request, ChatGptPrincipal>();
  const providerAdmittedRequests = new WeakSet<express.Request>();
  const ipLimit = createRateLimitMiddleware({ bucketName: 'chatgpt-booker-client', maxRequests: 120, windowMs: 60_000,
    keyGenerator: req => resolvePublicProviderClientIdentity(req, { trustRailwayRealIp: runtimeConfig.limits.publicProviderTrustRailwayRealIp }) });
  const principalLimit = createRateLimitMiddleware({ bucketName: 'chatgpt-booker-owner', maxRequests: 30, windowMs: 60_000,
    keyGenerator: req => bookerPrincipalActorKey(principals.get(req)!) });
  router.get(BOOKER_METADATA_PATH, (_req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    if (configuration.status !== 'ready') {
      res.status(configuration.status === 'disabled' ? 404 : 503).json({ error: 'BOOKER_INTEGRATION_UNAVAILABLE' }); return;
    }
    res.json(bookerProtectedResourceMetadata(configuration));
  });
  const authenticate: RequestHandler = async (req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Pragma', 'no-cache');
    if (configuration.status !== 'ready' || !verify) {
      res.status(configuration.status === 'disabled' ? 404 : 503).json({ error: 'BOOKER_INTEGRATION_UNAVAILABLE' }); return;
    }
    const origin = req.header('origin');
    if (origin && origin !== new URL(configuration.resource).origin) {
      res.status(403).json({ error: 'BOOKER_ORIGIN_DENIED' }); return;
    }
    const headers = req.rawHeaders.filter((_, index) => index % 2 === 0).filter(value => value.toLowerCase() === 'authorization');
    const result = await verify(headers.length > 1 ? undefined : req.header('authorization'));
    if (!result.ok) {
      res.setHeader('WWW-Authenticate', bookerAuthChallenge(configuration, false, result.error));
      res.status(result.status).json({ error: 'BOOKER_AUTHORIZATION_REQUIRED' }); return;
    }
    principals.set(req, result.principal);
    req.authenticatedActorKey = bookerPrincipalActorKey(result.principal);
    next();
  };
  router.all(BOOKER_MCP_PATH, ipLimit, authenticate, principalLimit);
  const parse = express.json({ limit: 262_144, strict: true, inflate: false });
  const boundedParser: RequestHandler = (req, res, next) => {
    if (!req.is('application/json')) { res.status(415).json({ error: 'BOOKER_REQUEST_INVALID' }); return; }
    parse(req, res, error => {
      if (!error) { next(); return; }
      res.status(error.status === 413 ? 413 : 400).json({ error: 'BOOKER_REQUEST_INVALID' });
    });
  };
  const admitProvider: RequestHandler = (req, res, next) => {
    if (Array.isArray(req.body)) { res.status(400).json({ error: 'BOOKER_BATCH_UNSUPPORTED' }); return; }
    const name = req.body?.params?.name;
    const principal = principals.get(req)!;
    if (req.body?.method !== 'tools/call' || !providerTools.has(name) || !isBookerMcpToolName(name)
      || !isBookerMcpInput(name, req.body?.params?.arguments)
      || !hasBookerPermission(principal, requiresBookerGenerationPermission(name), req.body.params.arguments.universeId)) {
      next(); return;
    }
    if (hasUnsafeBlockingConditions()) { res.status(503).json({ error: 'BOOKER_UNAVAILABLE' }); return; }
    providerAdmission(req, res, error => {
      if (error) { res.status(503).json({ error: 'BOOKER_UNAVAILABLE' }); return; }
      providerAdmittedRequests.add(req);
      next();
    });
  };
  router.post(BOOKER_MCP_PATH, boundedParser, admitProvider, async (req, res) => {
    const principal = principals.get(req)!;
    const disconnect = createClientDisconnectAbortScope(req, res, 'Booker client disconnected.');
    const server = new Server({ name: 'arcanos-backstage-booker-private', version: '1.0.0' }, {
      capabilities: { tools: {} },
      instructions: 'Use only these seven Booker tools for the exact authorized universe. Preserve Kay "Spotlight" Morales and the existing CLEAR policy. Protected generation requires current complete backend authority. Continuity retrieval preserves backend snapshot freshness, completeness, and coverage, including explicitly marked last-known-good reads. Never invent canon or replace a protected failure with local generation. Preserve accepted jobId and poll getBackstageBookerJobResult while pending; never resubmit generation after acceptance. Retry an initial transport failure without jobId only once with the identical request/idempotency key. No canon writing tools are available.',
    });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: bookerMcpTools.filter(tool => hasBookerPermission(principal, requiresBookerGenerationPermission(tool.name))) as Tool[],
    }));
    server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
      const name = request.params.name;
      if (!isBookerMcpToolName(name)) return { isError: true, content: [{ type: 'text', text: 'BOOKER_TOOL_UNAVAILABLE' }] };
      const generation = requiresBookerGenerationPermission(name);
      if (!hasBookerPermission(principal, generation)) return { isError: true,
        content: [{ type: 'text', text: 'BOOKER_PERMISSION_DENIED' }],
        _meta: { 'mcp/www_authenticate': configuration.status === 'ready'
          ? [bookerAuthChallenge(configuration, generation, 'insufficient_scope')] : [] } };
      if (!isBookerMcpInput(name, request.params.arguments)) return { isError: true, content: [{ type: 'text', text: 'BOOKER_INPUT_INVALID' }] };
      if (!hasBookerPermission(principal, generation, request.params.arguments.universeId)) {
        return { isError: true, content: [{ type: 'text', text: 'BOOKER_UNIVERSE_DENIED' }] };
      }
      if (providerTools.has(name) && hasUnsafeBlockingConditions()) {
        return { isError: true, content: [{ type: 'text', text: 'BOOKER_UNAVAILABLE' }] };
      }
      const inheritedSignal = getRequestAbortSignal();
      const signal = AbortSignal.any([disconnect.signal, extra.signal, ...(inheritedSignal ? [inheritedSignal] : [])]);
      const operationCapMs = name === 'getBackstageBookerJobResult' ? 35_000 : BOOKER_OPERATION_TIMEOUT_MS;
      const timeoutMs = Math.min(operationCapMs, Math.max(1, options.timeoutMs ?? operationCapMs),
        getRequestRemainingMs() ?? operationCapMs, principal.expiresAt * 1_000 - Date.now());
      if (timeoutMs <= 0) return { isError: true, content: [{ type: 'text', text: 'BOOKER_TIMEOUT' }] };
      let aborted = false;
      try {
        const invoke = () => execute(principal, name, request.params.arguments, { requestId: req.requestId, traceId: req.traceId, logger: req.logger });
        const output = await runWithRequestAbortTimeout({ timeoutMs, parentSignal: signal,
          abortMessage: 'Booker request timed out.', onAbort: () => { aborted = true; } },
        () => providerAdmittedRequests.has(req) ? runWithBookerMcpProviderAdmission(invoke) : invoke());
        if (!isBookerMcpOutput(name, output)) throw new BookerMcpError('BOOKER_OUTPUT_INVALID');
        return { structuredContent: { ...output }, content: [{ type: 'text', text: JSON.stringify(output) }],
          ...(output.statusCode >= 400 ? { isError: true } : {}) };
      } catch (error) {
        const code = aborted ? signal.aborted ? 'BOOKER_CANCELLED' : 'BOOKER_TIMEOUT'
          : error instanceof BookerMcpError ? error.code : 'BOOKER_UNAVAILABLE';
        return { isError: true, content: [{ type: 'text', text: code }] };
      }
    });
    res.once('close', () => { disconnect.cleanup(); void server.close().catch(() => {}); });
    try { await server.connect(transport); await transport.handleRequest(req, res, req.body); }
    catch { if (!res.headersSent) res.status(500).json({ error: 'BOOKER_REQUEST_FAILED' }); }
  });
  router.all(BOOKER_MCP_PATH, (_req, res) => { res.status(405).set('Allow', 'POST').json({ error: 'BOOKER_METHOD_UNSUPPORTED' }); });
  return router;
}
