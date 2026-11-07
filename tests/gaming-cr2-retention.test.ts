import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, jest, test } from '@jest/globals';
import { GamingResolvedSourceHarness } from './testUtils/gamingResolvedSourceHarness.js';
import { gamingAcquisitionAxios } from './testUtils/gamingAcquisitionFixtures.js';

let database = new GamingResolvedSourceHarness();
const http = jest.fn();
const enqueue = jest.fn();
jest.unstable_mockModule('axios', () => ({ default: gamingAcquisitionAxios(http) }));
jest.unstable_mockModule('node:dns/promises', () => ({ Resolver: class {
  async resolve4() { return ['93.184.216.34']; }
  async resolve6() { return []; }
  cancel() {}
} }));
jest.unstable_mockModule('@core/db/client.js', () => ({ getPool: () => database.pool, isDatabaseConnected: () => true }));
jest.unstable_mockModule('@core/db/repositories/jobRepository.js', () => ({ findOrCreateGptJob: enqueue, getJobById: jest.fn(),
  IdempotencyKeyConflictError: class extends Error {}, JobRepositoryUnavailableError: class extends Error {} }));
jest.unstable_mockModule('@services/workerAutonomyService.js', () => ({ planAutonomousWorkerJob: async () => ({ status: 'pending', maxRetries: 2 }) }));
const { evaluateGamingHybridCandidates, createApprovedGamingHybridIngestion } = await import('../src/services/gamingHybridCandidates.js');
const { executeQueuedGamingSourceIngestion } = await import('../src/services/gamingSourceIngestion.js');
const { searchActiveGamingKnowledge } = await import('../src/core/db/repositories/gamingSourceRepository.js');
const { resolveGamingDocument } = await import('../src/services/gamingDocumentResolution.js');
const { extractGamingFreshnessMetadata } = await import('../src/shared/gaming/gamingFreshnessCore.js');
const url = 'https://guides.example.org/cr2-retention';
const input = { protocolVersion: 'gaming-hybrid-v2' as const, game: 'Amber Pilgrim', mode: 'guide' as const,
  prompt: 'How do I cross the obsidian observatory?', candidates: [{ url }] };
const context = { actorKey: 'synthetic-cr2-retention', workflowId: 'cr2-retention-workflow',
  storagePolicy: 'ask_before_store' as const, retainUnverified: true };
function respond(metadata = '') {
  http.mockResolvedValue({ status: 200, headers: { 'content-type': 'text/html' },
    data: '<html><title>Amber Pilgrim wiki</title><article><p>Amber Pilgrim is a role-playing game.</p>'
      + '<p>This page provides an index of walkthrough entries. Browse the linked walkthrough entries and introductory reference articles for this game.</p>'
      + metadata + '</article></html>' });
}
beforeEach(() => {
  database = new GamingResolvedSourceHarness(); http.mockReset(); enqueue.mockReset(); respond();
  enqueue.mockImplementation(async (job: any) => ({ created: true, deduped: false,
    job: { id: randomUUID(), status: 'pending', created_at: new Date(), input: job.input } }));
});

describe('CR2 retained candidate authority boundaries', () => {
  test.each([
    ['platform', '<p>Platforms: PS5.</p>', { platform: 'PC' }, 'PLATFORM_MISMATCH'],
    ['region', '<p>Regions: EU.</p>', { region: 'US' }, 'REGION_MISMATCH'],
    ['patch', '<p>Patch: 1.0.</p>', { requestedVersion: '2.0' }, 'PATCH_MISMATCH'],
    ['edition', '<p>Edition: expansion.</p>', { edition: 'base-game' }, 'EDITION_CONFLICT'],
    ['conflicting metadata', '<p>Platforms: PC.</p><p>Platforms: PS5.</p>', { platform: 'PC' }, 'CONTRADICTORY_SOURCE_METADATA']
  ])('denies an early reference retention handle on explicit %s conflict', async (_name, metadata, scope, reason) => {
    respond(metadata as string);
    const result = await evaluateGamingHybridCandidates({ ...input, ...(scope as object) }, context);
    expect(result.accepted).toEqual([]);
    expect(result.retained ?? []).toEqual([]);
    expect(result.decisions[0]).toMatchObject({ decision: 'rejected', reasonCodes: [reason] });
    expect(result.decisions[0].candidateId).toBeUndefined();
    expect(database.revisions).toEqual([]); expect(enqueue).not.toHaveBeenCalled();
  });

  test('retains an explicitly compatible reference without making it generation evidence', async () => {
    respond('<dl><dt>Platforms</dt><dd>PC</dd><dt>Regions</dt><dd>EU</dd><dt>Edition</dt><dd>base game</dd></dl>');
    const document = await resolveGamingDocument(url);
    expect(extractGamingFreshnessMetadata(document, input).metadataConflict).toBeUndefined();
    const result = await evaluateGamingHybridCandidates({ ...input, platform: 'PC', region: 'EU', edition: 'base-game' }, context);
    expect(result.decisions[0]).toMatchObject({ decision: 'requires_confirmation', generationEligible: false });
    expect(result.accepted).toEqual([]); expect(result.retained).toHaveLength(1);
  });

  test.each(['build', 'meta'] as const)('preserves retained %s article type and revision reuse', async mode => {
    const evaluate = () => evaluateGamingHybridCandidates({ ...input, mode }, context);
    const save = async (key: string) => {
      const result = await evaluate();
      expect(result.accepted).toEqual([]); expect(result.retained).toHaveLength(1);
      const queued = await createApprovedGamingHybridIngestion({ candidates: result.retained!, storagePolicy: 'ask_before_store',
        confirmed: true, idempotencyKey: key }, { actorKey: context.actorKey, canStore: true, canAutoStore: false });
      expect(queued.statusCode).toBe(202);
      const body = (enqueue.mock.calls.at(-1)![0] as any).input.body;
      expect(body.sources[0].retainedApproval.recordType).toBe(mode);
      return executeQueuedGamingSourceIngestion((queued.payload as any).ingestionId, body);
    };
    const first = await save(`retained-${mode}-first`);
    expect(first.output.sources[0]).toMatchObject({ status: 'stored', classification: 'reference_only', generationEligible: false });
    const typed = await searchActiveGamingKnowledge({ gameKey: 'amber-pilgrim', query: 'walkthrough', mode });
    expect(typed.length).toBeGreaterThan(0); expect(typed.every(row => row.recordType === mode)).toBe(true);
    const revision = typed[0].revisionId;
    const duplicate = await save(`retained-${mode}-duplicate`);
    expect(duplicate.output.sources[0]).toMatchObject({ status: 'unchanged', generationEligible: false });
    expect((await searchActiveGamingKnowledge({ gameKey: 'amber-pilgrim', query: 'walkthrough', mode }))[0].revisionId).toBe(revision);
    const otherMode = mode === 'build' ? 'meta' : 'build';
    const other = await evaluateGamingHybridCandidates({ ...input, mode: otherMode }, context);
    const queued = await createApprovedGamingHybridIngestion({ candidates: other.retained!, storagePolicy: 'ask_before_store', confirmed: true,
      idempotencyKey: `retained-${mode}-other` }, { actorKey: context.actorKey, canStore: true, canAutoStore: false });
    const result = await executeQueuedGamingSourceIngestion((queued.payload as any).ingestionId, (enqueue.mock.calls.at(-1)![0] as any).input.body);
    expect(result.output.sources[0]).toMatchObject({ status: 'updated', classification: 'reference_only', generationEligible: false });
    const active = await searchActiveGamingKnowledge({ gameKey: 'amber-pilgrim', query: 'walkthrough', mode: otherMode });
    expect(active.length).toBeGreaterThan(0); expect(active.every(row => row.recordType === otherMode)).toBe(true);
    expect(active[0].revisionId).not.toBe(revision);
  });
});
