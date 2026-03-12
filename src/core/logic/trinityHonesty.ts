/**
 * Trinity honesty controls: capability framing, evidence tagging, minimalism rules, and user-visible debug gating.
 */

import type { TrinityOutputControls, TrinityRunOptions } from './trinityTypes.js';

export type TrinitySourceType = 'tool' | 'user_context' | 'memory' | 'inference' | 'template';
export type TrinityConfidence = 'high' | 'medium' | 'low';
export type TrinityVerificationStatus = 'verified' | 'unverified' | 'inferred' | 'unavailable';
export type TrinityResponseMode = 'answer' | 'partial_refusal' | 'refusal';

export interface TrinityCapabilityFlags {
  canBrowse: boolean;
  canVerifyLiveData: boolean;
  canConfirmExternalState: boolean;
  canPersistData: boolean;
  canCallBackend: boolean;
}

export interface TrinityToolBackedCapabilities {
  browse?: boolean;
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
  strictUserVisibleOutput: true
};

const LIVE_VERIFICATION_PATTERN =
  /\b(verified|verify|confirmed|confirm|checked|check|looked up|look up|reviewed|validated|i checked|i verified|i confirmed)\b/i;
const CURRENT_EXTERNAL_STATE_PATTERN =
  /\b(latest|current|currently|today|this week|recent|recently|up-to-date|as of now)\b/i;
const EXTERNAL_STATE_CONTEXT_PATTERN =
  /\b(competitor|competitors|market|news|pricing|release|launch|moves?|external|trend|trends|company|companies|regulation|stock|stocks|state|status|events?)\b/i;
const BACKEND_ACTION_PATTERN =
  /\b(saved|save|persisted|persist|wrote|write|stored|store|pinged|ping|called|call|updated|update|inserted|insert|deleted|delete|committed|commit|queried|query|inspected|inspect)\b/i;
const BACKEND_ACTION_CONTEXT_PATTERN =
  /\b(backend|database|db|table|record|row|service|services|api|endpoint|cache)\b/i;
const LIMITATION_LANGUAGE_PATTERN =
  /\b(can(?:not|'t)|unable to|do not have|don't have|haven't|have not|cannot confirm|can't confirm|cannot verify|can't verify|without live|without browsing|unverified|inferred|unavailable)\b/i;
const META_SECTION_HEADER_PATTERN =
  /(?:^|\n)\s*(audit notes?|reasoning notes?|developer notes?|observability|verification notes?)\s*:?[^\n]*[\s\S]*$/i;
const STYLE_INFLATION_PREFIX_PATTERNS = [
  /^\s*here(?:'s| is)\s+(?:a|the)\s+(?:concise|brief|direct|structured|auditable|verifiable)[^:]*:\s*/i,
  /^\s*below\s+(?:is|are)\s+[^:]*:\s*/i,
  /^\s*this\s+(?:is|answer is)\s+(?:structured|verifiable|auditable)[^:]*:\s*/i
] as const;

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

function splitIntoSegments(text: string): string[] {
  const normalizedText = normalizeWhitespace(text);
  if (!normalizedText) return [];
  return normalizedText
    .split(/\n+/)
    .flatMap(line => line.match(/[^.!?\n]+[.!?]?/g) ?? [line])
    .map(segment => segment.trim())
    .filter(Boolean);
}

function countWords(text: string): number {
  const words = text.match(/\S+/g);
  return words ? words.length : 0;
}

function hasExplicitLimitationLanguage(text: string): boolean {
  return LIMITATION_LANGUAGE_PATTERN.test(text);
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
  if (matchingBlockedSubtask) return matchingBlockedSubtask.trim().replace(/[.]*$/, '.');
  return params.fallbackText;
}

function ensureSingleSentence(text: string): string {
  const normalizedText = normalizeWhitespace(text).replace(/\.$/, '');
  return normalizedText ? `${normalizedText}.` : '';
}

function rewriteUnsupportedClaims(params: {
  text: string;
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

  for (const segment of segments) {
    const impliesLiveVerification = LIVE_VERIFICATION_PATTERN.test(segment);
    const impliesCurrentExternalState = CURRENT_EXTERNAL_STATE_PATTERN.test(segment) && EXTERNAL_STATE_CONTEXT_PATTERN.test(segment);
    const impliesBackendAction = BACKEND_ACTION_PATTERN.test(segment) && BACKEND_ACTION_CONTEXT_PATTERN.test(segment);
    const impliesPersistenceAction = /\b(saved|save|persisted|persist|wrote|write|stored|store|updated|update|inserted|insert)\b/i.test(segment);

    //audit Assumption: unverifiable current-state claims must be rewritten before the final answer reaches the caller.
    if ((impliesLiveVerification || impliesCurrentExternalState) && !supportsLiveVerification) {
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
    can_verify_live_data: capabilityFlags.canVerifyLiveData,
    can_confirm_external_state: capabilityFlags.canConfirmExternalState,
    can_persist_data: capabilityFlags.canPersistData,
    can_call_backend: capabilityFlags.canCallBackend
  })}\n</capability_flags>`;
}

/**
 * Build the intake-stage prompt envelope that preserves hard capability limits.
 */
export function buildIntakeCapabilityEnvelope(userRequest: string, capabilityFlags: TrinityCapabilityFlags): string {
  return [
    '<original_request>',
    sanitizePromptLine(userRequest),
    '</original_request>',
    '',
    buildCapabilityFlagsPromptBlock(capabilityFlags),
    '',
    'Hard constraints:',
    '- Preserve these capability flags exactly as written.',
    '- If the request mixes achievable and impossible work, keep the limitation explicit and still answer the achievable portion.',
    '- Do not imply browsing, live verification, backend execution, or persistence unless the capability flags allow it.',
    '- If current-state verification is impossible, keep that limitation visible instead of smoothing it away.'
  ].join('\n');
}

/**
 * Build the reasoning-stage prompt envelope with conservative honesty rules.
 */
export function buildReasoningCapabilityEnvelope(framedRequest: string, capabilityFlags: TrinityCapabilityFlags): string {
  return [
    '<framed_request>',
    sanitizePromptLine(framedRequest),
    '</framed_request>',
    '',
    buildCapabilityFlagsPromptBlock(capabilityFlags),
    '',
    'Schema requirements:',
    '- `response_mode` must be `partial_refusal` when any blocked subtask exists, and `refusal` only when nothing achievable remains.',
    '- Populate `achievable_subtasks`, `blocked_subtasks`, and `user_visible_caveats` with concrete short phrases.',
    '- Populate `claim_tags` using only: `tool`, `user_context`, `memory`, `inference`, or `template`.',
    '- `verification_status` may be `verified` only when the claim is backed by actual tool evidence allowed by the capability flags.',
    '- If a fact is not verifiable here, mark it `unverified`, `inferred`, or `unavailable` instead of upgrading certainty.'
  ].join('\n');
}

/**
 * Build the final-stage honesty instruction that prevents unsupported certainty upgrades.
 */
export function buildFinalHonestyInstruction(
  capabilityFlags: TrinityCapabilityFlags,
  reasoningHonesty: TrinityReasoningHonesty
): string {
  return [
    buildCapabilityFlagsPromptBlock(capabilityFlags),
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
    '- If the request has both achievable and blocked parts, answer the achievable part and qualify the blocked part instead of refusing everything.'
  ].join('\n');
}

/**
 * Rewrite final-stage output when it overclaims unsupported live verification or executed actions.
 */
export function enforceFinalStageHonesty(
  rawText: string,
  reasoningHonesty: TrinityReasoningHonesty,
  capabilityFlags: TrinityCapabilityFlags
): FinalClaimBlockResult {
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
    const impliesCurrentExternalState = CURRENT_EXTERNAL_STATE_PATTERN.test(line) && EXTERNAL_STATE_CONTEXT_PATTERN.test(line);
    const impliesBackendAction = BACKEND_ACTION_PATTERN.test(line) && BACKEND_ACTION_CONTEXT_PATTERN.test(line);

    //audit Assumption: unsupported verification language must be removed even when the prose sounds polished.
    if ((impliesLiveVerification || impliesCurrentExternalState) && !supportsLiveVerification) {
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

  return {
    requestedVerbosity: resolvedMaxWords !== null && resolvedMaxWords <= 80 && !options.requestedVerbosity ? 'minimal' : requestedVerbosity,
    maxWords: resolvedMaxWords,
    answerMode: resolvedMaxWords !== null && resolvedMaxWords <= 80 && !options.answerMode ? 'direct' : answerMode,
    debugPipeline,
    strictUserVisibleOutput
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
  return [
    '[TRINITY_PIPELINE_CONTRACT]',
    `stage=${params.stage}`,
    `requested_verbosity=${params.outputControls.requestedVerbosity}`,
    `max_words=${params.outputControls.maxWords ?? 'null'}`,
    `answer_mode=${params.outputControls.answerMode}`,
    `debug_pipeline=${params.outputControls.debugPipeline}`,
    `strict_user_visible_output=${params.outputControls.strictUserVisibleOutput}`,
    `can_browse=${params.capabilityFlags.canBrowse}`,
    `can_verify_live_data=${params.capabilityFlags.canVerifyLiveData}`,
    `can_confirm_external_state=${params.capabilityFlags.canConfirmExternalState}`,
    `can_persist_data=${params.capabilityFlags.canPersistData}`,
    `can_call_backend=${params.capabilityFlags.canCallBackend}`,
    'Rules:',
    '- Do not claim live verification, current external state, backend actions, or saved writes without tool-backed evidence.',
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
    buildReasoningCapabilityEnvelope(params.framedRequest, params.capabilityFlags),
    '',
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
    optionalCaveat
      ? `- If a limitation is needed, keep it to one short sentence such as: "${optionalCaveat.trim()}"`
      : '- If a limitation is needed, state it once and continue with the doable part.'
  ].join('\n');
}

/**
 * Enforce final-stage honesty and minimalism after ARCANOS-FINAL generation.
 */
export function enforceFinalStageHonestyAndMinimalism(params: {
  text: string;
  capabilityFlags: TrinityCapabilityFlags;
  outputControls: TrinityOutputControls;
  reasoningHonesty: TrinityReasoningHonesty;
}): { text: string; removedMetaSections: string[]; blockedOrRewrittenClaims: string[] } {
  const withoutMetaSections = removeUnrequestedMetaSections(params.text, params.outputControls);
  const deInflatedText = stripStyleInflationPrefix(withoutMetaSections.text);
  const rewrittenClaims = rewriteUnsupportedClaims({
    text: deInflatedText,
    capabilityFlags: params.capabilityFlags,
    reasoningHonesty: params.reasoningHonesty
  });
  return {
    text: normalizeWhitespace(compressToWordLimit(ensureRequiredLimitation(rewrittenClaims.text, params.reasoningHonesty), params.outputControls)),
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
