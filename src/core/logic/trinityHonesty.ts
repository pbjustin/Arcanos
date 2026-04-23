/**
 * Trinity honesty controls: capability framing, evidence tagging, minimalism rules, and user-visible debug gating.
 */

import type { TrinityIntentMode, TrinityOutputControls, TrinityRunOptions } from './trinityTypes.js';
import { countWords } from '@shared/text/countWords.js';
import { classifyIntentMode } from '@shared/text/intentModeClassifier.js';

export type TrinitySourceType = 'tool' | 'user_context' | 'memory' | 'inference' | 'template';
export type TrinityConfidence = 'high' | 'medium' | 'low';
export type TrinityVerificationStatus = 'verified' | 'unverified' | 'inferred' | 'unavailable';
export type TrinityResponseMode = 'answer' | 'partial_refusal' | 'refusal';

export interface TrinityCapabilityFlags {
  canBrowse: boolean;
  canVerifyProvidedData: boolean;
  canVerifyLiveData: boolean;
  canConfirmExternalState: boolean;
  canPersistData: boolean;
  canCallBackend: boolean;
}

export interface TrinityToolBackedCapabilities {
  browse?: boolean;
  verifyProvidedData?: boolean;
  verifyLiveData?: boolean;
  confirmExternalState?: boolean;
  persistData?: boolean;
  callBackend?: boolean;
}

export interface TrinityEvidenceTag {
  claimText: string;
  sourceType: TrinitySourceType;
  confidence: TrinityConfidence;
  verificationStatus: TrinityVerificationStatus;
}

export interface TrinityReasoningHonesty {
  responseMode: TrinityResponseMode;
  achievableSubtasks: string[];
  blockedSubtasks: string[];
  userVisibleCaveats: string[];
  evidenceTags: TrinityEvidenceTag[];
  blockedOrRewrittenClaims?: string[];
}

export interface FinalClaimBlockResult {
  text: string;
  blocked: boolean;
  blockedCategories: Array<'live_verification' | 'current_external_state' | 'backend_action'>;
}

const DEFAULT_OUTPUT_CONTROLS: TrinityOutputControls = {
  requestedVerbosity: 'normal',
  maxWords: null,
  answerMode: 'explained',
  debugPipeline: false,
  strictUserVisibleOutput: true,
  intentMode: 'EXECUTE_TASK'
};

const LIVE_VERIFICATION_PATTERN =
  /\b(verified|verify|confirmed|confirm|checked|check|looked up|look up|reviewed|validated|i checked|i verified|i confirmed)\b/i;
const CURRENT_EXTERNAL_STATE_PATTERN =
  /\b(latest|current|currently|today|this week|recent|recently|up-to-date|as of now)\b/i;
const EXTERNAL_STATE_CONTEXT_PATTERN =
  /\b(competitor|competitors|market|news|pricing|release|launch|moves?|external|trend|trends|company|companies|regulation|stock|stocks|state|status|events?)\b/i;
const CURRENT_EXTERNAL_REQUEST_PATTERN =
  /\b(verify|verified|check|checked|confirm|confirmed|review|reviewed|audit|audited|analy[sz]e|analy[sz]ed|assess|assessed|summari[sz]e|summari[sz]ed|compare|compared|track|tracked|latest|current|recent|today|this week|as of now)\b/i;
const LIVE_RUNTIME_STATE_PATTERN =
  /\b(live|runtime|runtime behavior|runtime state|execution state|orchestration state|deployment status|service health|service status|worker state|queue state|run state|environment state)\b/i;
const EXTERNAL_STATE_SECTION_HEADING_CONTEXT_PATTERN =
  /\b(competitor|competitors|market|news|pricing|release|external|trend|trends|company|companies|regulation|stock|stocks|state|status|events?)\b/i;
const BACKEND_ACTION_PATTERN =
  /\b(saved|save|persisted|persist|wrote|write|stored|store|pinged|ping|called|call|updated|update|inserted|insert|deleted|delete|committed|commit|queried|query|inspected|inspect)\b/i;
const BACKEND_ACTION_CONTEXT_PATTERN =
  /\b(backend|database|db|table|record|row|service|services|api|endpoint|cache)\b/i;
const LIMITATION_LANGUAGE_PATTERN =
  /\b(can(?:not|'t)|unable to|do not have|don't have|haven't|have not|cannot confirm|can't confirm|cannot verify|can't verify|without live|without browsing|unverified|unconfirmed|inferred|unavailable)\b/i;
const STATIC_SCOPE_LIMITATION_PATTERN =
  /\b(can only|only\s+(?:check|checks|inspect|inspects|analyze|analyzes|analyse|analyses|validate|validates)|limited to)\b/i;
const NEGATED_LIVE_SCOPE_PATTERN =
  /\bnot\s+(?:any\s+)?(?:live|runtime|current|external)\b/i;
const META_SECTION_HEADER_PATTERN =
  /(?:^|\n)\s*(audit notes?|reasoning notes?|developer notes?|observability|verification notes?)\s*:?[^\n]*[\s\S]*$/i;
const STYLE_INFLATION_PREFIX_PATTERNS = [
  /^\s*here(?:'s| is)\s+(?:a|the)\s+(?:concise|brief|direct|structured|auditable|verifiable)[^:]*:\s*/i,
  /^\s*below\s+(?:is|are)\s+[^:]*:\s*/i,
  /^\s*this\s+(?:is|answer is)\s+(?:structured|verifiable|auditable)[^:]*:\s*/i
] as const;
const OPENING_PADDING_SEGMENT_PATTERNS = [
  /^i can help with (?:that|this)\.?$/i,
  /^to answer directly[:,]?$/i,
  /^direct answer(?: only)?[:,]?$/i,
  /^here(?:'s| is) (?:the )?(?:answer|response|plan)\.?$/i,
  /^the short answer is:?$/i
] as const;
const SECTION_HEADING_PATTERN = /:\s*$/;
const LIST_ITEM_PATTERN = /^(?:[-*]|\d+\.)\s+/;
const PLANNING_OR_INSTRUCTION_LEAD_PATTERN =
  /^\s*(?:[-*]|\d+\.)?\s*(?:lead|highlight|emphasize|prioritize|ensure|prepare|offer|target|establish|provide|implement|secure|announce|obtain|conduct|coordinate|leverage|build|create|define|document|draft|position|launch|roll\s+out|ship|use|keep|focus)\b/i;
const CURRENT_EXTERNAL_FACT_SUBJECT_PATTERN =
  /^\s*(?:[-*]|\d+\.)?\s*(?:competitors?|several|many|most|major|the market|market|pricing|releases?|launches?|news|regulation|companies?|vendors?)\b/i;
const CURRENT_EXTERNAL_FACT_NOUN_PHRASE_LEAD_PATTERN =
  /^\s*(?:[-*]|\d+\.)?\s*(?:increased|decreased|heightened|growing|declining|notable)\b/i;
const CURRENT_EXTERNAL_FACT_VERB_PATTERN =
  /\b(is|are|was|were|has|have|had|continues?|continued|remains?|remained|shows?|showed|indicates?|indicated|accelerated|focused|focusing|expanded|cut|cuts|lowered|launched|launching|released|releasing|invested|investing|prioritized|prioritizing|emphasized|emphasizing)\b/i;
const SUBSTRING_DUPLICATE_OVERLAP_THRESHOLD = 0.65;
const SAME_CATEGORY_LIMITATION_DUPLICATE_OVERLAP_THRESHOLD = 0.72;
const GENERAL_DUPLICATE_OVERLAP_THRESHOLD = 0.9;
const SCOPE_DRIFT_QUALIFIER_PATTERN =
  /\s+or your(?: actual)?\s+(tooling|backend|stack|database|systems?|service|services)\b/gi;
const PROMPT_GENERATION_DISCLAIMER_PATTERNS = [
  /^(?:i|we)\s+(?:can(?:not|'t)|do not have|don't have|have not|haven't|am unable to|are unable to|cannot|can't)\b/i,
  /^(?:current|live|runtime|external|backend)\b.+\b(?:unverified|unconfirmed|cannot be (?:confirmed|verified)|can't be (?:confirmed|verified)|cannot verify|can't verify)\b/i,
  /^\byou can paste\b.+\bcodex\b/i,
  /^\bpaste (?:this|your) prompt\b.+\bcodex\b/i
] as const;
const SCOPE_STOP_WORDS = new Set([
  'a', 'an', 'and', 'answer', 'as', 'at', 'be', 'but', 'by', 'can', 'could', 'do', 'does', 'for', 'from', 'give', 'help',
  'here', 'how', 'i', 'if', 'in', 'is', 'it', 'latest', 'me', 'my', 'no', 'of', 'on', 'only', 'or', 'our', 'the', 'this',
  'to', 'under', 'verify', 'we', 'with', 'without', 'you', 'your'
]);

type LimitationCategory = 'live_verification' | 'backend_action' | 'persistence_action' | 'general';

export function resolveIntentMode(
  prompt: string,
  options: TrinityRunOptions
): TrinityIntentMode {
  if (options.intentMode) {
    return options.intentMode;
  }

  if (options.requestIntent) {
    return options.requestIntent;
  }

  return classifyIntentMode(prompt).intentMode;
}

export function readIntentMode(outputControls?: TrinityOutputControls | null): TrinityIntentMode {
  return outputControls?.intentMode ?? 'EXECUTE_TASK';
}

function isPromptGenerationRequest(outputControls: TrinityOutputControls): boolean {
  return readIntentMode(outputControls) === 'PROMPT_GENERATION';
}

function escapePromptAngleBrackets(value: string): string {
  return value.replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function serializePromptJson(value: unknown): string {
  return escapePromptAngleBrackets(JSON.stringify(value, null, 2));
}

function sanitizePromptLine(value: string): string {
  return escapePromptAngleBrackets(value.trim());
}

function normalizePromptList(values: string[]): string[] {
  return values.map(value => sanitizePromptLine(value)).filter(Boolean);
}

function dedupePreservingOrder(values: string[]): string[] {
  return Array.from(new Set(values.map(value => value.trim()).filter(Boolean)));
}

function formatTaskList(values: string[]): string | null {
  const normalizedValues = dedupePreservingOrder(values);
  if (normalizedValues.length === 0) {
    return null;
  }
  return new Intl.ListFormat('en').format(normalizedValues);
}

function splitIntoReviewLines(text: string): string[] {
  const rawLines = text.split(/\r?\n/);
  const lines: string[] = [];
  for (const rawLine of rawLines) {
    const trimmedLine = rawLine.trim();
    if (trimmedLine.length === 0) {
      lines.push('');
      continue;
    }
    if (/^[-*]\s/.test(trimmedLine) || /^\d+\.\s/.test(trimmedLine)) {
      lines.push(trimmedLine);
      continue;
    }
    lines.push(...trimmedLine.split(/(?<=[.!?])\s+/));
  }
  return lines;
}

function normalizeWhitespace(text: string): string {
  return text
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

function normalizeOutputSpacing(lines: string[]): string {
  const normalizedLines: string[] = [];
  let previousWasBlank = false;
  for (const line of lines) {
    const isBlankLine = line.trim().length === 0;
    if (isBlankLine) {
      if (!previousWasBlank && normalizedLines.length > 0) normalizedLines.push('');
      previousWasBlank = true;
      continue;
    }
    normalizedLines.push(line.trim());
    previousWasBlank = false;
  }
  return normalizedLines.join('\n').trim();
}

function isNumericSentencePeriod(line: string, index: number): boolean {
  const previousCharacter = line[index - 1] ?? '';
  const nextCharacter = line[index + 1] ?? '';

  return /\d/.test(previousCharacter) && /\d/.test(nextCharacter);
}

function splitLineIntoSegments(line: string): string[] {
  const segments: string[] = [];
  let currentSegment = '';

  for (let index = 0; index < line.length; index += 1) {
    const character = line[index] ?? '';
    currentSegment += character;

    if (!/[.!?]/.test(character)) {
      continue;
    }

    //audit Assumption: decimal or version-style periods like "GPT-5.1" belong inside a single sentence; failure risk: sentence splitting turns one truthful limitation into a caveat plus an orphaned fragment like "1 system here."; expected invariant: punctuation between digits never creates a new sentence boundary; handling strategy: keep the segment open when a period is flanked by digits.
    if (character === '.' && isNumericSentencePeriod(line, index)) {
      continue;
    }

    const nextCharacter = line[index + 1] ?? '';
    if (nextCharacter && !/\s/.test(nextCharacter)) {
      continue;
    }

    const normalizedSegment = currentSegment.trim();
    if (normalizedSegment) {
      segments.push(normalizedSegment);
    }
    currentSegment = '';

    while (index + 1 < line.length && /\s/.test(line[index + 1] ?? '')) {
      index += 1;
    }
  }

  const trailingSegment = currentSegment.trim();
  if (trailingSegment) {
    segments.push(trailingSegment);
  }

  return segments;
}

function splitIntoSegments(text: string): string[] {
  const normalizedText = normalizeWhitespace(text);
  if (!normalizedText) return [];
  return normalizedText
    .split(/\n+/)
    .flatMap(line => splitLineIntoSegments(line))
    .map(segment => segment.trim())
    .filter(Boolean);
}

function hasExplicitLimitationLanguage(text: string): boolean {
  return LIMITATION_LANGUAGE_PATTERN.test(text);
}

function normalizeScopeToken(value: string): string {
  let normalizedValue = value.toLowerCase().replace(/[^a-z0-9]+/g, '');
  if (normalizedValue.endsWith('ies') && normalizedValue.length > 4) {
    normalizedValue = `${normalizedValue.slice(0, -3)}y`;
  } else if (
    normalizedValue.endsWith('s') &&
    normalizedValue.length > 4 &&
    !normalizedValue.endsWith('ss') &&
    normalizedValue !== 'news'
  ) {
    normalizedValue = normalizedValue.slice(0, -1);
  }
  return normalizedValue;
}

function extractMeaningfulScopeTokens(text: string): string[] {
  return text
    .split(/[^a-z0-9]+/i)
    .map(value => normalizeScopeToken(value))
    .filter(value => value.length > 2 && !SCOPE_STOP_WORDS.has(value));
}

function buildAllowedScopeTerms(userPrompt: string, reasoningHonesty: TrinityReasoningHonesty): Set<string> {
  return new Set(
    [
      ...extractMeaningfulScopeTokens(userPrompt),
      ...reasoningHonesty.achievableSubtasks.flatMap(extractMeaningfulScopeTokens),
      ...reasoningHonesty.blockedSubtasks.flatMap(extractMeaningfulScopeTokens),
      ...reasoningHonesty.userVisibleCaveats.flatMap(extractMeaningfulScopeTokens)
    ]
  );
}

function normalizeSegmentForComparison(segment: string): string {
  return segment
    .toLowerCase()
    .replace(/[^\w\s]/g, ' ')
    .replace(/\bcan'?t\b/g, 'cannot')
    .replace(/\s+/g, ' ')
    .trim();
}

function buildComparisonTokenSet(segment: string): Set<string> {
  return new Set(
    normalizeSegmentForComparison(segment)
      .split(/\s+/)
      .map(value => normalizeScopeToken(value))
      .filter(value => value.length > 2 && !SCOPE_STOP_WORDS.has(value))
  );
}

function calculateTokenOverlap(leftTokens: Set<string>, rightTokens: Set<string>): number {
  if (leftTokens.size === 0 || rightTokens.size === 0) {
    return 0;
  }
  let intersectionSize = 0;
  for (const token of leftTokens) {
    if (rightTokens.has(token)) {
      intersectionSize += 1;
    }
  }
  return intersectionSize / Math.max(leftTokens.size, rightTokens.size);
}

function formatBlockedSubtaskAsLimitation(blockedSubtask: string): string {
  const normalizedSubtask = normalizeWhitespace(blockedSubtask).replace(/\.+$/, '');
  if (!normalizedSubtask) return '';
  if (LIMITATION_LANGUAGE_PATTERN.test(normalizedSubtask)) {
    return `${normalizedSubtask}.`;
  }
  return `I can't ${normalizedSubtask}.`;
}

function classifyLimitationCategory(segment: string): LimitationCategory | null {
  if (!LIMITATION_LANGUAGE_PATTERN.test(segment)) {
    return null;
  }
  if (/\b(live|browse|current|latest|competitor|external|market|news|verify|confirm)\b/i.test(segment)) {
    return 'live_verification';
  }
  if (/\b(backend|api|endpoint|services?|call|run)\b/i.test(segment)) {
    return 'backend_action';
  }
  if (/\b(save|saved|persist|persisted|store|stored|write|wrote|update|updated|insert|inserted|database|db)\b/i.test(segment)) {
    return 'persistence_action';
  }
  return 'general';
}

function evidenceMatchesCategory(
  evidenceTag: TrinityEvidenceTag,
  category: 'live_verification' | 'current_external_state' | 'backend_action'
): boolean {
  const normalizedClaim = evidenceTag.claimText.toLowerCase();
  switch (category) {
    case 'live_verification':
      return LIVE_VERIFICATION_PATTERN.test(normalizedClaim);
    case 'current_external_state':
      return CURRENT_EXTERNAL_STATE_PATTERN.test(normalizedClaim) || EXTERNAL_STATE_CONTEXT_PATTERN.test(normalizedClaim);
    case 'backend_action':
      return BACKEND_ACTION_PATTERN.test(normalizedClaim) && BACKEND_ACTION_CONTEXT_PATTERN.test(normalizedClaim);
  }
}

function hasVerifiedToolEvidence(
  evidenceTags: TrinityEvidenceTag[],
  category: 'live_verification' | 'current_external_state' | 'backend_action'
): boolean {
  return evidenceTags.some(evidenceTag => (
    evidenceTag.sourceType === 'tool' &&
    evidenceTag.verificationStatus === 'verified' &&
    evidenceMatchesCategory(evidenceTag, category)
  ));
}

function impliesCurrentExternalStateClaim(text: string): boolean {
  return (
    (CURRENT_EXTERNAL_STATE_PATTERN.test(text) && EXTERNAL_STATE_CONTEXT_PATTERN.test(text)) ||
    LIVE_RUNTIME_STATE_PATTERN.test(text)
  );
}

function requestTargetsCurrentExternalState(text: string): boolean {
  return (
    impliesCurrentExternalStateClaim(text) ||
    (EXTERNAL_STATE_CONTEXT_PATTERN.test(text) && CURRENT_EXTERNAL_REQUEST_PATTERN.test(text))
  );
}

function isSectionHeading(text: string): boolean {
  const trimmedText = text.trim();
  return SECTION_HEADING_PATTERN.test(trimmedText) && !LIST_ITEM_PATTERN.test(trimmedText);
}

function isListItem(text: string): boolean {
  return LIST_ITEM_PATTERN.test(text.trim());
}

function isPlanningOrInstructionSegment(text: string): boolean {
  return PLANNING_OR_INSTRUCTION_LEAD_PATTERN.test(text);
}

function isLikelyCurrentExternalStateSectionHeading(text: string, userPrompt: string): boolean {
  return (
    requestTargetsCurrentExternalState(userPrompt) &&
    isSectionHeading(text) &&
    (impliesCurrentExternalStateClaim(text) || EXTERNAL_STATE_SECTION_HEADING_CONTEXT_PATTERN.test(text))
  );
}

function isLikelyCurrentExternalStateFactAssertion(text: string, userPrompt: string): boolean {
  if (
    !requestTargetsCurrentExternalState(userPrompt) ||
    hasExplicitLimitationLanguage(text) ||
    isPlanningOrInstructionSegment(text) ||
    !EXTERNAL_STATE_CONTEXT_PATTERN.test(text)
  ) {
    return false;
  }

  return (
    impliesCurrentExternalStateClaim(text) ||
    (CURRENT_EXTERNAL_FACT_SUBJECT_PATTERN.test(text) && CURRENT_EXTERNAL_FACT_VERB_PATTERN.test(text)) ||
    CURRENT_EXTERNAL_FACT_NOUN_PHRASE_LEAD_PATTERN.test(text)
  );
}

function isLikelyUnsupportedExternalStateSectionBody(text: string): boolean {
  return isListItem(text) && !hasExplicitLimitationLanguage(text) && !isPlanningOrInstructionSegment(text);
}

function containsAffirmativeVerificationVerb(text: string): boolean {
  const normalizedText = text.toLowerCase();
  const negativeVerificationPhrases = [
    "can't verify",
    'cannot verify',
    "can't confirm",
    'cannot confirm',
    'unable to verify',
    'unable to confirm',
    'not verified',
    'not confirmed',
    'unverified'
  ];

  //audit Assumption: limitation lines often repeat verification verbs in negated form; failure risk: the honesty guard mistakes "can't verify" for a positive claim and strips valid caveats; expected invariant: explicit negative verification phrases suppress the affirmative-claim detector; handling strategy: short-circuit before checking the broader verification-verb pattern.
  if (negativeVerificationPhrases.some(phrase => normalizedText.includes(phrase))) {
    return false;
  }

  return /\b(i|we)\s+(checked|verified|confirmed|reviewed|validated|looked up)\b/i.test(text);
}

function containsAffirmativeCurrentStateAssertion(text: string): boolean {
  const normalizedText = text.toLowerCase();
  const negativeStatePhrases = [
    'unverified',
    'unconfirmed',
    'unavailable',
    'unknown',
    'uncertain',
    'not confirmed',
    'not verified',
    'not available',
    'not observable',
    'not visible',
    'not current',
    'not live'
  ];

  if (negativeStatePhrases.some(phrase => normalizedText.includes(phrase))) {
    return false;
  }

  return /\b(is|are|was|were|appears?|looks?|remains?)\s+(healthy|stable|consistent|available|current|latest|live|running|active|complete)\b/i.test(text);
}

function isQualifiedCurrentStateLimitation(text: string): boolean {
  const hasExplicitLimitationSignal =
    LIMITATION_LANGUAGE_PATTERN.test(text) ||
    (STATIC_SCOPE_LIMITATION_PATTERN.test(text) && NEGATED_LIVE_SCOPE_PATTERN.test(text));

  return (
    impliesCurrentExternalStateClaim(text) &&
    hasExplicitLimitationSignal &&
    !containsAffirmativeVerificationVerb(text) &&
    !containsAffirmativeCurrentStateAssertion(text)
  );
}

function allowsProvidedDataVerificationClaim(
  text: string,
  capabilityFlags: TrinityCapabilityFlags
): boolean {
  return (
    capabilityFlags.canVerifyProvidedData &&
    LIVE_VERIFICATION_PATTERN.test(text) &&
    !impliesCurrentExternalStateClaim(text)
  );
}

function buildPartialRefusalLead(reasoningHonesty: TrinityReasoningHonesty): string | null {
  const achievableTaskSummary = formatTaskList(reasoningHonesty.achievableSubtasks);
  const blockedTaskSummary = formatTaskList(reasoningHonesty.blockedSubtasks);
  if (!blockedTaskSummary) {
    return null;
  }
  return achievableTaskSummary
    ? `I can help with ${achievableTaskSummary}, but I can't ${blockedTaskSummary} here.`
    : `I can't ${blockedTaskSummary} here.`;
}

function buildFallbackHonestyText(reasoningHonesty: TrinityReasoningHonesty): string {
  const lead = buildPartialRefusalLead(reasoningHonesty);
  const caveat = reasoningHonesty.userVisibleCaveats.find(entry => entry.trim().length > 0)?.trim();
  return [lead, caveat].filter((entry): entry is string => Boolean(entry)).join(' ').trim()
    || 'I can help with general guidance, but I cannot verify external or executed state here.';
}

function parseMaxWordsFromPrompt(prompt: string): number | null {
  const patterns = [
    /\bunder\s+(\d+)\s+words?\b/i,
    /\bwithin\s+(\d+)\s+words?\b/i,
    /\bno more than\s+(\d+)\s+words?\b/i,
    /\bmax(?:imum)?\s+(\d+)\s+words?\b/i,
    /\b(\d+)\s*-\s*word\s+max\b/i,
    /\b(\d+)\s+word\s+limit\b/i
  ] as const;
  for (const pattern of patterns) {
    const match = prompt.match(pattern);
    if (match) {
      const parsedValue = Number.parseInt(match[1] ?? '', 10);
      if (Number.isFinite(parsedValue) && parsedValue > 0) {
        return Math.min(parsedValue, 2_000);
      }
    }
  }
  return null;
}

function containsAnyPattern(prompt: string, patterns: readonly RegExp[]): boolean {
  return patterns.some(pattern => pattern.test(prompt));
}

function resolveRequestedVerbosity(prompt: string, options: TrinityRunOptions): TrinityOutputControls['requestedVerbosity'] {
  if (options.requestedVerbosity) {
    return options.requestedVerbosity;
  }
  if (containsAnyPattern(prompt, [/\bconcise\b/i, /\bbrief\b/i, /\bminimal\b/i, /\bdirect answer only\b/i, /\bno extra explanation\b/i, /\bjust answer\b/i, /\bkeep it short\b/i])) {
    return 'minimal';
  }
  if (containsAnyPattern(prompt, [/\bdetailed\b/i, /\bin depth\b/i, /\bdeep dive\b/i, /\bstep by step\b/i, /\bfully explain\b/i])) {
    return 'detailed';
  }
  return DEFAULT_OUTPUT_CONTROLS.requestedVerbosity;
}

function resolveAnswerMode(prompt: string, options: TrinityRunOptions): TrinityOutputControls['answerMode'] {
  if (options.answerMode) {
    return options.answerMode;
  }
  if (containsAnyPattern(prompt, [/\bdebug\b/i, /\bshow pipeline\b/i, /\bshow intake output\b/i, /\bshow reasoning output\b/i])) {
    return 'debug';
  }
  if (containsAnyPattern(prompt, [/\baudit\b/i, /\baudit notes\b/i, /\breasoning notes\b/i])) {
    return 'audit';
  }
  if (containsAnyPattern(prompt, [/\bdirect answer only\b/i, /\bno extra explanation\b/i, /\bjust answer\b/i, /\bno preamble\b/i])) {
    return 'direct';
  }
  if (containsAnyPattern(prompt, [/\bexplain\b/i, /\bwhy\b/i, /\brationale\b/i, /\bwalk me through\b/i])) {
    return 'explained';
  }
  return DEFAULT_OUTPUT_CONTROLS.answerMode;
}

function stripStyleInflationPrefix(text: string): string {
  let cleanedText = text.trim();
  for (const pattern of STYLE_INFLATION_PREFIX_PATTERNS) {
    cleanedText = cleanedText.replace(pattern, '');
  }
  return cleanedText.trim();
}

function buildLimitationSentence(params: {
  fallbackText: string;
  existingCaveats: string[];
  blockedSubtasks: string[];
  matcher: RegExp;
}): string {
  const matchingCaveat = params.existingCaveats.find(caveat => params.matcher.test(caveat));
  if (matchingCaveat) return matchingCaveat.trim();
  const matchingBlockedSubtask = params.blockedSubtasks.find(blockedSubtask => params.matcher.test(blockedSubtask));
  if (matchingBlockedSubtask) return formatBlockedSubtaskAsLimitation(matchingBlockedSubtask);
  return params.fallbackText;
}

function ensureSingleSentence(text: string): string {
  const normalizedText = normalizeWhitespace(text).replace(/\.$/, '');
  return normalizedText ? `${normalizedText}.` : '';
}

function looksLikePromptGenerationCapabilityDisclaimer(segment: string): boolean {
  return PROMPT_GENERATION_DISCLAIMER_PATTERNS.some(pattern => pattern.test(segment.trim()));
}

function stripLeadingPromptGenerationDisclaimers(text: string): string {
  const segments = splitIntoSegments(text);
  let startIndex = 0;

  while (
    segments.length - startIndex > 1 &&
    looksLikePromptGenerationCapabilityDisclaimer(segments[startIndex] ?? '')
  ) {
    startIndex += 1;
  }

  return normalizeWhitespace(segments.slice(startIndex).join(' '));
}

function buildRequestIntentPromptLines(requestIntent: TrinityIntentMode): string[] {
  if (requestIntent === 'PROMPT_GENERATION') {
    return [
      '- Request intent: PROMPT_GENERATION.',
      '- Treat repo inspection, runtime checks, API verification, commands, and live-state references as instructions for the downstream executor.',
      '- Do not refuse solely because this backend lacks direct repo, runtime, or live external access when the user only asked for a prompt/spec/instructions.'
    ];
  }

  return [
    '- Request intent: EXECUTE_TASK.',
    '- Apply normal capability limits to work the backend itself is being asked to perform.'
  ];
}

function rewriteUnsupportedClaims(params: {
  text: string;
  userPrompt: string;
  capabilityFlags: TrinityCapabilityFlags;
  reasoningHonesty: TrinityReasoningHonesty;
}): { text: string; blockedOrRewrittenClaims: string[] } {
  const segments = splitIntoSegments(params.text);
  const blockedOrRewrittenClaims: string[] = [];
  const rewrittenSegments: string[] = [];
  let liveLimitationAdded = false;
  let backendLimitationAdded = false;
  let persistenceLimitationAdded = false;
  const supportsLiveVerification =
    params.capabilityFlags.canVerifyLiveData &&
    params.capabilityFlags.canConfirmExternalState &&
    (hasVerifiedToolEvidence(params.reasoningHonesty.evidenceTags, 'live_verification') ||
      hasVerifiedToolEvidence(params.reasoningHonesty.evidenceTags, 'current_external_state'));
  const supportsBackendAction =
    (params.capabilityFlags.canPersistData || params.capabilityFlags.canCallBackend) &&
    hasVerifiedToolEvidence(params.reasoningHonesty.evidenceTags, 'backend_action');
  let inUnsupportedExternalStateSection = false;

  for (const segment of segments) {
    const externalStateSectionHeading = isLikelyCurrentExternalStateSectionHeading(segment, params.userPrompt);
    if (isSectionHeading(segment) && !externalStateSectionHeading) {
      inUnsupportedExternalStateSection = false;
    }

    const impliesLiveVerification = LIVE_VERIFICATION_PATTERN.test(segment);
    const impliesCurrentExternalState = impliesCurrentExternalStateClaim(segment);
    const impliesIndirectCurrentExternalState =
      isLikelyCurrentExternalStateFactAssertion(segment, params.userPrompt) ||
      (inUnsupportedExternalStateSection && isLikelyUnsupportedExternalStateSectionBody(segment));
    const qualifiedCurrentStateLimitation = isQualifiedCurrentStateLimitation(segment);
    const allowsProvidedDataVerification = allowsProvidedDataVerificationClaim(segment, params.capabilityFlags);
    const impliesBackendAction = BACKEND_ACTION_PATTERN.test(segment) && BACKEND_ACTION_CONTEXT_PATTERN.test(segment);
    const impliesPersistenceAction = /\b(saved|save|persisted|persist|wrote|write|stored|store|updated|update|inserted|insert)\b/i.test(segment);

    //audit Assumption: unverifiable current-state claims must be rewritten before the final answer reaches the caller, but explicit limitation caveats like "runtime enforcement remains unverified" must survive intact; failure risk: the guard replaces truthful caveats with a generic refusal and hides the useful static audit; expected invariant: only affirmative unsupported claims are rewritten; handling strategy: exempt qualified current-state limitations before applying the rewrite.
    if (
      !qualifiedCurrentStateLimitation &&
      (((impliesLiveVerification && !allowsProvidedDataVerification) ||
        impliesCurrentExternalState ||
        externalStateSectionHeading ||
        impliesIndirectCurrentExternalState) &&
        !supportsLiveVerification)
    ) {
      blockedOrRewrittenClaims.push(segment);
      if (!liveLimitationAdded) {
        rewrittenSegments.push(ensureSingleSentence(buildLimitationSentence({
          fallbackText: "I can't confirm current external state here without live access",
          existingCaveats: params.reasoningHonesty.userVisibleCaveats,
          blockedSubtasks: params.reasoningHonesty.blockedSubtasks,
          matcher: /\b(live|browse|current|latest|verify|external|competitor)\b/i
        })));
        liveLimitationAdded = true;
      }
      inUnsupportedExternalStateSection = externalStateSectionHeading || inUnsupportedExternalStateSection || isListItem(segment);
      continue;
    }

    //audit Assumption: backend success wording is invalid without executed tool evidence.
    if (impliesBackendAction && !supportsBackendAction) {
      blockedOrRewrittenClaims.push(segment);
      if (!backendLimitationAdded) {
        rewrittenSegments.push("I can't confirm backend state or run backend actions here.");
        backendLimitationAdded = true;
      }
      continue;
    }

    if (impliesPersistenceAction && !supportsBackendAction && !params.capabilityFlags.canPersistData) {
      blockedOrRewrittenClaims.push(segment);
      if (!persistenceLimitationAdded) {
        rewrittenSegments.push("I haven't saved or persisted anything here.");
        persistenceLimitationAdded = true;
      }
      continue;
    }

    rewrittenSegments.push(segment);
  }

  return {
    text: normalizeWhitespace(rewrittenSegments.join(' ')),
    blockedOrRewrittenClaims
  };
}

function ensureRequiredLimitation(text: string, reasoningHonesty: TrinityReasoningHonesty): string {
  if (
    reasoningHonesty.responseMode === 'partial_refusal' &&
    !LIMITATION_LANGUAGE_PATTERN.test(text) &&
    reasoningHonesty.userVisibleCaveats.length > 0
  ) {
    return normalizeWhitespace(`${ensureSingleSentence(reasoningHonesty.userVisibleCaveats[0] ?? '')} ${text}`);
  }
  return text;
}

function isOpeningPaddingSegment(segment: string): boolean {
  return OPENING_PADDING_SEGMENT_PATTERNS.some(pattern => pattern.test(segment)) && !LIMITATION_LANGUAGE_PATTERN.test(segment);
}

function removeOpeningPadding(text: string): string {
  const segments = splitIntoSegments(text);
  if (segments.length <= 1) {
    return normalizeWhitespace(text);
  }
  const hasSubstantiveContent = segments.some(segment => !isOpeningPaddingSegment(segment));
  if (!hasSubstantiveContent) {
    return normalizeWhitespace(text);
  }
  //audit Assumption: disposable opening fillers can appear after an injected limitation sentence, not just as the first segment; failure risk: hard word-limit compression keeps filler instead of the actual answer; expected invariant: standalone padding lines are removed whenever substantive content remains elsewhere; handling strategy: drop only narrow filler segments that match the padding patterns and preserve all other content.
  return normalizeWhitespace(
    segments
      .filter(segment => !isOpeningPaddingSegment(segment))
      .join(' ')
  );
}

function trimUnrequestedScopeDrift(text: string, userPrompt: string, reasoningHonesty: TrinityReasoningHonesty): string {
  const allowedScopeTerms = buildAllowedScopeTerms(userPrompt, reasoningHonesty);
  return normalizeWhitespace(
    text.replace(SCOPE_DRIFT_QUALIFIER_PATTERN, (fullMatch, qualifierTarget: string) => {
      const normalizedQualifierTarget = normalizeScopeToken(qualifierTarget);
      //audit Assumption: narrow trailing qualifiers like "or your tooling" are scope drift unless the original request or reasoning contract explicitly mentions them; failure risk: leaving unrelated caveats in the answer makes the final output sound broader than requested; expected invariant: qualifier targets absent from the user/request scope are removed while requested ones remain; handling strategy: compare only against terms sourced from the prompt and reasoning metadata.
      return allowedScopeTerms.has(normalizedQualifierTarget) ? fullMatch : '';
    })
  );
}

function buildPreferredLimitationSegment(
  category: LimitationCategory,
  reasoningHonesty: TrinityReasoningHonesty
): string | null {
  switch (category) {
    case 'live_verification':
      return ensureSingleSentence(buildLimitationSentence({
        fallbackText: "I can't verify current external state here without live access",
        existingCaveats: reasoningHonesty.userVisibleCaveats,
        blockedSubtasks: reasoningHonesty.blockedSubtasks,
        matcher: /\b(live|browse|current|latest|verify|external|competitor|market|news)\b/i
      }));
    case 'backend_action':
      return ensureSingleSentence(buildLimitationSentence({
        fallbackText: "I can't confirm backend state or run backend actions here",
        existingCaveats: reasoningHonesty.userVisibleCaveats,
        blockedSubtasks: reasoningHonesty.blockedSubtasks,
        matcher: /\b(backend|api|endpoint|service|services|call|run)\b/i
      }));
    case 'persistence_action':
      return ensureSingleSentence(buildLimitationSentence({
        fallbackText: "I haven't saved or persisted anything here",
        existingCaveats: reasoningHonesty.userVisibleCaveats,
        blockedSubtasks: reasoningHonesty.blockedSubtasks,
        matcher: /\b(save|persist|store|write|database|db|update|insert)\b/i
      }));
    case 'general':
      return reasoningHonesty.userVisibleCaveats[0]
        ? ensureSingleSentence(reasoningHonesty.userVisibleCaveats[0] ?? '')
        : null;
  }
}

function compressLimitationSegments(text: string, reasoningHonesty: TrinityReasoningHonesty): string {
  const segments = splitIntoSegments(text);
  const seenCategories = new Set<LimitationCategory>();
  const keptSegments: string[] = [];
  for (const segment of segments) {
    const limitationCategory = classifyLimitationCategory(segment);
    if (!limitationCategory) {
      keptSegments.push(segment);
      continue;
    }
    //audit Assumption: the final answer should keep at most one concise limitation per limitation category; failure risk: stacked caveats crowd out the achievable answer; expected invariant: duplicate live/backend/persistence limitations collapse to one preferred sentence; handling strategy: keep the first category instance and replace it with the most specific caveat available from reasoning metadata.
    if (seenCategories.has(limitationCategory)) {
      continue;
    }
    seenCategories.add(limitationCategory);
    keptSegments.push(buildPreferredLimitationSegment(limitationCategory, reasoningHonesty) ?? ensureSingleSentence(segment));
  }
  return normalizeWhitespace(keptSegments.join(' '));
}

function areNearDuplicateSegments(leftSegment: string, rightSegment: string): boolean {
  const normalizedLeftSegment = normalizeSegmentForComparison(leftSegment);
  const normalizedRightSegment = normalizeSegmentForComparison(rightSegment);
  if (!normalizedLeftSegment || !normalizedRightSegment) {
    return false;
  }
  if (normalizedLeftSegment === normalizedRightSegment) {
    return true;
  }
  const leftTokens = buildComparisonTokenSet(leftSegment);
  const rightTokens = buildComparisonTokenSet(rightSegment);
  const tokenOverlap = calculateTokenOverlap(leftTokens, rightTokens);
  if (
    (normalizedLeftSegment.includes(normalizedRightSegment) || normalizedRightSegment.includes(normalizedLeftSegment)) &&
    tokenOverlap >= SUBSTRING_DUPLICATE_OVERLAP_THRESHOLD
  ) {
    return true;
  }
  const leftCategory = classifyLimitationCategory(leftSegment);
  const rightCategory = classifyLimitationCategory(rightSegment);
  if (leftCategory && rightCategory && leftCategory === rightCategory) {
    return tokenOverlap >= SAME_CATEGORY_LIMITATION_DUPLICATE_OVERLAP_THRESHOLD;
  }
  return tokenOverlap >= GENERAL_DUPLICATE_OVERLAP_THRESHOLD;
}

function dedupeNearDuplicateSegments(text: string): string {
  const keptSegments: string[] = [];
  for (const segment of splitIntoSegments(text)) {
    //audit Assumption: near-duplicate segments are accidental padding, not distinct user value; failure risk: repeated caveats or answer lines make the final output sound verbose and unnatural; expected invariant: only the first materially distinct sentence survives; handling strategy: compare normalized token overlap and drop later repeats.
    if (keptSegments.some(existingSegment => areNearDuplicateSegments(existingSegment, segment))) {
      continue;
    }
    keptSegments.push(segment);
  }
  return normalizeWhitespace(keptSegments.join(' '));
}

function removeUnrequestedMetaSections(text: string, outputControls: TrinityOutputControls): { text: string; removedMetaSections: string[] } {
  if (outputControls.answerMode === 'audit' || outputControls.answerMode === 'debug') {
    return { text, removedMetaSections: [] };
  }
  const removedHeaderMatch = text.match(META_SECTION_HEADER_PATTERN);
  if (!removedHeaderMatch) {
    return { text, removedMetaSections: [] };
  }
  return {
    text: text.replace(META_SECTION_HEADER_PATTERN, '').trim(),
    removedMetaSections: [removedHeaderMatch[0].trim()]
  };
}

function resolveEffectiveWordLimit(outputControls: TrinityOutputControls): number | null {
  if (typeof outputControls.maxWords === 'number' && outputControls.maxWords > 0) {
    return outputControls.maxWords;
  }
  return outputControls.requestedVerbosity === 'minimal' || outputControls.answerMode === 'direct' ? 90 : null;
}

function compressToWordLimit(text: string, outputControls: TrinityOutputControls): string {
  const effectiveWordLimit = resolveEffectiveWordLimit(outputControls);
  if (!effectiveWordLimit || countWords(text) <= effectiveWordLimit) {
    return normalizeWhitespace(text);
  }

  const indexedSegments = splitIntoSegments(text).map((segment, index) => ({
    segment,
    index,
    isLimitation: LIMITATION_LANGUAGE_PATTERN.test(segment)
  }));
  const prioritizedSegments = [
    ...indexedSegments.filter(item => item.isLimitation),
    ...indexedSegments.filter(item => !item.isLimitation)
  ];
  const selectedIndexes = new Set<number>();
  let usedWords = 0;

  for (const item of prioritizedSegments) {
    const segmentWordCount = countWords(item.segment);
    if (usedWords + segmentWordCount > effectiveWordLimit) {
      continue;
    }
    selectedIndexes.add(item.index);
    usedWords += segmentWordCount;
  }

  if (selectedIndexes.size === 0 && indexedSegments.length > 0) {
    return normalizeWhitespace(indexedSegments[0]!.segment.split(/\s+/).slice(0, effectiveWordLimit).join(' '));
  }

  return normalizeWhitespace(
    indexedSegments
      .filter(item => selectedIndexes.has(item.index))
      .map(item => item.segment)
      .join(' ')
  );
}

/**
 * Derive conservative capability flags for a Trinity request.
 * Inputs: optional tool-backed capability booleans. Output: normalized capability flags.
 */
export function deriveTrinityCapabilityFlags(toolBackedCapabilities: TrinityToolBackedCapabilities = {}): TrinityCapabilityFlags {
  return {
    canBrowse: toolBackedCapabilities.browse === true,
    canVerifyProvidedData: toolBackedCapabilities.verifyProvidedData === true,
    canVerifyLiveData: toolBackedCapabilities.verifyLiveData === true,
    canConfirmExternalState: toolBackedCapabilities.confirmExternalState === true,
    canPersistData: toolBackedCapabilities.persistData === true,
    canCallBackend: toolBackedCapabilities.callBackend === true
  };
}

/**
 * Create the default reasoning honesty envelope for downstream stages.
 */
export function createDefaultTrinityReasoningHonesty(): TrinityReasoningHonesty {
  return {
    responseMode: 'answer',
    achievableSubtasks: [],
    blockedSubtasks: [],
    userVisibleCaveats: [],
    evidenceTags: []
  };
}

/**
 * Serialize capability flags into a prompt-safe block for downstream stages.
 */
export function buildCapabilityFlagsPromptBlock(capabilityFlags: TrinityCapabilityFlags): string {
  return `<capability_flags>\n${serializePromptJson({
    can_browse: capabilityFlags.canBrowse,
    can_verify_provided_data: capabilityFlags.canVerifyProvidedData,
    can_verify_live_data: capabilityFlags.canVerifyLiveData,
    can_confirm_external_state: capabilityFlags.canConfirmExternalState,
    can_persist_data: capabilityFlags.canPersistData,
    can_call_backend: capabilityFlags.canCallBackend
  })}\n</capability_flags>`;
}

/**
 * Build the intake-stage prompt envelope that preserves hard capability limits.
 */
export function buildIntakeCapabilityEnvelope(
  userRequest: string,
  capabilityFlags: TrinityCapabilityFlags,
  requestIntent: TrinityIntentMode = 'EXECUTE_TASK'
): string {
  return [
    '<original_request>',
    sanitizePromptLine(userRequest),
    '</original_request>',
    '',
    buildCapabilityFlagsPromptBlock(capabilityFlags),
    '',
    ...buildRequestIntentPromptLines(requestIntent),
    '',
    'Hard constraints:',
    '- Preserve these capability flags exactly as written.',
    '- If the request mixes achievable and impossible work, keep the limitation explicit and still answer the achievable portion.',
    '- Verification of provided inputs or dependency outputs is allowed only when `can_verify_provided_data=true`; this never permits live or runtime-state verification.',
    '- Do not imply browsing, live verification, backend execution, or persistence unless the capability flags allow it.',
    '- If current-state verification is impossible, keep that limitation visible instead of smoothing it away.'
  ].join('\n');
}

/**
 * Build the reasoning-stage prompt envelope with conservative honesty rules.
 */
export function buildReasoningCapabilityEnvelope(
  framedRequest: string,
  capabilityFlags: TrinityCapabilityFlags,
  requestIntent: TrinityIntentMode = 'EXECUTE_TASK'
): string {
  return [
    '<framed_request>',
    sanitizePromptLine(framedRequest),
    '</framed_request>',
    '',
    buildCapabilityFlagsPromptBlock(capabilityFlags),
    '',
    ...buildRequestIntentPromptLines(requestIntent),
    '',
    'Schema requirements:',
    '- `response_mode` must be `partial_refusal` when any blocked subtask exists, and `refusal` only when nothing achievable remains.',
    '- Populate `achievable_subtasks`, `blocked_subtasks`, and `user_visible_caveats` with concrete short phrases.',
    '- Populate `claim_tags` using only: `tool`, `user_context`, `memory`, `inference`, or `template`.',
    '- Verification based only on provided inputs or dependency outputs may use verified wording only when `can_verify_provided_data=true`; live or runtime-state claims still require live evidence.',
    '- `verification_status` may be `verified` only when the claim is backed by actual tool evidence allowed by the capability flags.',
    '- If a fact is not verifiable here, mark it `unverified`, `inferred`, or `unavailable` instead of upgrading certainty.'
  ].join('\n');
}

/**
 * Build the final-stage honesty instruction that prevents unsupported certainty upgrades.
 */
export function buildFinalHonestyInstruction(
  capabilityFlags: TrinityCapabilityFlags,
  reasoningHonesty: TrinityReasoningHonesty,
  requestIntent: TrinityIntentMode = 'EXECUTE_TASK'
): string {
  return [
    buildCapabilityFlagsPromptBlock(capabilityFlags),
    '',
    ...buildRequestIntentPromptLines(requestIntent),
    '',
    '<reasoning_honesty>',
    serializePromptJson({
      response_mode: reasoningHonesty.responseMode,
      achievable_subtasks: normalizePromptList(reasoningHonesty.achievableSubtasks),
      blocked_subtasks: normalizePromptList(reasoningHonesty.blockedSubtasks),
      user_visible_caveats: normalizePromptList(reasoningHonesty.userVisibleCaveats),
      claim_tags: reasoningHonesty.evidenceTags.map(evidenceTag => ({
        claim_text: sanitizePromptLine(evidenceTag.claimText),
        source_type: evidenceTag.sourceType,
        confidence: evidenceTag.confidence,
        verification_status: evidenceTag.verificationStatus
      }))
    }),
    '</reasoning_honesty>',
    '',
    'Final-stage constraints:',
    '- If reasoning marked any subtask as blocked or unverifiable, keep that limitation explicit in the user-facing answer.',
    '- Do not upgrade `unverified`, `inferred`, or `unavailable` claims into verified, checked, current, or confirmed wording.',
    '- Do not claim backend calls, saves, writes, or successful tool actions unless there is explicit tool-backed verified evidence.',
    ...(requestIntent === 'PROMPT_GENERATION'
      ? [
          '- For PROMPT_GENERATION, downstream repo/runtime/API steps are instructions for another executor, not unsupported claims by this backend.',
          '- Do not refuse solely because the downstream prompt mentions inspection, verification, commands, or live state.'
        ]
      : []),
    '- If the request has both achievable and blocked parts, answer the achievable part and qualify the blocked part instead of refusing everything.'
  ].join('\n');
}

/**
 * Rewrite final-stage output when it overclaims unsupported live verification or executed actions.
 */
export function enforceFinalStageHonesty(
  rawText: string,
  reasoningHonesty: TrinityReasoningHonesty,
  capabilityFlags: TrinityCapabilityFlags,
  requestIntent: TrinityIntentMode = 'EXECUTE_TASK'
): FinalClaimBlockResult {
  //audit Assumption: prompt-generation requests may legitimately contain repo/runtime/API verification steps for a downstream executor; failure risk: execution-time capability disclaimers overwrite a valid generated prompt; expected invariant: unsupported-access rewrites only apply when the backend itself was asked to execute the work; handling strategy: bypass claim blocking for PROMPT_GENERATION and rely on the downstream-instruction prompts plus normal safety layers.
  if (requestIntent === 'PROMPT_GENERATION') {
    return {
      text: normalizeWhitespace(rawText),
      blocked: false,
      blockedCategories: []
    };
  }

  const supportsLiveVerification =
    capabilityFlags.canVerifyLiveData &&
    capabilityFlags.canConfirmExternalState &&
    hasVerifiedToolEvidence(reasoningHonesty.evidenceTags, 'live_verification') &&
    hasVerifiedToolEvidence(reasoningHonesty.evidenceTags, 'current_external_state');
  const supportsBackendAction =
    (capabilityFlags.canPersistData || capabilityFlags.canCallBackend) &&
    hasVerifiedToolEvidence(reasoningHonesty.evidenceTags, 'backend_action');
  const blockedCategories = new Set<'live_verification' | 'current_external_state' | 'backend_action'>();
  const keptLines: string[] = [];

  for (const line of splitIntoReviewLines(rawText)) {
    if (line.length === 0) {
      keptLines.push(line);
      continue;
    }

    const impliesLiveVerification = LIVE_VERIFICATION_PATTERN.test(line);
    const impliesCurrentExternalState = impliesCurrentExternalStateClaim(line);
    const qualifiedCurrentStateLimitation = isQualifiedCurrentStateLimitation(line);
    const allowsProvidedDataVerification = allowsProvidedDataVerificationClaim(line, capabilityFlags);
    const impliesBackendAction = BACKEND_ACTION_PATTERN.test(line) && BACKEND_ACTION_CONTEXT_PATTERN.test(line);

    //audit Assumption: unsupported verification language must be removed even when the prose sounds polished, but explicit limitation caveats about unverified live/runtime state are already the safe form and should remain visible; failure risk: stripping those caveats erases the precise boundary between static validation and live verification; expected invariant: affirmative unsupported claims are removed while qualified limitations stay in the answer; handling strategy: skip the block path for qualified current-state limitation lines.
    if (
      !qualifiedCurrentStateLimitation &&
      (((impliesLiveVerification && !allowsProvidedDataVerification) || impliesCurrentExternalState) && !supportsLiveVerification)
    ) {
      if (impliesLiveVerification) blockedCategories.add('live_verification');
      if (impliesCurrentExternalState) blockedCategories.add('current_external_state');
      continue;
    }
    if (impliesBackendAction && !supportsBackendAction) {
      blockedCategories.add('backend_action');
      continue;
    }
    keptLines.push(line);
  }

  let text = normalizeOutputSpacing(keptLines);
  const leadingDisclaimers: string[] = [];
  const partialRefusalLead = buildPartialRefusalLead(reasoningHonesty);

  if (partialRefusalLead && !hasExplicitLimitationLanguage(text)) {
    leadingDisclaimers.push(partialRefusalLead);
  }
  if ((blockedCategories.has('live_verification') || blockedCategories.has('current_external_state')) && !/live or current external information/i.test(text)) {
    leadingDisclaimers.push('I can help with general guidance, but I cannot verify live or current external information here.');
  }
  if (blockedCategories.has('backend_action') && !/backend or persistence action/i.test(text)) {
    leadingDisclaimers.push('I have not executed any backend or persistence action here.');
  }
  if (leadingDisclaimers.length > 0) {
    text = `${dedupePreservingOrder(leadingDisclaimers).join(' ')}${text ? `\n\n${text}` : ''}`.trim();
  }
  if (!text) {
    text = buildFallbackHonestyText(reasoningHonesty);
  }

  return { text, blocked: blockedCategories.size > 0, blockedCategories: Array.from(blockedCategories) };
}

/**
 * Derive user-visible output controls from explicit options and prompt cues.
 */
export function deriveTrinityOutputControls(prompt: string, options: TrinityRunOptions): TrinityOutputControls {
  const parsedMaxWords = parseMaxWordsFromPrompt(prompt);
  const requestedVerbosity = resolveRequestedVerbosity(prompt, options);
  const answerMode = resolveAnswerMode(prompt, options);
  const explicitMaxWords = typeof options.maxWords === 'number' && options.maxWords > 0 ? options.maxWords : null;
  const resolvedMaxWords = explicitMaxWords ?? parsedMaxWords;
  const debugPipeline = options.debugPipeline ?? answerMode === 'debug';
  const strictUserVisibleOutput = options.strictUserVisibleOutput ?? DEFAULT_OUTPUT_CONTROLS.strictUserVisibleOutput;
  const intentMode = resolveIntentMode(prompt, options);

  return {
    requestedVerbosity: resolvedMaxWords !== null && resolvedMaxWords <= 80 && !options.requestedVerbosity ? 'minimal' : requestedVerbosity,
    maxWords: resolvedMaxWords,
    answerMode: resolvedMaxWords !== null && resolvedMaxWords <= 80 && !options.answerMode ? 'direct' : answerMode,
    debugPipeline,
    strictUserVisibleOutput,
    intentMode
  };
}

/**
 * Build the structured contract block appended to each Trinity stage prompt.
 */
export function buildTrinityStageContractBlock(params: {
  stage: 'intake' | 'reasoning' | 'final';
  capabilityFlags: TrinityCapabilityFlags;
  outputControls: TrinityOutputControls;
}): string {
  const intentMode = readIntentMode(params.outputControls);
  return [
    '[TRINITY_PIPELINE_CONTRACT]',
    `stage=${params.stage}`,
    `intent_mode=${intentMode}`,
    `request_intent=${intentMode}`,
    `requested_verbosity=${params.outputControls.requestedVerbosity}`,
    `max_words=${params.outputControls.maxWords ?? 'null'}`,
    `answer_mode=${params.outputControls.answerMode}`,
    `debug_pipeline=${params.outputControls.debugPipeline}`,
    `strict_user_visible_output=${params.outputControls.strictUserVisibleOutput}`,
    `can_browse=${params.capabilityFlags.canBrowse}`,
    `can_verify_provided_data=${params.capabilityFlags.canVerifyProvidedData}`,
    `can_verify_live_data=${params.capabilityFlags.canVerifyLiveData}`,
    `can_confirm_external_state=${params.capabilityFlags.canConfirmExternalState}`,
    `can_persist_data=${params.capabilityFlags.canPersistData}`,
    `can_call_backend=${params.capabilityFlags.canCallBackend}`,
    'Rules:',
    '- Do not claim live verification, current external state, backend actions, or saved writes without the matching capability and evidence.',
    '- `can_verify_provided_data=true` allows validation of the provided inputs only; it never permits live/runtime/deployment verification.',
    ...(isPromptGenerationRequest(params.outputControls)
      ? [
          '- When request_intent=PROMPT_GENERATION, references to repo inspection, runtime checks, API verification, or commands belong to the downstream executor.'
        ]
      : []),
    '- If only part of the request is impossible, qualify only that part and continue with the doable portion.',
    '- Do not add audit notes, reasoning notes, or ceremonial framing unless answer_mode is audit or debug.',
    '- Prefer the shortest truthful answer that still completes the request.'
  ].join('\n');
}

/**
 * Build the reasoning-stage prompt with honesty and verbosity constraints.
 */
export function buildReasoningStagePrompt(params: {
  framedRequest: string;
  capabilityFlags: TrinityCapabilityFlags;
  outputControls: TrinityOutputControls;
}): string {
  return [
    buildReasoningCapabilityEnvelope(
      params.framedRequest,
      params.capabilityFlags,
      readIntentMode(params.outputControls)
    ),
    '',
    ...(isPromptGenerationRequest(params.outputControls)
      ? [
          'Prompt-generation override:',
          '- When the user asks for a prompt, spec, brief, or instructions, treat downstream repo/runtime/API actions as executable steps for another agent.',
          '- Keep `response_mode=answer` unless the requested content itself is unsafe.',
          '- Do not mark downstream inspection or verification steps as blocked merely because this backend cannot perform them directly.'
        ]
      : []),
    buildTrinityStageContractBlock({
      stage: 'reasoning',
      capabilityFlags: params.capabilityFlags,
      outputControls: params.outputControls
    }),
    '',
    'Additional reasoning requirements:',
    '- Prefer explicit uncertainty over invented specificity.',
    '- Use partial_refusal when some subtasks are blocked and still complete the achievable parts.',
    '- Mark unverifiable claims as unverified, inferred, or unavailable instead of verified.',
    '- Keep user_visible_caveats short and directly reusable in the final answer.',
    '- Avoid polished meta-language in final_answer; write natural user-facing content.'
  ].join('\n');
}

/**
 * Build the final-stage instruction block with output-control and minimalism rules.
 */
export function buildFinalStageInstruction(params: {
  capabilityFlags: TrinityCapabilityFlags;
  outputControls: TrinityOutputControls;
  reasoningHonesty: TrinityReasoningHonesty;
}): string {
  const optionalCaveat = params.reasoningHonesty.userVisibleCaveats[0];
  return [
    buildTrinityStageContractBlock({
      stage: 'final',
      capabilityFlags: params.capabilityFlags,
      outputControls: params.outputControls
    }),
    '',
    'Final answer requirements:',
    '- Return only the user-facing answer.',
    '- Keep the answer natural and direct. Do not add packaging like "Here is a concise plan" or "Below are the audit notes".',
    '- Preserve any blocked-subtask limitation, but do not pad it with extra commentary.',
    ...(isPromptGenerationRequest(params.outputControls)
      ? [
          '- Request intent is PROMPT_GENERATION. Write the prompt/spec/instructions for the downstream executor instead of refusing for lack of repo/runtime/live access.',
          '- Imperative repo/runtime/API steps belong to the downstream executor and should remain in the generated prompt.'
        ]
      : []),
    optionalCaveat
      ? `- If a limitation is needed, keep it to one short sentence such as: "${optionalCaveat.trim()}"`
      : '- If a limitation is needed, state it once and continue with the doable part.'
  ].join('\n');
}

/**
 * Enforce final-stage honesty and minimalism after ARCANOS-FINAL generation.
 * Inputs: raw final text, original user prompt, capability flags, output controls, and reasoning honesty metadata.
 * Output: normalized user-visible text plus any removed meta sections and rewritten unsupported claims.
 * Edge cases: collapses duplicate limitation sentences, strips narrow scope-drift qualifiers, and keeps the shortest truthful phrasing under direct/minimal word limits.
 */
export function enforceFinalStageHonestyAndMinimalism(params: {
  text: string;
  userPrompt: string;
  capabilityFlags: TrinityCapabilityFlags;
  outputControls: TrinityOutputControls;
  reasoningHonesty: TrinityReasoningHonesty;
}): { text: string; removedMetaSections: string[]; blockedOrRewrittenClaims: string[] } {
  const withoutMetaSections = removeUnrequestedMetaSections(params.text, params.outputControls);
  const deInflatedText = stripStyleInflationPrefix(withoutMetaSections.text);
  const promptGeneration = isPromptGenerationRequest(params.outputControls);
  const promptGenerationTrimmedText = promptGeneration
    ? stripLeadingPromptGenerationDisclaimers(deInflatedText)
    : deInflatedText;
  const rewrittenClaims = promptGeneration
    ? {
        text: promptGenerationTrimmedText,
        blockedOrRewrittenClaims: []
      }
    : rewriteUnsupportedClaims({
        text: promptGenerationTrimmedText,
        userPrompt: params.userPrompt,
        capabilityFlags: params.capabilityFlags,
        reasoningHonesty: params.reasoningHonesty
      });
  const textWithRequiredLimitation = promptGeneration
    ? rewrittenClaims.text
    : ensureRequiredLimitation(rewrittenClaims.text, params.reasoningHonesty);
  const openingMinimizedText = removeOpeningPadding(textWithRequiredLimitation);
  const scopeTightenedText = trimUnrequestedScopeDrift(openingMinimizedText, params.userPrompt, params.reasoningHonesty);
  const limitationCompressedText = promptGeneration
    ? scopeTightenedText
    : compressLimitationSegments(scopeTightenedText, params.reasoningHonesty);
  const dedupedText = dedupeNearDuplicateSegments(limitationCompressedText);
  return {
    text: normalizeWhitespace(compressToWordLimit(dedupedText, params.outputControls)),
    removedMetaSections: withoutMetaSections.removedMetaSections,
    blockedOrRewrittenClaims: rewrittenClaims.blockedOrRewrittenClaims
  };
}

/**
 * Decide whether pipeline debug data may be exposed to the caller.
 */
export function shouldExposePipelineDebug(outputControls: TrinityOutputControls): boolean {
  //audit Assumption: strict user-visible mode must suppress debug payloads even when debug capture is enabled.
  return outputControls.debugPipeline && !outputControls.strictUserVisibleOutput && outputControls.answerMode === 'debug';
}
