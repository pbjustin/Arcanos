import type { Response } from 'express';

export type AITimeoutKind = 'pipeline_timeout' | 'provider_timeout' | 'worker_timeout' | 'budget_abort';

export interface AIDegradedResponseMetadata {
  timeoutKind?: AITimeoutKind | null;
  degradedModeReason?: string | null;
  bypassedSubsystems?: string[] | null;
}

export const AI_TIMEOUT_KIND_HEADER = 'x-ai-timeout-kind';
export const AI_DEGRADED_REASON_HEADER = 'x-ai-degraded-reason';
export const AI_BYPASSED_SUBSYSTEMS_HEADER = 'x-ai-bypassed-subsystems';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeTimeoutKind(value: unknown): AITimeoutKind | null {
  if (typeof value !== 'string') {
    return null;
  }

  const normalized = value.trim().toLowerCase();
  return normalized === 'pipeline_timeout' ||
    normalized === 'provider_timeout' ||
    normalized === 'worker_timeout' ||
    normalized === 'budget_abort'
    ? normalized
    : null;
}

function normalizeReason(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function normalizeBypassedSubsystems(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value
      .filter((entry): entry is string => typeof entry === 'string')
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0);
  }

  if (typeof value === 'string' && value.trim().length > 0) {
    return value
      .split(',')
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0);
  }

  return [];
}

export function extractAIDegradedResponseMetadata(value: unknown): AIDegradedResponseMetadata | null {
  if (!isRecord(value)) {
    return null;
  }

  const timeoutKind = normalizeTimeoutKind(value.timeoutKind);
  const degradedModeReason = normalizeReason(value.degradedModeReason);
  const bypassedSubsystems = normalizeBypassedSubsystems(value.bypassedSubsystems);

  if (!timeoutKind && !degradedModeReason && bypassedSubsystems.length === 0) {
    return null;
  }

  return {
    timeoutKind,
    degradedModeReason,
    bypassedSubsystems
  };
}

export function applyAIDegradedResponseHeaders(
  res: Pick<Response, 'setHeader'>,
  metadata: AIDegradedResponseMetadata | null | undefined
): void {
  if (!metadata) {
    return;
  }

  const timeoutKind = normalizeTimeoutKind(metadata.timeoutKind);
  const degradedModeReason = normalizeReason(metadata.degradedModeReason);
  const bypassedSubsystems = normalizeBypassedSubsystems(metadata.bypassedSubsystems);

  if (timeoutKind) {
    res.setHeader(AI_TIMEOUT_KIND_HEADER, timeoutKind);
  }

  if (degradedModeReason) {
    res.setHeader(AI_DEGRADED_REASON_HEADER, degradedModeReason);
  }

  if (bypassedSubsystems.length > 0) {
    res.setHeader(AI_BYPASSED_SUBSYSTEMS_HEADER, bypassedSubsystems.join(','));
  }
}

export function readAIDegradedResponseHeaders(
  headers: Pick<Response, 'getHeader'>
): Required<AIDegradedResponseMetadata> {
  return {
    timeoutKind: normalizeTimeoutKind(headers.getHeader(AI_TIMEOUT_KIND_HEADER)),
    degradedModeReason: normalizeReason(headers.getHeader(AI_DEGRADED_REASON_HEADER)),
    bypassedSubsystems: normalizeBypassedSubsystems(headers.getHeader(AI_BYPASSED_SUBSYSTEMS_HEADER))
  };
}
