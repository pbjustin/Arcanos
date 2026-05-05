import {
  DISPATCH_CONFIDENCE_THRESHOLD,
  INTENT_CLARIFICATION_REQUIRED,
  type CapabilityRegistry,
  type DispatchPlan
} from './types.js';

type RuleMatch = {
  action: string;
  confidence: number;
  reason: string;
  payload?: unknown;
};

type DispatchRule = {
  action: string;
  confidence: number;
  reason: string;
  payload?: unknown;
  test: (normalizedUtterance: string) => boolean;
};

const CLOSE_CANDIDATE_DELTA = 0.05;

const DISPATCH_RULES: DispatchRule[] = [
  {
    action: 'diagnostics.run',
    confidence: 0.95,
    reason: 'matched_full_health_check',
    payload: {
      includeDb: true,
      includeWorkers: true,
      includeLogs: true,
      includeQueue: true
    },
    test: (utterance) =>
      /\b(full|deep|complete)\b.*\b(health|diagnostic|check)\b/u.test(utterance)
      || /\b(run|perform)\b.*\b(diagnostics?|health check)\b/u.test(utterance)
  },
  {
    action: 'workers.status',
    confidence: 0.93,
    reason: 'matched_worker_status',
    test: (utterance) =>
      /\b(check|show|get|read|are|is)\b.*\b(workers?|job runners?)\b/u.test(utterance)
      || /\b(workers?|job runners?)\b.*\b(alive|healthy|status|up|running)\b/u.test(utterance)
  },
  {
    action: 'queue.inspect',
    confidence: 0.92,
    reason: 'matched_queue_inspection',
    test: (utterance) =>
      /\b(queue|backlog|pending jobs?)\b.*\b(backed up|inspect|show|status|pending|depth)\b/u.test(utterance)
      || /\b(show|inspect|check|get)\b.*\b(queue|backlog|pending jobs?)\b/u.test(utterance)
  },
  {
    action: 'runtime.inspect',
    confidence: 0.9,
    reason: 'matched_runtime_status',
    test: (utterance) =>
      /\b(runtime|backend|server|app)\b.*\b(status|health|healthy|alive|up)\b/u.test(utterance)
      || /\b(status|health)\b.*\b(runtime|backend|server|app)\b/u.test(utterance)
  }
];

function normalizeUtterance(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9:_./-]+/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
}

function normalizeActionPhrase(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
}

function toCandidateList(matches: readonly RuleMatch[]): DispatchPlan['candidates'] {
  return matches.map((match) => ({
    action: match.action,
    confidence: match.confidence,
    reason: match.reason
  }));
}

function buildClarificationPlan(reason: string, matches: readonly RuleMatch[]): DispatchPlan {
  const topConfidence = matches[0]?.confidence ?? 0;
  return {
    action: INTENT_CLARIFICATION_REQUIRED,
    payload: {},
    confidence: topConfidence,
    source: 'rules',
    requiresConfirmation: false,
    reason,
    candidates: toCandidateList(matches)
  };
}

function collectExactRegistryMatches(
  normalizedUtterance: string,
  registry: CapabilityRegistry
): RuleMatch[] {
  const normalizedPhrase = normalizeActionPhrase(normalizedUtterance);
  const matches: RuleMatch[] = [];

  for (const action of registry.listActions()) {
    const normalizedAction = normalizeActionPhrase(action.action);
    if (
      normalizedPhrase === normalizedAction
      || normalizedPhrase === `run ${normalizedAction}`
      || normalizedPhrase === `execute ${normalizedAction}`
    ) {
      matches.push({
        action: action.action,
        confidence: 1,
        reason: 'matched_exact_registered_action',
        payload: action.payload
      });
    }
  }

  return matches;
}

function collectRuleMatches(normalizedUtterance: string): RuleMatch[] {
  return DISPATCH_RULES
    .filter((rule) => rule.test(normalizedUtterance))
    .map((rule) => ({
      action: rule.action,
      confidence: rule.confidence,
      reason: rule.reason,
      payload: rule.payload
    }));
}

function sortMatches(matches: readonly RuleMatch[]): RuleMatch[] {
  return [...matches].sort((left, right) => {
    const confidenceDelta = right.confidence - left.confidence;
    return confidenceDelta !== 0 ? confidenceDelta : left.action.localeCompare(right.action);
  });
}

function dedupeMatches(matches: readonly RuleMatch[]): RuleMatch[] {
  const byAction = new Map<string, RuleMatch>();
  for (const match of matches) {
    const existing = byAction.get(match.action);
    if (!existing || match.confidence > existing.confidence) {
      byAction.set(match.action, match);
    }
  }

  return sortMatches(Array.from(byAction.values()));
}

export function resolveRuleBasedDispatchPlan(input: {
  utterance: string;
  registry: CapabilityRegistry;
}): DispatchPlan {
  const normalizedUtterance = normalizeUtterance(input.utterance);
  if (normalizedUtterance.length === 0) {
    return buildClarificationPlan('empty_utterance', []);
  }

  const matches = dedupeMatches([
    ...collectExactRegistryMatches(normalizedUtterance, input.registry),
    ...collectRuleMatches(normalizedUtterance)
  ]).filter((match) => input.registry.hasAction(match.action));

  if (matches.length === 0) {
    return buildClarificationPlan('no_registered_intent_match', []);
  }

  const [topMatch, secondMatch] = matches;
  if (!topMatch || topMatch.confidence < DISPATCH_CONFIDENCE_THRESHOLD) {
    return buildClarificationPlan('confidence_below_threshold', matches);
  }

  if (secondMatch && topMatch.confidence - secondMatch.confidence <= CLOSE_CANDIDATE_DELTA) {
    return buildClarificationPlan('multiple_close_intent_candidates', matches);
  }

  const registryAction = input.registry.getAction(topMatch.action);
  return {
    action: topMatch.action,
    payload: topMatch.payload ?? registryAction?.payload ?? {},
    confidence: topMatch.confidence,
    source: 'rules',
    requiresConfirmation: Boolean(registryAction?.requiresConfirmation),
    reason: topMatch.reason,
    candidates: toCandidateList(matches)
  };
}
