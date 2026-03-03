import { createHash } from 'crypto';
import type { PoolClient } from 'pg';
import { getPool, isDatabaseConnected } from '../../db/client.js';
import { emitSafetyAuditEvent } from './auditEvents.js';
import { recordDuplicateSuppression } from './runtimeState.js';

interface AdvisoryLockRecord {
  client: PoolClient;
  advisoryKey: string;
}

export interface ExecutionLockHandle {
  lockId: string;
  distributed: boolean;
  release: () => Promise<void>;
}

const processLockSet = new Set<string>();
const advisoryLockMap = new Map<string, AdvisoryLockRecord>();

function toAdvisoryKey(lockId: string): string {
  const digest = createHash('sha256').update(lockId).digest('hex').slice(0, 15);
  const bigint = BigInt(`0x${digest}`) & 0x7fffffffffffffffn;
  return bigint.toString();
}

async function tryAcquireAdvisoryLock(lockId: string): Promise<boolean> {
  if (!isDatabaseConnected()) {
    return false;
  }
  const pool = getPool();
  if (!pool) {
    return false;
  }

  const advisoryKey = toAdvisoryKey(lockId);
  const client = await pool.connect();
  try {
    const result = await client.query<{ locked: boolean }>(
      'SELECT pg_try_advisory_lock($1::bigint) AS locked',
      [advisoryKey]
    );
    const locked = Boolean(result.rows[0]?.locked);
    //audit Assumption: advisory lock must stay attached to same session; failure risk: lock leak on release mismatch; expected invariant: store client only when lock acquired; handling strategy: retain client in map for explicit unlock.
    if (locked) {
      advisoryLockMap.set(lockId, { client, advisoryKey });
      return true;
    }

    client.release();
    return false;
  } catch {
    client.release();
    throw new Error(`Failed to acquire advisory lock for ${lockId}`);
  }
}

async function releaseAdvisoryLock(lockId: string): Promise<void> {
  const advisory = advisoryLockMap.get(lockId);
  if (!advisory) {
    return;
  }

  advisoryLockMap.delete(lockId);
  try {
    await advisory.client.query('SELECT pg_advisory_unlock($1::bigint)', [advisory.advisoryKey]);
  } finally {
    advisory.client.release();
  }
}

/**
 * Purpose: Acquire hybrid execution lock (process + advisory when DB is available).
 * Inputs/Outputs: lockId string; returns lock handle or null when duplicate suppressed.
 * Edge cases: Fails closed on advisory lock errors while DB is connected.
 */
export async function acquireExecutionLock(lockId: string): Promise<ExecutionLockHandle | null> {
  //audit Assumption: process mutex blocks same-process duplication immediately; failure risk: concurrent double execution in one node; expected invariant: one active process lock per lockId; handling strategy: suppress duplicate.
  if (processLockSet.has(lockId)) {
    recordDuplicateSuppression(lockId);
    emitSafetyAuditEvent({
      event: 'execution_lock_duplicate_process',
      severity: 'warn',
      details: { lockId }
    });
    return null;
  }
  processLockSet.add(lockId);

  let advisoryAcquired = false;
  const shouldUseAdvisory = isDatabaseConnected() && Boolean(getPool());

  if (shouldUseAdvisory) {
    try {
      advisoryAcquired = await tryAcquireAdvisoryLock(lockId);
      //audit Assumption: advisory lock contention indicates duplicate cross-process execution; failure risk: conflicting writes across instances; expected invariant: suppress when advisory lock unavailable; handling strategy: release process lock and return null.
      if (!advisoryAcquired) {
        processLockSet.delete(lockId);
        recordDuplicateSuppression(lockId);
        emitSafetyAuditEvent({
          event: 'execution_lock_duplicate_distributed',
          severity: 'warn',
          details: { lockId }
        });
        return null;
      }
    } catch (error) {
      processLockSet.delete(lockId);
      emitSafetyAuditEvent({
        event: 'execution_lock_advisory_error',
        severity: 'error',
        details: {
          lockId,
          message: error instanceof Error ? error.message : String(error)
        }
      });
      return null;
    }
  }

  let released = false;
  const release = async (): Promise<void> => {
    //audit Assumption: release may be called multiple times by defensive finally blocks; failure risk: throw on second release; expected invariant: idempotent release; handling strategy: no-op after first release.
    if (released) {
      return;
    }
    released = true;

    processLockSet.delete(lockId);
    if (advisoryAcquired) {
      await releaseAdvisoryLock(lockId);
    }
  };

  return {
    lockId,
    distributed: advisoryAcquired,
    release
  };
}

/**
 * Purpose: Execute callback under a hybrid execution lock.
 * Inputs/Outputs: lockId and async callback; returns callback result or null when duplicate suppressed.
 * Edge cases: Lock is always released via finally block.
 */
export async function runWithExecutionLock<T>(
  lockId: string,
  callback: () => Promise<T>
): Promise<T | null> {
  const lock = await acquireExecutionLock(lockId);
  if (!lock) {
    return null;
  }

  try {
    return await callback();
  } finally {
    await lock.release();
  }
}

