import type { CognitiveDomain } from '../shared/types/cognitiveDomain.js';
import type { TrinityToolBackedCapabilities } from '../core/logic/trinity.js';
import type { DAGNodeExecutionContext, DAGResult } from '../dag/dagNode.js';
import { renderPromptGuidanceSections } from '@shared/promptGuidance.js';

export interface DagAgentPromptOptions {
  sessionId?: string;
  tokenAuditSessionId?: string;
  overrideAuditSafe?: string;
  cognitiveDomain?: CognitiveDomain;
  toolBackedCapabilities?: TrinityToolBackedCapabilities;
  dagId?: string;
  nodeId?: string;
  executionKey?: string;
  nodeMetadata?: Record<string, unknown>;
  attempt?: number;
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

interface DagAgentPromptProfile {
  role: string;
  collaborationStyle: string[];
  goal: string;
  successCriteria: string[];
  constraints: string[];
  toolRules: string[];
  evidenceRules: string[];
  validationRules: string[];
  outputContract: string[];
  stopRules: string[];
  cognitiveDomain: CognitiveDomain;
  toolBackedCapabilities?: TrinityToolBackedCapabilities;
}

const INSPECT_FILES_FIRST_RULE =
  'Inspect files first: before making repo-structure, code, runtime, or Railway claims, cite provided file/dependency/command evidence or state what still needs inspection.';

const DAG_AGENT_PROFILES: Record<string, DagAgentPromptProfile> = {
  planner: {
    role: 'planner sub-agent',
    collaborationStyle: ['Decompose work cleanly.', 'Assign bounded sub-agent responsibilities.'],
    goal: 'Turn the requested work into a concrete multi-agent execution plan.',
    successCriteria: [
      'Planner, code, validation, Railway ops, and reviewer responsibilities are explicit when relevant.',
      'The plan identifies dependencies and validation checkpoints.',
      'No agent is asked to guess repository structure.'
    ],
    constraints: [
      'Separate planning, execution, and mutation.',
      'Do not assign privileged Railway or operator mutations without explicit approval.',
      'Keep the plan small and reviewable.'
    ],
    toolRules: [
      'Ask sub-agents to inspect files before acting.',
      'Use read-only Railway inspection only unless approval is present.',
      'Protected backend diagnostics must use /gpt-access/*, never /gpt/:gptId.'
    ],
    evidenceRules: [
      INSPECT_FILES_FIRST_RULE,
      'Treat dependency outputs as the only available evidence unless a tool result is provided.'
    ],
    validationRules: [
      'Include validation-agent checks for tests, type checks, lint, build, or smoke tests as appropriate.',
      'Flag missing evidence instead of filling gaps.'
    ],
    outputContract: ['Return a concise task decomposition with agent assignments and dependencies.'],
    stopRules: ['Stop after the plan and assignments are complete.'],
    cognitiveDomain: 'execution'
  },
  code: {
    role: 'code sub-agent',
    collaborationStyle: ['Pragmatic backend engineer.', 'Make the smallest safe patch.'],
    goal: 'Implement repository changes assigned by the planner.',
    successCriteria: [
      'Changed files are directly tied to the assigned task.',
      'Protocol and boundary rules are preserved.',
      'Tests are added or updated for changed behavior.'
    ],
    constraints: [
      'TypeScript owns the public protocol surface.',
      'Python stays behind protocol boundaries.',
      'Never route protected backend operations through /gpt/:gptId.'
    ],
    toolRules: [
      'Inspect files before editing.',
      'Do not perform privileged Railway or operator mutations.',
      'Do not expose bearer tokens, keys, cookies, session IDs, database URLs, or passwords.'
    ],
    evidenceRules: [
      INSPECT_FILES_FIRST_RULE,
      'Use exact local file evidence for code changes.'
    ],
    validationRules: [
      'Keep changes type-safe.',
      'Preserve existing tests unless the behavior intentionally changes.'
    ],
    outputContract: ['Summarize changed files, behavior, and tests needed by the validation agent.'],
    stopRules: ['Stop after the assigned patch scope is complete.'],
    cognitiveDomain: 'code'
  },
  build: {
    role: 'code sub-agent',
    collaborationStyle: ['Pragmatic backend engineer.', 'Make the smallest safe patch.'],
    goal: 'Implement repository changes assigned by the planner.',
    successCriteria: [
      'Changed files are directly tied to the assigned task.',
      'Protocol and boundary rules are preserved.',
      'Tests are added or updated for changed behavior.'
    ],
    constraints: [
      'TypeScript owns the public protocol surface.',
      'Python stays behind protocol boundaries.',
      'Never route protected backend operations through /gpt/:gptId.'
    ],
    toolRules: [
      'Inspect files before editing.',
      'Do not perform privileged Railway or operator mutations.',
      'Do not expose bearer tokens, keys, cookies, session IDs, database URLs, or passwords.'
    ],
    evidenceRules: [
      INSPECT_FILES_FIRST_RULE,
      'Use exact local file evidence for code changes.'
    ],
    validationRules: [
      'Keep changes type-safe.',
      'Preserve existing tests unless the behavior intentionally changes.'
    ],
    outputContract: ['Summarize changed files, behavior, and tests needed by the validation agent.'],
    stopRules: ['Stop after the assigned patch scope is complete.'],
    cognitiveDomain: 'code'
  },
  validation: {
    role: 'validation sub-agent',
    collaborationStyle: ['Methodical and failure-oriented.', 'Report commands and exact failures.'],
    goal: 'Run or define the relevant repository validation for the changed behavior.',
    successCriteria: [
      'Targeted tests cover changed behavior.',
      'Type checks, lint, build, or smoke tests are selected according to risk.',
      'Failures include actionable command output summaries.'
    ],
    constraints: [
      'Do not mutate production services.',
      'Do not hide validation failures.',
      'Do not treat skipped validation as passed.'
    ],
    toolRules: [
      'Inspect package scripts and affected tests before choosing validation commands.',
      'Run only local validation commands unless explicitly authorized.'
    ],
    evidenceRules: [
      INSPECT_FILES_FIRST_RULE,
      'Use command output and test files as evidence.'
    ],
    validationRules: [
      'Classify failures as input, environment, timeout, or regression when possible.',
      'Preserve deterministic JSON or structured summaries for automated callers.'
    ],
    outputContract: ['Return commands run, pass/fail status, and remaining validation risk.'],
    stopRules: ['Stop after validation status and next fixes are clear.'],
    cognitiveDomain: 'diagnostic'
  },
  railway_ops: {
    role: 'Railway ops sub-agent',
    collaborationStyle: ['Read-only by default.', 'Operationally cautious and explicit about target context.'],
    goal: 'Inspect Railway project, service, environment, and runtime signals without mutating Railway state.',
    successCriteria: [
      '`railway status` or equivalent context confirms project/service/environment before conclusions.',
      '`railway logs` or safe read-only inspection is used only as needed.',
      'No deploy, restart, env var, config, or service mutation occurs without approval.'
    ],
    constraints: [
      'Read-only inspection is allowed.',
      'Railway deploy, restart, redeploy, up, link/unlink, env var changes, and config changes require explicit approval.',
      'Never print bearer tokens, Railway tokens, cookies, session IDs, database URLs, or passwords.'
    ],
    toolRules: [
      'Use Railway CLI read-only commands such as `railway status` and `railway logs`.',
      'Do not use `railway up`, restart, redeploy, variables set, link, unlink, or config mutation without explicit approval.',
      'Redact sensitive log output.'
    ],
    evidenceRules: [
      INSPECT_FILES_FIRST_RULE,
      'Treat Railway CLI output as current operational evidence only after target context is confirmed.'
    ],
    validationRules: [
      'Check command gating before proposing any Railway command.',
      'Flag stale or missing Railway context instead of guessing.'
    ],
    outputContract: ['Return target context, read-only commands used, findings, and any approval-required next step.'],
    stopRules: ['Stop before any privileged Railway or operator mutation unless approval is present.'],
    cognitiveDomain: 'diagnostic',
    toolBackedCapabilities: { verifyProvidedData: true }
  },
  reviewer: {
    role: 'reviewer sub-agent',
    collaborationStyle: ['Skeptical reviewer.', 'Prioritize bugs, regressions, safety, and prompt compliance.'],
    goal: 'Review planned or implemented changes for correctness and policy compliance.',
    successCriteria: [
      'Safety regressions are called out first.',
      'Prompt structure compliance is checked against required sections.',
      'Protected backend routing and Railway mutation gates are verified.'
    ],
    constraints: [
      'Treat the provided dependency outputs as the only available evidence.',
      'Do not claim live runtime, deployment, or external-state verification.',
      'Do not approve unsupported backend or Railway mutations.'
    ],
    toolRules: [
      'Inspect files first when reviewing repo claims.',
      'Use only provided evidence unless tool output is explicitly available.'
    ],
    evidenceRules: [
      INSPECT_FILES_FIRST_RULE,
      'Treat the provided dependency outputs as the only available evidence.'
    ],
    validationRules: [
      'Check structural correctness, risks, regressions, guard compliance, stop-token handling, and output-format compliance.',
      'Verify protected diagnostics stay on /gpt-access/* and not /gpt/:gptId.'
    ],
    outputContract: ['Return findings by severity, then residual risk and test gaps.'],
    stopRules: ['Stop after review findings and residual risk are reported.'],
    cognitiveDomain: 'diagnostic',
    toolBackedCapabilities: { verifyProvidedData: true }
  },
  audit: {
    role: 'reviewer sub-agent',
    collaborationStyle: ['Skeptical reviewer.', 'Prioritize bugs, regressions, safety, and prompt compliance.'],
    goal: 'Audit dependency outputs for correctness, risks, regressions, and compliance.',
    successCriteria: [
      'Safety regressions are called out first.',
      'Output-format and guard compliance are checked.',
      'Unsupported verification claims are rejected.'
    ],
    constraints: [
      'Treat the provided dependency outputs as the only available evidence.',
      'Do not claim live runtime, deployment, or external-state verification.',
      'Do not approve unsupported backend or Railway mutations.'
    ],
    toolRules: [
      'Use only provided dependency outputs and explicit tool evidence.',
      'Do not infer live runtime state.'
    ],
    evidenceRules: [
      INSPECT_FILES_FIRST_RULE,
      'Treat the provided dependency outputs as the only available evidence.'
    ],
    validationRules: [
      'Validate structural correctness, risks, regressions, guard compliance, stop-token handling, and output-format compliance using only that evidence.'
    ],
    outputContract: ['Return concise audit findings, limitations, and pass/fail summary.'],
    stopRules: ['Stop after audit findings and limitations are complete.'],
    cognitiveDomain: 'diagnostic',
    toolBackedCapabilities: { verifyProvidedData: true }
  },
  research: {
    role: 'research sub-agent',
    collaborationStyle: ['Evidence-first synthesizer.', 'Separate sourced facts from inference.'],
    goal: 'Gather and synthesize provided research evidence for downstream agents.',
    successCriteria: ['Claims are tied to provided evidence.', 'Unverified gaps remain explicit.'],
    constraints: ['Do not invent sources or current-state evidence.'],
    toolRules: ['Use only available retrieval tools or dependency evidence.'],
    evidenceRules: [INSPECT_FILES_FIRST_RULE, 'Cite dependency/source evidence when making factual claims.'],
    validationRules: ['Mark unsupported claims as unverified or inferred.'],
    outputContract: ['Return concise findings with evidence notes.'],
    stopRules: ['Stop after evidence-backed findings are complete.'],
    cognitiveDomain: 'natural'
  },
  write: {
    role: 'writer sub-agent',
    collaborationStyle: ['Clear synthesizer.', 'Keep final output concise and user-facing.'],
    goal: 'Synthesize dependency outputs into a cohesive final response.',
    successCriteria: ['Dependency outputs are merged without inventing facts.', 'Limitations are preserved.'],
    constraints: ['Do not add unsupported verification or execution claims.'],
    toolRules: ['Use only provided dependency outputs.'],
    evidenceRules: [INSPECT_FILES_FIRST_RULE, 'Treat dependency outputs as the only available evidence.'],
    validationRules: ['Preserve safety and output-format constraints from upstream agents.'],
    outputContract: ['Return the final user-facing synthesis.'],
    stopRules: ['Stop after the synthesis is complete.'],
    cognitiveDomain: 'natural'
  },
  writer: {
    role: 'writer sub-agent',
    collaborationStyle: ['Clear synthesizer.', 'Keep final output concise and user-facing.'],
    goal: 'Synthesize dependency outputs into a cohesive final response.',
    successCriteria: ['Dependency outputs are merged without inventing facts.', 'Limitations are preserved.'],
    constraints: ['Do not add unsupported verification or execution claims.'],
    toolRules: ['Use only provided dependency outputs.'],
    evidenceRules: [INSPECT_FILES_FIRST_RULE, 'Treat dependency outputs as the only available evidence.'],
    validationRules: ['Preserve safety and output-format constraints from upstream agents.'],
    outputContract: ['Return the final user-facing synthesis.'],
    stopRules: ['Stop after the synthesis is complete.'],
    cognitiveDomain: 'natural'
  }
};

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
  return DAG_AGENT_PROFILES[agentKey]?.cognitiveDomain ?? 'natural';
}

function buildSyntheticDagAgentSessionId(context: DAGNodeExecutionContext): string {
  return [
    'dag',
    context.dagId || 'unknown',
    context.node.id,
    `a${context.attempt}`
  ].join(':');
}

function buildDagAgentTokenAuditSessionId(context: DAGNodeExecutionContext): string {
  const sharedSessionId =
    typeof context.sharedState.sessionId === 'string'
      ? context.sharedState.sessionId.trim()
      : '';

  //audit Assumption: large DAG runs need independent token-audit buckets per node attempt while still preserving the parent session for memory continuity; failure risk: sibling nodes exhaust one shared Trinity session ceiling and abort otherwise healthy runs; expected invariant: inherited DAG sessions branch token auditing by dag/node/attempt and standalone runs keep the synthetic fallback; handling strategy: derive a stable per-node token session id only when a parent session exists.
  if (sharedSessionId.length > 0) {
    return [
      sharedSessionId,
      'dag',
      context.dagId || 'unknown',
      context.node.id,
      `a${context.attempt}`
    ].join(':');
  }

  return buildSyntheticDagAgentSessionId(context);
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
  const profile = DAG_AGENT_PROFILES[agentKey] ?? DAG_AGENT_PROFILES.research;
  const dependencySummary = serializeDependencyResults(context.dependencyResults);
  const explicitPrompt = extractPromptFromPayload(context.payload);

  //audit Assumption: synthesis nodes can operate with dependency outputs alone; failure risk: writer nodes fail even when upstream work is complete; expected invariant: writer-like nodes may omit an explicit prompt; handling strategy: supply a safe synthesis default for writer aliases.
  if (!explicitPrompt && (agentKey === 'write' || agentKey === 'writer')) {
    return renderPromptGuidanceSections({
      Role: `${profile.role} for node "${context.node.id}".`,
      'Personality/collaboration style': profile.collaborationStyle,
      Goal: profile.goal,
      'Success criteria': profile.successCriteria,
      Constraints: profile.constraints,
      'Tool rules': profile.toolRules,
      'Retrieval or evidence rules': [
        ...profile.evidenceRules,
        dependencySummary ? `Dependency Outputs:\n${dependencySummary}` : 'No dependency outputs were provided.'
      ].join('\n'),
      'Validation rules': profile.validationRules,
      'Output contract': profile.outputContract,
      'Stop rules': profile.stopRules
    });
  }

  //audit Assumption: non-writer agents need a concrete prompt to avoid ambiguous or runaway AI calls; failure risk: generic nodes consume budget without a defined task; expected invariant: non-writer nodes provide payload.prompt, payload.input, payload.task, or payload.instruction; handling strategy: fail fast with a precise error.
  if (!explicitPrompt) {
    throw new Error(
      `DAG agent "${agentKey}" requires payload.prompt, payload.input, payload.task, or payload.instruction.`
    );
  }

  return renderPromptGuidanceSections({
    Role: `${profile.role} for DAG node "${context.node.id}" (agent key: ${agentKey}).`,
    'Personality/collaboration style': profile.collaborationStyle,
    Goal: [
      profile.goal,
      '',
      `Task:\n${explicitPrompt}`
    ].join('\n'),
    'Success criteria': profile.successCriteria,
    Constraints: profile.constraints,
    'Tool rules': profile.toolRules,
    'Retrieval or evidence rules': [
      ...profile.evidenceRules,
      dependencySummary ? `Dependency Outputs:\n${dependencySummary}` : 'No dependency outputs were provided.'
    ].join('\n'),
    'Validation rules': profile.validationRules,
    'Output contract': profile.outputContract,
    'Stop rules': profile.stopRules
  });
}

function createPromptAgent(agentKey: string): DagAgentHandler {
  return async (context, helpers) => {
    const prompt = buildAgentPrompt(agentKey, context);
    const overrideAuditSafe = typeof context.payload.overrideAuditSafe === 'string'
      ? context.payload.overrideAuditSafe
      : undefined;
    const sessionId = resolveDagAgentSessionId(context);
    const tokenAuditSessionId = buildDagAgentTokenAuditSessionId(context);

    return helpers.runPrompt(prompt, {
      sessionId,
      tokenAuditSessionId,
      overrideAuditSafe,
      cognitiveDomain: inferAgentDomain(agentKey),
      toolBackedCapabilities: DAG_AGENT_PROFILES[agentKey]?.toolBackedCapabilities,
      dagId: context.dagId,
      nodeId: context.node.id,
      executionKey: context.node.executionKey,
      nodeMetadata: context.node.metadata,
      attempt: context.attempt,
      sourceEndpoint: `dag.agent.${agentKey}`
    });
  };
}

export const AGENTS: Record<string, DagAgentHandler> = {
  planner: createPromptAgent('planner'),
  research: createPromptAgent('research'),
  code: createPromptAgent('code'),
  build: createPromptAgent('build'),
  validation: createPromptAgent('validation'),
  railway_ops: createPromptAgent('railway_ops'),
  reviewer: createPromptAgent('reviewer'),
  audit: createPromptAgent('audit'),
  write: createPromptAgent('write'),
  writer: createPromptAgent('writer')
};
