#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

export const ACCEPTED_SOURCES = new Set([
  'arcanos_owned_spec',
  'repo_schema',
  'human_authored',
  'redacted_consented_log'
]);

export const REJECTED_SOURCES = new Set([
  'openai_output',
  'openai_judgment',
  'custom_gpt_action_request',
  'hidden_reasoning',
  'raw_secret',
  'unknown',
  'third_party_copyrighted',
  'model_generated_label_without_human_review'
]);

const SECRET_PATTERNS = [
  /\bsk-[A-Za-z0-9_-]{20,}\b/,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{20,}\b/i,
  /\b(api[_-]?key|token|password|secret)\b\s*[:=]\s*["']?[^"',\s]{8,}/i
];

const OPENAI_OUTPUT_FIELDS = new Set(['openai_output', 'openai_judgment', 'hidden_reasoning']);
const ACCEPTED_TARGET_SHAPES = new Set(['label_only', 'json_only', 'compact_final']);
const ASSISTANT_TARGET_REJECT_PATTERNS = [
  /\bInput\s*:/i,
  /\bExpected\s*:/i,
  /\bAnalysis\s*:/i,
  /\bReasoning\s*:/i,
  /\bchain[-\s]?of[-\s]?thought\b/i,
  /\bhidden reasoning\b/i,
  /\breasoning trace\b/i,
  /\bstep[-\s]?by[-\s]?step\b/i,
  /\b(?:system|developer|user)\s*:/i,
  /<\|\/?analysis\|?>/i,
  /<\|\/?commentary\|?>/i,
  /<\|(?:start|end|channel|message)[^>]*\|>/i,
  /<\|(?:system|developer|user|assistant|analysis|commentary|final)[^>]*\|>/i,
  /^\.?assistant\s*analysis/i,
  /^\.?(?:assistant|system|developer|user)\s+(?:analysis|commentary|final)\b/i,
  /^analysis\b/i,
  /^commentary\b/i
];

function usage() {
  return {
    ok: false,
    error: 'usage',
    message: 'Usage: node scripts/gptoss/dataset-gate.mjs <dataset.jsonl>'
  };
}

function parseJsonLine(line, lineNumber, errors) {
  try {
    return JSON.parse(line);
  } catch (error) {
    errors.push({
      line: lineNumber,
      code: 'invalid_json',
      message: error instanceof Error ? error.message : 'Invalid JSON'
    });
    return null;
  }
}

function hasOpenAiOutputMarker(record) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) {
    return false;
  }

  return Object.keys(record).some((key) => OPENAI_OUTPUT_FIELDS.has(key));
}

function hasSecretMarker(rawLine) {
  return SECRET_PATTERNS.some((pattern) => pattern.test(rawLine));
}

function validateMetadata(record, lineNumber, errors) {
  if (!record.metadata || typeof record.metadata !== 'object' || Array.isArray(record.metadata)) {
    errors.push({ line: lineNumber, code: 'metadata_required' });
    return false;
  }

  if (record.metadata.no_openai_output_used !== true) {
    errors.push({ line: lineNumber, code: 'metadata_no_openai_output_required' });
    return false;
  }

  if (!ACCEPTED_TARGET_SHAPES.has(record.metadata.target_shape)) {
    errors.push({ line: lineNumber, code: 'metadata_target_shape_required' });
    return false;
  }

  return true;
}

function validateMessages(record, lineNumber, errors) {
  if (!('messages' in record)) {
    if (typeof record.text !== 'string' || record.text.trim().length === 0) {
      errors.push({ line: lineNumber, code: 'text_or_messages_required' });
      return false;
    }
    return true;
  }

  if (!Array.isArray(record.messages) || record.messages.length === 0) {
    errors.push({ line: lineNumber, code: 'messages_required' });
    return false;
  }

  let assistantCount = 0;
  let assistantContent = '';
  for (const [index, message] of record.messages.entries()) {
    if (!message || typeof message !== 'object' || Array.isArray(message)) {
      errors.push({ line: lineNumber, code: 'invalid_message', index });
      return false;
    }
    if (!['system', 'developer', 'user', 'assistant'].includes(message.role)) {
      errors.push({ line: lineNumber, code: 'invalid_message_role', index, role: message.role ?? null });
      return false;
    }
    if (typeof message.content !== 'string' || message.content.trim().length === 0) {
      errors.push({ line: lineNumber, code: 'invalid_message_content', index });
      return false;
    }
    if (message.role === 'assistant') {
      assistantCount += 1;
      assistantContent = message.content;
    }
  }

  if (assistantCount !== 1) {
    errors.push({ line: lineNumber, code: 'assistant_target_count', count: assistantCount });
    return false;
  }

  if (ASSISTANT_TARGET_REJECT_PATTERNS.some((pattern) => pattern.test(assistantContent))) {
    errors.push({ line: lineNumber, code: 'assistant_target_not_final_only' });
    return false;
  }

  return true;
}

export function validateRecord(record, rawLine, lineNumber, errors) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) {
    errors.push({ line: lineNumber, code: 'invalid_record', message: 'Each JSONL row must be an object.' });
    return false;
  }

  const source = typeof record.source === 'string' ? record.source : '';

  if (
    (source === 'openai_output' || source === 'openai_judgment') &&
    record.allowed_for_training !== false
  ) {
    errors.push({ line: lineNumber, code: 'allowed_for_training_must_be_false', source });
    return false;
  }

  if (REJECTED_SOURCES.has(source)) {
    errors.push({ line: lineNumber, code: 'rejected_source', source });
    return false;
  }

  if (!ACCEPTED_SOURCES.has(source)) {
    errors.push({ line: lineNumber, code: 'unknown_source', source: source || null });
    return false;
  }

  if (hasOpenAiOutputMarker(record)) {
    errors.push({ line: lineNumber, code: 'openai_output_marker' });
    return false;
  }

  if (hasSecretMarker(rawLine)) {
    errors.push({ line: lineNumber, code: 'secret_marker' });
    return false;
  }

  if (record.allowed_for_training !== true) {
    errors.push({ line: lineNumber, code: 'training_not_allowed', source });
    return false;
  }

  if (source === 'human_authored' && record.reviewed !== true) {
    errors.push({ line: lineNumber, code: 'human_review_required', source });
    return false;
  }

  if (
    source === 'redacted_consented_log' &&
    (record.redacted !== true || record.consent !== true)
  ) {
    errors.push({ line: lineNumber, code: 'redaction_consent_required', source });
    return false;
  }

  if (!validateMetadata(record, lineNumber, errors)) {
    return false;
  }

  if (!validateMessages(record, lineNumber, errors)) {
    return false;
  }

  return true;
}

export function validateJsonl(filePath) {
  const errors = [];
  const content = readFileSync(filePath, 'utf8');
  const lines = content.split(/\r?\n/);
  let checked = 0;
  let accepted = 0;

  lines.forEach((line, index) => {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      return;
    }

    checked += 1;
    const record = parseJsonLine(trimmed, index + 1, errors);
    if (record && validateRecord(record, trimmed, index + 1, errors)) {
      accepted += 1;
    }
  });

  return {
    ok: errors.length === 0,
    file: filePath,
    checked,
    accepted,
    rejected: checked - accepted,
    errors
  };
}

export function main(argv = process.argv.slice(2)) {
  const [filePath] = argv;

  if (!filePath) {
    console.log(JSON.stringify(usage(), null, 2));
    process.exitCode = 2;
    return;
  }

  try {
    const result = validateJsonl(filePath);
    console.log(JSON.stringify(result, null, 2));
    process.exitCode = result.ok ? 0 : 1;
  } catch (error) {
    console.log(JSON.stringify({
      ok: false,
      file: filePath,
      error: 'read_failed',
      message: error instanceof Error ? error.message : 'Unable to read dataset'
    }, null, 2));
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
