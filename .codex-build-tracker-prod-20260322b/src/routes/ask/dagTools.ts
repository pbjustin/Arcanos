import type OpenAI from 'openai';
import { z } from 'zod';

import { buildFunctionToolSet, type FunctionToolDefinition } from '@services/openai/functionTools.js';
import { parseToolArgumentsWithSchema } from '@services/safety/aiOutputBoundary.js';
import { arcanosDagRunService } from '@services/arcanosDagRunService.js';
import { generateRequestId } from '@shared/idGenerator.js';

import { TRINITY_CORE_DAG_TEMPLATE_NAME } from '@dag/templates.js';
import {
  appendUniqueDeterministicOperation,
  buildToolAskResponse,
  executeDeterministicToolOperations,
  runAskToolMode,
  type DeterministicToolOperation,
  type ToolExecutionResult,
} from './toolRuntime.js';
import type { AskResponse } from './types.js';

const DAG_TOOL_SYSTEM_PROMPT = [
  'You are ARCANOS in DAG orchestration mode.',
  'Use DAG control tools only when the operator is asking to create, inspect, verify, or cancel DAG runs.',
  'Prefer reading capabilities or current run state before making assumptions about unsupported orchestration behavior.',
  'Use create_dag_run when the operator wants the planner/research/build/audit/writer workflow started for a goal.',
  'If the prompt is not about DAG orchestration, do not call any tools.',
].join(' ');

const dagControlToolDefinitions: FunctionToolDefinition[] = [
  {
    name: 'get_dag_capabilities',
    description: 'Get the public DAG orchestration feature flags and execution limits.',
    parameters: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'create_dag_run',
    description: 'Create a DAG verification run for a natural-language goal.',
    parameters: {
      type: 'object',
      properties: {
        goal: {
          type: 'string',
          description: 'The goal or task to execute through the DAG orchestration pipeline.',
        },
        template: {
          type: 'string',
          description: `Optional DAG template name. Defaults to "${TRINITY_CORE_DAG_TEMPLATE_NAME}".`,
        },
        sessionId: {
          type: 'string',
          description: 'Optional session identifier for run grouping.',
        },
        maxConcurrency: {
          type: 'integer',
          minimum: 1,
          maximum: 20,
          description: 'Optional DAG concurrency override.',
        },
        debug: {
          type: 'boolean',
          description: 'Optional debug flag for the run.',
        },
      },
      required: ['goal'],
    },
  },
  {
    name: 'get_dag_run',
    description: 'Get one DAG run summary by run id.',
    parameters: {
      type: 'object',
      properties: {
        runId: {
          type: 'string',
          description: 'The DAG run identifier to inspect.',
        },
      },
      required: ['runId'],
    },
  },
  {
    name: 'get_dag_tree',
    description: 'Get the node tree for one DAG run.',
    parameters: {
      type: 'object',
      properties: {
        runId: {
          type: 'string',
          description: 'The DAG run identifier to inspect.',
        },
      },
      required: ['runId'],
    },
  },
  {
    name: 'get_dag_node',
    description: 'Get one DAG node detail by run id and node id.',
    parameters: {
      type: 'object',
      properties: {
        runId: {
          type: 'string',
          description: 'The DAG run identifier to inspect.',
        },
        nodeId: {
          type: 'string',
          description: 'The DAG node identifier to inspect.',
        },
      },
      required: ['runId', 'nodeId'],
    },
  },
  {
    name: 'get_dag_events',
    description: 'Get the event log for one DAG run.',
    parameters: {
      type: 'object',
      properties: {
        runId: {
          type: 'string',
          description: 'The DAG run identifier to inspect.',
        },
      },
      required: ['runId'],
    },
  },
  {
    name: 'get_dag_metrics',
    description: 'Get metrics and guard violations for one DAG run.',
    parameters: {
      type: 'object',
      properties: {
        runId: {
          type: 'string',
          description: 'The DAG run identifier to inspect.',
        },
      },
      required: ['runId'],
    },
  },
  {
    name: 'get_dag_errors',
    description: 'Get the error log for one DAG run.',
    parameters: {
      type: 'object',
      properties: {
        runId: {
          type: 'string',
          description: 'The DAG run identifier to inspect.',
        },
      },
      required: ['runId'],
    },
  },
  {
    name: 'get_dag_lineage',
    description: 'Get the lineage graph for one DAG run.',
    parameters: {
      type: 'object',
      properties: {
        runId: {
          type: 'string',
          description: 'The DAG run identifier to inspect.',
        },
      },
      required: ['runId'],
    },
  },
  {
    name: 'cancel_dag_run',
    description: 'Cancel one DAG run by identifier.',
    parameters: {
      type: 'object',
      properties: {
        runId: {
          type: 'string',
          description: 'The DAG run identifier to cancel.',
        },
      },
      required: ['runId'],
    },
  },
  {
    name: 'get_dag_verification',
    description: 'Get the verification outcome for one DAG run.',
    parameters: {
      type: 'object',
      properties: {
        runId: {
          type: 'string',
          description: 'The DAG run identifier to inspect.',
        },
      },
      required: ['runId'],
    },
  },
];

const {
  chatCompletionTools: dagControlChatCompletionTools,
  responsesTools: dagControlResponsesTools,
} = buildFunctionToolSet(dagControlToolDefinitions);

const dagRunIdArgsSchema = z.object({
  runId: z.string().trim().min(1),
});

const dagNodeArgsSchema = z.object({
  runId: z.string().trim().min(1),
  nodeId: z.string().trim().min(1),
});

const createDagRunArgsSchema = z.object({
  goal: z.string().trim().min(1),
  template: z.string().trim().min(1).optional(),
  sessionId: z.string().trim().min(1).max(100).optional(),
  maxConcurrency: z.number().int().min(1).max(20).optional(),
  debug: z.boolean().optional(),
});

interface DagToolContext {
  sessionId?: string;
}

type DagControlToolName =
  | 'get_dag_capabilities'
  | 'create_dag_run'
  | 'get_dag_run'
  | 'get_dag_tree'
  | 'get_dag_node'
  | 'get_dag_events'
  | 'get_dag_metrics'
  | 'get_dag_errors'
  | 'get_dag_lineage'
  | 'cancel_dag_run'
  | 'get_dag_verification';

interface DeterministicDagOperation extends DeterministicToolOperation<DagControlToolName> {}

const dagRunIdPattern = /\b(dagrun[-_][a-z0-9_-]+)\b/i;
const dagNodeIdPattern = /\bnode(?:\s+id)?\s*[:#]?\s*([a-z][a-z0-9_-]{1,63})\b/i;
const dagCapabilitiesPattern =
  /\b(?:dag|workflow|orchestration|orchestrator)\b[^.!?\n]{0,40}\b(?:capabilities|limits|features)\b|\b(?:capabilities|limits|features)\b[^.!?\n]{0,40}\b(?:dag|workflow|orchestration|orchestrator)\b/i;
const dagCreatePattern =
  /\b(?:create|start|launch|run|kick\s*off)\b[^.!?\n]{0,30}\b(?:dag|workflow|orchestration|pipeline)\b(?:\s+run)?(?:\s+(?:for|to|about))?\s*[:\-]?\s*(.+)$/is;
const dagTreePattern = /\b(?:tree|graph|nodes?)\b/i;
const dagEventsPattern = /\b(?:events?|log)\b/i;
const dagMetricsPattern = /\b(?:metrics?|stats?|performance)\b/i;
const dagErrorsPattern = /\b(?:errors?|failures?)\b/i;
const dagLineagePattern = /\b(?:lineage|ancestry|parent\s+chain)\b/i;
const dagVerificationPattern = /\b(?:verification|verify|validated?)\b/i;
const dagCancelPattern = /\b(?:cancel|stop|abort)\b/i;
const dagTemplatePattern = /\btemplate\s*[:=]?\s*([a-z0-9_-]+)\b/i;

function looksLikeDagControlPrompt(prompt: string): boolean {
  const dagControlPatterns = [
    /\bdag\b/i,
    /\bworkflow\b/i,
    /\borchestrat(?:e|ion|or)\b/i,
    /\bverification pipeline\b/i,
    /\btask graph\b/i,
    /\blineage\b/i,
    /\bplanner\b[^.!?\n]{0,30}\bresearch\b/i,
    /\bresearch\b[^.!?\n]{0,30}\baudit\b/i,
  ];

  return dagControlPatterns.some(pattern => pattern.test(prompt));
}

/**
 * Extract a DAG run creation request from natural-language command text.
 *
 * Purpose:
 * - Support reliable DAG creation without requiring a model round-trip.
 *
 * Inputs/outputs:
 * - Input: operator prompt.
 * - Output: captured goal text, optional template, and match position or `null`.
 *
 * Edge case behavior:
 * - Rejects empty captured goals to avoid creating malformed DAG runs.
 */
function extractCreateDagRunRequest(
  prompt: string,
  context: DagToolContext,
): { args: Record<string, unknown>; matchIndex: number } | null {
  const match = dagCreatePattern.exec(prompt);
  const goal = match?.[1]?.trim();
  const template = dagTemplatePattern.exec(prompt)?.[1]?.trim();

  //audit Assumption: DAG run creation should require an explicit captured goal; failure risk: vague inspection prompts create unintended runs; expected invariant: non-empty goal text; handling strategy: reject missing captured goals.
  if (!match || typeof match.index !== 'number' || !goal) {
    return null;
  }

  return {
    matchIndex: match.index,
    args: {
      goal,
      template,
      sessionId: context.sessionId,
    },
  };
}

/**
 * Infer deterministic DAG operations from common orchestration phrases.
 *
 * Purpose:
 * - Make common DAG prompts reliable even when model tool selection is skipped.
 *
 * Inputs/outputs:
 * - Input: operator prompt and optional execution context.
 * - Output: ordered list of inferred DAG operations.
 *
 * Edge case behavior:
 * - Returns an empty list when no stable command pattern is found so model-based tool routing can continue.
 */
function collectDeterministicDagOperations(
  prompt: string,
  context: DagToolContext,
): DeterministicDagOperation[] {
  const operations: DeterministicDagOperation[] = [];
  const runIdMatch = dagRunIdPattern.exec(prompt);
  const nodeIdMatch = dagNodeIdPattern.exec(prompt);
  const capabilitiesMatch = dagCapabilitiesPattern.exec(prompt);
  const createDagRun = extractCreateDagRunRequest(prompt, context);

  appendUniqueDeterministicOperation(operations, capabilitiesMatch?.index, 'get_dag_capabilities');

  if (runIdMatch?.[1]) {
    const runId = runIdMatch[1];

    appendUniqueDeterministicOperation(
      operations,
      dagVerificationPattern.exec(prompt)?.index,
      'get_dag_verification',
      { runId },
    );
    appendUniqueDeterministicOperation(
      operations,
      dagMetricsPattern.exec(prompt)?.index,
      'get_dag_metrics',
      { runId },
    );
    appendUniqueDeterministicOperation(
      operations,
      dagErrorsPattern.exec(prompt)?.index,
      'get_dag_errors',
      { runId },
    );
    appendUniqueDeterministicOperation(
      operations,
      dagLineagePattern.exec(prompt)?.index,
      'get_dag_lineage',
      { runId },
    );
    appendUniqueDeterministicOperation(
      operations,
      dagEventsPattern.exec(prompt)?.index,
      'get_dag_events',
      { runId },
    );
    appendUniqueDeterministicOperation(
      operations,
      dagCancelPattern.exec(prompt)?.index,
      'cancel_dag_run',
      { runId },
    );

    if (nodeIdMatch?.[1]) {
      appendUniqueDeterministicOperation(operations, nodeIdMatch.index, 'get_dag_node', {
        runId,
        nodeId: nodeIdMatch[1],
      });
    }

    appendUniqueDeterministicOperation(
      operations,
      dagTreePattern.exec(prompt)?.index,
      'get_dag_tree',
      { runId },
    );

    //audit Assumption: a run id without a more specific selector implies summary inspection; failure risk: prompt returns nothing for simple "show run" requests; expected invariant: one summary fetch for bare run-id prompts; handling strategy: append run summary last so more specific operations still execute first.
    appendUniqueDeterministicOperation(operations, runIdMatch.index, 'get_dag_run', { runId });
  }

  if (createDagRun) {
    appendUniqueDeterministicOperation(
      operations,
      createDagRun.matchIndex,
      'create_dag_run',
      createDagRun.args,
    );
  }

  return operations.sort((left, right) => left.matchIndex - right.matchIndex);
}

function summarizeDagTree(nodes: unknown): string {
  if (!Array.isArray(nodes) || nodes.length === 0) {
    return 'no nodes recorded';
  }

  const summarizedNodes = nodes
    .slice(0, 5)
    .map(node => {
      const typedNode = node as { nodeId?: string; status?: string };
      return `${typedNode.nodeId ?? 'unknown'}=${typedNode.status ?? 'unknown'}`;
    })
    .join(', ');

  return summarizedNodes;
}

function summarizeDagToolExecution(toolName: string, payload: Record<string, unknown>): string {
  switch (toolName) {
    case 'get_dag_capabilities': {
      const features = payload.features as Record<string, unknown> | undefined;
      const limits = payload.limits as Record<string, unknown> | undefined;
      return `DAG capabilities: orchestration=${features?.dagOrchestration ?? 'unknown'}, parallel=${features?.parallelExecution ?? 'unknown'}, maxConcurrency=${limits?.maxConcurrency ?? 'unknown'}, maxDepth=${limits?.maxSpawnDepth ?? 'unknown'}.`;
    }
    case 'create_dag_run':
      return `Started DAG run ${payload.runId ?? 'unknown'} with pipeline=${payload.pipeline ?? 'unknown'}, template=${payload.template ?? 'unknown'}, and status=${payload.status ?? 'unknown'}.`;
    case 'get_dag_run':
      return `DAG run ${payload.runId ?? 'unknown'} uses pipeline=${payload.pipeline ?? 'unknown'}, template=${payload.template ?? 'unknown'}, status=${payload.status ?? 'unknown'}, completedNodes=${payload.completedNodes ?? 'unknown'}, and failedNodes=${payload.failedNodes ?? 'unknown'}.`;
    case 'get_dag_tree':
      return `DAG tree for ${payload.runId ?? 'unknown'}: ${summarizeDagTree(payload.nodes)}.`;
    case 'get_dag_node':
      return `DAG node ${payload.nodeId ?? 'unknown'} in ${payload.runId ?? 'unknown'} is ${payload.status ?? 'unknown'} on attempt=${payload.attempt ?? 'unknown'}.`;
    case 'get_dag_events': {
      const events = Array.isArray(payload.events) ? payload.events : [];
      const latestEvent = events.at(-1) as { type?: string } | undefined;
      return `DAG events for ${payload.runId ?? 'unknown'}: count=${events.length}, latest=${latestEvent?.type ?? 'none'}.`;
    }
    case 'get_dag_metrics':
      return `DAG metrics for ${payload.runId ?? 'unknown'}: totalNodes=${payload.totalNodes ?? 'unknown'}, maxParallel=${payload.maxParallelNodesObserved ?? 'unknown'}, retries=${payload.totalRetries ?? 'unknown'}, failures=${payload.totalFailures ?? 'unknown'}.`;
    case 'get_dag_errors': {
      const errors = Array.isArray(payload.errors) ? payload.errors : [];
      const latestError = errors.at(-1) as { message?: string } | undefined;
      return `DAG errors for ${payload.runId ?? 'unknown'}: count=${errors.length}${latestError?.message ? `, latest="${latestError.message}"` : ''}.`;
    }
    case 'get_dag_lineage':
      return `DAG lineage for ${payload.runId ?? 'unknown'}: entries=${payload.entryCount ?? 'unknown'}, loopDetected=${payload.loopDetected ?? 'unknown'}.`;
    case 'cancel_dag_run': {
      const cancelledNodes = Array.isArray(payload.cancelledNodes) ? payload.cancelledNodes.length : 0;
      return `Cancelled DAG run ${payload.runId ?? 'unknown'} with ${cancelledNodes} node(s) marked cancelled.`;
    }
    case 'get_dag_verification':
      return `DAG verification for ${payload.runId ?? 'unknown'}: runCompleted=${payload.runCompleted ?? 'unknown'}, parallelExecutionObserved=${payload.parallelExecutionObserved ?? 'unknown'}, aggregationRanLast=${payload.aggregationRanLast ?? 'unknown'}.`;
    default:
      return `Executed ${toolName}.`;
  }
}

async function executeDagTool(
  toolName: string,
  rawArgs: string,
  context: DagToolContext,
): Promise<ToolExecutionResult> {
  switch (toolName) {
    case 'get_dag_capabilities': {
      const output = {
        features: arcanosDagRunService.getFeatureFlags(),
        limits: arcanosDagRunService.getExecutionLimits(),
      };
      return {
        output,
        summary: summarizeDagToolExecution(toolName, output),
      };
    }
    case 'create_dag_run': {
      const parsedArgs = parseToolArgumentsWithSchema(rawArgs, createDagRunArgsSchema, 'dagTools.create_dag_run');
      const output = await arcanosDagRunService.createRun({
        sessionId: parsedArgs.sessionId ?? context.sessionId ?? generateRequestId('session'),
        template: parsedArgs.template ?? TRINITY_CORE_DAG_TEMPLATE_NAME,
        input: {
          goal: parsedArgs.goal,
        },
        options: {
          maxConcurrency: parsedArgs.maxConcurrency,
          debug: parsedArgs.debug,
        },
      });
      return {
        output: output as unknown as Record<string, unknown>,
        summary: summarizeDagToolExecution(toolName, output as unknown as Record<string, unknown>),
      };
    }
    case 'get_dag_run': {
      const parsedArgs = parseToolArgumentsWithSchema(rawArgs, dagRunIdArgsSchema, 'dagTools.get_dag_run');
      const output = await arcanosDagRunService.getRun(parsedArgs.runId);
      const normalizedOutput = (output ?? { runId: parsedArgs.runId, status: 'not_found' }) as Record<string, unknown>;
      return {
        output: normalizedOutput,
        summary: output
          ? summarizeDagToolExecution(toolName, normalizedOutput)
          : `DAG run ${parsedArgs.runId} was not found.`,
      };
    }
    case 'get_dag_tree': {
      const parsedArgs = parseToolArgumentsWithSchema(rawArgs, dagRunIdArgsSchema, 'dagTools.get_dag_tree');
      const output = await arcanosDagRunService.getRunTree(parsedArgs.runId);
      const normalizedOutput = output
        ? { runId: output.runId, nodes: output.nodes }
        : { runId: parsedArgs.runId, status: 'not_found', nodes: [] };
      return {
        output: normalizedOutput,
        summary: output
          ? summarizeDagToolExecution(toolName, normalizedOutput)
          : `DAG tree for ${parsedArgs.runId} was not found.`,
      };
    }
    case 'get_dag_node': {
      const parsedArgs = parseToolArgumentsWithSchema(rawArgs, dagNodeArgsSchema, 'dagTools.get_dag_node');
      const output = await arcanosDagRunService.getNode(parsedArgs.runId, parsedArgs.nodeId);
      const normalizedOutput = (output ?? {
        runId: parsedArgs.runId,
        nodeId: parsedArgs.nodeId,
        status: 'not_found',
      }) as Record<string, unknown>;
      return {
        output: normalizedOutput,
        summary: output
          ? summarizeDagToolExecution(toolName, normalizedOutput)
          : `DAG node ${parsedArgs.nodeId} in ${parsedArgs.runId} was not found.`,
      };
    }
    case 'get_dag_events': {
      const parsedArgs = parseToolArgumentsWithSchema(rawArgs, dagRunIdArgsSchema, 'dagTools.get_dag_events');
      const output = await arcanosDagRunService.getRunEvents(parsedArgs.runId);
      const normalizedOutput = output
        ? { runId: output.runId, events: output.events }
        : { runId: parsedArgs.runId, status: 'not_found', events: [] };
      return {
        output: normalizedOutput,
        summary: output
          ? summarizeDagToolExecution(toolName, normalizedOutput)
          : `DAG events for ${parsedArgs.runId} were not found.`,
      };
    }
    case 'get_dag_metrics': {
      const parsedArgs = parseToolArgumentsWithSchema(rawArgs, dagRunIdArgsSchema, 'dagTools.get_dag_metrics');
      const output = await arcanosDagRunService.getRunMetrics(parsedArgs.runId);
      const normalizedOutput = output
        ? { runId: output.runId, ...output.metrics }
        : { runId: parsedArgs.runId, status: 'not_found' };
      return {
        output: normalizedOutput,
        summary: output
          ? summarizeDagToolExecution(toolName, normalizedOutput)
          : `DAG metrics for ${parsedArgs.runId} were not found.`,
      };
    }
    case 'get_dag_errors': {
      const parsedArgs = parseToolArgumentsWithSchema(rawArgs, dagRunIdArgsSchema, 'dagTools.get_dag_errors');
      const output = await arcanosDagRunService.getRunErrors(parsedArgs.runId);
      const normalizedOutput = output
        ? { runId: output.runId, errors: output.errors }
        : { runId: parsedArgs.runId, status: 'not_found', errors: [] };
      return {
        output: normalizedOutput,
        summary: output
          ? summarizeDagToolExecution(toolName, normalizedOutput)
          : `DAG errors for ${parsedArgs.runId} were not found.`,
      };
    }
    case 'get_dag_lineage': {
      const parsedArgs = parseToolArgumentsWithSchema(rawArgs, dagRunIdArgsSchema, 'dagTools.get_dag_lineage');
      const output = await arcanosDagRunService.getRunLineage(parsedArgs.runId);
      const normalizedOutput = output
        ? {
            runId: output.runId,
            entryCount: output.lineage.length,
            loopDetected: output.loopDetected,
            lineage: output.lineage,
          }
        : { runId: parsedArgs.runId, status: 'not_found', entryCount: 0, loopDetected: false };
      return {
        output: normalizedOutput,
        summary: output
          ? summarizeDagToolExecution(toolName, normalizedOutput)
          : `DAG lineage for ${parsedArgs.runId} was not found.`,
      };
    }
    case 'cancel_dag_run': {
      const parsedArgs = parseToolArgumentsWithSchema(rawArgs, dagRunIdArgsSchema, 'dagTools.cancel_dag_run');
      const output = arcanosDagRunService.cancelRun(parsedArgs.runId);
      const normalizedOutput = output
        ? {
            runId: output.runId,
            status: output.status,
            cancelledNodes: output.cancelledNodes,
          }
        : { runId: parsedArgs.runId, status: 'not_found', cancelledNodes: [] };
      return {
        output: normalizedOutput,
        summary: output
          ? summarizeDagToolExecution(toolName, normalizedOutput)
          : `DAG run ${parsedArgs.runId} was not found for cancellation.`,
      };
    }
    case 'get_dag_verification': {
      const parsedArgs = parseToolArgumentsWithSchema(rawArgs, dagRunIdArgsSchema, 'dagTools.get_dag_verification');
      const output = await arcanosDagRunService.getRunVerification(parsedArgs.runId);
      const normalizedOutput = output
        ? { runId: output.runId, ...output.verification }
        : { runId: parsedArgs.runId, status: 'not_found' };
      return {
        output: normalizedOutput,
        summary: output
          ? summarizeDagToolExecution(toolName, normalizedOutput)
          : `DAG verification for ${parsedArgs.runId} was not found.`,
      };
    }
    default:
      throw new Error(`Unsupported DAG tool: ${toolName}`);
  }
}

/**
 * Attempt to control DAG orchestration through natural-language tool-calling.
 *
 * Purpose:
 * - Give operators a natural-language `/ask` path for DAG runs, inspection, and verification without changing the HTTP DAG API.
 *
 * Inputs/outputs:
 * - Input: OpenAI client, prompt text, and optional request context such as session id.
 * - Output: DAG-tool AskResponse when DAG tools execute; `null` when the prompt should continue through normal ask routing.
 *
 * Edge case behavior:
 * - Non-DAG prompts return `null` so worker tools and the standard ask flow remain unchanged.
 */
export async function tryDispatchDagTools(
  client: OpenAI,
  prompt: string,
  context: DagToolContext = {},
): Promise<AskResponse | null> {
  if (!looksLikeDagControlPrompt(prompt)) {
    return null;
  }

  const deterministicSummary = await executeDeterministicToolOperations(
    collectDeterministicDagOperations(prompt, context),
    (toolName, rawArgs) => executeDagTool(toolName, rawArgs, context),
  );
  if (deterministicSummary) {
    return buildToolAskResponse('dag-tools', null, deterministicSummary, 'dag-tool');
  }

  //audit Assumption: OpenAI client must expose at least one tool-capable API; failure risk: DAG control prompts silently fail; expected invariant: either Responses or Chat Completions is available; handling strategy: throw explicit capability error.
  //audit Assumption: tool execution errors should remain visible to the model loop; failure risk: silent orchestration failure; expected invariant: the model receives structured tool failure output; handling strategy: serialize the error into function_call_output.
  return runAskToolMode({
    client,
    prompt,
    instructions: DAG_TOOL_SYSTEM_PROMPT,
    moduleName: 'dag-tools',
    responseIdPrefix: 'dag-tool',
    chatCompletionTools: dagControlChatCompletionTools,
    responsesTools: dagControlResponsesTools,
    executeTool: (toolName, rawArgs) => executeDagTool(toolName, rawArgs, context),
    maxOutputTokens: 512,
  });
}
