import express, { type RequestHandler } from 'express';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema, type Tool } from '@modelcontextprotocol/sdk/types.js';
import { getRequestAbortSignal, getRequestRemainingMs, runWithRequestAbortTimeout } from '@arcanos/runtime';
import { createClientDisconnectAbortScope } from '@shared/http/clientDisconnectAbort.js';
import { createRateLimitMiddleware } from '@platform/runtime/security.js';
import { config as runtimeConfig } from '@platform/runtime/config.js';
import { publicProviderRateLimit, resolvePublicProviderClientIdentity } from '@transport/http/middleware/publicProviderAdmission.js';
import { GAMING_MCP_PATH, GAMING_METADATA_PATH, gamingMcpTools, isGamingMcpToolName, isGamingMcpWrite, isGamingMcpInput, isGamingMcpOutput } from '@shared/chatgpt/gamingMcpContract.js';
import { resolveGamingExecutionBudget } from '@shared/gaming/gamingExecutionBudgetCore.js';
import { getGamingModuleTimeoutMs } from '@services/gamingConfig.js';
import type { ChatGptGamingToolName } from '@arcanos/protocol';
import { createGamingTokenVerifier, gamingAuthChallenge, gamingPrincipalActorKey, gamingProtectedResourceMetadata,
  hasGamingPermission, readGamingAuthConfiguration, type GamingAuthConfiguration } from '../chatgpt/gamingAuth.js';
import type { ChatGptPrincipal } from '../chatgpt/auth.js';
import { executeGamingMcp, GamingMcpError } from '../chatgpt/gaming.js';

const providerTools = new Set<ChatGptGamingToolName>(['arcanos_gaming_query', 'arcanos_gaming_hybrid_query', 'arcanos_gaming_submit_candidates']);
// Provider-capable reads share the execution envelope; fixtures/status and durable writes stay bounded.
const boundedOperationTimeouts: Partial<Record<ChatGptGamingToolName, number>> = { arcanos_gaming_canary: 5_000,
  arcanos_gaming_ingestion_status: 10_000, arcanos_gaming_ingest_sources: 20_000,
  arcanos_gaming_refresh_sources: 20_000, arcanos_gaming_ingest_candidates: 38_000 };

/** Dedicated single-owner resource. Test seams are internal parameters, never HTTP input. */
export function createChatGptGamingMcpRouter(options: {
  configuration?: GamingAuthConfiguration;
  verification?: Parameters<typeof createGamingTokenVerifier>[1];
  execute?: typeof executeGamingMcp;
  providerAdmission?: RequestHandler;
  timeoutMs?: number;
} = {}) {
  const router = express.Router();
  const configuration = options.configuration ?? readGamingAuthConfiguration();
  const verify = configuration.status === 'ready' ? createGamingTokenVerifier(configuration, options.verification) : undefined;
  const execute = options.execute ?? executeGamingMcp;
  const providerAdmission = options.providerAdmission ?? publicProviderRateLimit;
  const principals = new WeakMap<express.Request, ChatGptPrincipal>();
  const ipLimit = createRateLimitMiddleware({ bucketName: 'chatgpt-gaming-client', maxRequests: 120, windowMs: 60_000,
    keyGenerator: req => resolvePublicProviderClientIdentity(req, { trustRailwayRealIp: runtimeConfig.limits.publicProviderTrustRailwayRealIp }) });
  const principalLimit = createRateLimitMiddleware({ bucketName: 'chatgpt-gaming-owner', maxRequests: 30, windowMs: 60_000,
    keyGenerator: req => gamingPrincipalActorKey(principals.get(req)!) });
  router.get(GAMING_METADATA_PATH, (_req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    if (configuration.status !== 'ready') {
      res.status(configuration.status === 'disabled' ? 404 : 503).json({ error: 'GAMING_INTEGRATION_UNAVAILABLE' }); return;
    }
    res.json(gamingProtectedResourceMetadata(configuration));
  });
  const authenticate: RequestHandler = async (req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    if (configuration.status !== 'ready' || !verify) {
      res.status(configuration.status === 'disabled' ? 404 : 503).json({ error: 'GAMING_INTEGRATION_UNAVAILABLE' }); return;
    }
    const origin = req.header('origin');
    if (origin && origin !== new URL(configuration.resource).origin) {
      res.status(403).json({ error: 'GAMING_ORIGIN_DENIED' }); return;
    }
    const headers = req.rawHeaders.filter((_, index) => index % 2 === 0).filter(value => value.toLowerCase() === 'authorization');
    const result = await verify(headers.length > 1 ? undefined : req.header('authorization'));
    if (!result.ok) {
      res.setHeader('WWW-Authenticate', gamingAuthChallenge(configuration, false, result.error));
      res.status(result.status).json({ error: 'GAMING_AUTHORIZATION_REQUIRED' }); return;
    }
    principals.set(req, result.principal); next();
  };
  router.all(GAMING_MCP_PATH, ipLimit, authenticate, principalLimit);
  const parse = express.json({ limit: 32_768, strict: true, inflate: false });
  const boundedParser: RequestHandler = (req, res, next) => {
    if (!req.is('application/json')) { res.status(415).json({ error: 'GAMING_REQUEST_INVALID' }); return; }
    parse(req, res, error => {
      if (!error) { next(); return; }
      res.status(error.status === 413 ? 413 : 400).json({ error: 'GAMING_REQUEST_INVALID' });
    });
  };
  const admitProvider: RequestHandler = (req, res, next) => {
    if (Array.isArray(req.body)) { res.status(400).json({ error: 'GAMING_BATCH_UNSUPPORTED' }); return; }
    const name = req.body?.params?.name;
    if (req.body?.method !== 'tools/call' || !providerTools.has(name) || !isGamingMcpToolName(name)
      || !isGamingMcpInput(name, req.body?.params?.arguments)) { next(); return; }
    providerAdmission(req, res, error => {
      if (error) { res.status(503).json({ error: 'GAMING_UNAVAILABLE' }); return; }
      next();
    });
  };
  router.post(GAMING_MCP_PATH, boundedParser, admitProvider, async (req, res) => {
    const principal = principals.get(req)!;
    const disconnect = createClientDisconnectAbortScope(req, res, 'Gaming client disconnected.');
    const server = new Server({ name: 'arcanos-gaming-private', version: '1.0.0' }, { capabilities: { tools: {} },
      instructions: 'Gaming tools only. Normal guide/build/meta traffic selects released gaming-hybrid-v2; explicit v1 remains legacy-compatible. Preserve structured protocol version, revision, nextAction and workflow state. Search only when the backend requests discovery. V2 recovery requires the returned grant, same workflowId, current expectedRevision and a new operation key. Never restart or downgrade an exhausted workflow. Never store sources without the separate write tool and confirmation. Do not restart exhausted discovery; poll at most three times. A timed-out write may have been accepted: retry only the identical idempotency key.' });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: hasGamingPermission(principal) ? gamingMcpTools as Tool[] : [] }));
    server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
      const name = request.params.name;
      const write = isGamingMcpToolName(name) && isGamingMcpWrite(name);
      if (!hasGamingPermission(principal, write)) return { isError: true,
        content: [{ type: 'text', text: 'GAMING_PERMISSION_DENIED' }],
        _meta: { 'mcp/www_authenticate': configuration.status === 'ready'
          ? [gamingAuthChallenge(configuration, write, 'insufficient_scope')] : [] } };
      if (!isGamingMcpToolName(name)) return { isError: true, content: [{ type: 'text', text: 'GAMING_TOOL_UNAVAILABLE' }] };
      if (!isGamingMcpInput(name, request.params.arguments)) return { isError: true, content: [{ type: 'text', text: 'GAMING_INPUT_INVALID' }] };
      const inheritedSignal = getRequestAbortSignal();
      const signal = AbortSignal.any([disconnect.signal, extra.signal, ...(inheritedSignal ? [inheritedSignal] : [])]);
      const requestRemainingMs = getRequestRemainingMs();
      const executionBudget = resolveGamingExecutionBudget({ moduleTimeoutMs: getGamingModuleTimeoutMs(), requestRemainingMs });
      const operationCapMs = options.timeoutMs === undefined ? executionBudget.mcpOperationTimeoutMs
        : resolveGamingExecutionBudget({ moduleTimeoutMs: options.timeoutMs, requestRemainingMs }).mcpOperationTimeoutMs;
      const mcpOperationTimeoutMs = Math.min(executionBudget.mcpOperationTimeoutMs,
        providerTools.has(name) ? executionBudget.mcpOperationTimeoutMs : boundedOperationTimeouts[name] ?? 0,
        operationCapMs);
      req.logger?.info?.('gaming.mcp.execution_budget', { mcpOperationTimeoutMs, requestRemainingMs });
      if (mcpOperationTimeoutMs <= 0) return { isError: true, content: [{ type: 'text', text: 'GAMING_TIMEOUT' }] };
      let aborted = false;
      try {
        const output = await runWithRequestAbortTimeout({ timeoutMs: mcpOperationTimeoutMs,
          parentSignal: signal, abortMessage: 'Gaming request timed out.', onAbort: () => { aborted = true; } },
        () => execute(principal, name, request.params.arguments, { requestId: req.requestId, traceId: req.traceId,
          autoStoreApproved: configuration.status === 'ready' && configuration.autoStoreApproved }));
        if (!isGamingMcpOutput(name, output)) throw new GamingMcpError('GAMING_OUTPUT_INVALID');
        return { structuredContent: { ...output }, content: [{ type: 'text', text: JSON.stringify(output) }],
          ...(output.statusCode >= 400 ? { isError: true } : {}) };
      } catch (error) {
        const code = aborted ? signal.aborted ? 'GAMING_CANCELLED' : 'GAMING_TIMEOUT'
          : error instanceof GamingMcpError ? error.code : 'GAMING_UNAVAILABLE';
        return { isError: true, content: [{ type: 'text', text: code }] };
      }
    });
    res.once('close', () => { disconnect.cleanup(); void server.close().catch(() => {}); });
    try { await server.connect(transport); await transport.handleRequest(req, res, req.body); }
    catch { if (!res.headersSent) res.status(500).json({ error: 'GAMING_REQUEST_FAILED' }); }
  });
  router.all(GAMING_MCP_PATH, (_req, res) => { res.status(405).set('Allow', 'POST').json({ error: 'GAMING_METHOD_UNSUPPORTED' }); });
  return router;
}
