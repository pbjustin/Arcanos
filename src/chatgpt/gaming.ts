import type { ChatGptGamingOutput, ChatGptGamingToolName } from '@arcanos/protocol';
import { getRequestAbortSignal } from '@arcanos/runtime';
import { runWithSessionContext } from '@platform/runtime/sessionContext.js';
import { hasUnsafeBlockingConditions } from '@services/safety/runtimeState.js';
import { dispatchPublicGamingRequest } from '@services/gamingPublicDispatcher.js';
import { isGamingMcpInput, isGamingMcpOutput, isGamingMcpWrite, gamingMcpWritePolicyError } from '@shared/chatgpt/gamingMcpContract.js';
import type { GamingHybridCallContext } from '@services/gamingHybridKnowledge.js';
import type { PublicGamingCanaryResponse } from '@services/publicGamingCanary.js';
import type { ChatGptPrincipal } from './auth.js';
import { hasGamingPermission, gamingPrincipalActorKey } from './gamingAuth.js';

type GatewayResult = { statusCode: number; payload: unknown };
type HybridResult = { status: number; body: unknown };
export interface GamingMcpServices {
  query: (input: Record<string, unknown>) => Promise<unknown>;
  canary: () => { statusCode: number; response: PublicGamingCanaryResponse };
  hybridQuery: (input: unknown, context: GamingHybridCallContext) => Promise<HybridResult>;
  candidates: (input: unknown, context: GamingHybridCallContext) => Promise<HybridResult>;
  ingestCandidates: (input: unknown, context: GamingHybridCallContext) => Promise<HybridResult>;
  ingestSources: (input: unknown, context: GamingHybridCallContext) => Promise<GatewayResult>;
  refreshSources: (input: unknown, context: GamingHybridCallContext) => Promise<GatewayResult>;
  ingestionStatus: (id: string, context: GamingHybridCallContext) => Promise<GatewayResult>;
}
export class GamingMcpError extends Error { constructor(public readonly code: string) { super(code); } }

/** Fixed service references. No generic dispatcher, HTTP proxy, bearer bridge, jobs or module selector. */
export function createGamingMcpExecutor(overrides: Partial<GamingMcpServices> = {}) {
  const services: GamingMcpServices = {
    query: async input => (await import('@services/arcanos-gaming.js')).ArcanosGaming.actions.query(input),
    canary: () => { throw new GamingMcpError('GAMING_CANARY_UNAVAILABLE'); },
    hybridQuery: async (input, context) => (await import('@services/gamingHybridKnowledge.js')).gamingHybridWorkflow.query(input, context),
    candidates: async (input, context) => (await import('@services/gamingHybridKnowledge.js')).gamingHybridWorkflow.candidates(input, context),
    ingestCandidates: async (input, context) => (await import('@services/gamingHybridKnowledge.js')).gamingHybridWorkflow.ingest(input, context),
    ingestSources: async (input, context) => (await import('@services/gamingSourceIngestion.js')).createGamingSourceIngestion(input, context),
    refreshSources: async (input, context) => (await import('@services/gamingSourceIngestion.js')).refreshGamingSources(input, context),
    ingestionStatus: async (id, context) => (await import('@services/gamingSourceIngestion.js')).getGamingSourceIngestionStatus(id, context),
    ...overrides,
  };
  return async (principal: ChatGptPrincipal, name: ChatGptGamingToolName, input: unknown,
    options: { requestId?: string; traceId?: string; autoStoreApproved?: boolean } = {}): Promise<ChatGptGamingOutput> => {
    const write = isGamingMcpWrite(name);
    if (!hasGamingPermission(principal, write)) throw new GamingMcpError('GAMING_PERMISSION_DENIED');
    if (hasUnsafeBlockingConditions()) throw new GamingMcpError('GAMING_UNAVAILABLE');
    if (!isGamingMcpInput(name, input)) throw new GamingMcpError('GAMING_INPUT_INVALID');
    // Automatic storage applies only to backend-approved candidates with standing permission.
    const canAutoStore = name === 'arcanos_gaming_ingest_candidates' && options.autoStoreApproved === true;
    if (write) {
      const denied = gamingMcpWritePolicyError(input, canAutoStore);
      if (denied) throw new GamingMcpError(denied);
    }
    const context: GamingHybridCallContext = { actorKey: gamingPrincipalActorKey(principal),
      requestId: options.requestId, traceId: options.traceId, signal: getRequestAbortSignal(), canStore: write, canAutoStore };
    return runWithSessionContext(undefined, async () => {
      let result: unknown;
      let statusCode = 200;
      switch (name) {
        case 'arcanos_gaming_query': {
          const decision = dispatchPublicGamingRequest({ action: 'query', payload: input }, 'query');
          if (!decision.ok) throw new GamingMcpError('GAMING_REQUEST_UNSUPPORTED');
          result = await services.query(input); break;
        }
        case 'arcanos_gaming_canary': {
          if (!dispatchPublicGamingRequest({ action: 'canary', payload: { scope: 'public_pipeline' } }, 'canary').ok) {
            throw new GamingMcpError('GAMING_CANARY_UNAVAILABLE');
          }
          const value = overrides.canary ? services.canary()
            : (await import('@services/publicGamingCanary.js')).executePublicGamingCanary({ requestId: options.requestId, traceId: options.traceId });
          statusCode = value.statusCode;
          result = { ...value.response, route: 'gaming_mcp_canary',
            message: `Gaming MCP bundled fixture ${value.response.ok ? 'completed' : 'failed'}. Legacy HTTP route and live provider/storage behavior were not checked.`,
            checks: { ...value.response.checks, publicRoute: 'skipped' } };
          break;
        }
        case 'arcanos_gaming_hybrid_query':
        case 'arcanos_gaming_submit_candidates':
        case 'arcanos_gaming_ingest_candidates': {
          const operation = name === 'arcanos_gaming_hybrid_query' ? services.hybridQuery
            : name === 'arcanos_gaming_submit_candidates' ? services.candidates : services.ingestCandidates;
          const value = await operation(input, context); statusCode = value.status; result = value.body; break;
        }
        case 'arcanos_gaming_ingestion_status': {
          const value = await services.ingestionStatus(String(input.ingestionId), context);
          statusCode = value.statusCode; result = value.payload; break;
        }
        case 'arcanos_gaming_ingest_sources':
        case 'arcanos_gaming_refresh_sources': {
          const { confirmStore: _confirmation, storagePolicy: _storagePolicy, ...payload } = input;
          const refresh = name === 'arcanos_gaming_refresh_sources';
          const value = await (refresh ? services.refreshSources : services.ingestSources)({ action: refresh ? 'refresh' : 'ingest', payload }, context);
          statusCode = value.statusCode; result = value.payload; break;
        }
      }
      const output = { statusCode, result: result as Record<string, unknown> };
      if (!isGamingMcpOutput(name, output)) throw new GamingMcpError('GAMING_OUTPUT_INVALID');
      return output;
    });
  };
}
export const executeGamingMcp = createGamingMcpExecutor();
