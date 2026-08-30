import { describe, expect, it, jest } from '@jest/globals';

import {
  BACKSTAGE_NOTION_MAX_READABLE_CHUNKS_PER_SNAPSHOT,
  BACKSTAGE_NOTION_MAX_WRITABLE_CHUNKS_PER_SNAPSHOT,
  acquireBackstageNotionSyncLeaseWithLateRelease,
  assertBackstageNotionSnapshotCapacityInvariant,
  assertBackstageNotionSnapshotChunkCountWritable,
  isBackstageNotionSnapshotChunkCountReadable,
  isBackstageNotionSnapshotChunkCountWritable,
  shouldVerifyBackstageNotionSnapshotUnchanged,
} from '../src/shared/backstage/backstageNotionSyncCore.js';

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(resolvePromise => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

describe('Backstage Notion sync Phase-A core', () => {
  it.each([
    [2_048, true, true],
    [2_117, true, true],
    [2_307, true, true],
    [4_096, true, true],
    [4_097, false, false],
  ])('classifies the reader and writer boundary at %d chunks', (
    chunkCount,
    readable,
    writable
  ) => {
    expect(isBackstageNotionSnapshotChunkCountReadable(chunkCount))
      .toBe(readable);
    expect(isBackstageNotionSnapshotChunkCountWritable(chunkCount))
      .toBe(writable);
  });

  it('advances the bounded writer only to the proven reader ceiling', () => {
    expect(BACKSTAGE_NOTION_MAX_READABLE_CHUNKS_PER_SNAPSHOT).toBe(4_096);
    expect(BACKSTAGE_NOTION_MAX_WRITABLE_CHUNKS_PER_SNAPSHOT).toBe(4_096);
    expect(() => assertBackstageNotionSnapshotChunkCountWritable(4_096))
      .not.toThrow();
    expect(() => assertBackstageNotionSnapshotChunkCountWritable(4_097))
      .toThrow('chunks must contain 1-4096 records.');
  });

  it.each([
    0,
    -1,
    1.5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    BACKSTAGE_NOTION_MAX_READABLE_CHUNKS_PER_SNAPSHOT + 1,
  ])('rejects an invalid snapshot chunk count of %p', chunkCount => {
    expect(isBackstageNotionSnapshotChunkCountReadable(chunkCount)).toBe(false);
    expect(isBackstageNotionSnapshotChunkCountWritable(chunkCount)).toBe(false);
  });

  it('enforces the shared writer-at-or-below-reader capacity invariant', () => {
    expect(() => assertBackstageNotionSnapshotCapacityInvariant()).not.toThrow();
    expect(() => assertBackstageNotionSnapshotCapacityInvariant(4_096, 4_096))
      .not.toThrow();
    expect(() => assertBackstageNotionSnapshotCapacityInvariant(4_096, 4_097))
      .toThrow('writer <= reader');

    for (const [readable, writable] of [
      [0, 0],
      [4_096.5, 4_096],
      [4_096, 0],
      [4_096, Number.NaN],
    ] as const) {
      expect(() => assertBackstageNotionSnapshotCapacityInvariant(
        readable,
        writable
      )).toThrow('positive integer ceilings');
    }
  });

  it('selects unchanged verification for a readable Phase-B snapshot', () => {
    expect(shouldVerifyBackstageNotionSnapshotUnchanged({
      chunkCount: 2_117,
      embeddingModelMatches: true,
      manifestMatches: true,
    })).toBe(true);
    expect(shouldVerifyBackstageNotionSnapshotUnchanged({
      chunkCount: 4_097,
      embeddingModelMatches: true,
      manifestMatches: true,
    })).toBe(false);
    expect(shouldVerifyBackstageNotionSnapshotUnchanged({
      chunkCount: 2_117,
      embeddingModelMatches: false,
      manifestMatches: true,
    })).toBe(false);
  });

  it('releases an exact lease once when cancellation wins its late acquisition', async () => {
    const pending = deferred<{
      holderId: string;
      leaseToken: string;
    } | null>();
    const abortReason = new DOMException('cancelled', 'AbortError');
    const releaseLate = jest.fn(async () => undefined);
    const acquisition = acquireBackstageNotionSyncLeaseWithLateRelease({
      acquire: () => pending.promise,
      assertCanAcquire: () => undefined,
      releaseLate,
      waitForAcquisition: async () => {
        throw abortReason;
      },
    });

    await expect(acquisition).rejects.toBe(abortReason);
    expect(releaseLate).not.toHaveBeenCalled();
    const lease = {
      holderId: 'holder',
      leaseToken: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaad',
    };
    pending.resolve(lease);
    await pending.promise;
    await Promise.resolve();

    expect(releaseLate).toHaveBeenCalledTimes(1);
    expect(releaseLate).toHaveBeenCalledWith(lease);
  });

  it('does not acquire after the abort preflight rejects', async () => {
    const abortReason = new DOMException('already stopped', 'AbortError');
    const acquire = jest.fn(async () => null);

    await expect(acquireBackstageNotionSyncLeaseWithLateRelease({
      acquire,
      assertCanAcquire: () => {
        throw abortReason;
      },
      releaseLate: async () => undefined,
      waitForAcquisition: async pending => pending,
    })).rejects.toBe(abortReason);
    expect(acquire).not.toHaveBeenCalled();
  });
});
