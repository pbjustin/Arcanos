import {
  hasPromptGenerationIntent,
  type IntentModeClassification,
} from '@shared/text/intentModeClassifier.js';

export interface RuntimeInspectionPromptClassification {
  detectedIntent: 'RUNTIME_INSPECTION_REQUIRED' | 'STANDARD';
  matchedKeywords: string[];
  repoInspectionDisabled: boolean;
  onlyReturnRuntimeValues: boolean;
}

type RuntimeKeywordRule = {
  label: string;
  pattern: RegExp;
};

const DAG_ARTIFACT_EXECUTION_PATTERNS = [
  /\b(?:dag(?:\s+run)?|workflow(?:\s+run)?|orchestration(?:\s+run)?)\b/i,
  /\b(?:trace|lineage|nodes?|events?|metrics?|verification|latest|recent|most\s+recent)\b/i,
];

const RUNTIME_INSPECTION_PATTERNS = [
  /\b(?:run|reach|show|check|inspect|list|query|fetch|get|audit|diagnose|debug|investigate|probe|validate|verify)\b[^.!?\n]{0,40}\bdiagnostics?\b/i,
  /\b(?:run|reach|show|check|inspect|list|query|fetch|get|audit|diagnose|debug|investigate|probe|validate|verify)\b[^.!?\n]{0,40}\b(?:runtime|self[-\s]?heal|workers?|worker\s+health|queue|system\s+status|runtime\s+status|telemetry|metrics|events?|status)\b/i,
  /\b(?:runtime|self[-\s]?heal|worker\s+health|queue\s+health|system\s+status|runtime\s+status|telemetry|metrics|events?)\b[^.!?\n]{0,20}\b(?:now|current|currently|live)\b/i,
  /\b(?:current|currently|live)\b[^.!?\n]{0,20}\b(?:runtime|backend|deployment|service|instance|worker\s+health|queue|system\s+status)\b/i,
  /\bverify\s+in\s+production\b/i,
  /\b(?:run|show|check|inspect)\s+self[-\s]?heal\b|\bself[-\s]?heal\s+(?:status|health|runtime|events?)\b/i,
  /\b(?:show|check|inspect|list)\s+workers?\b|\bworkers?\s+(?:status|health|queue|runtime)\b/i,
  /\bqueue\s+health\b/i,
  /\bsystem\s+status\b/i,
  /\bloop\s+running\b/i,
  /\b(?:runtime|telemetry|worker|self[-\s]?heal|process|queue|deployment)\b[^.!?\n]{0,20}\bevents?\b|\bevents?\b[^.!?\n]{0,20}\b(?:runtime|telemetry|worker|self[-\s]?heal|process|queue|deployment)\b/i,
  /\bsystem\s+health\b/i,
  /\bhealth\s+probe\b/i,
  /\blive\s+verification\b/i,
  /\baudit\b[^.!?\n]{0,24}\b(?:this|the)\s+(?:instance|deployment|backend|service)\b/i,
  /\b(?:instance|deployment|backend|service)\b[^.!?\n]{0,24}\baudit\b/i,
];

const RUNTIME_KEYWORD_RULES: RuntimeKeywordRule[] = [
  { label: 'live', pattern: /\blive\b/i },
  { label: 'runtime', pattern: /\bruntime\b/i },
  { label: 'currently running', pattern: /\bcurrently\s+running\b/i },
  { label: 'currently active', pattern: /\bcurrently\s+active\b/i },
  {
    label: 'active',
    pattern: /\b(?:runtime|worker|process|deployment|service|queue|loop)\b[^.!?\n]{0,16}\bactive\b|\bactive\b[^.!?\n]{0,16}\b(?:runtime|worker|process|deployment|service|queue|loop)\b/i,
  },
  { label: 'status now', pattern: /\bstatus\s+now\b/i },
  {
    label: 'diagnostics',
    pattern: /\b(?:run|show|check|inspect)\s+diagnostics?\b|\bdiagnostics?\s+(?:status|report|summary)\b/i,
  },
  {
    label: 'self-heal',
    pattern: /\b(?:run|show|check|inspect)\s+self[-\s]?heal\b|\bself[-\s]?heal\s+(?:status|health|runtime|events?)\b/i,
  },
  {
    label: 'workers',
    pattern: /\b(?:show|check|inspect|list)\s+workers?\b|\bworkers?\s+(?:status|health|queue|runtime)\b/i,
  },
  { label: 'queue health', pattern: /\bqueue\s+health\b/i },
  { label: 'system status', pattern: /\bsystem\s+status\b/i },
  { label: 'production state', pattern: /\bproduction\s+state\b/i },
  { label: 'loop running', pattern: /\bloop\s+running\b/i },
  { label: 'telemetry', pattern: /\btelemetry\b/i },
  {
    label: 'events',
    pattern: /\b(?:runtime|telemetry|worker|self[-\s]?heal|process|queue|deployment)\b[^.!?\n]{0,20}\bevents?\b|\bevents?\b[^.!?\n]{0,20}\b(?:runtime|telemetry|worker|self[-\s]?heal|process|queue|deployment)\b/i,
  },
];

const REPO_BLOCK_RULES = [
  /\bdo\s+not\s+use\s+repo(?:\s+inspection)?\b/i,
  /\bno\s+repo(?:\s+inspection)?\b/i,
  /\bonly\s+return\s+runtime\s+values\b/i,
  /\bruntime\s+values\s+only\b/i,
];

function uniqueStrings(values: Array<string | null | undefined>): string[] {
  return Array.from(
    new Set(
      values
        .filter((value): value is string => typeof value === 'string')
        .map(value => value.trim())
        .filter(value => value.length > 0)
    ).values()
  );
}

function isDagArtifactExecutionRequest(prompt: string | null | undefined): boolean {
  if (!prompt) {
    return false;
  }

  return DAG_ARTIFACT_EXECUTION_PATTERNS.every(pattern => pattern.test(prompt));
}

export function isPromptAuthoringRequest(prompt: string | null | undefined): boolean {
  return hasPromptGenerationIntent(prompt);
}

export function shouldInspectRuntimePrompt(
  prompt: string | null | undefined,
  intentClassification?: IntentModeClassification
): boolean {
  if (!prompt) {
    return false;
  }

  if (intentClassification?.intentMode === 'PROMPT_GENERATION') {
    return false;
  }

  if (!intentClassification && isPromptAuthoringRequest(prompt)) {
    return false;
  }

  if (isDagArtifactExecutionRequest(prompt)) {
    return false;
  }

  return RUNTIME_INSPECTION_PATTERNS.some(pattern => pattern.test(prompt));
}

export function classifyRuntimeInspectionPrompt(
  prompt: string | null | undefined
): RuntimeInspectionPromptClassification {
  const normalized = typeof prompt === 'string' ? prompt.trim() : '';
  if (!normalized) {
    return {
      detectedIntent: 'STANDARD',
      matchedKeywords: [],
      repoInspectionDisabled: false,
      onlyReturnRuntimeValues: false,
    };
  }

  const matchedKeywords = uniqueStrings(
    RUNTIME_KEYWORD_RULES
      .filter(rule => rule.pattern.test(normalized))
      .map(rule => rule.label)
  );
  const repoInspectionDisabled = REPO_BLOCK_RULES.some(rule => rule.test(normalized));
  const onlyReturnRuntimeValues =
    /\bonly\s+return\s+runtime\s+values\b/i.test(normalized)
    || /\bruntime\s+values\s+only\b/i.test(normalized);

  return {
    detectedIntent: shouldInspectRuntimePrompt(normalized)
      ? 'RUNTIME_INSPECTION_REQUIRED'
      : 'STANDARD',
    matchedKeywords,
    repoInspectionDisabled,
    onlyReturnRuntimeValues,
  };
}
