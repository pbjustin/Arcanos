const DAG_RUNS_API_BASE_PATH = '/api/arcanos/dag/runs';
const DAG_TOKEN_PATTERN = /\bdag\b/i;

export const DAG_EXECUTION_VERB_PATTERN = /\b(?:create|start|launch|run|trigger|execute|kick\s*off)\b/i;
export const DAG_EXECUTION_SUBJECT_PATTERN = /\b(?:dag|workflow|orchestration|pipeline)\b/i;
export const DAG_EXECUTION_ARTIFACT_PATTERN =
  /\b(?:trace|tree|graph|nodes?|events?|metrics?|errors?|failures?|lineage|verification|verify|validated?)\b/i;

export interface DagRunFollowUpPaths {
  runId: string;
  trace: string;
  tree: string;
  lineage: string;
  metrics: string;
  errors: string;
  verification: string;
}

export function shouldTreatPromptAsDagExecution(
  prompt: string,
  options: {
    requireDagTokenForArtifact?: boolean;
  } = {},
): boolean {
  if (!DAG_EXECUTION_VERB_PATTERN.test(prompt)) {
    return false;
  }

  if (DAG_EXECUTION_SUBJECT_PATTERN.test(prompt)) {
    return true;
  }

  if (!DAG_EXECUTION_ARTIFACT_PATTERN.test(prompt)) {
    return false;
  }

  return !options.requireDagTokenForArtifact || DAG_TOKEN_PATTERN.test(prompt);
}

export function buildDagRunFollowUpPaths(runId: string): DagRunFollowUpPaths {
  const runPath = `${DAG_RUNS_API_BASE_PATH}/${runId}`;

  return {
    runId,
    trace: `${runPath}/trace`,
    tree: `${runPath}/tree`,
    lineage: `${runPath}/lineage`,
    metrics: `${runPath}/metrics`,
    errors: `${runPath}/errors`,
    verification: `${runPath}/verification`,
  };
}
