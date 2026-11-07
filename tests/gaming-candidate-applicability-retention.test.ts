import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, jest, test } from '@jest/globals';
import { GamingResolvedSourceHarness } from './testUtils/gamingResolvedSourceHarness.js';
import { gamingAcquisitionAxios } from './testUtils/gamingAcquisitionFixtures.js';

const http = jest.fn();
const enqueue = jest.fn();
let database = new GamingResolvedSourceHarness();
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
const { executeQueuedGamingSourceIngestion, buildStoredGamingKnowledgeContext } = await import('../src/services/gamingSourceIngestion.js');
const { resolveGamingDocument } = await import('../src/services/gamingDocumentResolution.js');
const { extractGamingFreshnessMetadata } = await import('../src/shared/gaming/gamingFreshnessCore.js');

const url = 'https://guides.example.org/applicability-unknown';
const input = { protocolVersion: 'gaming-hybrid-v2' as const, game: 'Amber Pilgrim', mode: 'guide' as const,
  prompt: 'How do I cross the obsidian observatory?', edition: 'base-game', candidates: [{ url }] };
const context = { actorKey: 'synthetic-applicability-retention', workflowId: 'synthetic-workflow',
  storagePolicy: 'ask_before_store' as const, retainUnverified: true };
const guidance = 'In the game Amber Pilgrim, use the silver telescope to cross the obsidian observatory. Rotate the telescope toward the eastern beacon before crossing the crystal bridge. Open the amber gate after aligning the telescope.';
function respond(metadata = '<p>Effective from: 2026-99-99.</p>', prose = guidance) {
  http.mockResolvedValue({ status: 200, headers: { 'content-type': 'text/html' },
    data: `<html><title>Amber Pilgrim guide</title><article><p>${prose}</p><p>Edition: base game.</p>${metadata}</article></html>` });
}
beforeEach(() => {
  database = new GamingResolvedSourceHarness();
  http.mockReset(); enqueue.mockReset();
  enqueue.mockImplementation(async (job: any) => ({ created: true, deduped: false,
    job: { id: randomUUID(), status: 'pending', input: job.input, created_at: new Date() } }));
  respond();
});

describe('non-authoritative retention of readable applicability-unknown guides', () => {
  test('returns an owner-confirmable v2 handle without admitting answer evidence or authority', async () => {
    const document = await resolveGamingDocument(url, 1000000, { documentPurpose: 'durable' });
    expect(extractGamingFreshnessMetadata(document, input).metadataUnverified).toBe(true);
    const evaluated = await evaluateGamingHybridCandidates(input, context);
    expect(evaluated.accepted).toEqual([]);
    expect(evaluated.retained).toHaveLength(1);
    expect(evaluated.decisions[0]).toMatchObject({ decision: 'requires_confirmation', candidateId: expect.any(String),
      classification: 'stored_unverified', generationEligible: false,
      reasonCodes: expect.arrayContaining(['COMPATIBILITY_UNVERIFIED', 'UNVERIFIED_RETENTION_REQUIRES_CONFIRMATION']) });
    const storage = { candidates: evaluated.retained!, storagePolicy: 'ask_before_store' as const,
      confirmed: false, idempotencyKey: 'unknown-confirmation' };
    const owner = { actorKey: context.actorKey, canStore: true, canAutoStore: false };
    expect((await createApprovedGamingHybridIngestion(storage, owner)).statusCode).toBe(403);
    expect(enqueue).not.toHaveBeenCalled();
    const queued = await createApprovedGamingHybridIngestion({ ...storage, confirmed: true }, owner);
    expect(queued.statusCode).toBe(202);
    const request = enqueue.mock.calls[0][0] as any;
    const output = await executeQueuedGamingSourceIngestion((queued.payload as any).ingestionId, request.input.body);
    expect(output.output.sources[0]).toMatchObject({ status: 'stored', classification: 'stored_unverified', generationEligible: false });
    expect(database.revisions[0].provenance.authorityAssessment).toBeUndefined();
    const later = await buildStoredGamingKnowledgeContext({ game: input.game, prompt: input.prompt, mode: input.mode });
    expect(later.context).toBe('');
    expect(later.sources).toEqual([]);
  });

  test.each([
    ['platform conflict', '<p>Platforms: PS5.</p><p>Effective from: 2026-99-99.</p>', guidance, { platform: 'PC' }],
    ['region conflict', '<p>Regions: EU.</p><p>Effective from: 2026-99-99.</p>', guidance, { region: 'US' }],
    ['patch conflict', '<p>Patch: 1.0.</p><p>Effective from: 2026-99-99.</p>', guidance, { requestedVersion: '2.0' }],
    ['source-use restriction', '<p>No automated use.</p><p>Effective from: 2026-99-99.</p>', guidance, {}],
    ['wrong game', '<p>Game: Crystal Odyssey.</p><p>Effective from: 2026-99-99.</p>', guidance.replaceAll('Amber Pilgrim', 'Crystal Odyssey'), {}]
  ])('does not retain %s', async (_name, metadata, prose, extra) => {
    respond(metadata as string, prose as string);
    const evaluated = await evaluateGamingHybridCandidates({ ...input, ...(extra as object) }, context);
    expect(evaluated.accepted).toEqual([]);
    expect(evaluated.retained ?? []).toEqual([]);
    expect(evaluated.decisions[0].decision).toBe('rejected');
    expect(evaluated.decisions[0].candidateId).toBeUndefined();
    expect(enqueue).not.toHaveBeenCalled();
  });

  test.each(['gaming-hybrid-v1', 'gaming-hybrid-v2'] as const)('requires explicit retention intent under %s', async protocolVersion => {
    const evaluated = await evaluateGamingHybridCandidates({ ...input, protocolVersion }, { ...context, retainUnverified: false });
    expect(evaluated.accepted).toEqual([]);
    expect(evaluated.retained ?? []).toEqual([]);
    expect(evaluated.decisions[0].candidateId).toBeUndefined();
  });

  test('continues to admit a complete applicable guide as ordinary acquired evidence', async () => {
    respond('');
    const evaluated = await evaluateGamingHybridCandidates(input, context);
    expect(evaluated.accepted).toHaveLength(1);
    expect(evaluated.accepted[0].sourceAssessment).toMatchObject({ decision: 'accept', gates: { compatibility: 'verified' } });
    expect(evaluated.retained ?? []).toEqual([]);
  });
});
