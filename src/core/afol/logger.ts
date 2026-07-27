import path from 'node:path';

import { recordTraceEvent } from '@platform/logging/telemetry.js';
import { getEnv, getEnvNumber } from '@platform/runtime/env.js';

import {
  clampAfolPersistenceRecordLimit,
  createAfolErrorRecord,
  projectAfolPersistenceRecord,
  readUtf8Tail,
  resolveSafePersistenceTarget,
  writeFileAtomically,
} from './persistence.js';
import type {
  AfolErrorCategory,
  AfolPersistedDecisionRecord,
  AfolPersistenceRecord,
} from './types.js';

const DEFAULT_RETENTION_LIMIT = 100;
const MAX_RETENTION_LIMIT = 1_000;
const DEFAULT_TAIL_BYTES = 512 * 1_024;
const MIN_TAIL_BYTES = 1_024;
const MAX_TAIL_BYTES = 4 * 1_024 * 1_024;

function clampTailBytes(value: number): number {
  if (!Number.isFinite(value)) {
    return DEFAULT_TAIL_BYTES;
  }
  return Math.min(
    MAX_TAIL_BYTES,
    Math.max(MIN_TAIL_BYTES, Math.floor(value))
  );
}

const configuredLogPath = getEnv('AFOL_LOG_PATH');
const defaultLogPath = path.resolve(
  configuredLogPath ?? path.join('logs', 'afol-decisions.log')
);
const defaultRetentionLimit = clampAfolPersistenceRecordLimit(
  getEnvNumber('AFOL_LOG_RETENTION_LIMIT', DEFAULT_RETENTION_LIMIT),
  DEFAULT_RETENTION_LIMIT
);
const defaultTailBytes = clampTailBytes(
  getEnvNumber('AFOL_LOG_TAIL_BYTES', DEFAULT_TAIL_BYTES)
);

let logFilePath = defaultLogPath;
let retentionLimit = defaultRetentionLimit;
let tailBytes = defaultTailBytes;
let loggerQueue: Promise<void> = Promise.resolve();

function enqueueLoggerOperation<T>(
  operation: () => Promise<T>
): Promise<T> {
  const result = loggerQueue.then(operation, operation);
  loggerQueue = result.then(
    () => undefined,
    () => undefined
  );
  return result;
}

function parseProjectedRecords(content: string): AfolPersistenceRecord[] {
  const records: AfolPersistenceRecord[] = [];
  for (const rawLine of content.split('\n')) {
    const line = rawLine.trim();
    if (line.length === 0) {
      continue;
    }
    try {
      const projected = projectAfolPersistenceRecord(JSON.parse(line));
      if (projected) {
        records.push(projected);
      }
    } catch {
      // Malformed historical lines are intentionally skipped.
    }
  }
  return records;
}

async function readRecentUnqueued(limit: number): Promise<AfolPersistenceRecord[]> {
  if (limit === 0) {
    return [];
  }
  const content = await readUtf8Tail(logFilePath, tailBytes);
  if (content.length === 0) {
    return [];
  }
  return parseProjectedRecords(content).slice(-limit);
}

function serializeRecords(records: readonly AfolPersistenceRecord[]): string {
  if (records.length === 0) {
    return '';
  }
  return `${records.map((record) => JSON.stringify(record)).join('\n')}\n`;
}

async function persistRecordUnqueued(
  record: AfolPersistenceRecord
): Promise<boolean> {
  try {
    const retained = await readRecentUnqueued(
      Math.max(0, retentionLimit - 1)
    );
    const next = [...retained, record].slice(-retentionLimit);
    await writeFileAtomically(logFilePath, serializeRecords(next));
    return true;
  } catch {
    recordTraceEvent('afol.logger.persist_failed', {
      category: 'io_failure',
      recordKind: record.kind,
    });
    return false;
  }
}

function categoryForContext(context: string): AfolErrorCategory {
  if (context === 'decide') {
    return 'decision_failed';
  }
  if (context === 'persistence') {
    return 'persistence_failed';
  }
  return 'internal_failure';
}

export function configureLogger(
  options: {
    filePath?: string;
    retentionLimit?: number;
    tailBytes?: number;
  } = {}
): Promise<void> {
  return enqueueLoggerOperation(async () => {
    const nextPath = options.filePath
      ? path.resolve(options.filePath)
      : defaultLogPath;
    const canonicalPath = await resolveSafePersistenceTarget(nextPath, {
      createParent: true,
    });
    logFilePath = canonicalPath;
    retentionLimit = options.retentionLimit === undefined
      ? defaultRetentionLimit
      : clampAfolPersistenceRecordLimit(
        options.retentionLimit,
        DEFAULT_RETENTION_LIMIT
      );
    tailBytes = options.tailBytes === undefined
      ? defaultTailBytes
      : clampTailBytes(options.tailBytes);
  });
}

export function getLogFilePath(): string {
  return logFilePath;
}

export function logDecision(
  value: AfolPersistedDecisionRecord
): Promise<boolean> {
  const projected = projectAfolPersistenceRecord(value);
  if (projected?.kind !== 'decision') {
    recordTraceEvent('afol.logger.persist_failed', {
      category: 'invalid_record',
      recordKind: 'decision',
    });
    return Promise.resolve(false);
  }
  return enqueueLoggerOperation(
    () => persistRecordUnqueued(projected)
  );
}

/**
 * Persist only a fixed category. The historical error argument is accepted for
 * compatibility but is never inspected, serialized, or sent to telemetry.
 */
export function logError(
  context: string,
  _error?: unknown
): Promise<boolean> {
  const record = createAfolErrorRecord(categoryForContext(context));
  return enqueueLoggerOperation(
    () => persistRecordUnqueued(record)
  );
}

export function getRecent(limit = 10): Promise<AfolPersistenceRecord[]> {
  const boundedLimit = Number.isFinite(limit)
    ? Math.min(
      MAX_RETENTION_LIMIT,
      Math.max(0, Math.floor(limit))
    )
    : 10;
  if (boundedLimit === 0) {
    return Promise.resolve([]);
  }

  return enqueueLoggerOperation(async () => {
    try {
      return await readRecentUnqueued(boundedLimit);
    } catch {
      recordTraceEvent('afol.logger.read_failed', {
        category: 'io_failure',
      });
      return [];
    }
  });
}

/**
 * Preserve the file while replacing its contents through the atomic writer.
 */
export function clearLogs(): Promise<boolean> {
  return enqueueLoggerOperation(async () => {
    try {
      await writeFileAtomically(logFilePath, '');
      return true;
    } catch {
      recordTraceEvent('afol.logger.clear_failed', {
        category: 'io_failure',
      });
      return false;
    }
  });
}

/**
 * Reset configuration only after prior writes settle. Existing files are not
 * deleted or truncated.
 */
export function resetLogger(): Promise<void> {
  return enqueueLoggerOperation(async () => {
    const canonicalPath = await resolveSafePersistenceTarget(defaultLogPath, {
      createParent: true,
    });
    logFilePath = canonicalPath;
    retentionLimit = defaultRetentionLimit;
    tailBytes = defaultTailBytes;
  });
}
