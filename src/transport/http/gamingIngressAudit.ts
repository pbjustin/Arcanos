import { createHash } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';

import { getGamingCanaryAuditEnabled } from '@services/gamingConfig.js';
import { redactString } from '@shared/redaction.js';
import { resolveSafeRequestPath } from '@shared/requestPathSanitizer.js';

export const GAMING_INGRESS_AUDIT_EVENT = 'gaming.request.ingress_audit';
export const GAMING_INGRESS_AUDIT_VERSION = 1;

const URL_FIELD_NAMES = ['url', 'urls', 'guideUrl', 'guideUrls'] as const;
const SAFE_PAYLOAD_KEYS = new Set([
  'audit',
  'evidenceAttempt',
  'evidenceOrigin',
  'enableAudit',
  'enableHrc',
  'game',
  'guideUrl',
  'guideUrls',
  'hrc',
  'mode',
  'prompt',
  'requestedVersion',
  'url',
  'urls',
]);
const UNEXPECTED_PAYLOAD_KEY_MARKER = '[unexpected]';
const MAX_GAMING_PROMPT_CODE_UNITS = 8_000;
const GAMING_INGRESS_AUDIT_EMITTED_KEY = 'gamingIngressAuditEmitted';

type UrlFieldName = typeof URL_FIELD_NAMES[number];

export type GamingIngressAuditData = {
  requestId: string;
  traceId: string;
  route: 'gaming';
  action: string | null;
  mode: string | null;
  game: string | null;
  auditVersion: 1;
  promptSha256: string;
  promptUtf8Bytes: number;
  promptCodePointCount: number;
  sortedPayloadKeys: string[];
  urlFieldPresence: Record<UrlFieldName, boolean>;
  urlFieldCounts: Record<UrlFieldName, number>;
  totalCandidateFieldCount: number;
  auditEnabled: true;
  timestamp: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function sanitizeAuditLabel(value: unknown, maxLength: number): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  if (
    trimmed.length > maxLength
    || /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060\u2066-\u2069\ufeff]/u.test(value)
  ) {
    return '[unsupported]';
  }

  const redacted = redactString(trimmed);
  return redacted === '[REDACTED]'
    || /https?:\/\/|\b\S+@\S+\.\S+\b|\bgh[opusr]_[A-Za-z0-9]{12,}\b/iu.test(redacted)
    ? '[unsupported]'
    : redacted;
}

function sanitizeAction(value: unknown): string | null {
  return value === 'query' ? value : null;
}

function sanitizeMode(value: unknown): string | null {
  return value === 'guide' || value === 'build' || value === 'meta' ? value : null;
}

function countOriginalUrlField(value: unknown): number {
  if (typeof value === 'string') {
    return 1;
  }

  return Array.isArray(value) ? value.length : 0;
}

function resolveSortedPayloadKeys(payload: Record<string, unknown>): string[] {
  const safeKeys: string[] = [];
  let hasUnexpectedKey = false;
  for (const key in payload) {
    if (!Object.prototype.hasOwnProperty.call(payload, key)) {
      continue;
    }
    if (SAFE_PAYLOAD_KEYS.has(key)) {
      safeKeys.push(key);
    } else {
      hasUnexpectedKey = true;
    }
  }
  if (hasUnexpectedKey) {
    safeKeys.push(UNEXPECTED_PAYLOAD_KEY_MARKER);
  }
  return safeKeys.sort();
}

/**
 * Build a hash-only attestation from the unnormalized public Gaming payload.
 * Returns null for unsupported shapes so the existing request validator remains authoritative.
 */
export function buildGamingIngressAuditData(input: {
  body: unknown;
  requestId: string;
  traceId: string;
  timestamp?: string;
}): GamingIngressAuditData | null {
  if (!isRecord(input.body) || !isRecord(input.body.payload)) {
    return null;
  }

  const payload = input.body.payload;
  const prompt = payload.prompt;
  if (typeof prompt !== 'string' || prompt.length > MAX_GAMING_PROMPT_CODE_UNITS) {
    return null;
  }

  const urlFieldPresence = Object.fromEntries(
    URL_FIELD_NAMES.map((field) => [
      field,
      Object.prototype.hasOwnProperty.call(payload, field),
    ])
  ) as Record<UrlFieldName, boolean>;
  const urlFieldCounts = Object.fromEntries(
    URL_FIELD_NAMES.map((field) => [field, countOriginalUrlField(payload[field])])
  ) as Record<UrlFieldName, number>;

  return {
    requestId: input.requestId,
    traceId: input.traceId,
    route: 'gaming',
    action: sanitizeAction(input.body.action),
    mode: sanitizeMode(payload.mode),
    game: sanitizeAuditLabel(payload.game, 120),
    auditVersion: GAMING_INGRESS_AUDIT_VERSION,
    promptSha256: createHash('sha256').update(prompt, 'utf8').digest('hex'),
    promptUtf8Bytes: Buffer.byteLength(prompt, 'utf8'),
    promptCodePointCount: countCodePoints(prompt),
    sortedPayloadKeys: resolveSortedPayloadKeys(payload),
    urlFieldPresence,
    urlFieldCounts,
    totalCandidateFieldCount: Object.values(urlFieldCounts).reduce(
      (total, count) => total + count,
      0
    ),
    auditEnabled: true,
    timestamp: input.timestamp ?? new Date().toISOString(),
  };
}

function countCodePoints(value: string): number {
  let count = 0;
  for (const _codePoint of value) {
    count += 1;
  }
  return count;
}

/** Emit at most one audit event for the exact canonical public Gaming path. */
export function gamingIngressAudit(req: Request, res: Response, next: NextFunction): void {
  if (
    !getGamingCanaryAuditEnabled()
    || resolveSafeRequestPath(req) !== '/gpt/arcanos-gaming'
    || res.locals[GAMING_INGRESS_AUDIT_EMITTED_KEY] === true
  ) {
    next();
    return;
  }

  const requestId = req.requestId;
  const traceId = req.traceId;
  if (!requestId || !traceId || !req.logger) {
    next();
    return;
  }
  const auditData = buildGamingIngressAuditData({ body: req.body, requestId, traceId });
  if (auditData) {
    res.locals[GAMING_INGRESS_AUDIT_EMITTED_KEY] = true;
    req.logger.info(GAMING_INGRESS_AUDIT_EVENT, auditData);
  }
  next();
}
