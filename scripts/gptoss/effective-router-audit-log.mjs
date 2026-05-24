#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import {
  CLEAN_SAFETY_FLAGS,
  DEFAULT_ADAPTER_DIR,
  REQUIRED_RUNTIME_SUPPORTS,
  RUNTIME_REPORT_DIR,
  assertRuntimeReportPath,
} from './effective-router-runtime.mjs';

export const AUDIT_VERSION = 1;
export const DEFAULT_AUDIT_DIR = join(RUNTIME_REPORT_DIR, 'audit');
export const INPUT_PREVIEW_LIMIT = 160;
export const MODEL_PREVIEW_LIMIT = 240;

const SECRET_PATTERNS = [
  {
    pattern: /\bsk-(?:proj-)?[A-Za-z0-9_-]{8,}/g,
    replacement: '[REDACTED_OPENAI_KEY]',
  },
  {
    pattern: /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi,
    replacement: 'Bearer [REDACTED]',
  },
  {
    pattern: /\b(postgres(?:ql)?|redis):\/\/[^\s"'<>]+/gi,
    replacement: (_match, scheme) => `${scheme}://[REDACTED]`,
  },
  {
    pattern: /\b(OPENAI_API_KEY|RAILWAY_TOKEN|RAILWAY_API_TOKEN|DATABASE_URL|REDIS_URL|POSTGRES_URL|COOKIE|SESSION_ID|SESSION_TOKEN)\s*[:=]\s*["']?[^"'\s,;}]+["']?/gi,
    replacement: (_match, key) => `${key}=[REDACTED]`,
  },
  {
    pattern: /\b(password|passwd|secret|token|api[_-]?key)\s*[:=]\s*["']?[^"'\s,;}]+["']?/gi,
    replacement: (_match, key) => `${key}=[REDACTED]`,
  },
  {
    pattern: /\b(Set-Cookie|Cookie):\s*[^\n\r]+/gi,
    replacement: (_match, key) => `${key}: [REDACTED]`,
  },
];

function timestampForPath(timestamp = new Date().toISOString()) {
  return String(timestamp).replace(/[:.]/g, '-');
}

function safePathSegment(value) {
  return String(value || 'request')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'request';
}

function toDisplayPath(path) {
  return String(path).replace(/\\/g, '/');
}

export function redactText(value) {
  let text = String(value ?? '');
  for (const { pattern, replacement } of SECRET_PATTERNS) {
    text = text.replace(pattern, replacement);
  }
  return text;
}

export function cappedPreview(value, limit = INPUT_PREVIEW_LIMIT) {
  const text = redactText(value).replace(/\s+/g, ' ').trim();
  if (text.length <= limit) {
    return text;
  }
  const suffix = '...[truncated]';
  return `${text.slice(0, Math.max(0, limit - suffix.length))}${suffix}`;
}

export function hashInput(value) {
  return createHash('sha256').update(String(value ?? ''), 'utf8').digest('hex');
}

export function defaultAuditPath(requestId, timestamp = new Date().toISOString()) {
  return join(DEFAULT_AUDIT_DIR, `audit-${timestampForPath(timestamp)}-${safePathSegment(requestId)}.json`);
}

function auditSafety(result) {
  const safety = result?.safety || CLEAN_SAFETY_FLAGS;
  return {
    openAiCalled: safety.openAiCalled === true,
    trainingExecuted: safety.trainingExecuted === true,
    vllmUsed: safety.vllmUsed === true,
    railwayCliUsed: safety.railwayCliUsed === true,
    liveDbUsed: safety.liveDbUsed === true,
    noOpenAiOutputUsed: safety.noOpenAiOutputUsed !== false,
  };
}

export function buildAuditRecord({
  request,
  result,
  auditPath = defaultAuditPath(request?.requestId),
  timestamp = new Date().toISOString(),
} = {}) {
  if (!request || typeof request !== 'object') {
    throw new Error('audit_request_required');
  }
  if (!result || typeof result !== 'object') {
    throw new Error('audit_result_required');
  }
  const effective = result.effective || {};
  const localModel = result.localModel || {};
  return {
    auditVersion: AUDIT_VERSION,
    requestId: String(result.requestId || request.requestId || ''),
    timestamp,
    inputHash: hashInput(request.userInput),
    inputPreview: cappedPreview(request.userInput, INPUT_PREVIEW_LIMIT),
    adapterDir: redactText(request.adapterDir || DEFAULT_ADAPTER_DIR),
    runtimeSupports: {
      ...REQUIRED_RUNTIME_SUPPORTS,
      ...(request.runtimeSupports || {}),
    },
    model: {
      modelLoaded: result.modelLoaded === true,
      executed: localModel.executed === true || (result.executeRequested === true && result.modelLoaded === true),
      rawFinalTextPreview: cappedPreview(result.model?.rawFinalText || '', MODEL_PREVIEW_LIMIT),
    },
    effective: {
      plane: effective.plane || 'writing-plane',
      action: effective.action || 'unknown',
      risk: effective.risk || 'unknown',
      requiresConfirmation: effective.requiresConfirmation === true,
      allowedForTraining: false,
      sources: Array.isArray(effective.sources) ? effective.sources : [],
    },
    safety: auditSafety(result),
    replay: {
      command: `npm run gptoss:runtime:request:replay -- --audit ${toDisplayPath(auditPath)}`,
    },
  };
}

export function writeAuditRecord({
  request,
  result,
  auditPath,
  timestamp = new Date().toISOString(),
} = {}) {
  const path = auditPath || defaultAuditPath(result?.requestId || request?.requestId, timestamp);
  assertRuntimeReportPath(path);
  const record = buildAuditRecord({ request, result, auditPath: path, timestamp });
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
  return { path, record };
}

export function readAuditRecord(path) {
  if (!existsSync(path)) {
    throw new Error(`missing_audit_file:${path}`);
  }
  return JSON.parse(readFileSync(path, 'utf8'));
}

export function latestAuditPath(auditDir = DEFAULT_AUDIT_DIR) {
  if (!existsSync(auditDir)) {
    return null;
  }
  const candidates = readdirSync(auditDir)
    .filter((name) => name.endsWith('.json'))
    .map((name) => join(auditDir, name))
    .filter((path) => statSync(path).isFile())
    .sort((left, right) => statSync(right).mtimeMs - statSync(left).mtimeMs);
  return candidates[0] || null;
}

function parseArgs(argv = []) {
  const options = {
    command: argv[0] || 'latest',
    auditDir: DEFAULT_AUDIT_DIR,
  };
  for (let index = 1; index < argv.length; index += 1) {
    const flag = argv[index];
    const next = argv[index + 1];
    if (flag === '--audit-dir' && next) {
      options.auditDir = next;
      index += 1;
    } else {
      throw new Error(`Unknown or incomplete argument: ${flag}`);
    }
  }
  if (options.command !== 'latest') {
    throw new Error(`Unknown audit log command: ${options.command}`);
  }
  return options;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const path = latestAuditPath(options.auditDir);
  if (!path) {
    process.stdout.write(`${JSON.stringify({ ok: false, error: 'audit_log_not_found' }, null, 2)}\n`);
    process.exitCode = 1;
    return;
  }
  const record = readAuditRecord(path);
  process.stdout.write(`${JSON.stringify({ ok: true, audit: toDisplayPath(path), record }, null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stdout.write(`${JSON.stringify({
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      safety: CLEAN_SAFETY_FLAGS,
    }, null, 2)}\n`);
    process.exitCode = 2;
  });
}
