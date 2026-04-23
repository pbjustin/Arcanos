export type IntentMode = 'PROMPT_GENERATION' | 'EXECUTE_TASK';

export type PromptArtifactKind =
  | 'prompt'
  | 'system_prompt'
  | 'spec'
  | 'brief'
  | 'instructions'
  | 'tasking_document'
  | 'message';

export type DownstreamExecutorKind =
  | 'codex'
  | 'agent'
  | 'ai'
  | 'model'
  | 'tool'
  | 'assistant'
  | 'executor';

export interface IntentModeClassification {
  intentMode: IntentMode;
  artifactRequested: boolean;
  requestedArtifactKinds: PromptArtifactKind[];
  downstreamExecutorImplied: boolean;
  downstreamExecutorKinds: DownstreamExecutorKind[];
  artifactSignals: string[];
  authoringSignals: string[];
  downstreamSignals: string[];
  deliverySignals: string[];
  executionSignals: string[];
  reason: string;
}

interface LabeledPattern<TLabel extends string = string> {
  label: TLabel;
  pattern: RegExp;
}

interface ArtifactPattern extends LabeledPattern<PromptArtifactKind> {}
interface ExecutorPattern extends LabeledPattern<DownstreamExecutorKind> {}

const ARTIFACT_PATTERNS: ArtifactPattern[] = [
  { label: 'system_prompt', pattern: /\bsystem\s+prompt\b/i },
  { label: 'tasking_document', pattern: /\btasking(?:\s+doc(?:ument)?)?\b/i },
  { label: 'instructions', pattern: /\binstructions?\b/i },
  { label: 'spec', pattern: /\bspec(?:ification)?\b/i },
  { label: 'brief', pattern: /\bbrief\b/i },
  { label: 'message', pattern: /\bmessage\b/i },
  { label: 'prompt', pattern: /\bprompt\b/i },
];

const EXECUTOR_PATTERNS: ExecutorPattern[] = [
  { label: 'codex', pattern: /\bcodex\b/i },
  { label: 'agent', pattern: /\b(?:another\s+agent|an?\s+agent|agents?)\b/i },
  { label: 'ai', pattern: /\b(?:another\s+ai|an?\s+ai)\b/i },
  { label: 'model', pattern: /\b(?:another\s+model|an?\s+model|models?)\b/i },
  { label: 'tool', pattern: /\b(?:another\s+tool|an?\s+tool|tools?)\b/i },
  { label: 'assistant', pattern: /\b(?:another\s+assistant|an?\s+assistant|assistants?)\b/i },
  { label: 'executor', pattern: /\bexecutors?\b/i },
];

const AUTHORING_PATTERNS: LabeledPattern[] = [
  { label: 'write', pattern: /\bwrite\b/i },
  { label: 'generate', pattern: /\bgenerate\b/i },
  { label: 'draft', pattern: /\bdraft\b/i },
  { label: 'create', pattern: /\bcreate\b/i },
  { label: 'make', pattern: /\bmake\b/i },
  { label: 'compose', pattern: /\bcompose\b/i },
  { label: 'produce', pattern: /\bproduce\b/i },
  { label: 'craft', pattern: /\bcraft\b/i },
  { label: 'author', pattern: /\bauthor\b/i },
  { label: 'prepare', pattern: /\bprepare\b/i },
  { label: 'rewrite', pattern: /\brewrite\b/i },
  { label: 'revise', pattern: /\brev(?:ise|ision)\b/i },
  { label: 'convert', pattern: /\b(?:turn|convert)\b[\s\S]{0,80}\binto\b/i },
];

const ARTIFACT_REQUEST_PATTERNS: LabeledPattern[] = [
  {
    label: 'authoring_deliverable',
    pattern: /\b(?:write|generate|draft|create|make|prepare|compose|produce|craft|author|rewrite|revise)\b[^.!?\n]{0,80}\b(?:system\s+prompt|prompt|instructions?|spec(?:ification)?|brief|tasking(?:\s+doc(?:ument)?)?|message)\b/i,
  },
  {
    label: 'deliverable_request',
    pattern: /\b(?:need|want|give|provide|return|output|share)\b[^.!?\n]{0,80}\b(?:system\s+prompt|prompt|instructions?|spec(?:ification)?|brief|tasking(?:\s+doc(?:ument)?)?|message)\b/i,
  },
  {
    label: 'artifact_first_request',
    pattern: /\b(?:system\s+prompt|prompt|instructions?|spec(?:ification)?|brief|tasking(?:\s+doc(?:ument)?)?|message)\b[^.!?\n]{0,80}\b(?:for|to|telling|that\s+tells?|that\s+instructs?|another\s+(?:tool|model|agent|ai|assistant)|would\s+(?:follow|use))\b/i,
  },
  {
    label: 'artifact_conversion',
    pattern: /\b(?:turn|convert)\b[^.!?\n]{0,80}\binto\s+(?:a|an|the)?\s*(?:system\s+prompt|prompt|instructions?|spec(?:ification)?|brief|tasking(?:\s+doc(?:ument)?)?|message)\b/i,
  },
  {
    label: 'output_only_artifact',
    pattern: /\boutput\s+only\s+the\s+(?:system\s+prompt|prompt|instructions?|spec(?:ification)?|brief|tasking(?:\s+doc(?:ument)?)?|message)\b/i,
  },
];

const DOWNSTREAM_SIGNAL_PATTERNS: LabeledPattern[] = [
  {
    label: 'for_executor',
    pattern: /\bfor\s+(?:codex|another\s+agent|an?\s+agent|another\s+ai|an?\s+ai|another\s+model|an?\s+model|another\s+tool|an?\s+tool|another\s+assistant|an?\s+assistant|executor)\b/i,
  },
  {
    label: 'telling_executor',
    pattern: /\b(?:telling|tell(?:ing)?|instruct(?:ing)?)\s+(?:codex|another\s+agent|an?\s+agent|another\s+ai|an?\s+ai|another\s+model|an?\s+model|another\s+tool|an?\s+tool|another\s+assistant|an?\s+assistant|executor)\b/i,
  },
  {
    label: 'delegate_executor',
    pattern: /\b(?:make|get|have|let)\s+(?:codex|another\s+agent|an?\s+agent|another\s+ai|an?\s+ai|another\s+model|an?\s+model|another\s+tool|an?\s+tool|another\s+assistant|an?\s+assistant|executor)\b/i,
  },
  {
    label: 'another_executor',
    pattern: /\banother\s+(?:agent|ai|model|tool|assistant)\b/i,
  },
  {
    label: 'lets_executor',
    pattern: /\blets?\s+(?:another\s+agent|an?\s+agent|another\s+ai|an?\s+ai|another\s+model|an?\s+model|another\s+tool|an?\s+tool|another\s+assistant|an?\s+assistant|codex)\b/i,
  },
  {
    label: 'executor_assigned_work',
    pattern: /\b(?:codex|another\s+agent|an?\s+agent|another\s+ai|an?\s+ai|another\s+model|an?\s+model|another\s+tool|an?\s+tool|another\s+assistant|an?\s+assistant|executor)\b[^.!?\n]{0,80}\b(?:inspect|verify|fix|update|audit|analy[sz]e|run|test|check)\b/i,
  },
];

const DELIVERY_SIGNAL_PATTERNS: LabeledPattern[] = [
  {
    label: 'send_to_executor',
    pattern: /\bwhat\s+i\s+should\s+send\b[^.!?\n]{0,48}\b(?:to\s+)?(?:codex|another\s+agent|an?\s+agent|another\s+ai|an?\s+ai|another\s+model|an?\s+model|another\s+tool|an?\s+tool|another\s+assistant|an?\s+assistant|executor)\b/i,
  },
  {
    label: 'hand_to_executor',
    pattern: /\bsomething\s+i\s+can\s+(?:hand|send|pass|give|share)\b[^.!?\n]{0,40}\b(?:to\s+)?(?:codex|another\s+agent|an?\s+agent|another\s+ai|an?\s+ai|another\s+model|an?\s+model|another\s+tool|an?\s+tool|another\s+assistant|an?\s+assistant|executor)\b/i,
  },
  {
    label: 'deliverable_for_executor',
    pattern: /\b(?:give|provide|return|share)\b[^.!?\n]{0,80}\bsomething\b[^.!?\n]{0,80}\b(?:hand|send|pass|give|share)\b[^.!?\n]{0,40}\b(?:to\s+)?(?:codex|another\s+agent|an?\s+agent|another\s+ai|an?\s+ai|another\s+model|an?\s+model|another\s+tool|an?\s+tool|another\s+assistant|an?\s+assistant|executor)\b/i,
  },
  {
    label: 'executor_would_follow',
    pattern: /\b(?:codex|another\s+agent|an?\s+agent|another\s+ai|an?\s+ai|another\s+model|an?\s+model|another\s+tool|an?\s+tool|another\s+assistant|an?\s+assistant|executor)\b[^.!?\n]{0,48}\bwould\s+(?:follow|use)\b/i,
  },
];

const DELEGATED_ARTIFACTLESS_PATTERNS: LabeledPattern[] = [
  {
    label: 'help_me_make_executor',
    pattern: /\bhelp\s+me\b[^.!?\n]{0,60}\b(?:make|get|have|let)\s+(?:codex|another\s+agent|an?\s+agent|another\s+ai|an?\s+ai|another\s+model|an?\s+model|another\s+tool|an?\s+tool|another\s+assistant|an?\s+assistant|executor)\b/i,
  },
  {
    label: 'generate_something_for_executor',
    pattern: /\b(?:generate|create|draft|write|compose|produce|craft)\b[^.!?\n]{0,50}\bsomething\b[^.!?\n]{0,80}\b(?:another\s+agent|an?\s+agent|another\s+ai|an?\s+ai|another\s+model|an?\s+model|another\s+tool|an?\s+tool|another\s+assistant|an?\s+assistant|codex)\b/i,
  },
  {
    label: 'make_executor_do_work',
    pattern: /\b(?:make|get|have|let)\s+(?:codex|another\s+agent|an?\s+agent|another\s+ai|an?\s+ai|another\s+model|an?\s+model|another\s+tool|an?\s+tool|another\s+assistant|an?\s+assistant|executor)\b[^.!?\n]{0,80}\b(?:inspect|verify|fix|update|audit|analy[sz]e|run|test|check)\b/i,
  },
];

const EXECUTION_PATTERNS: LabeledPattern[] = [
  { label: 'inspect', pattern: /\binspect\b/i },
  { label: 'verify', pattern: /\bverify\b/i },
  { label: 'fix', pattern: /\bfix\b/i },
  { label: 'update', pattern: /\bupdate\b/i },
  { label: 'audit', pattern: /\baudit\b/i },
  { label: 'analyze', pattern: /\banaly[sz]e\b/i },
  { label: 'run', pattern: /\brun\b/i },
  { label: 'test', pattern: /\btest\b/i },
  { label: 'check', pattern: /\bcheck\b/i },
];

function matchLabels<TLabel extends string>(
  text: string,
  patterns: Array<LabeledPattern<TLabel>>,
): TLabel[] {
  const labels = patterns
    .filter(({ pattern }) => pattern.test(text))
    .map(({ label }) => label);

  return Array.from(new Set(labels));
}

function normalizeArtifactKinds(kinds: PromptArtifactKind[]): PromptArtifactKind[] {
  if (!kinds.includes('system_prompt')) {
    return kinds;
  }

  return kinds.filter((kind) => kind !== 'prompt');
}

export function classifyIntentMode(prompt: string | null | undefined): IntentModeClassification {
  const normalizedPrompt = prompt?.trim() ?? '';
  if (!normalizedPrompt) {
    return {
      intentMode: 'EXECUTE_TASK',
      artifactRequested: false,
      requestedArtifactKinds: [],
      downstreamExecutorImplied: false,
      downstreamExecutorKinds: [],
      artifactSignals: [],
      authoringSignals: [],
      downstreamSignals: [],
      deliverySignals: [],
      executionSignals: [],
      reason: 'empty_prompt_defaults_to_execute_task',
    };
  }

  const requestedArtifactKinds = normalizeArtifactKinds(matchLabels(normalizedPrompt, ARTIFACT_PATTERNS));
  const authoringSignals = matchLabels(normalizedPrompt, AUTHORING_PATTERNS);
  const artifactSignals = matchLabels(normalizedPrompt, ARTIFACT_REQUEST_PATTERNS);
  const downstreamSignals = matchLabels(normalizedPrompt, DOWNSTREAM_SIGNAL_PATTERNS);
  const deliverySignals = matchLabels(normalizedPrompt, DELIVERY_SIGNAL_PATTERNS);
  const downstreamExecutorKinds = matchLabels(normalizedPrompt, EXECUTOR_PATTERNS);
  const executionSignals = matchLabels(normalizedPrompt, EXECUTION_PATTERNS);
  const downstreamExecutorImplied =
    downstreamExecutorKinds.length > 0 &&
    (
      downstreamSignals.length > 0 ||
      deliverySignals.length > 0 ||
      requestedArtifactKinds.length > 0 ||
      authoringSignals.length > 0
    );
  const delegatedArtifactlessRequest =
    requestedArtifactKinds.length === 0 &&
    downstreamExecutorKinds.length > 0 &&
    (
      deliverySignals.length > 0 ||
      DELEGATED_ARTIFACTLESS_PATTERNS.some(({ pattern }) => pattern.test(normalizedPrompt))
    );
  const artifactRequested =
    requestedArtifactKinds.length > 0 &&
    (artifactSignals.length > 0 || authoringSignals.length > 0 || downstreamExecutorImplied);

  if (artifactRequested) {
    return {
      intentMode: 'PROMPT_GENERATION',
      artifactRequested,
      requestedArtifactKinds,
      downstreamExecutorImplied,
      downstreamExecutorKinds,
      artifactSignals,
      authoringSignals,
      downstreamSignals,
      deliverySignals,
      executionSignals,
      reason: downstreamExecutorImplied
        ? 'artifact_requested_for_downstream_executor'
        : 'artifact_requested',
    };
  }

  if (delegatedArtifactlessRequest) {
    return {
      intentMode: 'PROMPT_GENERATION',
      artifactRequested: false,
      requestedArtifactKinds,
      downstreamExecutorImplied: true,
      downstreamExecutorKinds,
      artifactSignals,
      authoringSignals,
      downstreamSignals,
      deliverySignals,
      executionSignals,
      reason: deliverySignals.length > 0
        ? 'delegated_deliverable_for_downstream_executor'
        : 'downstream_executor_instruction_requested',
    };
  }

  return {
    intentMode: 'EXECUTE_TASK',
    artifactRequested: false,
    requestedArtifactKinds,
    downstreamExecutorImplied,
    downstreamExecutorKinds,
    artifactSignals,
    authoringSignals,
    downstreamSignals,
    deliverySignals,
    executionSignals,
    reason: 'no_prompt_generation_signals',
  };
}

export function hasPromptGenerationIntent(prompt: string | null | undefined): boolean {
  return classifyIntentMode(prompt).intentMode === 'PROMPT_GENERATION';
}
