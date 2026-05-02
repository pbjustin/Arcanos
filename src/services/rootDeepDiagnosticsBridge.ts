import crypto from 'node:crypto';
import type { Request } from 'express';

import { resolveErrorMessage } from '@core/lib/errors/index.js';
import { auditLogger } from '@platform/logging/auditLogger.js';
import { getRequestActorKey } from '@platform/runtime/security.js';
import { runtimeDiagnosticsService } from '@services/runtimeDiagnosticsService.js';
import { getTrinityStatus } from '@services/trinityStatusService.js';
import {
  getWorkerControlHealth,
  getWorkerControlStatus,
} from '@services/workerControlService.js';
import { buildSafetySelfHealSnapshot } from '@services/selfHealRuntimeInspectionService.js';
import { arcanosDagRunService } from '@services/arcanosDagRunService.js';

export const ROOT_DEEP_DIAGNOSTICS_ACTION = 'root.deep_diagnostics';
export const ROOT_DIAGNOSTICS_FORBIDDEN = 'ROOT_DIAGNOSTICS_FORBIDDEN';

const ROOT_DEEP_DIAGNOSTICS_ALLOWED_GPT_IDS = new Set(['arcanos-core', 'core', 'arcanos-daemon']);
const ROOT_DIAGNOSTICS_MAX_OBJECT_KEYS = 12;
const ROOT_DIAGNOSTICS_MAX_ARRAY_ITEMS = 3;
const ROOT_DIAGNOSTICS_MAX_DEPTH = 4;
const ROOT_DIAGNOSTICS_MAX_STRING_LENGTH = 240;
const ROOT_DIAGNOSTICS_REDACTED = '[REDACTED]';
const ROOT_DIAGNOSTICS_SENSITIVE_KEY_PATTERN =
  /(authorization|bearer|token|secret|password|api[_-]?key|credential)/i;

type RootDiagnosticsDenialReason =
  | 'disabled'
  | 'gpt_not_allowlisted'
  | 'admin_token_missing'
  | 'authorization_missing'
  | 'authorization_mismatch';

type RootDiagnosticsAuthResult =
  | { allowed: true }
  | {
      allowed: false;
      reason: RootDiagnosticsDenialReason;
    };

export interface RootDiagnosticsSubCheck {
  ok: boolean;
  name: string;
  data: unknown | null;
  error: string | null;
}

export interface RootDiagnosticsReportPayload {
  ok: boolean;
  gptId: string;
  action: typeof ROOT_DEEP_DIAGNOSTICS_ACTION;
  traceId: string;
  timestamp: string;
  report: RootDiagnosticsSubCheck[];
}

interface RootDiagnosticsAuditInput {
  req: Request;
  timestamp: string;
  traceId: string;
  gptId: string;
  action: string;
  allowed: boolean;
  denialReason?: RootDiagnosticsDenialReason;
  report?: RootDiagnosticsSubCheck[];
}

interface RootDiagnosticsRequestLogger {
  info: (event: string, data: Record<string, unknown>) => void;
  warn: (event: string, data: Record<string, unknown>) => void;
}

interface RootDiagnosticsAuthUser {
  source?: unknown;
  id?: unknown;
  email?: unknown;
  role?: unknown;
}

type RootDiagnosticsRequest = Request & {
  logger?: RootDiagnosticsRequestLogger;
  authUser?: RootDiagnosticsAuthUser;
};

function truncateRootDiagnosticsString(value: string): string {
  if (value.length <= ROOT_DIAGNOSTICS_MAX_STRING_LENGTH) {
    return value;
  }

  return `${value.slice(0, ROOT_DIAGNOSTICS_MAX_STRING_LENGTH)}...[truncated]`;
}

function normalizeRootDiagnosticsData(value: unknown, depth = 0, keyHint = ''): unknown | null {
  if (ROOT_DIAGNOSTICS_SENSITIVE_KEY_PATTERN.test(keyHint)) {
    return ROOT_DIAGNOSTICS_REDACTED;
  }

  if (value === null || value === undefined) {
    return null;
  }

  if (typeof value === 'string') {
    return truncateRootDiagnosticsString(value);
  }

  if (typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }

  if (typeof value !== 'object') {
    return String(value);
  }

  if (depth >= ROOT_DIAGNOSTICS_MAX_DEPTH) {
    return Array.isArray(value)
      ? { total: value.length, truncated: value.length > 0 }
      : { keys: Object.keys(value as Record<string, unknown>).slice(0, ROOT_DIAGNOSTICS_MAX_OBJECT_KEYS), truncated: true };
  }

  if (Array.isArray(value)) {
    return {
      total: value.length,
      items: value
        .slice(0, ROOT_DIAGNOSTICS_MAX_ARRAY_ITEMS)
        .map((entry) => normalizeRootDiagnosticsData(entry, depth + 1, keyHint)),
      truncated: value.length > ROOT_DIAGNOSTICS_MAX_ARRAY_ITEMS,
    };
  }

  const entries = Object.entries(value as Record<string, unknown>);
  const output: Record<string, unknown> = {};
  for (const [entryKey, entryValue] of entries.slice(0, ROOT_DIAGNOSTICS_MAX_OBJECT_KEYS)) {
    output[entryKey] = normalizeRootDiagnosticsData(entryValue, depth + 1, entryKey);
  }

  if (entries.length > ROOT_DIAGNOSTICS_MAX_OBJECT_KEYS) {
    output.truncatedKeys = entries.length - ROOT_DIAGNOSTICS_MAX_OBJECT_KEYS;
  }

  return output;
}

function parseRootDiagnosticGpts(): Set<string> {
  return new Set(
    (process.env.ARCANOS_ROOT_DIAGNOSTIC_GPTS ?? '')
      .split(',')
      .map((value) => value.trim().toLowerCase())
      .filter((value) => value.length > 0)
  );
}

function constantTimeEquals(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);

  if (leftBuffer.length !== rightBuffer.length) {
    return false;
  }

  return crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function resolveRequesterIdentity(req: Request): Record<string, unknown> {
  const authUser = (req as RootDiagnosticsRequest).authUser;

  if (authUser) {
    return {
      source: authUser.source,
      id: authUser.id,
      email: authUser.email,
      role: authUser.role,
    };
  }

  return {
    source: 'request-actor-key',
    actorKey: getRequestActorKey(req),
  };
}

export function isRootDeepDiagnosticsAction(action: string | null | undefined): boolean {
  return action === ROOT_DEEP_DIAGNOSTICS_ACTION;
}

export function authorizeRootDeepDiagnosticsRequest(req: Request, gptId: string): RootDiagnosticsAuthResult {
  if (process.env.ENABLE_ROOT_DEEP_DIAGNOSTICS !== 'true') {
    return { allowed: false, reason: 'disabled' };
  }

  const normalizedGptId = gptId.trim().toLowerCase();
  if (
    !ROOT_DEEP_DIAGNOSTICS_ALLOWED_GPT_IDS.has(normalizedGptId) ||
    !parseRootDiagnosticGpts().has(normalizedGptId)
  ) {
    return { allowed: false, reason: 'gpt_not_allowlisted' };
  }

  const adminToken = process.env.ARCANOS_ADMIN_TOKEN;
  if (typeof adminToken !== 'string' || adminToken.length === 0) {
    return { allowed: false, reason: 'admin_token_missing' };
  }

  const authorizationHeader = req.header('authorization');
  if (typeof authorizationHeader !== 'string' || authorizationHeader.length === 0) {
    return { allowed: false, reason: 'authorization_missing' };
  }

  const expectedAuthorizationHeader = `Bearer ${adminToken}`;
  if (!constantTimeEquals(authorizationHeader, expectedAuthorizationHeader)) {
    return { allowed: false, reason: 'authorization_mismatch' };
  }

  return { allowed: true };
}

async function runCheck(
  name: string,
  operation: () => Promise<unknown> | unknown
): Promise<RootDiagnosticsSubCheck> {
  try {
    return {
      ok: true,
      name,
      data: normalizeRootDiagnosticsData(await operation()),
      error: null,
    };
  } catch (error) {
    return {
      ok: false,
      name,
      data: null,
      error: resolveErrorMessage(error),
    };
  }
}

export async function buildRootDeepDiagnosticsReport(params: {
  req: Request;
  gptId: string;
  traceId: string;
}): Promise<RootDiagnosticsReportPayload> {
  const report = await Promise.all([
    runCheck('/status', () => runtimeDiagnosticsService.getHealthSnapshot()),
    runCheck('/workers/status', () => getWorkerControlStatus()),
    runCheck('/worker-helper/health', () => getWorkerControlHealth()),
    runCheck('/trinity/status', () => getTrinityStatus()),
    runCheck('/status/safety/self-heal', () => buildSafetySelfHealSnapshot()),
    runCheck('/api/arcanos/capabilities', () => ({
      features: arcanosDagRunService.getFeatureFlags(),
      limits: arcanosDagRunService.getExecutionLimits(),
    })),
    runCheck('diagnostics.summary', () => runtimeDiagnosticsService.getDiagnosticsSnapshot(params.req.app)),
  ]);

  return {
    ok: report.every((check) => check.ok),
    gptId: params.gptId,
    action: ROOT_DEEP_DIAGNOSTICS_ACTION,
    traceId: params.traceId,
    timestamp: new Date().toISOString(),
    report,
  };
}

export function logRootDeepDiagnosticsAttempt(input: RootDiagnosticsAuditInput): void {
  const failedChecks = input.report?.filter((check) => !check.ok).map((check) => check.name) ?? [];
  const auditEntry = {
    event: 'gpt.root_deep_diagnostics.audit',
    timestamp: input.timestamp,
    traceId: input.traceId,
    requester: resolveRequesterIdentity(input.req),
    gptId: input.gptId,
    action: input.action,
    allowed: input.allowed,
    denied: !input.allowed,
    denialReason: input.denialReason ?? null,
    diagnosticsResultSummary: input.report
      ? {
          totalChecks: input.report.length,
          failedChecks: failedChecks.length,
          failedCheckNames: failedChecks,
          ok: failedChecks.length === 0,
        }
      : null,
  };

  auditLogger.log(auditEntry);

  const requestLogger = (input.req as RootDiagnosticsRequest).logger;
  if (!requestLogger) {
    return;
  }

  if (input.allowed) {
    requestLogger.info('gpt.root_deep_diagnostics.audit', auditEntry);
    return;
  }

  requestLogger.warn('gpt.root_deep_diagnostics.audit', auditEntry);
}
