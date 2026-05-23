import { redactString, redactValue } from './railway-redaction.mjs';

export const APPROVED_TRAINING_SOURCES = new Set([
  'arcanos_owned_spec',
  'repo_schema',
  'human_authored',
  'redacted_consented_log',
]);

export const CANDIDATE_ONLY_SOURCES = new Set([
  'railway_cli_observation',
  'eval_failure_observation',
]);

export const REJECTED_TRAINING_SOURCES = new Set([
  'openai_output',
  'openai_judgment',
  'custom_gpt_action_request',
  'hidden_reasoning',
  'raw_secret',
  'unknown',
  'third_party_copyrighted',
  'model_generated_label_without_human_review',
  ...CANDIDATE_ONLY_SOURCES,
]);

const SECRET_MARKERS = [
  /\bsk-[A-Za-z0-9_-]{10,}\b/,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{10,}\b/i,
  /\b(?:RAILWAY_TOKEN|RAILWAY_API_TOKEN|OPENAI_API_KEY|DATABASE_URL|POSTGRES_URL|REDIS_URL)\b\s*[:=]\s*["']?[^"',\s]{8,}/i,
  /\b(?:postgres|postgresql|mysql|mongodb|redis):\/\/[^\s"',]+/i,
  /\b(?:railway|rwy|rw)_[A-Za-z0-9_=]{16,}\b/i,
  /\b(api[_-]?key|token|password|secret|cookie)\b\s*[:=]\s*["']?[^"',\s]{8,}/i,
];

const RAW_LOG_MARKERS = [
  /\bStarting\s+Container\b/i,
  /\b(?:INFO|WARN|ERROR|DEBUG)\b\s+[-.:/@A-Za-z0-9_ ]{8,}/,
  /\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z\b.*\b(?:INFO|WARN|ERROR|DEBUG|Traceback)\b/i,
];

function serialized(value) {
  try {
    return typeof value === 'string' ? value : JSON.stringify(value);
  } catch {
    return String(value ?? '');
  }
}

export function hasSecretLikeValue(value) {
  const text = serialized(value);
  return SECRET_MARKERS.some((pattern) => pattern.test(text));
}

export function hasRawLogLikeValue(value) {
  const text = serialized(value);
  return RAW_LOG_MARKERS.some((pattern) => pattern.test(text));
}

function sourceOf(record) {
  return typeof record?.source === 'string' ? record.source : 'unknown';
}

function noOpenAiOutputUsed(record) {
  if (record?.no_openai_output_used === false || record?.metadata?.no_openai_output_used === false) {
    return false;
  }
  if (record?.no_openai_output_used === true || record?.metadata?.no_openai_output_used === true) {
    return true;
  }
  if (record?.openAiCalled === false || record?.openai_called === false) {
    return true;
  }
  return false;
}

function addCommonRejectReasons(record, reasons) {
  const source = sourceOf(record);

  if (record?.contains_secret === true || hasSecretLikeValue(record)) {
    reasons.push('contains_secret');
  }

  if (hasRawLogLikeValue(record)) {
    reasons.push('raw_log_like_content');
  }

  if (!noOpenAiOutputUsed(record)) {
    reasons.push('no_openai_output_used_required');
  }

  if (source === 'openai_output' || source === 'openai_judgment') {
    reasons.push('openai_derived_source_rejected');
  }

  if (source === 'hidden_reasoning') {
    reasons.push('hidden_reasoning_rejected');
  }

  if (source === 'raw_secret') {
    reasons.push('raw_secret_rejected');
  }

  if (source === 'custom_gpt_action_request') {
    reasons.push('custom_gpt_action_request_requires_manual_transform');
  }

  if (source === 'unknown') {
    reasons.push('unknown_source_rejected');
  }
}

export function evaluateCandidateRecord(record) {
  const reasons = [];
  const source = sourceOf(record);
  addCommonRejectReasons(record, reasons);

  if (record?.allowed_for_training !== false) {
    reasons.push('candidate_allowed_for_training_must_be_false');
  }

  if (record?.reviewed !== false) {
    reasons.push('candidate_reviewed_must_be_false');
  }

  if (record?.requires_human_review !== true) {
    reasons.push('candidate_requires_human_review_must_be_true');
  }

  if (source === 'redacted_consented_log' && (record?.redacted !== true || record?.consent !== true)) {
    reasons.push('redacted_consented_log_requires_redaction_and_consent');
  }

  if (APPROVED_TRAINING_SOURCES.has(source)) {
    reasons.push('approved_source_should_enter_reviewed_example_store_not_candidate_queue');
  }

  return {
    ok: reasons.length === 0,
    source,
    allowedForTraining: false,
    requiresHumanReview: true,
    reasons,
  };
}

export function evaluateApprovedTrainingExample(record) {
  const reasons = [];
  const source = sourceOf(record);
  addCommonRejectReasons(record, reasons);

  if (REJECTED_TRAINING_SOURCES.has(source)) {
    reasons.push(`source_rejected:${source}`);
  }

  if (!APPROVED_TRAINING_SOURCES.has(source)) {
    reasons.push(`source_not_approved:${source}`);
  }

  if (record?.allowed_for_training !== true) {
    reasons.push('allowed_for_training_true_required');
  }

  if (record?.reviewed !== true) {
    reasons.push('reviewed_true_required');
  }

  if (record?.redacted !== true) {
    reasons.push('redacted_true_required');
  }

  if (source === 'redacted_consented_log' && record?.consent !== true) {
    reasons.push('consent_true_required');
  }

  return {
    ok: reasons.length === 0,
    source,
    allowedForTraining: record?.allowed_for_training === true,
    requiresHumanReview: record?.reviewed !== true,
    reasons,
  };
}

export function normalizeCandidateRecord(input, {
  candidateId,
  source = input?.source || 'eval_failure_observation',
  redacted = false,
} = {}) {
  const redactedInput = redactValue(input);
  const id = candidateId || input?.candidate_id || input?.id || `gptoss-candidate-${Date.now()}`;
  const rawInputSummary = redactString(serialized({
    source,
    action: redactedInput?.action,
    runId: redactedInput?.run_id,
    evalId: redactedInput?.eval_id || redactedInput?.id,
  }));

  return {
    candidate_id: id,
    source,
    reviewed: false,
    redacted: redacted === true || redactedInput?.redacted === true,
    allowed_for_training: false,
    requires_human_review: true,
    contains_secret: hasSecretLikeValue(input),
    no_openai_output_used: noOpenAiOutputUsed(redactedInput) || redactedInput?.openAiCalled !== true,
    raw_input_summary: rawInputSummary,
    proposed_messages: [],
    proposed_metadata: {
      source_kind: source,
      requires_human_review: true,
      not_raw_training_label: true,
      no_openai_output_used: true,
    },
    rejection_reason: 'unreviewed_candidate_not_trainable',
  };
}
