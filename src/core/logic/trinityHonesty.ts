/**
 * Trinity honesty controls for capability framing, evidence tagging, and final-stage claim blocking.
 * Inputs/Outputs: pure helpers that derive capability flags, serialize prompt envelopes, and rewrite unsupported certainty.
 * Edge cases: defaults to conservative false/empty values so unverifiable requests stay explicitly limited unless tool-backed evidence is provided.
 */

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
}

export interface FinalClaimBlockResult {
  text: string;
  blocked: boolean;
  blockedCategories: Array<'live_verification' | 'current_external_state' | 'backend_action'>;
}

const LIVE_VERIFICATION_PATTERN =
  /\b(verified|verify|confirmed|confirm|checked|check|looked up|look up|reviewed|validated|i checked|i verified|i confirmed)\b/i;
const CURRENT_EXTERNAL_STATE_PATTERN =
  /\b(latest|current|currently|today|this week|recent|recently|up-to-date|as of now)\b/i;
const EXTERNAL_STATE_CONTEXT_PATTERN =
  /\b(competitor|competitors|market|news|pricing|release|launch|moves?|external|trend|trends|company|companies|regulation|stock|stocks)\b/i;
const BACKEND_ACTION_PATTERN =
  /\b(saved|save|persisted|persist|wrote|write|stored|store|pinged|ping|called|call|updated|update|inserted|insert|deleted|delete|committed|commit)\b/i;
const BACKEND_ACTION_CONTEXT_PATTERN =
  /\b(backend|database|db|table|record|row|service|api|endpoint|cache)\b/i;
const LIMITATION_LANGUAGE_PATTERN =
  /\b(can(?:not|'t)|unable to|do not have|don't have|haven't|have not|cannot confirm|can't confirm|cannot verify|can't verify)\b/i;

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
  return values
    .map(value => sanitizePromptLine(value))
    .filter(value => value.length > 0);
}

function dedupePreservingOrder(values: string[]): string[] {
  return Array.from(new Set(values.map(value => value.trim()).filter(Boolean)));
}

function formatTaskList(values: string[]): string | null {
  const normalizedValues = dedupePreservingOrder(values);
  //audit Assumption: empty task arrays should not generate placeholder prose; failure risk: robotic filler that weakens the final answer; expected invariant: helper returns null when no useful task text exists; handling strategy: drop empty lists from synthesized disclaimers.
  if (normalizedValues.length === 0) {
    return null;
  }
  return normalizedValues.length === 1 ? normalizedValues[0] : normalizedValues.slice(0, 2).join(' and ');
}

function splitIntoReviewLines(text: string): string[] {
  const rawLines = text.split(/\r?\n/);
  const lines: string[] = [];

  for (const rawLine of rawLines) {
    const trimmedLine = rawLine.trim();
    //audit Assumption: blank lines are structural separators; failure risk: collapsed paragraphs after filtering; expected invariant: paragraph boundaries survive round-trip processing; handling strategy: preserve explicit blank separators.
    if (trimmedLine.length === 0) {
      lines.push('');
      continue;
    }

    //audit Assumption: markdown bullets and numbered steps should stay atomic to avoid mangling list formatting; failure risk: sentence splitting corrupts bullet structure; expected invariant: list lines preserve original formatting; handling strategy: bypass sentence segmentation for bullet-like prefixes.
    if (/^[-*]\s/.test(trimmedLine) || /^\d+\.\s/.test(trimmedLine)) {
      lines.push(trimmedLine);
      continue;
    }

    lines.push(...trimmedLine.split(/(?<=[.!?])\s+/));
  }

  return lines;
}

function hasExplicitLimitationLanguage(text: string): boolean {
  return LIMITATION_LANGUAGE_PATTERN.test(text);
}

function normalizeOutputSpacing(lines: string[]): string {
  const normalizedLines: string[] = [];
  let previousWasBlank = false;

  for (const line of lines) {
    const isBlankLine = line.trim().length === 0;
    //audit Assumption: consecutive blank lines are formatting noise after filtering; failure risk: oversized vertical gaps in final responses; expected invariant: at most one blank separator between content blocks; handling strategy: coalesce repeated blanks.
    if (isBlankLine) {
      if (!previousWasBlank && normalizedLines.length > 0) {
        normalizedLines.push('');
      }
      previousWasBlank = true;
      continue;
    }

    normalizedLines.push(line.trim());
    previousWasBlank = false;
  }

  return normalizedLines.join('\n').trim();
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
    default:
      return false;
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

  //audit Assumption: response-mode metadata should surface only when the model identified blocked work; failure risk: forced refusal prose on fully answerable prompts; expected invariant: partial-refusal lead appears only for mixed or blocked requests; handling strategy: require at least one blocked subtask before generating the sentence.
  if (!blockedTaskSummary) {
    return null;
  }

  if (achievableTaskSummary) {
    return `I can help with ${achievableTaskSummary}, but I can't ${blockedTaskSummary} here.`;
  }

  return `I can't ${blockedTaskSummary} here.`;
}

function buildFallbackHonestyText(reasoningHonesty: TrinityReasoningHonesty): string {
  const lead = buildPartialRefusalLead(reasoningHonesty);
  const caveat = reasoningHonesty.userVisibleCaveats.find(entry => entry.trim().length > 0)?.trim();
  const segments = [lead, caveat].filter((entry): entry is string => typeof entry === 'string' && entry.length > 0);
  return segments.join(' ').trim() || 'I can help with general guidance, but I cannot verify external or executed state here.';
}

/**
 * Derive conservative capability flags for a Trinity request.
 * Inputs/Outputs: optional tool-backed capability booleans -> normalized capability flags.
 * Edge cases: every capability defaults to false unless it is explicitly declared tool-backed.
 */
export function deriveTrinityCapabilityFlags(
  toolBackedCapabilities: TrinityToolBackedCapabilities = {}
): TrinityCapabilityFlags {
  return {
    canBrowse: toolBackedCapabilities.browse === true,
    canVerifyLiveData: toolBackedCapabilities.verifyLiveData === true,
    canConfirmExternalState: toolBackedCapabilities.confirmExternalState === true,
    canPersistData: toolBackedCapabilities.persistData === true,
    canCallBackend: toolBackedCapabilities.callBackend === true
  };
}

/**
 * Create the default honesty envelope for reasoning-stage metadata.
 * Inputs/Outputs: none -> empty-but-conservative reasoning honesty structure.
 * Edge cases: response mode defaults to `answer` so normal requests do not inherit refusal language.
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
 * Serialize capability flags into a prompt-safe JSON block.
 * Inputs/Outputs: capability flags -> XML-like block containing sanitized JSON.
 * Edge cases: booleans always serialize deterministically.
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
 * Build the intake-stage user message that frames hard capability limits.
 * Inputs/Outputs: user request + capability flags -> prompt-safe intake message.
 * Edge cases: request text is sanitized before embedding.
 */
export function buildIntakeCapabilityEnvelope(
  userRequest: string,
  capabilityFlags: TrinityCapabilityFlags
): string {
  return [
    '<original_request>',
    sanitizePromptLine(userRequest),
    '</original_request>',
    '',
    buildCapabilityFlagsPromptBlock(capabilityFlags),
    '',
    'Hard constraints:',
    '- Preserve these capability flags exactly as written.',
    '- If the request mixes achievable and impossible work, frame it so downstream reasoning keeps the limitation explicit and still answers the achievable portion.',
    '- Do not imply browsing, live verification, backend execution, or persistence unless the capability flags allow it.',
    '- If current-state verification is impossible, keep that limitation visible instead of smoothing it away.'
  ].join('\n');
}

/**
 * Build the reasoning-stage prompt envelope with conservative honesty rules.
 * Inputs/Outputs: framed request + capability flags -> schema-oriented reasoning prompt.
 * Edge cases: framed request and metadata are sanitized before embedding.
 */
export function buildReasoningCapabilityEnvelope(
  framedRequest: string,
  capabilityFlags: TrinityCapabilityFlags
): string {
  return [
    '<framed_request>',
    sanitizePromptLine(framedRequest),
    '</framed_request>',
    '',
    buildCapabilityFlagsPromptBlock(capabilityFlags),
    '',
    'Schema requirements:',
    '- `response_mode` must be `partial_refusal` when any blocked subtask exists, and `refusal` only when nothing achievable remains.',
    '- Populate `achievable_subtasks`, `blocked_subtasks`, and `user_visible_caveats` with concrete short phrases, not empty filler.',
    '- Populate `claim_tags` for material claims using only: `tool`, `user_context`, `memory`, `inference`, or `template`.',
    '- `verification_status` may be `verified` only when the claim is backed by actual tool evidence allowed by the capability flags.',
    '- If a fact is not verifiable here, mark it `unverified`, `inferred`, or `unavailable` instead of upgrading certainty.',
    '- Prefer explicit uncertainty over invented specificity and general patterns over unverified current-event claims.'
  ].join('\n');
}

/**
 * Build the final-stage honesty instruction that preserves stage-to-stage limitations.
 * Inputs/Outputs: capability flags + reasoning honesty metadata -> prompt-safe instruction block.
 * Edge cases: empty arrays serialize as deterministic JSON arrays.
 */
export function buildFinalHonestyInstruction(
  capabilityFlags: TrinityCapabilityFlags,
  reasoningHonesty: TrinityReasoningHonesty
): string {
  const promptSafeHonesty = {
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
  };

  return [
    buildCapabilityFlagsPromptBlock(capabilityFlags),
    '',
    '<reasoning_honesty>',
    serializePromptJson(promptSafeHonesty),
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
 * Rewrite final-stage output when it overclaims unsupported live verification or execution.
 * Inputs/Outputs: raw final text + reasoning honesty + capability flags -> rewritten text with block metadata.
 * Edge cases: when all risky lines are removed, returns a fallback limitation sentence derived from reasoning metadata.
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
    //audit Assumption: blank separators preserve paragraph boundaries after filtering; failure risk: merged sections that read unnaturally; expected invariant: blank lines survive when surrounding content survives; handling strategy: carry them through unchanged.
    if (line.length === 0) {
      keptLines.push(line);
      continue;
    }

    const impliesLiveVerification = LIVE_VERIFICATION_PATTERN.test(line);
    const impliesCurrentExternalState =
      CURRENT_EXTERNAL_STATE_PATTERN.test(line) &&
      EXTERNAL_STATE_CONTEXT_PATTERN.test(line);
    const impliesBackendAction =
      BACKEND_ACTION_PATTERN.test(line) &&
      BACKEND_ACTION_CONTEXT_PATTERN.test(line);

    //audit Assumption: unsupported verification language must be removed even when the prose sounds polished; failure risk: final stage upgrades uncertainty into false confirmation; expected invariant: only tool-backed evidence can justify verification claims; handling strategy: drop risky lines and add an explicit limitation prefix later.
    if ((impliesLiveVerification || impliesCurrentExternalState) && !supportsLiveVerification) {
      if (impliesLiveVerification) blockedCategories.add('live_verification');
      if (impliesCurrentExternalState) blockedCategories.add('current_external_state');
      continue;
    }

    //audit Assumption: successful backend/persistence claims are invalid without executed tool evidence; failure risk: user believes a save/write/call occurred when none did; expected invariant: action-success wording survives only with verified tool backing; handling strategy: remove unsupported action lines and synthesize a truthful disclaimer.
    if (impliesBackendAction && !supportsBackendAction) {
      blockedCategories.add('backend_action');
      continue;
    }

    keptLines.push(line);
  }

  let text = normalizeOutputSpacing(keptLines);
  const leadingDisclaimers: string[] = [];
  const partialRefusalLead = buildPartialRefusalLead(reasoningHonesty);

  //audit Assumption: partial-refusal metadata should stay user-visible when the final prose omits it; failure risk: blocked work disappears and answer sounds fully completed; expected invariant: mixed-capability requests retain an explicit limitation statement; handling strategy: prepend a synthesized lead when the filtered text lacks limitation language.
  if (partialRefusalLead && !hasExplicitLimitationLanguage(text)) {
    leadingDisclaimers.push(partialRefusalLead);
  }

  //audit Assumption: filtered current-state/live-verification claims require a replacement disclaimer; failure risk: the user only sees a truncated answer with no reason why; expected invariant: removed live-state claims are explained once in plain language; handling strategy: prepend a single consolidated limitation sentence.
  if (
    (blockedCategories.has('live_verification') || blockedCategories.has('current_external_state')) &&
    !/live or current external information/i.test(text)
  ) {
    leadingDisclaimers.push('I can help with general guidance, but I cannot verify live or current external information here.');
  }

  //audit Assumption: removed backend-action claims require a plain statement that nothing was executed; failure risk: omission alone can still leave the user assuming work happened; expected invariant: rewritten output explicitly denies unexecuted actions; handling strategy: prepend a short execution disclaimer when needed.
  if (blockedCategories.has('backend_action') && !/backend or persistence action/i.test(text)) {
    leadingDisclaimers.push('I have not executed any backend or persistence action here.');
  }

  if (leadingDisclaimers.length > 0) {
    text = `${dedupePreservingOrder(leadingDisclaimers).join(' ')}${text ? `\n\n${text}` : ''}`.trim();
  }

  if (!text) {
    text = buildFallbackHonestyText(reasoningHonesty);
  }

  return {
    text,
    blocked: blockedCategories.size > 0,
    blockedCategories: Array.from(blockedCategories)
  };
}
