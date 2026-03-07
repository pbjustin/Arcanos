import type { CognitiveDomain } from '../shared/types/cognitiveDomain.js';
import type { DAGNodeExecutionContext, DAGResult } from '../dag/dagNode.js';

export interface DagAgentPromptOptions {
  sessionId?: string;
  overrideAuditSafe?: string;
  cognitiveDomain?: CognitiveDomain;
  sourceEndpoint: string;
}

export interface DagAgentExecutionHelpers {
  runPrompt(prompt: string, options: DagAgentPromptOptions): Promise<unknown>;
}

export type DagAgentHandler = (
  context: DAGNodeExecutionContext,
  helpers: DagAgentExecutionHelpers
) => Promise<unknown>;

const MAX_DEPENDENCY_OUTPUT_CHARACTERS = 1200;
const MAX_DEPENDENCY_SUMMARY_CHARACTERS = 3600;

function truncateText(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }

  //audit Assumption: downstream DAG prompts need bounded dependency context; failure risk: oversized prompts exceed token budgets and starve later nodes; expected invariant: serialized dependency text stays within configured caps; handling strategy: truncate with an explicit marker instead of dropping the field silently.
  return `${value.slice(0, Math.max(0, maxLength - 24))}...[truncated ${value.length - maxLength} chars]`;
}

function summarizeDependencyOutput(output: unknown): string {
  if (typeof output === 'string') {
    return truncateText(output, MAX_DEPENDENCY_OUTPUT_CHARACTERS);
  }

  if (output && typeof output === 'object' && !Array.isArray(output)) {
    const typedOutput = output as {
      summary?: unknown;
      result?: unknown;
      value?: unknown;
    };

    if (typeof typedOutput.summary === 'string' && typedOutput.summary.trim().length > 0) {
      return truncateText(typedOutput.summary.trim(), MAX_DEPENDENCY_OUTPUT_CHARACTERS);
    }

    if (typeof typedOutput.result === 'string' && typedOutput.result.trim().length > 0) {
      return truncateText(typedOutput.result.trim(), MAX_DEPENDENCY_OUTPUT_CHARACTERS);
    }

    if (typeof typedOutput.value === 'string' && typedOutput.value.trim().length > 0) {
      return truncateText(typedOutput.value.trim(), MAX_DEPENDENCY_OUTPUT_CHARACTERS);
    }
  }

  try {
    return truncateText(JSON.stringify(output), MAX_DEPENDENCY_OUTPUT_CHARACTERS);
  } catch {
    return '[Unserializable dependency output]';
  }
}

function serializeDependencyResults(dependencyResults: Record<string, DAGResult>): string {
  const serializedDependencies = Object.values(dependencyResults)
    .map(result => {
      return [
        `Dependency Node: ${result.nodeId}`,
        `Status: ${result.status}`,
        `Output: ${summarizeDependencyOutput(result.output)}`
      ].join('\n');
    })
    .join('\n\n');

  return truncateText(serializedDependencies, MAX_DEPENDENCY_SUMMARY_CHARACTERS);
}

function extractPromptFromPayload(payload: Record<string, unknown>): string | null {
  const candidateKeys = ['prompt', 'input', 'task', 'instruction'];

  for (const candidateKey of candidateKeys) {
    const rawValue = payload[candidateKey];
    if (typeof rawValue === 'string' && rawValue.trim().length > 0) {
      return rawValue.trim();
    }
  }

  return null;
}

function inferAgentDomain(agentKey: string): CognitiveDomain {
  switch (agentKey) {
    case 'build':
      return 'code';
    case 'audit':
      return 'diagnostic';
    case 'planner':
      return 'execution';
    case 'research':
    case 'write':
    case 'writer':
    default:
      return 'natural';
  }
}

function buildSyntheticDagAgentSessionId(context: DAGNodeExecutionContext): string {
  return [
    'dag',
    context.dagId || 'unknown',
    context.node.id,
    `a${context.attempt}`
  ].join(':');
}

function resolveDagAgentSessionId(context: DAGNodeExecutionContext): string {
  const sharedSessionId =
    typeof context.sharedState.sessionId === 'string'
      ? context.sharedState.sessionId.trim()
      : '';

  //audit Assumption: DAG worker calls should reuse the originating request session when the orchestrator provided one; failure risk: worker-side Trinity calls drift from the main server pipeline and lose shared memory or lineage continuity; expected invariant: non-empty sharedState.sessionId wins, otherwise DAG execution still falls back to a deterministic synthetic session; handling strategy: prefer the inherited session id and preserve the legacy fallback for standalone DAG runs.
  if (sharedSessionId.length > 0) {
    return sharedSessionId;
  }

  return buildSyntheticDagAgentSessionId(context);
}

function buildAgentPrompt(
  agentKey: string,
  context: DAGNodeExecutionContext
): string {
  const dependencySummary = serializeDependencyResults(context.dependencyResults);
  const explicitPrompt = extractPromptFromPayload(context.payload);

  //audit Assumption: synthesis nodes can operate with dependency outputs alone; failure risk: writer nodes fail even when upstream work is complete; expected invariant: writer-like nodes may omit an explicit prompt; handling strategy: supply a safe synthesis default for writer aliases.
  if (!explicitPrompt && (agentKey === 'write' || agentKey === 'writer')) {
    return [
      'You are the DAG writer node.',
      'Synthesize the dependency outputs into a cohesive final response.',
      dependencySummary ? `Dependency Outputs:\n${dependencySummary}` : 'No dependency outputs were provided.'
    ].join('\n\n');
  }

  //audit Assumption: non-writer agents need a concrete prompt to avoid ambiguous or runaway AI calls; failure risk: generic nodes consume budget without a defined task; expected invariant: non-writer nodes provide payload.prompt, payload.input, payload.task, or payload.instruction; handling strategy: fail fast with a precise error.
  if (!explicitPrompt) {
    throw new Error(
      `DAG agent "${agentKey}" requires payload.prompt, payload.input, payload.task, or payload.instruction.`
    );
  }

  const promptSections = [
    `You are the ${agentKey} DAG agent for node "${context.node.id}".`,
    `Task:\n${explicitPrompt}`
  ];

  if (dependencySummary) {
    promptSections.push(`Dependency Outputs:\n${dependencySummary}`);
  }

  return promptSections.join('\n\n');
}

function createPromptAgent(agentKey: string): DagAgentHandler {
  return async (context, helpers) => {
    const prompt = buildAgentPrompt(agentKey, context);
    const overrideAuditSafe = typeof context.payload.overrideAuditSafe === 'string'
      ? context.payload.overrideAuditSafe
      : undefined;
    const sessionId = resolveDagAgentSessionId(context);

    return helpers.runPrompt(prompt, {
      sessionId,
      overrideAuditSafe,
      cognitiveDomain: inferAgentDomain(agentKey),
      sourceEndpoint: `dag.agent.${agentKey}`
    });
  };
}

export const AGENTS: Record<string, DagAgentHandler> = {
  planner: createPromptAgent('planner'),
  research: createPromptAgent('research'),
  build: createPromptAgent('build'),
  audit: createPromptAgent('audit'),
  write: createPromptAgent('write'),
  writer: createPromptAgent('writer')
};
