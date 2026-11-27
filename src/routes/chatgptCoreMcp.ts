import express, { type RequestHandler } from 'express';
import { TextDecoder } from 'node:util';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  CallToolRequestSchema, JSONRPCRequestSchema, ListToolsRequestSchema, SUPPORTED_PROTOCOL_VERSIONS,
} from '@modelcontextprotocol/sdk/types.js';
import { getRequestAbortSignal, getRequestRemainingMs, runWithRequestAbortTimeout } from '@arcanos/runtime/requestAbort';
import { config as runtimeConfig } from '@platform/runtime/config.js';
import { createRateLimitMiddleware } from '@platform/runtime/security.js';
import {
  CORE_MCP_PATH, CORE_METADATA_PATH, CORE_QUERY_SCOPE, CORE_MEMORY_READ_SCOPE, CORE_MEMORY_WRITE_SCOPE,
  coreMcpTools, coreMcpToolScope, isCoreMcpInput, isCoreMcpMutation, isCoreMcpOutput, isCoreMcpToolName, type CoreScope,
} from '@shared/chatgpt/coreMcpContract.js';
import { createClientDisconnectAbortScope } from '@shared/http/clientDisconnectAbort.js';
import { hasUnsafeBlockingConditions } from '@services/safety/runtimeState.js';
import {
  publicProviderRateLimit, resolvePublicProviderClientIdentity,
} from '@transport/http/middleware/publicProviderAdmission.js';
import type { ChatGptPrincipal } from '../chatgpt/auth.js';
import type { executeCoreMcp } from '../chatgpt/core.js';
import {
  coreAuthChallenge, corePrincipalActorKey, coreProtectedResourceMetadata, createCoreTokenVerifier,
  hasCorePermission, readCoreAuthConfiguration, type CoreAuthConfiguration,
} from '../chatgpt/coreAuth.js';

const CORE_OPERATION_TIMEOUT_MS = 35_000;
const fatalUtf8Decoder = new TextDecoder('utf-8', { fatal: true });
const jsonContentType = /^[\t ]*application\/json(?:[\t ]*;[\t ]*charset[\t ]*=[\t ]*(?:utf-8|"utf-8"))?[\t ]*$/i;

function missingSessionScope(principal: ChatGptPrincipal, sessionId: string | undefined): CoreScope | undefined {
  if (sessionId === undefined) return;
  if (!hasCorePermission(principal, CORE_MEMORY_READ_SCOPE)) return CORE_MEMORY_READ_SCOPE;
  if (!hasCorePermission(principal, CORE_MEMORY_WRITE_SCOPE)) return CORE_MEMORY_WRITE_SCOPE;
}

/** The Core resource authenticates every MCP request before allocating or parsing its body. */
export function createChatGptCoreMcpRouter(options: {
  configuration?: CoreAuthConfiguration;
  verification?: Parameters<typeof createCoreTokenVerifier>[1];
  execute?: typeof executeCoreMcp;
  providerAdmission?: RequestHandler;
  isUnsafe?: typeof hasUnsafeBlockingConditions;
  timeoutMs?: number;
} = {}) {
  const router = express.Router({ caseSensitive: true, strict: true });
  const configuration = options.configuration ?? readCoreAuthConfiguration();
  const verify = configuration.status === 'ready' ? createCoreTokenVerifier(configuration, options.verification) : undefined;
  const execute: typeof executeCoreMcp = options.execute
    ?? (async (...args) => (await import('../chatgpt/core.js')).executeCoreMcp(...args));
  const providerAdmission = options.providerAdmission ?? publicProviderRateLimit;
  const isUnsafe = options.isUnsafe ?? hasUnsafeBlockingConditions;
  const principals = new WeakMap<express.Request, ChatGptPrincipal>();
  const providerAdmitted = new WeakSet<express.Request>();
  const clientLimit = createRateLimitMiddleware({
    bucketName: 'chatgpt-core-client', maxRequests: 120, windowMs: 60_000,
    keyGenerator: req => resolvePublicProviderClientIdentity(req, {
      trustRailwayRealIp: runtimeConfig.limits.publicProviderTrustRailwayRealIp,
    }),
  });
  const ownerLimit = createRateLimitMiddleware({
    bucketName: 'chatgpt-core-owner', maxRequests: 30, windowMs: 60_000,
    keyGenerator: req => req.authenticatedActorKey!,
  });
  router.get(CORE_METADATA_PATH, (_req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    if (configuration.status !== 'ready') {
      res.status(configuration.status === 'disabled' ? 404 : 503).json({ error: 'CORE_INTEGRATION_UNAVAILABLE' });
      return;
    }
    res.json(coreProtectedResourceMetadata(configuration));
  });
  const authenticate: RequestHandler = async (req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Pragma', 'no-cache');
    if (configuration.status !== 'ready' || !verify) {
      res.status(configuration.status === 'disabled' ? 404 : 503).json({ error: 'CORE_INTEGRATION_UNAVAILABLE' });
      return;
    }
    const origin = req.header('origin');
    if (origin && origin !== new URL(configuration.resource).origin) {
      res.status(403).json({ error: 'CORE_ORIGIN_DENIED' });
      return;
    }
    const authorization = req.headersDistinct.authorization;
    const result = await verify(authorization?.length === 1 ? authorization[0] : undefined);
    if (!result.ok) {
      res.setHeader('WWW-Authenticate', coreAuthChallenge(configuration, CORE_QUERY_SCOPE, result.error));
      res.status(result.status).json({ error: 'CORE_AUTHORIZATION_REQUIRED' });
      return;
    }
    try {
      req.authenticatedActorKey = corePrincipalActorKey(result.principal);
    } catch {
      res.setHeader('WWW-Authenticate', coreAuthChallenge(configuration, CORE_QUERY_SCOPE, 'invalid_token'));
      res.status(401).json({ error: 'CORE_AUTHORIZATION_REQUIRED' });
      return;
    }
    principals.set(req, result.principal);
    next();
  };
  router.all(CORE_MCP_PATH, clientLimit, authenticate, ownerLimit);

  const parse = express.json({ limit: 196_608, strict: true, inflate: false, verify: (_req, _res, body) => {
    fatalUtf8Decoder.decode(body);
  } });
  const boundedParser: RequestHandler = (req, res, next) => {
    if (!jsonContentType.test(req.get('content-type') ?? '')) {
      res.status(415).json({ error: 'CORE_REQUEST_INVALID' });
      return;
    }
    parse(req, res, error => {
      if (!error) { next(); return; }
      res.status(error.status === 413 ? 413 : error.status === 415 ? 415 : 400).json({ error: 'CORE_REQUEST_INVALID' });
    });
  };

  const admitQuery: RequestHandler = (req, res, next) => {
    if (Array.isArray(req.body)) {
      res.status(400).json({ error: 'CORE_BATCH_UNSUPPORTED' });
      return;
    }
    // The SDK's version error echoes the header. Keep arbitrary header values out of replies.
    const protocol = req.get('mcp-protocol-version');
    if (req.body?.method !== 'initialize' && protocol !== undefined && !SUPPORTED_PROTOCOL_VERSIONS.includes(protocol)) {
      res.status(400).json({ error: 'CORE_PROTOCOL_UNSUPPORTED' });
      return;
    }
    if (req.body?.method === 'tools/call' && !CallToolRequestSchema.safeParse(req.body).success) {
      res.status(400).json({ error: 'CORE_REQUEST_INVALID' });
      return;
    }
    const principal = principals.get(req)!;
    const args: unknown = req.body?.params?.arguments;
    if (req.body?.method !== 'tools/call' || req.body?.params?.name !== 'coreAsk'
      || !JSONRPCRequestSchema.safeParse(req.body).success
      || !hasCorePermission(principal)
      || !isCoreMcpInput('coreAsk', args)
      || missingSessionScope(principal, args.sessionId)) {
      next();
      return;
    }
    if (isUnsafe()) {
      res.status(503).json({ error: 'CORE_UNAVAILABLE' });
      return;
    }
    providerAdmission(req, res, error => {
      if (error) {
        res.status(503).json({ error: 'CORE_UNAVAILABLE' });
        return;
      }
      providerAdmitted.add(req);
      next();
    });
  };

  router.post(CORE_MCP_PATH, boundedParser, admitQuery, async (req, res) => {
    const principal = principals.get(req)!;
    const disconnect = createClientDisconnectAbortScope(req, res, 'Core client disconnected.');
    const server = new Server({ name: 'arcanos-core-private', version: '1.0.0' }, {
      capabilities: { tools: {} },
      instructions: 'Use Core for backend-dependent questions. Preserve the original prompt and the same idempotency key for an uncertain submission. Continue an accepted job by polling getCoreJobResult for that job ID only, up to three times per turn. If still pending, report it as pending. Present a Core answer only after backend completion. Use only an owned Core session for backend memory. Obtain explicit user approval after a memory save challenge before returning its token with the exact original request.',
    });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: coreMcpTools.filter(tool => hasCorePermission(principal, coreMcpToolScope(tool.name))),
    }));
    server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
      const name = request.params.name;
      if (!isCoreMcpToolName(name)) return toolError('CORE_TOOL_UNAVAILABLE');
      const args = request.params.arguments;
      const scope = coreMcpToolScope(name);
      const denied = (neededScope: CoreScope) => ({
        ...toolError('CORE_PERMISSION_DENIED'),
        _meta: {
          'mcp/www_authenticate': configuration.status === 'ready'
            ? [coreAuthChallenge(configuration, neededScope, hasCorePermission(principal) ? 'insufficient_scope' : 'invalid_token')]
            : [],
        },
      });
      if (!hasCorePermission(principal, scope)) return denied(scope);
      if (!isCoreMcpInput(name, args)) return toolError('CORE_INPUT_INVALID');
      if (name === 'coreAsk') {
        const missingScope = missingSessionScope(principal, 'sessionId' in args ? args.sessionId : undefined);
        if (missingScope) return denied(missingScope);
        if (!providerAdmitted.has(req)) return toolError('CORE_UNAVAILABLE');
      }
      if (isCoreMcpMutation(name) && isUnsafe()) return toolError('CORE_UNAVAILABLE');

      const inheritedSignal = getRequestAbortSignal();
      const signal = AbortSignal.any([disconnect.signal, extra.signal, ...(inheritedSignal ? [inheritedSignal] : [])]);
      const timeoutMs = Math.min(CORE_OPERATION_TIMEOUT_MS, options.timeoutMs ?? CORE_OPERATION_TIMEOUT_MS,
        getRequestRemainingMs() ?? CORE_OPERATION_TIMEOUT_MS, principal.expiresAt * 1_000 - Date.now());
      if (timeoutMs <= 0) return toolError('CORE_TIMEOUT');
      let aborted = false;
      try {
        const output = await runWithRequestAbortTimeout({
          timeoutMs, requestId: req.requestId, parentSignal: signal, abortMessage: 'Core request timed out.',
          onAbort: () => { aborted = true; },
        }, () => execute(principal, name, args, { requestId: req.requestId, traceId: req.traceId }));
        if (!isCoreMcpOutput(name, output)) return toolError('CORE_OUTPUT_INVALID');
        // Keep the short-lived confirmation token in the structured tool reply only.
        const summary: Record<string, unknown> = { ...output };
        delete summary.confirmationToken;
        return {
          structuredContent: { ...output },
          content: [{ type: 'text' as const, text: JSON.stringify(summary) }],
          ...(!output.ok ? { isError: true } : {}),
        };
      } catch {
        return toolError(aborted ? (signal.aborted ? 'CORE_CANCELLED' : 'CORE_TIMEOUT') : 'CORE_UNAVAILABLE');
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
      if (!res.headersSent) res.status(500).json({ error: 'CORE_REQUEST_FAILED' });
    }
  });

  router.all(CORE_MCP_PATH, (_req, res) => {
    res.status(405).set('Allow', 'POST').json({ error: 'CORE_METHOD_UNSUPPORTED' });
  });
  return router;
}

function toolError(code: string) {
  return { isError: true, content: [{ type: 'text' as const, text: code }] };
}
