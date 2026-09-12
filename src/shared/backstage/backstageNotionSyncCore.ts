export const BACKSTAGE_NOTION_MAX_READABLE_CHUNKS_PER_SNAPSHOT = 4_096;

/** Internal, bounded diagnostics; never includes provider identifiers or content. */
export type BackstageNotionTopologyRejectionCode =
  | 'ancestor_cycle'
  | 'duplicate_structural_parent'
  | 'provider_parent_mismatch'
  | 'unreachable_database_member'
  | 'duplicate_database_membership'
  | 'ambiguous_page_edge';

/** Membership is intentionally absent: only provider/containment parents form a graph. */
export function hasBackstageNotionParentCycle(
  parents: ReadonlyMap<string, string | null>
): boolean {
  const verified = new Set<string>();
  for (const pageId of parents.keys()) {
    const ancestors = new Set<string>();
    let current: string | null | undefined = pageId;
    while (current !== null && current !== undefined && !verified.has(current)) {
      if (ancestors.has(current)) return true;
      ancestors.add(current);
      current = parents.get(current);
    }
    for (const ancestor of ancestors) verified.add(ancestor);
  }
  return false;
}

// Reader compatibility was deployed first; this bounded release now advances
// the writer to the already-supported reader ceiling.
export const BACKSTAGE_NOTION_MAX_WRITABLE_CHUNKS_PER_SNAPSHOT = 4_096;

export function assertBackstageNotionSnapshotCapacityInvariant(
  readableChunks: number = BACKSTAGE_NOTION_MAX_READABLE_CHUNKS_PER_SNAPSHOT,
  writableChunks: number = BACKSTAGE_NOTION_MAX_WRITABLE_CHUNKS_PER_SNAPSHOT
): void {
  if (
    !Number.isSafeInteger(readableChunks)
    || readableChunks < 1
    || !Number.isSafeInteger(writableChunks)
    || writableChunks < 1
    || writableChunks > readableChunks
  ) {
    throw new Error(
      'Backstage Notion snapshot capacity requires positive integer ceilings with writer <= reader.'
    );
  }
}

assertBackstageNotionSnapshotCapacityInvariant();

export interface BackstageNotionUnchangedSnapshotDecisionInput {
  chunkCount: number;
  embeddingModelMatches: boolean;
  manifestMatches: boolean;
}

export interface BackstageNotionLateAcquisitionLeaseIdentity {
  holderId: string;
  leaseToken: string;
}

export interface BackstageNotionLateAcquisitionFenceInput<
  TLease extends BackstageNotionLateAcquisitionLeaseIdentity
> {
  acquire: () => Promise<TLease | null>;
  assertCanAcquire: () => void;
  releaseLate: (lease: TLease) => Promise<void>;
  waitForAcquisition: (
    pendingAcquisition: Promise<TLease | null>
  ) => Promise<TLease | null>;
}

export function isBackstageNotionSnapshotChunkCountReadable(
  chunkCount: number
): boolean {
  return Number.isSafeInteger(chunkCount)
    && chunkCount >= 1
    && chunkCount <= BACKSTAGE_NOTION_MAX_READABLE_CHUNKS_PER_SNAPSHOT;
}

export function isBackstageNotionSnapshotChunkCountWritable(
  chunkCount: number
): boolean {
  return Number.isSafeInteger(chunkCount)
    && chunkCount >= 1
    && chunkCount <= BACKSTAGE_NOTION_MAX_WRITABLE_CHUNKS_PER_SNAPSHOT;
}

export function assertBackstageNotionSnapshotChunkCountWritable(
  chunkCount: number
): void {
  if (!isBackstageNotionSnapshotChunkCountWritable(chunkCount)) {
    throw new Error(
      `chunks must contain 1-${BACKSTAGE_NOTION_MAX_WRITABLE_CHUNKS_PER_SNAPSHOT} records.`
    );
  }
}

export function shouldVerifyBackstageNotionSnapshotUnchanged(
  input: BackstageNotionUnchangedSnapshotDecisionInput
): boolean {
  return input.manifestMatches
    && input.embeddingModelMatches
    && isBackstageNotionSnapshotChunkCountReadable(input.chunkCount);
}

/**
 * Start one non-cancellable lease acquisition behind an abort preflight and
 * fence-clean the exact lease if cancellation wins delivery to the caller.
 */
export async function acquireBackstageNotionSyncLeaseWithLateRelease<
  TLease extends BackstageNotionLateAcquisitionLeaseIdentity
>(
  input: BackstageNotionLateAcquisitionFenceInput<TLease>
): Promise<TLease | null> {
  input.assertCanAcquire();
  const pendingAcquisition = input.acquire();

  try {
    return await input.waitForAcquisition(pendingAcquisition);
  } catch (error) {
    void pendingAcquisition
      .then(acquiredLease => (
        acquiredLease ? input.releaseLate(acquiredLease) : undefined
      ))
      .catch(() => undefined);
    throw error;
  }
}
