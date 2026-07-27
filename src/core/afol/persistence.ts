import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import type {
  AfolErrorCategory,
  AfolPersistedDecisionRecord,
  AfolPersistedErrorRecord,
  AfolPersistenceRecord,
  DecisionRecord,
  RouteName,
} from './types.js';

const INVALID_TIMESTAMP = '1970-01-01T00:00:00.000Z';
const DECISION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const MAX_PERSISTENCE_RECORDS = 1_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isMissingFileError(error: unknown): boolean {
  return isRecord(error) && error.code === 'ENOENT';
}

function hasSameFileIdentity(
  left: { dev: bigint; ino: bigint },
  right: { dev: bigint; ino: bigint }
): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function safeTimestamp(value: unknown): string {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) {
    return INVALID_TIMESTAMP;
  }
  return new Date(value).toISOString();
}

function safeDecisionId(value: unknown): string {
  return typeof value === 'string' && DECISION_ID_PATTERN.test(value)
    ? value
    : 'redacted';
}

function safeRoute(value: unknown): RouteName {
  return value === 'primary' || value === 'backup' || value === 'reject'
    ? value
    : 'reject';
}

function safeLatency(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return 0;
  }
  return Math.min(Number.MAX_SAFE_INTEGER, Math.max(0, value));
}

function safeErrorCategory(value: unknown): AfolErrorCategory {
  if (
    value === 'decision_failed' ||
    value === 'persistence_failed' ||
    value === 'internal_failure'
  ) {
    return value;
  }
  return 'internal_failure';
}

export function clampAfolPersistenceRecordLimit(
  value: number,
  fallback: number
): number {
  const safeFallback = Number.isFinite(fallback)
    ? Math.min(
      MAX_PERSISTENCE_RECORDS,
      Math.max(1, Math.floor(fallback))
    )
    : 1;
  if (!Number.isFinite(value)) {
    return safeFallback;
  }
  return Math.min(
    MAX_PERSISTENCE_RECORDS,
    Math.max(1, Math.floor(value))
  );
}

function projectDirectDecisionRecord(
  value: Record<string, unknown>
): AfolPersistedDecisionRecord {
  return {
    kind: 'decision',
    id: safeDecisionId(value.id),
    timestamp: safeTimestamp(value.timestamp),
    ok: value.ok === true,
    route: safeRoute(value.route),
    latencyMs: safeLatency(value.latencyMs),
    cached: value.cached === true,
    degraded: value.degraded === true,
  };
}

/**
 * Produce the only decision shape allowed on AFOL persistence surfaces.
 */
export function projectAfolDecisionForPersistence(
  decision: DecisionRecord
): AfolPersistedDecisionRecord {
  const metadata = isRecord(decision.response.metadata)
    ? decision.response.metadata
    : {};
  return {
    kind: 'decision',
    id: safeDecisionId(decision.id),
    timestamp: safeTimestamp(decision.meta.timestamp),
    ok: decision.ok === true,
    route: safeRoute(decision.route.name),
    latencyMs: safeLatency(decision.meta.latencyMs),
    cached: decision.response.cached === true,
    degraded:
      metadata.degraded === true ||
      typeof decision.response.error === 'string',
  };
}

export function createAfolErrorRecord(
  category: AfolErrorCategory,
  timestamp = new Date().toISOString()
): AfolPersistedErrorRecord {
  return {
    kind: 'error',
    timestamp: safeTimestamp(timestamp),
    category: safeErrorCategory(category),
  };
}

/**
 * Reproject current or legacy JSONL values. This deliberately ignores every
 * field outside the fixed metadata union, including historical input, output,
 * intent, context, and provider-error fields.
 */
export function projectAfolPersistenceRecord(
  value: unknown
): AfolPersistenceRecord | null {
  if (!isRecord(value)) {
    return null;
  }

  if (value.kind === 'decision') {
    return projectDirectDecisionRecord(value);
  }
  if (value.kind === 'error') {
    return createAfolErrorRecord(
      safeErrorCategory(value.category),
      safeTimestamp(value.timestamp)
    );
  }

  if (isRecord(value.decision)) {
    const decision = value.decision;
    const route = isRecord(decision.route)
      ? decision.route.name
      : isRecord(decision.response)
        ? decision.response.route
        : undefined;
    const response = isRecord(decision.response) ? decision.response : {};
    const metadata = isRecord(response.metadata) ? response.metadata : {};
    const meta = isRecord(decision.meta) ? decision.meta : {};
    return {
      kind: 'decision',
      id: safeDecisionId(decision.id),
      timestamp: safeTimestamp(meta.timestamp ?? value.timestamp),
      ok: decision.ok === true,
      route: safeRoute(route),
      latencyMs: safeLatency(meta.latencyMs),
      cached: response.cached === true,
      degraded:
        metadata.degraded === true ||
        typeof response.error === 'string',
    };
  }

  if (
    Object.hasOwn(value, 'error') ||
    Object.hasOwn(value, 'context')
  ) {
    const category = value.context === 'decide'
      ? 'decision_failed'
      : 'internal_failure';
    return createAfolErrorRecord(
      category,
      safeTimestamp(value.timestamp)
    );
  }

  return null;
}

function assertSafeTargetPath(configuredPath: string): string {
  if (configuredPath.trim().length === 0) {
    throw new Error('AFOL persistence target is unsafe.');
  }
  const resolved = path.resolve(configuredPath);
  const parsed = path.parse(resolved);
  if (!path.isAbsolute(resolved) || resolved === parsed.root) {
    throw new Error('AFOL persistence target is unsafe.');
  }
  return resolved;
}

async function validateExistingTarget(targetPath: string): Promise<void> {
  try {
    const stats = await fs.lstat(targetPath);
    if (stats.isSymbolicLink() || !stats.isFile()) {
      throw new Error('AFOL persistence target is unsafe.');
    }
  } catch (error) {
    if (!isMissingFileError(error)) {
      throw error;
    }
  }
}

/**
 * Resolve a configured persistence file through its canonical parent.
 */
export async function resolveSafePersistenceTarget(
  configuredPath: string,
  options: { createParent?: boolean } = {}
): Promise<string> {
  const resolved = assertSafeTargetPath(configuredPath);
  const parent = path.dirname(resolved);
  if (options.createParent === true) {
    await fs.mkdir(parent, { recursive: true, mode: 0o700 });
  }

  const canonicalParent = await fs.realpath(parent);
  const parentStats = await fs.lstat(canonicalParent);
  if (!parentStats.isDirectory() || parentStats.isSymbolicLink()) {
    throw new Error('AFOL persistence parent is unsafe.');
  }

  const target = path.join(canonicalParent, path.basename(resolved));
  if (path.dirname(target) !== canonicalParent) {
    throw new Error('AFOL persistence target is unsafe.');
  }
  await validateExistingTarget(target);
  return target;
}

/**
 * Replace a persistence file through a same-directory, exclusively owned temp
 * file. Node's rename maps to the platform's atomic same-volume replacement;
 * on platforms that refuse replacement, the old target remains intact.
 */
export async function writeFileAtomically(
  configuredPath: string,
  content: string
): Promise<string> {
  const target = await resolveSafePersistenceTarget(configuredPath, {
    createParent: true,
  });
  const parent = path.dirname(target);
  const tempPath = path.join(
    parent,
    `.${path.basename(target)}.${randomUUID()}.tmp`
  );
  let handle: Awaited<ReturnType<typeof fs.open>> | null = null;
  let ownsTemp = false;

  try {
    handle = await fs.open(tempPath, 'wx', 0o600);
    ownsTemp = true;
    await handle.writeFile(content, { encoding: 'utf8' });
    await handle.sync();
    await handle.close();
    handle = null;

    await validateExistingTarget(target);
    await fs.rename(tempPath, target);
    ownsTemp = false;
    return target;
  } finally {
    await handle?.close().catch(() => {});
    if (ownsTemp) {
      await fs.unlink(tempPath).catch(() => {});
    }
  }
}

/**
 * Read only the final bounded byte window of a regular persistence file.
 */
export async function readUtf8Tail(
  configuredPath: string,
  maxBytes: number
): Promise<string> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
    return '';
  }

  let target: string;
  try {
    target = await resolveSafePersistenceTarget(configuredPath);
  } catch (error) {
    if (isMissingFileError(error)) {
      return '';
    }
    throw error;
  }

  let handle: Awaited<ReturnType<typeof fs.open>> | null = null;
  try {
    const beforeOpen = await fs.lstat(target, { bigint: true });
    if (beforeOpen.isSymbolicLink() || !beforeOpen.isFile()) {
      throw new Error('AFOL persistence target is unsafe.');
    }

    handle = await fs.open(target, 'r');
    const opened = await handle.stat({ bigint: true });
    const afterOpen = await fs.lstat(target, { bigint: true });
    if (
      !opened.isFile() ||
      afterOpen.isSymbolicLink() ||
      !afterOpen.isFile() ||
      !hasSameFileIdentity(beforeOpen, opened) ||
      !hasSameFileIdentity(opened, afterOpen)
    ) {
      throw new Error('AFOL persistence target is unsafe.');
    }

    if (opened.size > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new Error('AFOL persistence target is too large.');
    }
    const fileSize = Number(opened.size);
    const bytesToRead = Math.min(fileSize, maxBytes);
    if (bytesToRead === 0) {
      return '';
    }
    const start = fileSize - bytesToRead;
    const buffer = Buffer.alloc(bytesToRead);
    const { bytesRead } = await handle.read(
      buffer,
      0,
      bytesToRead,
      start
    );
    let content = buffer.subarray(0, bytesRead).toString('utf8');
    if (start > 0) {
      const firstNewline = content.indexOf('\n');
      content = firstNewline === -1
        ? ''
        : content.slice(firstNewline + 1);
    }
    return content;
  } catch (error) {
    if (isMissingFileError(error)) {
      return '';
    }
    throw error;
  } finally {
    await handle?.close().catch(() => {});
  }
}
