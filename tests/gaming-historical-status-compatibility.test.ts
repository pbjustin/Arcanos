import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { createGamingClearAssessment, GAMING_CLEAR_POLICY_VERSION } from '../src/shared/gaming/gamingClearPolicy.js';

const fixtures = JSON.parse(readFileSync(new URL('./fixtures/gaming-historical-status/records.json', import.meta.url), 'utf8'));
const ingestionId = '019fe3cd-8c01-7f01-8d2d-caa951bc4b9b';
const getJobByIdMock = jest.fn();
const enqueueMock = jest.fn();
const persistMock = jest.fn();
const resolveMock = jest.fn();
const normalizeMock = jest.fn();
const plannerMock = jest.fn();
class IdempotencyKeyConflictError extends Error {}
class JobRepositoryUnavailableError extends Error {}
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const actorScope = (actor: string) => hash(`${actor}\ngaming-source-ingestion`);
let service: typeof import('../src/services/gamingSourceIngestion.js');

/** Wrap a historical producer body without granting it current execution authority. */
function historicalJob(fixture: any, status = 'completed') {
  const failed = status === 'failed';
  return {
    id: ingestionId, job_type: 'gpt', status, idempotency_scope_hash: actorScope(fixture.actorKey),
    created_at: new Date('2026-09-09T12:00:00.000Z'), updated_at: new Date('2026-09-09T12:01:00.000Z'),
    ...(['completed', 'failed', 'cancelled', 'expired'].includes(status)
      ? { completed_at: new Date('2026-09-09T12:01:00.000Z') } : {}),
    input: { gptId: 'arcanos-gaming', executionModeReason: 'gaming_source_ingestion',
      requestPath: '/gpt-access/gaming/sources/ingestions', body: structuredClone(fixture.body) },
    ...(['completed', 'failed'].includes(status) ? { output: {
      ok: true, action: 'ingest', ingestionId, status: failed ? 'completed_with_errors' : 'completed',
      counts: { total: 1, queued: 0, succeeded: failed ? 0 : 1, rejected: 0, failed: failed ? 1 : 0,
        recordsCreated: failed ? 0 : 1, recordsUpdated: 0 },
      sources: [{ submittedIndex: 0, canonicalUrl: fixture.body.sources[0].canonicalUrl,
        status: failed ? 'failed' : 'stored', recordsCreated: failed ? 0 : 1, recordsUpdated: 0,
        ...(failed ? { error: { code: 'SOURCE_FETCH_FAILED', message: 'The source fetch failed.', retryable: true } } : {}) }]
    } } : {})
  };
}

beforeAll(async () => {
  jest.unstable_mockModule('../src/core/db/repositories/jobRepository.js', () => ({
    getJobById: getJobByIdMock, findOrCreateGptJob: enqueueMock,
    IdempotencyKeyConflictError, JobRepositoryUnavailableError
  }));
  jest.unstable_mockModule('../src/core/db/repositories/gamingSourceRepository.js', () => ({
    GamingSourceRepositoryUnavailableError: class extends Error {}, persistGamingSourceRevision: persistMock,
    getGamingSourceById: jest.fn(), searchActiveGamingKnowledge: jest.fn(), findActiveGamingSourceIdentities: jest.fn()
  }));
  jest.unstable_mockModule('../src/services/gamingDocumentResolution.js', () => ({
    GAMING_DOCUMENT_RESOLVER_VERSION: 'gaming-document-v1', GamingDocumentAcquisitionError: class extends Error {},
    resolveGamingDocument: resolveMock, projectGamingDocumentPublicUrl: (url: string) => url,
    isResolvedGamingDocumentIdentityVerified: (document: any, url: string) => document.requestedUrl === url,
    describeGamingDocumentSource: (url: string) => ({ publicUrl: url })
  }));
  jest.unstable_mockModule('../src/services/gamingBuildResources.js', () => ({ ingestGamingBuildResource: normalizeMock }));
  jest.unstable_mockModule('../src/services/workerAutonomyService.js', () => ({ planAutonomousWorkerJob: plannerMock }));
  jest.unstable_mockModule('../src/services/gamingSourceDiscovery.js', () => ({
    sanitizeGamingDiscoveryCandidateUrl: (url: string) => ({ url, rejected: false })
  }));
  jest.unstable_mockModule('../src/platform/logging/structuredLogging.js', () => ({
    logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(), child: jest.fn() }
  }));
  service = await import('../src/services/gamingSourceIngestion.js');
});

beforeEach(() => {
  for (const mock of [getJobByIdMock, enqueueMock, persistMock, resolveMock, normalizeMock, plannerMock]) mock.mockReset();
  plannerMock.mockResolvedValue({ status: 'pending', maxRetries: 2, priority: 100, autonomyState: {}, planningReasons: [] });
});

describe('history-derived retained Gaming status compatibility', () => {
  const statusMatrix = fixtures.flatMap((fixture: any) => ['completed', 'failed', 'pending', 'running', 'cancelled', 'expired']
    .map(status => [fixture.body.sources[0].hybridApproval.gamingClear.policyProfile, status, fixture]));

  it.each(statusMatrix)('reads %s in %s state without replaying approval', async (_policy, status, fixture) => {
    getJobByIdMock.mockResolvedValue(historicalJob(fixture, status));
    const result = await service.getGamingSourceIngestionStatus(ingestionId, { actorKey: fixture.actorKey });
    expect(result.statusCode).toBe(200);
    const payload: any = result.payload;
    expect(payload.action).toBe('status');
    expect(payload.status).toBe(status === 'pending' ? 'queued' : status);
    expect(payload.sources[0].status).toBe(status === 'completed' ? 'stored'
      : status === 'pending' ? 'queued' : status === 'running' ? 'running' : 'failed');
    expect(JSON.stringify(payload)).not.toMatch(/hybridApproval|gamingClear|actorScopeHash|contentHash|applicabilityBinding/u);
    expect(resolveMock).not.toHaveBeenCalled();
    expect(persistMock).not.toHaveBeenCalled();
    expect(enqueueMock).not.toHaveBeenCalled();
  });

  it.each(fixtures)('rejects historical execution from committed producer $provenance.commit', async fixture => {
    const body = structuredClone(fixture.body);
    expect(service.parseQueuedGamingSourceIngestionBody(body).ok).toBe(false);
    expect(service.isQueuedGamingSourceIngestion(historicalJob(fixture).input)).toBe(false);
    await expect(service.executeQueuedGamingSourceIngestion(ingestionId, body))
      .rejects.toMatchObject({ code: 'GAMING_SOURCE_JOB_INVALID' });
    const retained = body.sources[0];
    expect((await service.createApprovedGamingSourceIngestion([{
      url: retained.canonicalUrl, game: retained.game, ...retained.hybridApproval,
      sourceTrustType: retained.sourceTrustType, sourceAssessment: retained.hybridApproval.gamingClear
    }], 'historical-read-cannot-reapprove', { actorKey: fixture.actorKey, canStore: true })).statusCode).toBe(400);
    expect(resolveMock).not.toHaveBeenCalled();
    expect(persistMock).not.toHaveBeenCalled();
    expect(enqueueMock).not.toHaveBeenCalled();
  });

  it.each(fixtures)('reads a failed $provenance.commit job without saved output', async fixture => {
    const job: any = historicalJob(fixture, 'failed');
    delete job.output;
    getJobByIdMock.mockResolvedValue(job);
    expect(await service.getGamingSourceIngestionStatus(ingestionId, { actorKey: fixture.actorKey }))
      .toMatchObject({ statusCode: 200, payload: { action: 'status', status: 'failed', counts: { queued: 0, failed: 1 },
        sources: [{ status: 'failed', recordsCreated: 0, error: { code: 'INTERNAL_ERROR', retryable: false } }] } });
    expect(resolveMock).not.toHaveBeenCalled();
    expect(persistMock).not.toHaveBeenCalled();
    expect(enqueueMock).not.toHaveBeenCalled();
  });

  it.each(fixtures)('isolates status ownership for committed producer $provenance.commit', async fixture => {
    const job = historicalJob(fixture);
    getJobByIdMock.mockResolvedValue(job);
    expect((await service.getGamingSourceIngestionStatus(ingestionId, { actorKey: 'different-actor' })).statusCode).toBe(404);
    // A plain actor digest is not the ingestion-specific actor binding.
    job.idempotency_scope_hash = hash(fixture.actorKey);
    expect((await service.getGamingSourceIngestionStatus(ingestionId, { actorKey: fixture.actorKey })).statusCode).toBe(404);
    expect(resolveMock).not.toHaveBeenCalled();
    expect(persistMock).not.toHaveBeenCalled();
  });

  const malformed: Array<[string, (job: any) => void]> = [
    ['unknown CLEAR policy', job => { job.input.body.sources[0].hybridApproval.gamingClear.policyProfile = 'gaming-clear-policy/v999:walkthrough:source'; }],
    ['future rubric', job => { job.input.body.sources[0].hybridApproval.gamingClear.rubricVersion = 'gaming-clear/v2'; }],
    ['extra policy tuple field', job => { job.input.body.sources[0].hybridApproval.gamingClear.policyProfile += ':extra'; }],
    ['inherited question profile', job => { job.input.body.sources[0].hybridApproval.gamingClear.policyProfile = 'gaming-clear-policy/v1:constructor:source'; }],
    ['answer policy on source', job => { job.input.body.sources[0].hybridApproval.gamingClear.policyProfile = 'gaming-clear-policy/v1:walkthrough:answer'; }],
    ['unbounded dimension score', job => { job.input.body.sources[0].hybridApproval.gamingClear.dimensionScores.clarity.score = 50; }],
    ['unknown approval field', job => { job.input.body.sources[0].hybridApproval.authorizeExecution = true; }],
    ['unknown body field', job => { job.input.body.grantStorage = true; }],
    ['unknown source policy', job => { job.input.body.sources[0].hybridApproval.sourcePolicyVersion = 'gaming-hybrid-source-policy-v999'; }],
    ['unknown freshness policy', job => { job.input.body.sources[0].hybridApproval.freshnessPolicyVersion = 'gaming-hybrid-freshness-v999'; }],
    ['malformed approval actor hash', job => { job.input.body.sources[0].hybridApproval.actorScopeHash = 'actor'; }],
    ['oversized freshness', job => { job.input.body.sources[0].hybridApproval.freshness = { value: 'x'.repeat(8_001) }; }],
    ['wrong job type', job => { job.job_type = 'memory'; }],
    ['wrong GPT envelope', job => { job.input.gptId = 'other-gpt'; }],
    ['wrong route envelope', job => { job.input.requestPath = '/gpt/anything'; }],
    ['wrong execution reason', job => { job.input.executionModeReason = 'other_reason'; }]
  ];
  it.each(malformed)('rejects malformed retained record: %s', async (_name, mutate) => {
    const job = historicalJob(fixtures[0]);
    mutate(job);
    getJobByIdMock.mockResolvedValue(job);
    expect((await service.getGamingSourceIngestionStatus(ingestionId, { actorKey: fixtures[0].actorKey })).statusCode).toBe(404);
    expect(resolveMock).not.toHaveBeenCalled();
    expect(persistMock).not.toHaveBeenCalled();
    expect(enqueueMock).not.toHaveBeenCalled();
  });

  it('retains repository-unavailable and missing-job behavior', async () => {
    getJobByIdMock.mockResolvedValue(null);
    expect((await service.getGamingSourceIngestionStatus(ingestionId, { actorKey: fixtures[0].actorKey })).statusCode).toBe(404);
    getJobByIdMock.mockRejectedValue(new JobRepositoryUnavailableError());
    expect((await service.getGamingSourceIngestionStatus(ingestionId, { actorKey: fixtures[0].actorKey })).statusCode).toBe(503);
  });

  it('keeps current approval execution and actor-scoped idempotency on the current policy', async () => {
    const url = 'https://example.com/current-copper-vale-guide';
    const text = 'Game: Copper Vale. To obtain the Amber Token, buy it at the market for 25 coins. '.repeat(5);
    const document = { requestedUrl: url, canonicalUrl: url, publicUrl: url, host: 'example.com', text, contentType: 'text/html',
      metadata: { title: 'Copper Vale guide', headings: 'Amber Token route' },
      extraction: { strategy: 'article', rawTextLength: text.length, cleanedTextLength: text.length },
      resolution: { resolverId: 'generic-html', resolverVersion: '1', strategy: 'article', documentType: 'html', supportsStructuredExtraction: true },
      metrics: { rawTextLength: text.length, cleanedTextLength: text.length, truncated: false } };
    const contentHash = service.hashGamingApprovedDocument(document as any);
    const prior = fixtures[4].body.sources[0].hybridApproval.gamingClear;
    const assessment = createGamingClearAssessment({ ...prior, questionProfile: 'walkthrough', subjectHash: contentHash,
      dimensions: prior.dimensionScores, evidenceRefs: ['history-fixture-source'], evaluatedAt: '2026-11-06T12:00:00.000Z' });
    const source = (actorKey: string) => ({ url, game: 'Copper Vale', contentHash, sourceAssessment: assessment,
      actorScopeHash: hash(actorKey), policyVersion: 'gaming-hybrid-candidates/v1' as const,
      sourceTrustType: 'supplied' as const, freshness: {} });
    // Only repository effects are doubled. The service computes real request fingerprints/scopes.
    const rows = new Map<string, any>();
    enqueueMock.mockImplementation(async (request: any) => {
      const key = `${request.idempotencyScopeHash}:${request.idempotencyKeyHash}`;
      const existing = rows.get(key);
      if (existing && existing.requestFingerprintHash !== request.requestFingerprintHash) throw new IdempotencyKeyConflictError();
      if (existing) return { job: existing.job, created: false, deduped: true, dedupeReason: 'idempotency_key' };
      const job = { id: ingestionId, status: 'pending', created_at: new Date('2026-11-06T12:00:00.000Z'), input: request.input };
      rows.set(key, { job, requestFingerprintHash: request.requestFingerprintHash });
      return { job, created: true, deduped: false, dedupeReason: 'new_job' };
    });
    const context = { actorKey: 'current-owner', canStore: true };
    const first = await service.createApprovedGamingSourceIngestion([source(context.actorKey)], 'current-history-check', context);
    expect(first).toMatchObject({ statusCode: 202, payload: { deduplicated: false } });
    const replay = await service.createApprovedGamingSourceIngestion([source(context.actorKey)], 'current-history-check', context);
    expect(replay).toMatchObject({ statusCode: 202, payload: { deduplicated: true, ingestionId } });
    const otherActor = { actorKey: 'other-current-owner', canStore: true };
    expect(await service.createApprovedGamingSourceIngestion([source(otherActor.actorKey)], 'current-history-check', otherActor))
      .toMatchObject({ statusCode: 202, payload: { deduplicated: false } });
    const changed = { ...source(context.actorKey), recordType: 'build' as const };
    expect((await service.createApprovedGamingSourceIngestion([changed], 'current-history-check', context)).statusCode).toBe(409);
    expect((await service.createApprovedGamingSourceIngestion([source('wrong-actor')], 'current-history-check', context)).statusCode).toBe(400);
    const body = (enqueueMock.mock.calls[0][0] as any).input.body;
    expect(body.sources[0].hybridApproval.gamingClear.policyProfile).toBe(`${GAMING_CLEAR_POLICY_VERSION}:walkthrough:source`);
    expect(service.parseQueuedGamingSourceIngestionBody(body).ok).toBe(true);
    resolveMock.mockResolvedValue(document);
    normalizeMock.mockResolvedValue({ classification: { type: 'article' }, quality: 'substantial', adapterId: 'synthetic',
      adapterVersion: '1', evidenceText: text, metrics: {}, validation: { issues: [] } });
    persistMock.mockResolvedValue({ state: 'created', sourceId: '019fe3cd-8c01-7f01-8d2d-caa951bc4ba0',
      revisionId: '019fe3cd-8c01-7f01-8d2d-caa951bc4ba1', recordsCreated: 1, recordsUpdated: 0 });
    expect(await service.executeQueuedGamingSourceIngestion(ingestionId, body))
      .toMatchObject({ output: { status: 'completed', sources: [{ status: 'stored' }] }, retryable: false });
    expect(persistMock).toHaveBeenCalledTimes(1);
    expect((persistMock.mock.calls[0][0] as any).provenance.gamingClear.policyProfile)
      .toBe(`${GAMING_CLEAR_POLICY_VERSION}:walkthrough:source`);
  });
});
