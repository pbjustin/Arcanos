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
}

export interface DagTemplateDefinition {
  plannerNodeId: string | null;
  rootNodeId: string | null;
  graph: DAGGraph;
  nodeMetadataById: Record<string, DagTemplateNodeMetadata>;
}

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
  const normalizedTemplate = request.template.trim().toLowerCase();
  const goalText = getGoalText(request.input);

  //audit Assumption: the first public DAG contract only supports the verification pipeline; failure risk: callers believe arbitrary templates are available and receive a malformed graph; expected invariant: unknown templates are rejected explicitly; handling strategy: guard template selection before graph construction.
  if (![
    'default',
    'verification-default',
    'simple-4-node',
    'planner-research-build-audit-writer'
  ].includes(normalizedTemplate)) {
    throw new Error(`Unsupported DAG template "${request.template}".`);
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
    `Audit the planned work for correctness, risks, and regressions for: ${goalText}`;
  const writerPrompt =
    getStringInput(request.input, 'writerPrompt') ||
    `Merge the dependency outputs into a final answer for: ${goalText}`;

  const nodeMetadataById: Record<string, DagTemplateNodeMetadata> = {
    planner: {
      parentNodeId: null,
      agentRole: 'planner',
      jobType: 'plan'
    },
    research: {
      parentNodeId: 'planner',
      agentRole: 'research',
      jobType: 'search'
    },
    build: {
      parentNodeId: 'planner',
      agentRole: 'build',
      jobType: 'execute'
    },
    audit: {
      parentNodeId: 'planner',
      agentRole: 'audit',
      jobType: 'verify'
    },
    writer: {
      parentNodeId: 'planner',
      agentRole: 'writer',
      jobType: 'synthesize'
    }
  };

  return {
    plannerNodeId: 'planner',
    rootNodeId: 'writer',
    nodeMetadataById,
    graph: {
      id: request.template,
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
