import type { DAGGraph } from './dagGraph.js';
import type { DAGNode } from './dagNode.js';
import type {
  AgentRole,
  CreateDagRunRequest,
  JobType
} from '../shared/types/arcanos-verification-contract.types.js';

export interface DagTemplateNodeMetadata {
  parentNodeId: string | null;
  agentRole: AgentRole;
  jobType: JobType;
  pipeline: 'trinity';
  pipelineTemplate: typeof TRINITY_CORE_DAG_TEMPLATE_NAME;
}

export interface DagTemplateDefinition {
  templateName: string;
  plannerNodeId: string | null;
  rootNodeId: string | null;
  graph: DAGGraph;
  nodeMetadataById: Record<string, DagTemplateNodeMetadata>;
}

export const TRINITY_CORE_DAG_TEMPLATE_NAME = 'trinity-core';

export class UnsupportedDagTemplateError extends Error {
  readonly templateName: string;

  constructor(templateName: string) {
    super(`Unsupported DAG template "${templateName}".`);
    this.name = 'UnsupportedDagTemplateError';
    this.templateName = templateName;
  }
}

const LEGACY_TRINITY_DAG_TEMPLATE_ALIASES = new Set([
  'default',
  'verification-default',
  'simple-4-node',
  'planner-research-build-audit-writer',
  'archetype-v2'
]);

function getStringInput(input: Record<string, unknown>, key: string): string | null {
  const rawValue = input[key];
  return typeof rawValue === 'string' && rawValue.trim().length > 0
    ? rawValue.trim()
    : null;
}

function getGoalText(input: Record<string, unknown>): string {
  return (
    getStringInput(input, 'goal') ||
    getStringInput(input, 'task') ||
    getStringInput(input, 'prompt') ||
    getStringInput(input, 'topic') ||
    'Produce a verified final answer.'
  );
}

function createAgentNode(
  nodeId: string,
  dependencies: string[],
  executionKey: string,
  payload: Record<string, unknown>,
  metadata: DagTemplateNodeMetadata
): DAGNode {
  return {
    id: nodeId,
    type: 'agent',
    dependencies,
    executionKey,
    metadata: {
      ...metadata,
      ...payload
    }
  };
}

/**
 * Resolve one requested DAG template name to the canonical public template label.
 *
 * Purpose:
 * - Keep legacy DAG aliases working while exposing one stable Trinity template name to probes and clients.
 *
 * Inputs/outputs:
 * - Input: raw caller-provided template name.
 * - Output: canonical public template label for supported Trinity graphs, otherwise the normalized original name.
 *
 * Edge case behavior:
 * - Returns the normalized input for unknown names so callers can decide whether to reject or pass through.
 */
export function resolvePublicDagTemplateName(templateName: string): string {
  const normalizedTemplateName = templateName.trim().toLowerCase();

  //audit Assumption: multiple legacy DAG aliases still point to the same Trinity graph; failure risk: external probes misclassify identical runs as different pipelines; expected invariant: supported Trinity aliases collapse to one public label; handling strategy: normalize legacy names to the canonical Trinity template name before public exposure.
  if (
    normalizedTemplateName === TRINITY_CORE_DAG_TEMPLATE_NAME ||
    LEGACY_TRINITY_DAG_TEMPLATE_ALIASES.has(normalizedTemplateName)
  ) {
    return TRINITY_CORE_DAG_TEMPLATE_NAME;
  }

  return normalizedTemplateName;
}

/**
 * Build a DAG template supported by the verification API.
 *
 * Purpose:
 * - Convert one public template name into a graph and stable node metadata used by the API layer.
 *
 * Inputs/outputs:
 * - Input: verified create-run request payload.
 * - Output: graph plus planner/root node identifiers and node metadata.
 *
 * Edge case behavior:
 * - Throws when the template name is unknown so callers can return a clean `400`.
 */
export function buildDagTemplate(request: CreateDagRunRequest): DagTemplateDefinition {
  const normalizedTemplate = resolvePublicDagTemplateName(request.template);
  const goalText = getGoalText(request.input);

  //audit Assumption: the first public DAG contract only supports the verification pipeline; failure risk: callers believe arbitrary templates are available and receive a malformed graph; expected invariant: unknown templates are rejected explicitly; handling strategy: guard template selection before graph construction.
  if (normalizedTemplate !== TRINITY_CORE_DAG_TEMPLATE_NAME) {
    throw new UnsupportedDagTemplateError(request.template);
  }

  const plannerPrompt =
    getStringInput(request.input, 'plannerPrompt') ||
    `Plan a small DAG execution for this goal: ${goalText}`;
  const researchPrompt =
    getStringInput(request.input, 'researchPrompt') ||
    `Research the relevant context for: ${goalText}`;
  const buildPrompt =
    getStringInput(request.input, 'buildPrompt') ||
    `Produce the implementation or build-oriented output for: ${goalText}`;
  const auditPrompt =
    getStringInput(request.input, 'auditPrompt') ||
    `Validate the planned work using only the provided dependency outputs. Check correctness, risks, regressions, and output-contract compliance for: ${goalText}`;
  const writerPrompt =
    getStringInput(request.input, 'writerPrompt') ||
    `Merge the dependency outputs into a final answer for: ${goalText}`;

  const nodeMetadataById: Record<string, DagTemplateNodeMetadata> = {
    planner: {
      parentNodeId: null,
      agentRole: 'planner',
      jobType: 'plan',
      pipeline: 'trinity',
      pipelineTemplate: TRINITY_CORE_DAG_TEMPLATE_NAME
    },
    research: {
      parentNodeId: 'planner',
      agentRole: 'research',
      jobType: 'search',
      pipeline: 'trinity',
      pipelineTemplate: TRINITY_CORE_DAG_TEMPLATE_NAME
    },
    build: {
      parentNodeId: 'planner',
      agentRole: 'build',
      jobType: 'execute',
      pipeline: 'trinity',
      pipelineTemplate: TRINITY_CORE_DAG_TEMPLATE_NAME
    },
    audit: {
      parentNodeId: 'planner',
      agentRole: 'audit',
      jobType: 'verify',
      pipeline: 'trinity',
      pipelineTemplate: TRINITY_CORE_DAG_TEMPLATE_NAME
    },
    writer: {
      parentNodeId: 'planner',
      agentRole: 'writer',
      jobType: 'synthesize',
      pipeline: 'trinity',
      pipelineTemplate: TRINITY_CORE_DAG_TEMPLATE_NAME
    }
  };

  return {
    templateName: normalizedTemplate,
    plannerNodeId: 'planner',
    rootNodeId: 'writer',
    nodeMetadataById,
    graph: {
      id: normalizedTemplate,
      nodes: {
        planner: createAgentNode('planner', [], 'planner', {
          prompt: plannerPrompt
        }, nodeMetadataById.planner),
        research: createAgentNode('research', ['planner'], 'research', {
          prompt: researchPrompt
        }, nodeMetadataById.research),
        build: createAgentNode('build', ['planner'], 'build', {
          prompt: buildPrompt
        }, nodeMetadataById.build),
        audit: createAgentNode('audit', ['planner'], 'audit', {
          prompt: auditPrompt
        }, nodeMetadataById.audit),
        writer: createAgentNode('writer', ['research', 'build', 'audit'], 'writer', {
          prompt: writerPrompt
        }, nodeMetadataById.writer)
      },
      edges: [
        { from: 'planner', to: 'research' },
        { from: 'planner', to: 'build' },
        { from: 'planner', to: 'audit' },
        { from: 'research', to: 'writer' },
        { from: 'build', to: 'writer' },
        { from: 'audit', to: 'writer' }
      ],
      entrypoints: ['planner']
    }
  };
}
