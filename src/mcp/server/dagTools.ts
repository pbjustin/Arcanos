import { z } from 'zod';

import type { McpRequestContext } from '../context.js';
import { mcpError, mcpText } from '../errors.js';
import { arcanosDagRunService } from '@services/arcanosDagRunService.js';
import { TRINITY_CORE_DAG_TEMPLATE_NAME } from '@dag/templates.js';
import { DAG_LATEST_DEBUG_MARKER, type DagLatestRunToolOutput } from '../../types/dag.js';
import { requireNonceOrIssue, stripConfirmationFields, wrapTool } from './helpers.js';

type AnyMcpServer = {
  registerTool: (name: string, config: Record<string, unknown>, handler: (args: unknown) => Promise<unknown>) => void;
};

const DAG_RUN_WAIT_MAX_MS = 30_000;
const DEFAULT_DAG_TRACE_SLOW_MS = 1_500;

const dagCreateInputSchema = z.object({
  goal: z.string().trim().min(1).optional(),
  input: z.record(z.any()).optional(),
  template: z.string().trim().min(1).optional(),
  sessionId: z.string().trim().min(1).optional(),
  maxConcurrency: z.number().int().min(1).max(20).optional(),
  allowRecursiveSpawning: z.boolean().optional(),
  debug: z.boolean().optional(),
  confirmationNonce: z.string().optional(),
});

const dagRunIdSchema = z.object({
  runId: z.string().trim().min(1),
});

const dagLatestRunSchema = z.object({
  sessionId: z.string().trim().min(1).optional(),
});

const dagNodeSchema = dagRunIdSchema.extend({
  nodeId: z.string().trim().min(1),
});

const dagTraceSchema = dagRunIdSchema.extend({
  maxEvents: z.number().int().min(1).max(1000).optional(),
});

const dagWaitSchema = dagRunIdSchema.extend({
  updatedAfter: z.string().datetime().optional(),
  waitForUpdateMs: z.number().int().min(0).max(DAG_RUN_WAIT_MAX_MS).optional(),
});

const dagCancelSchema = dagRunIdSchema.extend({
  sessionId: z.string().trim().min(1).optional(),
  confirmationNonce: z.string().optional(),
});

/**
 * Build a structured MCP not-found error for DAG resources.
 *
 * Purpose:
 * - Keep DAG MCP tools consistent with the existing MCP error contract when runs or nodes are missing.
 *
 * Inputs/outputs:
 * - Input: MCP request context, human-readable resource label, and resource details.
 * - Output: MCP error payload with `ERR_NOT_FOUND`.
 *
 * Edge case behavior:
 * - Details are passed through unchanged so callers can distinguish run vs node misses.
 */
function createDagNotFoundError(
  ctx: McpRequestContext,
  resource: string,
  details: Record<string, unknown>
) {
  return mcpError({
    code: 'ERR_NOT_FOUND',
    message: `${resource} not found`,
    details,
    requestId: ctx.requestId,
  });
}

function resolveDagTraceSlowMs(): number {
  const rawValue = Number.parseInt(process.env.DAG_TRACE_SLOW_MS ?? '', 10);
  if (!Number.isFinite(rawValue) || rawValue <= 0) {
    return DEFAULT_DAG_TRACE_SLOW_MS;
  }

  return Math.trunc(rawValue);
}

function measurePayloadBytes(payload: unknown): number {
  return Buffer.byteLength(JSON.stringify(payload), 'utf8');
}

function logDagInspection(
  ctx: McpRequestContext,
  event: 'dag.run.latest' | 'dag.run.trace',
  details: Record<string, unknown> & { durationMs: number }
): void {
  const loggerMethod = details.durationMs >= resolveDagTraceSlowMs() ? ctx.logger.warn : ctx.logger.info;
  loggerMethod(event, details);
}

function buildLatestDagRunToolOutput(latestRun: Awaited<ReturnType<typeof arcanosDagRunService.inspectLatestRunSummary>>): DagLatestRunToolOutput {
  if (!latestRun) {
    throw new Error('Latest DAG run summary is required to build the tool output.');
  }

  return {
    __debug: DAG_LATEST_DEBUG_MARKER,
    found: true,
    ...latestRun.latest,
  };
}

/**
 * Normalize DAG run creation input for the orchestration service.
 *
 * Purpose:
 * - Let MCP callers create DAG runs with either a simple `goal` string or a prebuilt `input` object.
 *
 * Inputs/outputs:
 * - Input: parsed MCP tool arguments plus request-local MCP context.
 * - Output: normalized payload for `ArcanosDagRunService.createRun`.
 *
 * Edge case behavior:
 * - Falls back to the MCP context session or request id when the caller omits `sessionId`.
 */
function normalizeDagCreateRequest(
  args: z.infer<typeof dagCreateInputSchema>,
  ctx: McpRequestContext
) {
  const input = args.input ? { ...args.input } : {};

  //audit Assumption: MCP callers often provide only a natural-language goal; failure risk: empty DAG payloads create ambiguous plans; expected invariant: a provided goal is copied into the orchestration input; handling strategy: merge `goal` into `input` before dispatch.
  if (args.goal) {
    input.goal = args.goal;
  }

  const options = {
    maxConcurrency: args.maxConcurrency,
    allowRecursiveSpawning: args.allowRecursiveSpawning,
    debug: args.debug,
  };

  return {
    sessionId: args.sessionId ?? ctx.sessionId ?? ctx.requestId,
    template: args.template ?? TRINITY_CORE_DAG_TEMPLATE_NAME,
    input,
    options,
  };
}

/**
 * Validate the non-structural DAG creation requirement that a caller provides work to do.
 *
 * Purpose:
 * - Preserve a readable MCP JSON schema while still rejecting empty DAG creation requests.
 *
 * Inputs/outputs:
 * - Input: parsed DAG creation args plus request context.
 * - Output: MCP bad-request error payload or `null` when valid.
 *
 * Edge case behavior:
 * - Returns an MCP error instead of throwing so callers get a contract-aligned failure.
 */
function validateDagCreateIntent(
  args: z.infer<typeof dagCreateInputSchema>,
  ctx: McpRequestContext
) {
  //audit Assumption: DAG creation without a goal or explicit input is always invalid; failure risk: AI clients start empty runs that waste queue capacity and budget; expected invariant: at least one of `goal` or `input` is supplied; handling strategy: return `ERR_BAD_REQUEST` before orchestration starts.
  if (!args.goal && !args.input) {
    return mcpError({
      code: 'ERR_BAD_REQUEST',
      message: 'Provide either `goal` or `input` when creating a DAG run.',
      details: { tool: 'dag.run.create' },
      requestId: ctx.requestId,
    });
  }

  return null;
}

/**
 * Register DAG orchestration MCP tools on one MCP server instance.
 *
 * Purpose:
 * - Expose DAG run creation, inspection, waiting, verification, and cancellation over ARCANOS MCP.
 *
 * Inputs/outputs:
 * - Input: MCP server instance plus request-scoped context.
 * - Output: registers tools in-place on the server.
 *
 * Edge case behavior:
 * - Missing DAG runs and nodes return `ERR_NOT_FOUND` instead of generic internal errors.
 */
export function registerDagMcpTools(server: AnyMcpServer, ctx: McpRequestContext): void {
  server.registerTool(
    'dag.capabilities',
    {
      title: 'DAG Capabilities',
      description: 'Gets DAG orchestration feature flags and execution limits.',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({}).passthrough(),
    },
    wrapTool('dag.capabilities', ctx, async () => {
      return mcpText({
        features: arcanosDagRunService.getFeatureFlags(),
        limits: arcanosDagRunService.getExecutionLimits(),
      });
    })
  );

  server.registerTool(
    'dag.run.create',
    {
      title: 'Create DAG Run',
      description: 'Creates a DAG orchestration run from a goal or explicit input payload.',
      annotations: { readOnlyHint: false, openWorldHint: true },
      inputSchema: dagCreateInputSchema,
    },
    wrapTool('dag.run.create', ctx, async (rawArgs: unknown) => {
      const args = dagCreateInputSchema.parse(rawArgs);
      const validationError = validateDagCreateIntent(args, ctx);
      if (validationError) {
        return validationError;
      }

      const gate = requireNonceOrIssue(args, 'dag.run.create', ctx, stripConfirmationFields(args));
      if (!gate.ok) {
        return gate.error;
      }

      const run = await arcanosDagRunService.createRun(normalizeDagCreateRequest(args, ctx));
      return mcpText({ run });
    })
  );

  server.registerTool(
    'dag.run.latest',
    {
      title: 'Get Latest DAG Run',
      description: 'Gets the most recently updated DAG run summary, optionally scoped to a session.',
      annotations: { readOnlyHint: true },
      inputSchema: dagLatestRunSchema,
    },
    wrapTool('dag.run.latest', ctx, async (rawArgs: unknown) => {
      const args = dagLatestRunSchema.parse(rawArgs);
      const resolvedSessionId = args.sessionId ?? ctx.sessionId;
      const latestRun = await arcanosDagRunService.inspectLatestRunSummary(resolvedSessionId);
      if (!latestRun) {
        return createDagNotFoundError(ctx, 'DAG run', { sessionId: resolvedSessionId ?? null });
      }

      const responseBody = buildLatestDagRunToolOutput(latestRun);
      ctx.logger.info('dag.run.latest.invoke', {
        tool: 'dag.run.latest',
        source: 'NEW_IMPLEMENTATION',
        requestId: ctx.requestId,
        sessionId: resolvedSessionId ?? null,
        runId: responseBody.runId,
      });
      logDagInspection(ctx, 'dag.run.latest', {
        requestId: ctx.requestId,
        traceId: ctx.req?.traceId ?? ctx.requestId,
        runId: responseBody.runId,
        sessionId: resolvedSessionId ?? null,
        durationMs: latestRun.diagnostics.totalMs,
        localLookupMs: latestRun.diagnostics.localLookupMs,
        persistedLookupMs: latestRun.diagnostics.persistedLookupMs,
        persistedLookupTimedOut: latestRun.diagnostics.persistedLookupTimedOut,
        snapshotSource: latestRun.diagnostics.snapshotSource,
        payloadBytes: measurePayloadBytes(responseBody),
      });

      return mcpText(responseBody);
    })
  );

  server.registerTool(
    'dag.run.get',
    {
      title: 'Get DAG Run',
      description: 'Gets one DAG run summary by id.',
      annotations: { readOnlyHint: true },
      inputSchema: dagRunIdSchema,
    },
    wrapTool('dag.run.get', ctx, async (rawArgs: unknown) => {
      const args = dagRunIdSchema.parse(rawArgs);
      const run = await arcanosDagRunService.getRun(args.runId);
      if (!run) {
        return createDagNotFoundError(ctx, 'DAG run', { runId: args.runId });
      }

      return mcpText({ run });
    })
  );

  server.registerTool(
    'dag.run.wait',
    {
      title: 'Wait for DAG Run',
      description: 'Waits for one DAG run summary to advance past a known update timestamp.',
      annotations: { readOnlyHint: true },
      inputSchema: dagWaitSchema,
    },
    wrapTool('dag.run.wait', ctx, async (rawArgs: unknown) => {
      const args = dagWaitSchema.parse(rawArgs);
      const waitedRun = await arcanosDagRunService.waitForRunUpdate(args.runId, {
        updatedAfter: args.updatedAfter,
        waitForUpdateMs: args.waitForUpdateMs,
      });
      if (!waitedRun) {
        return createDagNotFoundError(ctx, 'DAG run', { runId: args.runId });
      }

      return mcpText(waitedRun);
    })
  );

  server.registerTool(
    'dag.run.trace',
    {
      title: 'Get DAG Trace',
      description: 'Gets a staged full DAG trace for one explicit run id, including tree, events, metrics, errors, lineage, and verification.',
      annotations: { readOnlyHint: true },
      inputSchema: dagTraceSchema,
    },
    wrapTool('dag.run.trace', ctx, async (rawArgs: unknown) => {
      const args = dagTraceSchema.parse(rawArgs);
      const inspection = await arcanosDagRunService.inspectRunTrace(args.runId, {
        maxEvents: args.maxEvents,
      });
      if (!inspection) {
        return createDagNotFoundError(ctx, 'DAG run', { runId: args.runId });
      }

      logDagInspection(ctx, 'dag.run.trace', {
        requestId: ctx.requestId,
        traceId: ctx.req?.traceId ?? ctx.requestId,
        runId: args.runId,
        durationMs: inspection.diagnostics.totalMs,
        snapshotSource: inspection.diagnostics.snapshotSource,
        localLookupMs: inspection.diagnostics.localLookupMs,
        persistedLookupMs: inspection.diagnostics.persistedLookupMs,
        buildRunMs: inspection.diagnostics.buildMs.run,
        buildTreeMs: inspection.diagnostics.buildMs.tree,
        buildEventsMs: inspection.diagnostics.buildMs.events,
        buildMetricsMs: inspection.diagnostics.buildMs.metrics,
        buildErrorsMs: inspection.diagnostics.buildMs.errors,
        buildLineageMs: inspection.diagnostics.buildMs.lineage,
        buildVerificationMs: inspection.diagnostics.buildMs.verification,
        payloadBytes: measurePayloadBytes(inspection.trace),
        totalNodes: inspection.diagnostics.payload.nodes,
        totalEvents: inspection.diagnostics.payload.totalEvents,
        returnedEvents: inspection.diagnostics.payload.returnedEvents,
        totalErrors: inspection.diagnostics.payload.errors,
        lineageEntries: inspection.diagnostics.payload.lineageEntries,
      });

      return mcpText(inspection.trace);
    })
  );

  server.registerTool(
    'dag.run.tree',
    {
      title: 'Get DAG Tree',
      description: 'Gets the DAG node tree for one run.',
      annotations: { readOnlyHint: true },
      inputSchema: dagRunIdSchema,
    },
    wrapTool('dag.run.tree', ctx, async (rawArgs: unknown) => {
      const args = dagRunIdSchema.parse(rawArgs);
      const tree = await arcanosDagRunService.getRunTree(args.runId);
      if (!tree) {
        return createDagNotFoundError(ctx, 'DAG run', { runId: args.runId });
      }

      return mcpText(tree);
    })
  );

  server.registerTool(
    'dag.run.node',
    {
      title: 'Get DAG Node',
      description: 'Gets one DAG node detail by run id and node id.',
      annotations: { readOnlyHint: true },
      inputSchema: dagNodeSchema,
    },
    wrapTool('dag.run.node', ctx, async (rawArgs: unknown) => {
      const args = dagNodeSchema.parse(rawArgs);
      const node = await arcanosDagRunService.getNode(args.runId, args.nodeId);
      if (!node) {
        return createDagNotFoundError(ctx, 'DAG node', { runId: args.runId, nodeId: args.nodeId });
      }

      return mcpText({ node });
    })
  );

  server.registerTool(
    'dag.run.events',
    {
      title: 'Get DAG Events',
      description: 'Gets the event log for one DAG run.',
      annotations: { readOnlyHint: true },
      inputSchema: dagRunIdSchema,
    },
    wrapTool('dag.run.events', ctx, async (rawArgs: unknown) => {
      const args = dagRunIdSchema.parse(rawArgs);
      const events = await arcanosDagRunService.getRunEvents(args.runId);
      if (!events) {
        return createDagNotFoundError(ctx, 'DAG run', { runId: args.runId });
      }

      return mcpText(events);
    })
  );

  server.registerTool(
    'dag.run.metrics',
    {
      title: 'Get DAG Metrics',
      description: 'Gets aggregate metrics and guard violations for one DAG run.',
      annotations: { readOnlyHint: true },
      inputSchema: dagRunIdSchema,
    },
    wrapTool('dag.run.metrics', ctx, async (rawArgs: unknown) => {
      const args = dagRunIdSchema.parse(rawArgs);
      const metrics = await arcanosDagRunService.getRunMetrics(args.runId);
      if (!metrics) {
        return createDagNotFoundError(ctx, 'DAG run', { runId: args.runId });
      }

      return mcpText(metrics);
    })
  );

  server.registerTool(
    'dag.run.errors',
    {
      title: 'Get DAG Errors',
      description: 'Gets the error log for one DAG run.',
      annotations: { readOnlyHint: true },
      inputSchema: dagRunIdSchema,
    },
    wrapTool('dag.run.errors', ctx, async (rawArgs: unknown) => {
      const args = dagRunIdSchema.parse(rawArgs);
      const errors = await arcanosDagRunService.getRunErrors(args.runId);
      if (!errors) {
        return createDagNotFoundError(ctx, 'DAG run', { runId: args.runId });
      }

      return mcpText(errors);
    })
  );

  server.registerTool(
    'dag.run.lineage',
    {
      title: 'Get DAG Lineage',
      description: 'Gets DAG lineage and loop-detection data for one run.',
      annotations: { readOnlyHint: true },
      inputSchema: dagRunIdSchema,
    },
    wrapTool('dag.run.lineage', ctx, async (rawArgs: unknown) => {
      const args = dagRunIdSchema.parse(rawArgs);
      const lineage = await arcanosDagRunService.getRunLineage(args.runId);
      if (!lineage) {
        return createDagNotFoundError(ctx, 'DAG run', { runId: args.runId });
      }

      return mcpText(lineage);
    })
  );

  server.registerTool(
    'dag.run.verification',
    {
      title: 'Get DAG Verification',
      description: 'Gets the verification summary for one DAG run.',
      annotations: { readOnlyHint: true },
      inputSchema: dagRunIdSchema,
    },
    wrapTool('dag.run.verification', ctx, async (rawArgs: unknown) => {
      const args = dagRunIdSchema.parse(rawArgs);
      const verification = await arcanosDagRunService.getRunVerification(args.runId);
      if (!verification) {
        return createDagNotFoundError(ctx, 'DAG run', { runId: args.runId });
      }

      return mcpText(verification);
    })
  );

  server.registerTool(
    'dag.run.cancel',
    {
      title: 'Cancel DAG Run',
      description: 'Cancels one DAG run by id.',
      annotations: { destructiveHint: true },
      inputSchema: dagCancelSchema,
    },
    wrapTool('dag.run.cancel', ctx, async (rawArgs: unknown) => {
      const args = dagCancelSchema.parse(rawArgs);
      const gate = requireNonceOrIssue(args, 'dag.run.cancel', ctx, stripConfirmationFields(args));
      if (!gate.ok) {
        return gate.error;
      }

      const cancelled = arcanosDagRunService.cancelRun(args.runId);
      if (!cancelled) {
        return createDagNotFoundError(ctx, 'DAG run', { runId: args.runId });
      }

      return mcpText(cancelled);
    })
  );
}
