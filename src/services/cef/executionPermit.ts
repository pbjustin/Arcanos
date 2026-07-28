/**
 * Opaque, single-use authority for one exact CEF command execution.
 */

import { createHash, timingSafeEqual } from 'node:crypto';

import type {
  CefExecutionPermit,
  CommandExecutionContext,
  CommandName,
} from './types.js';

const executionPermitMarker = Symbol('cefExecutionPermit');

export type { CefExecutionPermit } from './types.js';

interface CefExecutionPermitRecord {
  executionFingerprint: Buffer;
}

const issuedExecutionPermits = new WeakMap<
  CefExecutionPermit,
  CefExecutionPermitRecord
>();

function compareStringKeys(leftKey: string, rightKey: string): number {
  if (leftKey < rightKey) {
    return -1;
  }
  if (leftKey > rightKey) {
    return 1;
  }
  return 0;
}

function stableStringify(value: unknown): string {
  if (value === undefined) {
    return 'undefined';
  }
  if (value === null) {
    return 'null';
  }
  if (typeof value === 'number') {
    return Number.isFinite(value) ? JSON.stringify(value) : 'null';
  }
  if (typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(entry => stableStringify(entry)).join(',')}]`;
  }

  const entries = Object.entries(value as Record<string, unknown>)
    .sort(([leftKey], [rightKey]) => compareStringKeys(leftKey, rightKey))
    .map(([key, entryValue]) => (
      `${JSON.stringify(key)}:${stableStringify(entryValue)}`
    ));
  return `{${entries.join(',')}}`;
}

function buildExecutionFingerprint(
  command: CommandName,
  payload: Record<string, unknown>,
  context: CommandExecutionContext
): Buffer {
  return createHash('sha256')
    .update('cef-execution-permit-v1\0')
    .update(stableStringify({
      command,
      payload,
      binding: {
        source: context.source ?? null,
        capabilityId: context.capabilityId ?? null,
        stepId: context.stepId ?? null,
      },
    }))
    .digest();
}

/**
 * Issue one opaque permit for an already confirmed command and exact payload.
 *
 * The permit is deliberately represented by object identity rather than a
 * serializable token so caller-controlled JSON cannot manufacture authority.
 */
export function issueCefExecutionPermit(
  command: CommandName,
  payload: Record<string, unknown>,
  context: CommandExecutionContext = {}
): CefExecutionPermit {
  const permit = Object.freeze({
    [executionPermitMarker]: true as const,
  }) as unknown as CefExecutionPermit;
  issuedExecutionPermits.set(permit, {
    executionFingerprint: buildExecutionFingerprint(command, payload, context),
  });
  return permit;
}

/**
 * Consume one permit and verify its exact command, payload, and step binding.
 *
 * A recognized permit is deleted before comparison, so even a mismatched use
 * cannot replay it against a later command.
 */
export function consumeCefExecutionPermit(
  permit: CefExecutionPermit | undefined,
  command: CommandName,
  payload: Record<string, unknown>,
  context: CommandExecutionContext = {}
): boolean {
  if (!permit || typeof permit !== 'object') {
    return false;
  }

  const issuedPermit = issuedExecutionPermits.get(permit);
  if (!issuedPermit) {
    return false;
  }
  issuedExecutionPermits.delete(permit);

  const presentedFingerprint = buildExecutionFingerprint(
    command,
    payload,
    context
  );
  return timingSafeEqual(
    issuedPermit.executionFingerprint,
    presentedFingerprint
  );
}
