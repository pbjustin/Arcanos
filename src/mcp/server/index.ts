import { z } from 'zod';
import crypto from 'node:crypto';

import type { McpRequestContext } from '../context.js';
import { MCP_FLAGS } from '../registry.js';
import { mcpError, mcpText } from '../errors.js';
import { issueConfirmationNonce, verifyAndConsumeNonce } from '../confirm.js';
import { isModuleActionAllowed } from '../modulesAllowlist.js';

import { resolveErrorMessage } from '@core/lib/errors/index.js';

import { runThroughBrain } from '@core/logic/trinity.js';
import { runARCANOS } from '@core/logic/arcanos.js';
import { runTrinity } from '@trinity/trinity.js';
import { DEFAULT_FINE_TUNE } from '@config/openai.js';

import { actionPlanInputSchema, type ActionPlanRecord, type ClearDecision } from '@shared/types/actionPlan.js';
import { buildClear2Summary } from '@services/clear2.js';

import {
  createPlan,
  getPlan,
  listPlans,
  approvePlan,
  blockPlan,
  expirePlan,
  createExecutionResult,
  getExecutionResults,
} from '@stores/actionPlanStore.js';

import { validateCapability, listAgents, getAgent, registerAgent, updateHeartbeat } from '@stores/agentRegistry.js';

import { ingestUrl, ingestContent, answerQuestion } from '@services/webRag.js';

import { connectResearchBridge } from '@services/researchHub.js';

import { saveMemory, loadMemory, deleteMemory, query as dbQuery } from '@core/db/index.js';

import { loadModuleDefinitions } from '@services/moduleLoader.js';
import { dispatchModuleAction } from '@routes/modules.js';

import { runHealthCheck } from '@platform/logging/diagnostics.js';
import { acquireExecutionLock } from '@services/safety/executionLock.js';
import { emitSafetyAuditEvent } from '@services/safety/auditEvents.js';
import { stripConfirmationFields, requireNonceOrIssue, notExposed, buildClearRecheckInput, wrapTool } from './helpers.js';

type AnyMcpServer = any;

/**
 * MCP SDK imports vary by version; keep them isolated here.
 * This file assumes @modelcontextprotocol/sdk is installed.
 */
async function getMcpSdk() {
  try {
    const mod = await import('@modelcontextprotocol/sdk/server/mcp.js');
    return {
      McpServer: (mod as any).McpServer,
    };
  } catch (error) {
    const message = resolveErrorMessage(error);
    throw new Error(`MCP server support is unavailable because @modelcontextprotocol/sdk is not installed: ${message}`);
  }
}

async function findMissingCapability(plan: ActionPlanRecord) {
  for (const action of plan.actions) {
    const hasCapability = await validateCapability(action.agentId, action.capability);
    if (!hasCapability) return action;
  }
  return null;
}

/** Build CLEAR 2.0 re-evaluation input from an existing plan record. */
export async function createMcpServer(ctx: McpRequestContext): Promise<AnyMcpServer> {
  const { McpServer } = await getMcpSdk();

  const server = new McpServer({ name: 'arcanos', version: '1.0.0' }, { capabilities: { logging: {} } });

  // -------------------------
  // Core reasoning tools
  // -------------------------
  server.registerTool(
    'trinity.ask',
    {
      title: 'Trinity Ask',
      description: 'Runs the Trinity pipeline (same as POST /ask).',
      annotations: { readOnlyHint: true, openWorldHint: true },
      inputSchema: z
        .object({
          prompt: z.string().optional(),
          userInput: z.string().optional(),
          content: z.string().optional(),
          text: z.string().optional(),
          query: z.string().optional(),
          sessionId: z.string().optional(),
          overrideAuditSafe: z.string().optional(),
          clientContext: z.record(z.any()).optional(),
          metadata: z.record(z.any()).optional(),
        })
        .passthrough(),
    },
    wrapTool('trinity.ask', ctx, async (args: any) => {
      const prompt = args.prompt ?? args.userInput ?? args.content ?? args.text ?? args.query ?? '';
      const sessionId = args.sessionId ?? ctx.sessionId;
      const result = await runThroughBrain(
        ctx.openai,
        prompt,
        sessionId,
        args.overrideAuditSafe,
        { sourceEndpoint: 'mcp.trinity.ask' },
        ctx.runtimeBudget
      );
      return mcpText(result);
    })
  );

  server.registerTool(
    'arcanos.run',
    {
      title: 'ARCANOS Run',
      description: 'Runs the ARCANOS diagnostic pipeline (same as POST /arcanos).',
      annotations: { readOnlyHint: true, openWorldHint: true },
      inputSchema: z.object({
        userInput: z.string(),
        sessionId: z.string().optional(),
        overrideAuditSafe: z.string().optional(),
      }),
    },
    wrapTool('arcanos.run', ctx, async (args: any) => {
      const result = await runARCANOS(ctx.openai, args.userInput, args.sessionId ?? ctx.sessionId, args.overrideAuditSafe);
      return mcpText(result);
    })
  );

  server.registerTool(
    'trinity.query_finetune',
    {
      title: 'Query Fine-tune',
      description: 'Runs the fine-tuned model endpoint (same as POST /query-finetune).',
      annotations: { readOnlyHint: true, openWorldHint: true },
      inputSchema: z.object({ prompt: z.string() }),
    },
    wrapTool('trinity.query_finetune', ctx, async (args: any) => {
      const out = await runTrinity({ prompt: args.prompt, model: DEFAULT_FINE_TUNE });
      return mcpText(out);
    })
  );

  // -------------------------
  // CLEAR + Plans
  // -------------------------
  server.registerTool(
    'clear.evaluate',
    {
      title: 'CLEAR Evaluate',
      description: 'Evaluates a proposed plan using CLEAR 2.0 (same as POST /clear/evaluate).',
      annotations: { readOnlyHint: true },
      inputSchema: actionPlanInputSchema,
    },
    wrapTool('clear.evaluate', ctx, async (args: any) => {
      const summary = buildClear2Summary(args);
      return mcpText(summary);
    })
  );

  server.registerTool(
    'plans.create',
    {
      title: 'Create Plan',
      description: 'Creates a plan record (same as POST /plans).',
      annotations: { readOnlyHint: false },
      inputSchema: actionPlanInputSchema,
    },
    wrapTool('plans.create', ctx, async (args: any) => {
      const plan = await createPlan(args);
      return mcpText(plan);
    })
  );

  server.registerTool(
    'plans.list',
    {
      title: 'List Plans',
      description: 'Lists plan records (same as GET /plans).',
      annotations: { readOnlyHint: true },
      inputSchema: z
        .object({
          status: z.string().optional(),
          limit: z.number().int().min(1).max(200).optional(),        })
        .passthrough(),
    },
    wrapTool('plans.list', ctx, async (args: any) => {
      const data = await listPlans({ status: args.status, limit: args.limit });
      return mcpText(data);
    })
  );

  server.registerTool(
    'plans.get',
    {
      title: 'Get Plan',
      description: 'Gets a plan record (same as GET /plans/:planId).',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({ planId: z.string() }),
    },
    wrapTool('plans.get', ctx, async (args: any) => {
      const plan = await getPlan(args.planId);
      if (!plan) {
        return mcpError({ code: 'ERR_NOT_FOUND', message: 'Plan not found', details: { planId: args.planId }, requestId: ctx.requestId });
      }
      return mcpText(plan);
    })
  );

  server.registerTool(
    'plans.approve',
    {
      title: 'Approve Plan',
      description: 'Approves a plan (same as POST /plans/:planId/approve).',
      annotations: { readOnlyHint: false },
      inputSchema: z.object({
        planId: z.string(),
        sessionId: z.string().optional(),
        confirmationNonce: z.string().optional(),
      }),
    },
    wrapTool('plans.approve', ctx, async (args: any) => {
      const gate = requireNonceOrIssue(args, 'plans.approve', ctx, stripConfirmationFields(args));
      if (!gate.ok) return gate.error;

      const plan = await approvePlan(args.planId);
      return mcpText(plan);
    })
  );

  server.registerTool(
    'plans.block',
    {
      title: 'Block Plan',
      description: 'Blocks a plan (same as POST /plans/:planId/block).',
      annotations: { destructiveHint: true },
      inputSchema: z.object({
        planId: z.string(),
        reason: z.string().optional(),
        sessionId: z.string().optional(),
        confirmationNonce: z.string().optional(),
      }),
    },
    wrapTool('plans.block', ctx, async (args: any) => {
      if (!MCP_FLAGS.exposeDestructive) return notExposed('plans.block', ctx);

      const gate = requireNonceOrIssue(args, 'plans.block', ctx, stripConfirmationFields(args));
      if (!gate.ok) return gate.error;

      const plan = await blockPlan(args.planId);
      return mcpText(plan);
    })
  );

  server.registerTool(
    'plans.expire',
    {
      title: 'Expire Plan',
      description: 'Expires a plan (same as POST /plans/:planId/expire).',
      annotations: { destructiveHint: true },
      inputSchema: z.object({
        planId: z.string(),
        sessionId: z.string().optional(),
        confirmationNonce: z.string().optional(),
      }),
    },
    wrapTool('plans.expire', ctx, async (args: any) => {
      if (!MCP_FLAGS.exposeDestructive) return notExposed('plans.expire', ctx);

      const gate = requireNonceOrIssue(args, 'plans.expire', ctx, stripConfirmationFields(args));
      if (!gate.ok) return gate.error;

      const plan = await expirePlan(args.planId);
      return mcpText(plan);
    })
  );

  server.registerTool(
    'plans.execute',
    {
      title: 'Execute Plan',
      description: 'Executes a plan (same as POST /plans/:planId/execute).',
      annotations: { destructiveHint: true, openWorldHint: true },
      inputSchema: z.object({
        planId: z.string(),
        sessionId: z.string().optional(),
        confirmationNonce: z.string().optional(),
      }),
    },
    wrapTool('plans.execute', ctx, async (args: any) => {
      if (!MCP_FLAGS.exposeDestructive) return notExposed('plans.execute', ctx);

      const gate = requireNonceOrIssue(args, 'plans.execute', ctx, stripConfirmationFields(args));
      if (!gate.ok) return gate.error;

      const plan = await getPlan(args.planId);
      if (!plan) {
        return mcpError({ code: 'ERR_NOT_FOUND', message: 'Plan not found', details: { planId: args.planId }, requestId: ctx.requestId });
      }

      if (plan.status === 'blocked' || plan.clearScore?.decision === 'block') {
        return mcpError({
          code: 'ERR_GATED',
          message: 'Cannot execute blocked plan',
          details: { planId: plan.id, status: plan.status, clearDecision: plan.clearScore?.decision },
          requestId: ctx.requestId,
        });
      }
      if (plan.status !== 'approved') {
        return mcpError({
          code: 'ERR_GATED',
          message: `Plan must be approved before execution (current: ${plan.status})`,
          details: { planId: plan.id, status: plan.status },
          requestId: ctx.requestId,
        });
      }

      const missingAction = await findMissingCapability(plan);
      if (missingAction) {
        return mcpError({
          code: 'ERR_GATED',
          message: `Agent ${missingAction.agentId} lacks capability: ${missingAction.capability}`,
          details: { planId: plan.id, agentId: missingAction.agentId, capability: missingAction.capability },
          requestId: ctx.requestId,
        });
      }

      const clearRecheck = buildClear2Summary(buildClearRecheckInput(plan));
      if (clearRecheck.decision === 'block') {
        await blockPlan(plan.id);
        return mcpError({
          code: 'ERR_GATED',
          message: 'CLEAR re-evaluation blocked this plan',
          details: { planId: plan.id, clearRecheck },
          requestId: ctx.requestId,
        });
      }

      const lock = await acquireExecutionLock(`policy-task:${plan.id}`);
      if (!lock) {
        emitSafetyAuditEvent({
          event: 'policy_task_duplicate_suppressed',
          severity: 'warn',
          details: { planId: plan.id },
        });
        return mcpError({
          code: 'ERR_GATED',
          message: 'Execution suppressed due to duplicate lock',
          details: { planId: plan.id },
          requestId: ctx.requestId,
        });
      }

      try {
        const clearDecision = (plan.clearScore?.decision ?? 'block') as ClearDecision;
        const results = await Promise.all(
          plan.actions.map(action => createExecutionResult(plan.id, action.id, action.agentId, 'success', clearDecision) as any)
        );
        return mcpText({ plan_id: plan.id, status: 'executed', results });
      } finally {
        try {
          await (lock as any)?.release?.();
        } catch {}
      }
    })
  );

  server.registerTool(
    'plans.results',
    {
      title: 'Plan Results',
      description: 'Gets execution results for a plan (same as GET /plans/:planId/results).',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({ planId: z.string() }),
    },
    wrapTool('plans.results', ctx, async (args: any) => {
      const results = await getExecutionResults(args.planId);
      return mcpText({ results });
    })
  );

  // -------------------------
  // Agents
  // -------------------------
  server.registerTool(
    'agents.register',
    {
      title: 'Register Agent',
      description: 'Registers an agent (same as POST /agents/register).',
      annotations: { readOnlyHint: false },
      inputSchema: z
        .object({
          agentId: z.string(),
          name: z.string().optional(),
          capabilities: z.array(z.string()).optional(),
          metadata: z.record(z.any()).optional(),
        })
        .passthrough(),
    },
    wrapTool('agents.register', ctx, async (args: any) => {
      const agent = await registerAgent(args);
      return mcpText({ success: true, agent });
    })
  );

  server.registerTool(
    'agents.list',
    {
      title: 'List Agents',
      description: 'Lists registered agents (same as GET /agents).',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({}).passthrough(),
    },
    wrapTool('agents.list', ctx, async () => {
      const agents = await listAgents();
      return mcpText({ agents });
    })
  );

  server.registerTool(
    'agents.get',
    {
      title: 'Get Agent',
      description: 'Gets a registered agent (same as GET /agents/:agentId).',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({ agentId: z.string() }),
    },
    wrapTool('agents.get', ctx, async (args: any) => {
      const agent = await getAgent(args.agentId);
      if (!agent) {
        return mcpError({ code: 'ERR_NOT_FOUND', message: 'Agent not found', details: { agentId: args.agentId }, requestId: ctx.requestId });
      }
      return mcpText(agent);
    })
  );

  server.registerTool(
    'agents.heartbeat',
    {
      title: 'Agent Heartbeat',
      description: 'Updates agent heartbeat (same as POST /agents/:agentId/heartbeat).',
      annotations: { readOnlyHint: false },
      inputSchema: z.object({ agentId: z.string() }),
    },
    wrapTool('agents.heartbeat', ctx, async (args: any) => {
      const agent = await updateHeartbeat(args.agentId);
      return mcpText({ success: true, agent });
    })
  );

  // -------------------------
  // RAG + Research
  // -------------------------
  server.registerTool(
    'rag.ingest_url',
    {
      title: 'RAG Ingest URL',
      description: 'Fetches and ingests a URL into RAG (same as POST /rag/fetch).',
      annotations: { openWorldHint: true },
      inputSchema: z.object({
        url: z.string().url(),
        sessionId: z.string().optional(),
        confirmationNonce: z.string().optional(),
      }),
    },
    wrapTool('rag.ingest_url', ctx, async (args: any) => {
      const gate = requireNonceOrIssue(args, 'rag.ingest_url', ctx, stripConfirmationFields(args));
      if (!gate.ok) return gate.error;

      const out = await ingestUrl(args.url);
      return mcpText(out);
    })
  );

  server.registerTool(
    'rag.ingest_content',
    {
      title: 'RAG Ingest Content',
      description: 'Ingests raw content into RAG (same as POST /rag/save).',
      annotations: { readOnlyHint: false },
      inputSchema: z.object({
        content: z.string(),
        source: z.string().optional(),
        metadata: z.record(z.any()).optional(),
        sessionId: z.string().optional(),
        confirmationNonce: z.string().optional(),
      }),
    },
    wrapTool('rag.ingest_content', ctx, async (args: any) => {
      const gate = requireNonceOrIssue(args, 'rag.ingest_content', ctx, stripConfirmationFields(args));
      if (!gate.ok) return gate.error;

      const out = await ingestContent({ content: args.content, source: args.source, metadata: args.metadata });
      return mcpText(out);
    })
  );

  server.registerTool(
    'rag.query',
    {
      title: 'RAG Query',
      description: 'Queries ingested knowledge (same as POST /rag/query).',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({ question: z.string(), topK: z.number().int().min(1).max(50).optional() }).passthrough(),
    },
    wrapTool('rag.query', ctx, async (args: any) => {
      const out = await answerQuestion(args.question);
      return mcpText(out);
    })
  );

  server.registerTool(
    'research.run',
    {
      title: 'Research Run',
      description: 'Runs research workflow (same as POST /commands/research).',
      annotations: { openWorldHint: true },
      inputSchema: z.object({
        topic: z.string(),
        urls: z.array(z.string().url()).optional(),
        sessionId: z.string().optional(),
        confirmationNonce: z.string().optional(),
      }),
    },
    wrapTool('research.run', ctx, async (args: any) => {
      const gate = requireNonceOrIssue(args, 'research.run', ctx, stripConfirmationFields(args));
      if (!gate.ok) return gate.error;

      const bridge = connectResearchBridge('mcp');
      const out = await bridge.requestResearch({ topic: args.topic, urls: args.urls });
      return mcpText(out);
    })
  );

  // -------------------------
  // Memory + Modules + Ops
  // -------------------------
  server.registerTool(
    'memory.save',
    {
      title: 'Memory Save',
      description: 'Saves a memory key/value (same as POST /api/memory/save).',
      annotations: { readOnlyHint: false },
      inputSchema: z.object({
        key: z.string(),
        value: z.any(),
        ttlSeconds: z.number().int().min(1).optional(),
        sessionId: z.string().optional(),
        confirmationNonce: z.string().optional(),
      }),
    },
    wrapTool('memory.save', ctx, async (args: any) => {
      const gate = requireNonceOrIssue(args, 'memory.save', ctx, stripConfirmationFields(args));
      if (!gate.ok) return gate.error;

      const out = await saveMemory(args.key, args.value);
      return mcpText(out);
    })
  );

  server.registerTool(
    'memory.load',
    {
      title: 'Memory Load',
      description: 'Loads a memory by key (same as GET /api/memory/load).',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({ key: z.string() }),
    },
    wrapTool('memory.load', ctx, async (args: any) => {
      const out = await loadMemory(args.key);
      return mcpText(out);
    })
  );

  server.registerTool(
    'memory.list',
    {
      title: 'Memory List',
      description: 'Lists memory entries (same as GET /api/memory/list).',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({ limit: z.number().int().min(1).max(200).optional() }).passthrough(),
    },
    wrapTool('memory.list', ctx, async (args: any) => {
      // dbQuery signature depends on your DB module; keep simple.
      const limit = args.limit ?? 50;
      const out = await dbQuery('SELECT key, updated_at FROM memory ORDER BY updated_at DESC LIMIT $1', [limit] as any);
      return mcpText(out);
    })
  );

  server.registerTool(
    'memory.delete',
    {
      title: 'Memory Delete',
      description: 'Deletes a memory by key (same as DELETE /api/memory/delete).',
      annotations: { destructiveHint: true },
      inputSchema: z.object({
        key: z.string(),
        sessionId: z.string().optional(),
        confirmationNonce: z.string().optional(),
      }),
    },
    wrapTool('memory.delete', ctx, async (args: any) => {
      if (!MCP_FLAGS.exposeDestructive) return notExposed('memory.delete', ctx);

      const gate = requireNonceOrIssue(args, 'memory.delete', ctx, stripConfirmationFields(args));
      if (!gate.ok) return gate.error;

      const out = await deleteMemory(args.key);
      return mcpText(out);
    })
  );

  server.registerTool(
    'modules.list',
    {
      title: 'Modules List',
      description: 'Lists loaded modules and actions (same as GET /registry).',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({}).passthrough(),
    },
    wrapTool('modules.list', ctx, async () => {
      const defs = await loadModuleDefinitions();
      return mcpText(defs);
    })
  );

  server.registerTool(
    'modules.invoke',
    {
      title: 'Modules Invoke',
      description: 'Invokes a module action (similar to POST /queryroute). Deny-by-default allowlist is enforced.',
      annotations: { openWorldHint: true },
      inputSchema: z.object({
        module: z.string(),
        action: z.string(),
        payload: z.any().optional(),
        sessionId: z.string().optional(),
        confirmationNonce: z.string().optional(),
      }),
    },
    wrapTool('modules.invoke', ctx, async (args: any) => {
      if (!isModuleActionAllowed(args.module, args.action)) {
        return mcpError({
          code: 'ERR_GATED',
          message: `Module action not allowed: ${args.module}:${args.action}`,
          details: {
            module: args.module,
            action: args.action,
            allowlistEnv: 'MCP_ALLOW_MODULE_ACTIONS',
          },
          requestId: ctx.requestId,
        });
      }

      const gate = requireNonceOrIssue(args, 'modules.invoke', ctx, stripConfirmationFields(args));
      if (!gate.ok) return gate.error;

      const out = await dispatchModuleAction(args.module, args.action, args.payload ?? {});
      return mcpText(out);
    })
  );

  server.registerTool(
    'ops.health_report',
    {
      title: 'Ops Health Report',
      description: 'Runs a health report (similar to GET /railway/healthcheck).',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({}).passthrough(),
    },
    wrapTool('ops.health_report', ctx, async () => {
      const out = await runHealthCheck();
      return mcpText(out);
    })
  );

  return server;
}

export async function buildMcpServer(ctx: McpRequestContext): Promise<{ server: AnyMcpServer; transport: any }> {
  let StreamableHTTPServerTransport: any;
  try {
    const transportMod = await import('@modelcontextprotocol/sdk/server/streamableHttp.js');
    StreamableHTTPServerTransport = (transportMod as any).StreamableHTTPServerTransport;
  } catch (error) {
    const message = resolveErrorMessage(error);
    throw new Error(`MCP HTTP transport is unavailable because @modelcontextprotocol/sdk is not installed: ${message}`);
  }

  const server = await createMcpServer(ctx);

  const sessionIdGenerator = MCP_FLAGS.enableSessions ? (() => crypto.randomUUID()) : undefined;
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator });

  await server.connect(transport);
  return { server, transport };
}
