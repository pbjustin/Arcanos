import { createHash } from 'node:crypto';

import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { createGamingClearAssessment, gamingClearHash } from '../src/shared/gaming/gamingClearPolicy.js';
import {
  QUEUED_GPT_JOB_PRODUCER_CONTRACT_SOURCE,
  QUEUED_GPT_JOB_PRODUCER_CONTRACT_VERSION,
} from '../src/shared/gpt/asyncGptJob.js';

const findOrCreateGptJobMock = jest.fn();
const getJobByIdMock = jest.fn();
const persistGamingSourceRevisionMock = jest.fn();
const getGamingSourceByIdMock = jest.fn();
const searchActiveGamingKnowledgeMock = jest.fn();
const resolveGamingDocumentMock = jest.fn();
const planAutonomousWorkerJobMock = jest.fn();
const ingestGamingBuildResourceMock = jest.fn();

function sourceApproval(subjectHash: string) {
  const dimension = { status: 'evaluated' as const, score: 4.5, reasonCodes: ['SYNTHETIC_SUPPORTED_SOURCE'],
    evidenceRefs: ['synthetic-source'], unresolvedFacts: [] };
  return createGamingClearAssessment({ profile: 'source', questionProfile: 'walkthrough', sourceRole: 'gameplay_guide',
    subjectId: 'synthetic-source', subjectHash, contextFingerprint: gamingClearHash('synthetic-context'), evidenceRefs: ['synthetic-source'],
    gates: { identity: 'verified', compatibility: 'verified', claimSupport: 'verified', freshness: 'verified', provenance: 'verified', security: 'verified' },
    dimensions: { clarity: dimension, leverage: dimension, efficiency: dimension, alignment: dimension, resilience: dimension } });
}

function resolvedDocument(url: string, text: string, overrides: Record<string, unknown> = {}) {
  return {
    requestedUrl: url,
    canonicalUrl: url,
    publicUrl: url,
    host: new URL(url).hostname,
    text,
    contentType: 'text/html',
    rawDocument: {
      body: '<html><title>Borderlands 4 Endgame Build</title><body>Useful guide</body></html>',
      contentType: 'text/html',
      truncated: false
    },
    metadata: { title: 'Borderlands 4 Endgame Build', headings: 'Endgame Build' },
    extraction: { strategy: 'article', rawTextLength: text.length, cleanedTextLength: text.length },
    resolution: { resolverId: 'generic-html', resolverVersion: '1', strategy: 'article', documentType: 'html', supportsStructuredExtraction: true },
    metrics: { rawTextLength: text.length, cleanedTextLength: text.length, truncated: false },
    ...overrides
  };
}

class MockGamingSourceRepositoryUnavailableError extends Error {}
class MockGamingDocumentAcquisitionError extends Error {
  acquisition: Record<string, unknown>;
  constructor(readonly code: string, stage: string, subreason: string, redirectCount = 0, readonly status?: number) {
    super('Safe acquisition failure');
    this.acquisition = { stage, subreason, redirectCount, failingHop: redirectCount, ruleId: 'gaming.fixture', policyVersion: 'gaming-https-acquisition-v1' };
  }
}

function gamingSourceActorScopeHash(actorKey: string): string {
  return createHash('sha256')
    .update(`${actorKey}\ngaming-source-ingestion`, 'utf8')
    .digest('hex');
}

function genericNormalizedGamingSource(evidenceText: string) {
  return {
    publicUrl: 'https://example.com/generic-guide',
    safeDisplayUrl: 'https://example.com/generic-guide',
    classification: {
      type: 'article',
      confidence: 0.8,
      gameConfidence: 0.8,
      gameEvidence: [],
      extractionStrategy: 'visible_html',
      reason: 'test',
      signals: []
    },
    build: undefined,
    quality: 'substantial',
    validation: {
      accepted: true,
      quality: 'substantial',
      normalizedFieldCount: 2,
      usefulFieldCount: 2,
      categoryCount: 1,
      equipmentCount: 0,
      skillCount: 0,
      statCount: 0,
      issues: []
    },
    adapterId: 'test-generic',
    adapterVersion: '1',
    extractionStrategy: 'visible_html',
    evidenceText,
    publicSnippet: evidenceText.slice(0, 120),
    metrics: {},
    cacheHit: false
  };
}

let createGamingSourceIngestion: typeof import('../src/services/gamingSourceIngestion.js').createGamingSourceIngestion;
let refreshGamingSources: typeof import('../src/services/gamingSourceIngestion.js').refreshGamingSources;
let executeQueuedGamingSourceIngestion: typeof import('../src/services/gamingSourceIngestion.js').executeQueuedGamingSourceIngestion;
let getGamingSourceIngestionStatus: typeof import('../src/services/gamingSourceIngestion.js').getGamingSourceIngestionStatus;
let buildStoredGamingKnowledgeContext: typeof import('../src/services/gamingSourceIngestion.js').buildStoredGamingKnowledgeContext;

beforeEach(async () => {
  jest.resetModules();
  findOrCreateGptJobMock.mockReset();
  getJobByIdMock.mockReset();
  persistGamingSourceRevisionMock.mockReset();
  getGamingSourceByIdMock.mockReset();
  searchActiveGamingKnowledgeMock.mockReset();
  resolveGamingDocumentMock.mockReset();
  planAutonomousWorkerJobMock.mockReset();
  ingestGamingBuildResourceMock.mockReset();

  findOrCreateGptJobMock.mockResolvedValue({
    job: {
      id: '019fe3cd-8c01-7f01-8d2d-caa951bc4b9b',
      status: 'pending',
      created_at: new Date('2026-08-08T12:00:00.000Z'),
      input: {}
    },
    created: true,
    deduped: false,
    dedupeReason: 'new_job'
  });
  planAutonomousWorkerJobMock.mockResolvedValue({
    status: 'pending',
    maxRetries: 2,
    priority: 100,
    autonomyState: {},
    planningReasons: []
  });
  resolveGamingDocumentMock.mockImplementation(async (url: string) => resolvedDocument(
    url,
    'Borderlands 4 endgame build equipment skills rotation '.repeat(12)
  ));
  ingestGamingBuildResourceMock.mockResolvedValue({
    publicUrl: 'https://mobalytics.gg/borderlands-4/builds',
    safeDisplayUrl: 'https://mobalytics.gg/borderlands-4/builds',
    classification: {
      type: 'build_planner',
      confidence: 0.9,
      gameConfidence: 0.9,
      gameEvidence: [],
      extractionStrategy: 'visible_html',
      reason: 'test',
      signals: []
    },
    build: {
      game: 'Borderlands 4',
      title: 'Endgame Build',
      patch: '1.2',
      equipment: [{ name: 'Test Weapon' }],
      source: {
        url: 'https://mobalytics.gg/borderlands-4/builds',
        resourceType: 'build_planner',
        extractor: 'test',
        confidence: 0.9
      }
    },
    quality: 'substantial',
    validation: {
      accepted: true,
      quality: 'substantial',
      normalizedFieldCount: 4,
      usefulFieldCount: 4,
      categoryCount: 1,
      equipmentCount: 1,
      skillCount: 0,
      statCount: 0,
      issues: []
    },
    adapterId: 'test',
    adapterVersion: '1',
    extractionStrategy: 'visible_html',
    evidenceText: 'Endgame Build with Test Weapon',
    publicSnippet: 'Endgame Build',
    metrics: {
      payloadLength: 0,
      payloadHash: '0'.repeat(64),
      decodedSize: 0,
      normalizedFieldCount: 4,
      equipmentCount: 1,
      skillCount: 0,
      statCount: 0,
      extractionElapsedMs: 1,
      adapterElapsedMs: 0
    },
    cacheHit: false
  });
  persistGamingSourceRevisionMock.mockResolvedValue({
    sourceId: '019fe3cd-8c01-7f01-8d2d-caa951bc4ba0',
    revisionId: '019fe3cd-8c01-7f01-8d2d-caa951bc4ba1',
    state: 'created',
    recordsCreated: 1,
    recordsUpdated: 0
  });

  class IdempotencyKeyConflictError extends Error {}
  class JobRepositoryUnavailableError extends Error {}
  jest.unstable_mockModule('../src/core/db/repositories/jobRepository.js', () => ({
    findOrCreateGptJob: findOrCreateGptJobMock,
    getJobById: getJobByIdMock,
    IdempotencyKeyConflictError,
    JobRepositoryUnavailableError
  }));
  jest.unstable_mockModule('../src/core/db/repositories/gamingSourceRepository.js', () => ({
    GamingSourceRepositoryUnavailableError: MockGamingSourceRepositoryUnavailableError,
    persistGamingSourceRevision: persistGamingSourceRevisionMock,
    getGamingSourceById: getGamingSourceByIdMock,
    searchActiveGamingKnowledge: searchActiveGamingKnowledgeMock,
    findActiveGamingSourceIdentities: jest.fn(async () => [{ sourceId: '019fe3cd-8c01-7f01-8d2d-caa951bc4ba0', gameKey: 'borderlands-4', gameName: 'Borderlands 4' }])
  }));
  jest.unstable_mockModule('../src/services/gamingDocumentResolution.js', () => ({
    GAMING_DOCUMENT_RESOLVER_VERSION: 'gaming-document-v1',
    GamingDocumentAcquisitionError: MockGamingDocumentAcquisitionError,
    resolveGamingDocument: resolveGamingDocumentMock,
    projectGamingDocumentPublicUrl: (url: string) => url,
    isResolvedGamingDocumentIdentityVerified: (document: any, url: string) => document.requestedUrl === url,
    describeGamingDocumentSource: (url: string) => ({ publicUrl: url })
  }));
  jest.unstable_mockModule('../src/services/workerAutonomyService.js', () => ({
    planAutonomousWorkerJob: planAutonomousWorkerJobMock
  }));
  jest.unstable_mockModule('../src/services/gamingBuildResources.js', () => ({
    ingestGamingBuildResource: ingestGamingBuildResourceMock
  }));
  jest.unstable_mockModule('../src/services/gamingSourceDiscovery.js', () => ({
    sanitizeGamingDiscoveryCandidateUrl: (rawUrl: string) => {
      try {
        const parsed = new URL(rawUrl);
        parsed.hash = '';
        parsed.searchParams.delete('utm_source');
        parsed.searchParams.sort();
        return { url: parsed.toString(), rejected: false };
      } catch {
        return { rejected: true };
      }
    }
  }));
  jest.unstable_mockModule('../src/platform/logging/structuredLogging.js', () => ({
    logger: {
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
      debug: jest.fn(),
      child: jest.fn()
    }
  }));

  ({
    createGamingSourceIngestion,
    refreshGamingSources,
    executeQueuedGamingSourceIngestion,
    getGamingSourceIngestionStatus,
    buildStoredGamingKnowledgeContext
  } = await import('../src/services/gamingSourceIngestion.js'));
});

describe('gaming source ingestion', () => {
  it('requires write permission and a strict content-bound quality assessment before hybrid enqueue', async () => {
    const { createApprovedGamingSourceIngestion } = await import('../src/services/gamingSourceIngestion.js');
    const actorKey = 'synthetic-hybrid-actor';
    const contentHash = gamingClearHash('synthetic-content');
    const source = { url: 'https://example.com/guide', game: 'Borderlands 4', contentHash,
      actorScopeHash: createHash('sha256').update(actorKey).digest('hex'), policyVersion: 'gaming-hybrid-candidates/v1' as const,
      sourceTrustType: 'supplied' as const, freshness: {}, sourceAssessment: sourceApproval(contentHash) };
    expect((await createApprovedGamingSourceIngestion([source], 'no-write-1', { actorKey, canStore: false })).statusCode).toBe(403);
    for (const assessment of [{ ...source.sourceAssessment, overall: 5 },
      { ...source.sourceAssessment, rubricVersion: 'gaming-clear/v2' }, sourceApproval(gamingClearHash('other-content'))]) {
      expect((await createApprovedGamingSourceIngestion([{ ...source, sourceAssessment: assessment as any }],
        'invalid-assessment-1', { actorKey, canStore: true })).statusCode).toBe(400);
    }
    expect(findOrCreateGptJobMock).not.toHaveBeenCalled();
  });

  it('never promotes changed hidden structured HTML after hybrid approval of unchanged visible prose', async () => {
    const { createApprovedGamingSourceIngestion, hashGamingApprovedDocument } = await import('../src/services/gamingSourceIngestion.js');
    const url = 'https://example.com/borderlands-4-guide';
    const text = 'Borderlands 4 route guide equipment skills rotation '.repeat(12);
    const approved = resolvedDocument(url, text);
    const actorKey = 'hybrid-approved-actor';
    const queued = await createApprovedGamingSourceIngestion([{
      url, game: 'Borderlands 4', contentHash: hashGamingApprovedDocument(approved as any),
      actorScopeHash: createHash('sha256').update(actorKey).digest('hex'),
      policyVersion: 'gaming-hybrid-candidates/v1', sourceTrustType: 'supplied', freshness: {},
      sourceAssessment: sourceApproval(hashGamingApprovedDocument(approved as any))
    }], 'hybrid-hidden-json-1', { actorKey, canStore: true });
    expect(queued.statusCode).toBe(202);
    resolveGamingDocumentMock.mockResolvedValue({ ...approved, rawDocument: {
      body: '<script type="application/json">{"equipment":[{"name":"UNAPPROVED HIDDEN WEAPON"}]}</script>',
      contentType: 'text/html', truncated: false
    } });
    const queuedBody = (findOrCreateGptJobMock.mock.calls[0][0] as any).input.body;
    const result = await executeQueuedGamingSourceIngestion('019fe3cd-8c01-7f01-8d2d-caa951bc4b9b', queuedBody);
    expect(result.output.sources[0].status).toBe('stored');
    expect((ingestGamingBuildResourceMock.mock.calls[0][0] as any).html).toBeUndefined();
    const persisted = persistGamingSourceRevisionMock.mock.calls[0][0] as any;
    expect(persisted.provenance.gamingClear).toMatchObject({ rubricVersion: 'gaming-clear/v1', profile: 'source',
      subjectHash: hashGamingApprovedDocument(approved as any), qualityEligible: true });
    expect(JSON.stringify(persisted.records)).not.toContain('UNAPPROVED HIDDEN WEAPON');
    expect(JSON.stringify(persisted.records)).not.toContain('Test Weapon');
    expect(persisted.records.every((record: any) => !record.normalized.structuredEvidence && !record.normalized.equipment)).toBe(true);
    expect(persisted.records[0].searchText).toContain('equipment skills rotation');
  });

  it('reports legacy queued hybrid approval as requiring reassessment without fabricating a pass or invoking acquisition', async () => {
    const { createApprovedGamingSourceIngestion } = await import('../src/services/gamingSourceIngestion.js');
    const actorKey = 'legacy-hybrid-actor';
    const contentHash = gamingClearHash('legacy-approved-content');
    await createApprovedGamingSourceIngestion([{ url: 'https://example.com/guide', game: 'Borderlands 4', contentHash,
      actorScopeHash: createHash('sha256').update(actorKey).digest('hex'), policyVersion: 'gaming-hybrid-candidates/v1',
      sourceTrustType: 'supplied', freshness: {}, sourceAssessment: sourceApproval(contentHash) }], 'legacy-hybrid-1', { actorKey, canStore: true });
    const body = (findOrCreateGptJobMock.mock.calls[0][0] as any).input.body;
    delete body.sources[0].hybridApproval.gamingClear;
    const result = await executeQueuedGamingSourceIngestion('019fe3cd-8c01-7f01-8d2d-caa951bc4b9b', body);
    expect(result.output).toMatchObject({ status: 'completed_with_errors', sources: [{ status: 'rejected',
      error: { code: 'APPROVED_ASSESSMENT_REQUIRED', retryable: false } }] });
    expect(resolveGamingDocumentMock).not.toHaveBeenCalled();
    expect(persistGamingSourceRevisionMock).not.toHaveBeenCalled();
  });

  it('preserves the prior revision when refetch truncates to the same approved text', async () => {
    const { createApprovedGamingSourceIngestion, hashGamingApprovedDocument } = await import('../src/services/gamingSourceIngestion.js');
    const url = 'https://example.com/borderlands-4-guide';
    const text = 'Borderlands 4 route guide equipment skills rotation '.repeat(12);
    const approved = resolvedDocument(url, text);
    const actorKey = 'hybrid-approved-actor';
    const approvedHash = hashGamingApprovedDocument(approved as any);
    const queued = await createApprovedGamingSourceIngestion([{
      url, game: 'Borderlands 4', contentHash: approvedHash,
      actorScopeHash: createHash('sha256').update(actorKey).digest('hex'),
      policyVersion: 'gaming-hybrid-candidates/v1', sourceTrustType: 'supplied', freshness: {}, sourceAssessment: sourceApproval(approvedHash)
    }], 'hybrid-truncated-refetch-1', { actorKey, canStore: true });
    expect(queued.statusCode).toBe(202);
    const queuedBody = (findOrCreateGptJobMock.mock.calls[0][0] as any).input.body;
    resolveGamingDocumentMock.mockResolvedValue(approved);
    const stored = await executeQueuedGamingSourceIngestion('019fe3cd-8c01-7f01-8d2d-caa951bc4b9b', queuedBody);
    expect(stored.output.sources[0].status).toBe('stored');
    expect(persistGamingSourceRevisionMock).toHaveBeenCalledTimes(1);
    persistGamingSourceRevisionMock.mockClear();
    ingestGamingBuildResourceMock.mockClear();
    const truncated = { ...approved, metrics: { ...approved.metrics, rawTextLength: text.length + 500, truncated: true } };
    expect(hashGamingApprovedDocument(truncated as any)).toBe(approvedHash);
    resolveGamingDocumentMock.mockResolvedValue(truncated);
    const result = await executeQueuedGamingSourceIngestion('019fe3cd-8c01-7f01-8d2d-caa951bc4b9b', queuedBody);
    expect(result.output.sources[0]).toMatchObject({ status: 'rejected', recordsCreated: 0, recordsUpdated: 0,
      error: { code: 'APPROVED_CONTENT_CHANGED', retryable: false } });
    expect(ingestGamingBuildResourceMock).not.toHaveBeenCalled();
    expect(persistGamingSourceRevisionMock).not.toHaveBeenCalled();
  });

  it('preserves pre-acquisition-policy idempotency fingerprints for unchanged ingest and legacy refresh', async () => {
    const canonicalUrl = 'https://example.com/guide';
    const sourceId = '019fe3cd-8c01-7f01-8d2d-caa951bc4ba0';
    const context = { actorKey: 'legacy-idempotency-fixture' };
    const baselineFingerprint = (action: 'ingest' | 'refresh') => createHash('sha256').update(
      `{"action":"${action}","refreshReason":${action === 'refresh' ? '"user_requested"' : 'null'},"rejected":[],"sources":[{"canonicalUrl":"https://example.com/guide","gameKey":"borderlands-4","patchVersion":null,"sourceId":${action === 'refresh' ? JSON.stringify(sourceId) : 'null'},"sourceTypeHint":"article"}]}`
    ).digest('hex');
    await createGamingSourceIngestion({ action: 'ingest', payload: {
      game: 'Borderlands 4', sourceUrls: [canonicalUrl], sourceTypeHint: 'article', idempotencyKey: 'legacy-ingest-fixture'
    } }, context);
    expect(findOrCreateGptJobMock).toHaveBeenLastCalledWith(expect.objectContaining({
      requestFingerprintHash: baselineFingerprint('ingest')
    }));
    const source = { id: sourceId, canonicalUrl, game: 'Borderlands 4', gameKey: 'borderlands-4',
      sourceType: 'supplied', trustScore: 0.25, latestRevision: { patch: null } };
    getGamingSourceByIdMock.mockResolvedValue(source);
    await refreshGamingSources({ action: 'refresh', payload: { sourceIds: [sourceId], idempotencyKey: 'legacy-refresh-fixture' } }, context);
    expect(findOrCreateGptJobMock).toHaveBeenLastCalledWith(expect.objectContaining({
      requestFingerprintHash: baselineFingerprint('refresh')
    }));
    getGamingSourceByIdMock.mockResolvedValue({ ...source, latestRevision: { patch: null,
      provenance: { requestedUrl: 'https://example.com/original-guide' } } });
    await refreshGamingSources({ action: 'refresh', payload: { sourceIds: [sourceId], idempotencyKey: 'legacy-refresh-fixture' } }, context);
    expect(findOrCreateGptJobMock).toHaveBeenLastCalledWith(expect.objectContaining({
      requestFingerprintHash: expect.not.stringMatching(baselineFingerprint('refresh'))
    }));
  });

  it('canonicalizes and deduplicates source URLs before creating one durable job', async () => {
    const response = await createGamingSourceIngestion({
      action: 'ingest',
      payload: {
        game: 'Borderlands 4',
        sourceUrls: [
          'https://mobalytics.gg/borderlands-4/builds?utm_source=chatgpt',
          'https://mobalytics.gg/borderlands-4/builds'
        ],
        sourceTypeHint: 'build_planner',
        origin: 'user_supplied',
        idempotencyKey: 'ingest-borderlands-builds-v1'
      }
    }, {
      actorKey: 'test-actor',
      requestId: 'request-1',
      traceId: 'trace-1'
    });

    expect(response.statusCode).toBe(202);
    expect(response.payload).toEqual(expect.objectContaining({
      ok: true,
      ingestionId: '019fe3cd-8c01-7f01-8d2d-caa951bc4b9b',
      status: 'queued',
      deduplicated: false
    }));
    const responsePayload = response.payload as { sources: unknown[] };
    expect(responsePayload.sources).toEqual([
      expect.objectContaining({ submittedIndex: 0, status: 'queued' }),
      expect.objectContaining({
        submittedIndex: 1,
        status: 'rejected',
        error: expect.objectContaining({ code: 'DUPLICATE_URL', retryable: false })
      })
    ]);
    const queuedInput = findOrCreateGptJobMock.mock.calls[0][0] as {
      input: {
        body: { sources: Array<{ canonicalUrl: string }> };
        producerContract: { version: number; source: string };
      };
    };
    expect(queuedInput.input.producerContract).toEqual({
      version: QUEUED_GPT_JOB_PRODUCER_CONTRACT_VERSION,
      source: QUEUED_GPT_JOB_PRODUCER_CONTRACT_SOURCE,
    });
    expect(queuedInput.input.body.sources).toHaveLength(1);
    expect(queuedInput.input.body.sources[0].canonicalUrl).toBe(
      'https://mobalytics.gg/borderlands-4/builds'
    );
    expect(JSON.stringify(queuedInput)).not.toContain('utm_source');
  });

  it.each([
    ['Minecraft', 'Minecraft Dungeons', 'minecraft-dungeons'],
    ['Elden Ring', 'Elden Ring Shadow of the Erdtree', 'elden-ring-shadow-of-the-erdtree'],
    ['World of Warcraft', 'World of Warcraft Classic', 'world-of-warcraft-classic']
  ])('preserves the precise %s variant through enqueue and persistence at the same source URL', async (baseGame, game, gameKey) => {
    const url = 'https://example.com/shared-guide';
    const fingerprints: string[] = [];
    const persistedGameKeys: string[] = [];
    for (const requestedGame of [baseGame, game]) {
      const text = `${requestedGame} progression guide. Cross the canyon and activate the tower to open the eastern route. `.repeat(5);
      resolveGamingDocumentMock.mockResolvedValueOnce(resolvedDocument(url, text, {
        metadata: { title: `${requestedGame} progression guide`, headings: 'Progression' }
      }));
      ingestGamingBuildResourceMock.mockResolvedValueOnce(genericNormalizedGamingSource(text));
      const response = await createGamingSourceIngestion({
        action: 'ingest',
        payload: { game: ` ${requestedGame} `, sourceUrls: [url], idempotencyKey: 'precise-game-identity-ingestion' }
      }, { actorKey: 'test-actor' });

      expect(response.statusCode).toBe(202);
      const queued = findOrCreateGptJobMock.mock.calls.at(-1)![0] as {
        input: { body: { sources: Array<{ game: string; gameKey: string }> } };
        requestFingerprintHash: string;
      };
      expect(queued.input.body.sources[0].game).toBe(requestedGame);
      const expectedGameKey = requestedGame === game ? gameKey : baseGame.toLowerCase().replaceAll(' ', '-');
      expect(queued.input.body.sources[0].gameKey).toBe(expectedGameKey);
      fingerprints.push(queued.requestFingerprintHash);

      const result = await executeQueuedGamingSourceIngestion('019fe3cd-8c01-7f01-8d2d-caa951bc4b9b', queued.input.body);
      expect(result.output.sources[0].status).toBe('stored');
      expect(persistGamingSourceRevisionMock).toHaveBeenLastCalledWith(expect.objectContaining({
        canonicalUrl: url,
        gameName: requestedGame,
        gameKey: expectedGameKey,
        records: expect.arrayContaining([expect.objectContaining({
          normalized: expect.objectContaining({ game: requestedGame })
        })])
      }));
      persistedGameKeys.push((persistGamingSourceRevisionMock.mock.calls.at(-1)![0] as { gameKey: string }).gameKey);
    }
    expect(new Set(fingerprints).size).toBe(2);
    expect(new Set(persistedGameKeys).size).toBe(2);
  });

  it('rejects mismatched idempotency values without enqueueing', async () => {
    const response = await createGamingSourceIngestion({
      action: 'ingest',
      payload: {
        game: 'Borderlands 4',
        sourceUrls: ['https://mobalytics.gg/borderlands-4/builds'],
        idempotencyKey: 'body-idempotency-key'
      }
    }, {
      actorKey: 'test-actor',
      idempotencyKey: 'header-idempotency-key'
    });

    expect(response.statusCode).toBe(400);
    expect(response.payload).toEqual(expect.objectContaining({
      ok: false,
      error: expect.objectContaining({ code: 'GAMING_SOURCE_VALIDATION_ERROR' })
    }));
    expect(findOrCreateGptJobMock).not.toHaveBeenCalled();
  });

  it('keeps multi-issue request diagnostics useful and inside the closed error bound', async () => {
    const unexpectedFields = Object.fromEntries(
      Array.from({ length: 40 }, (_, index) => [
        `unexpectedDiagnosticField${index.toString().padStart(2, '0')}`,
        true,
      ])
    );
    const responses = await Promise.all([
      createGamingSourceIngestion({
        action: 'ingest',
        payload: {
          game: '',
          sourceUrls: [],
          idempotencyKey: 'short',
          ...unexpectedFields,
        },
      }, { actorKey: 'test-actor' }),
      refreshGamingSources({
        action: 'refresh',
        payload: {
          sourceIds: [],
          idempotencyKey: 'short',
          ...unexpectedFields,
        },
      }, { actorKey: 'test-actor' }),
    ]);

    for (const [response, expectedPaths] of [
      [responses[0], ['payload.game', 'payload.sourceUrls']],
      [responses[1], ['payload.sourceIds', 'payload.idempotencyKey']],
    ] as const) {
      expect(response.statusCode).toBe(400);
      const message = (response.payload as {
        error: { message: string };
      }).error.message;
      expect(Array.from(message).length).toBeLessThanOrEqual(240);
      expect(message).toContain('...[truncated]');
      for (const expectedPath of expectedPaths) {
        expect(message).toContain(expectedPath);
      }
    }
    expect(findOrCreateGptJobMock).not.toHaveBeenCalled();
  });

  it('returns the closed storage-unavailable response when refresh lookup storage is down', async () => {
    getGamingSourceByIdMock.mockRejectedValue(new MockGamingSourceRepositoryUnavailableError());

    const response = await refreshGamingSources({
      action: 'refresh',
      payload: {
        sourceIds: ['019fe3cd-8c01-7f01-8d2d-caa951bc4ba0'],
        idempotencyKey: 'refresh-borderlands-source-v1'
      }
    }, { actorKey: 'test-actor' });

    expect(response.statusCode).toBe(503);
    expect(response.payload).toEqual({
      ok: false,
      error: {
        code: 'GAMING_SOURCE_STORAGE_UNAVAILABLE',
        message: 'Gaming-source refresh storage is unavailable.'
      }
    });
    expect(findOrCreateGptJobMock).not.toHaveBeenCalled();
  });

  it('keeps unexpected refresh lookup failures inside the closed Gaming 500 contract', async () => {
    getGamingSourceByIdMock.mockRejectedValue(new Error('unexpected refresh lookup failure'));

    const response = await refreshGamingSources({
      action: 'refresh',
      payload: {
        sourceIds: ['019fe3cd-8c01-7f01-8d2d-caa951bc4ba0'],
        idempotencyKey: 'refresh-borderlands-source-v1'
      }
    }, { actorKey: 'test-actor' });

    expect(response.statusCode).toBe(500);
    expect(response.payload).toEqual({
      ok: false,
      error: {
        code: 'GAMING_SOURCE_INTERNAL_ERROR',
        message: 'Failed to refresh gaming sources.'
      }
    });
    expect(findOrCreateGptJobMock).not.toHaveBeenCalled();
  });

  it('fetches, normalizes, persists provenance, and returns a source-level result', async () => {
    const execution = await executeQueuedGamingSourceIngestion(
      '019fe3cd-8c01-7f01-8d2d-caa951bc4b9b',
      {
        action: 'ingest',
        schemaVersion: '1',
        sources: [{
          submittedIndex: 0,
          canonicalUrl: 'https://mobalytics.gg/borderlands-4/builds',
          game: 'Borderlands 4',
          gameKey: 'borderlands-4',
          sourceTypeHint: 'build_planner',
          origin: 'user_supplied'
        }],
        rejectedSources: [],
        submittedCount: 1
      },
      { requestId: 'request-1', traceId: 'trace-1' }
    );

    expect(execution.retryable).toBe(false);
    expect(resolveGamingDocumentMock).toHaveBeenCalledWith(
      'https://mobalytics.gg/borderlands-4/builds',
      1_000_000,
      expect.objectContaining({ includeLinks: false })
    );
    expect(execution.output).toEqual(expect.objectContaining({
      status: 'completed',
      counts: expect.objectContaining({ succeeded: 1, recordsCreated: 1 }),
      sources: [expect.objectContaining({
        status: 'stored',
        sourceId: '019fe3cd-8c01-7f01-8d2d-caa951bc4ba0',
        sourceType: 'build_planner',
        patchVersion: '1.2'
      })]
    }));
    expect(persistGamingSourceRevisionMock).toHaveBeenCalledWith(expect.objectContaining({
      gameKey: 'borderlands-4',
      gameName: 'Borderlands 4',
      canonicalUrl: 'https://mobalytics.gg/borderlands-4/builds',
      sourceType: 'supplied',
      contentHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      provenance: expect.objectContaining({ origin: 'user_supplied' }),
      records: [expect.objectContaining({
        recordType: 'build',
        payloadHash: expect.stringMatching(/^[a-f0-9]{64}$/),
        normalized: expect.objectContaining({ structuredEvidence: 'Endgame Build with Test Weapon' })
      })]
    }));
  });

  it('retains later structured build facts in the first chunk search text without duplicating them', async () => {
    const url = 'https://mobalytics.gg/borderlands-4/builds';
    const text = 'Borderlands 4 endgame route. Follow the canyon and activate the checkpoint. '.repeat(70);
    const lateFact = 'Rotation: Activate the Zephyrglass Overdrive after the shield breaks.';
    const evidenceText = `[STRUCTURED BUILD EVIDENCE - EXTRACTED FACTS ONLY]\n${'Equipment: Synthetic reinforced armor with enhanced shield capacity. '.repeat(75)}\n${lateFact}`;
    expect(evidenceText.indexOf(lateFact)).toBeGreaterThan(4_000);
    expect(evidenceText.length).toBeLessThan(8_000);
    resolveGamingDocumentMock.mockResolvedValueOnce(resolvedDocument(url, text));
    const normalized = await ingestGamingBuildResourceMock();
    ingestGamingBuildResourceMock.mockResolvedValueOnce({
      ...normalized,
      build: { ...normalized.build, rotation: ['Activate the Zephyrglass Overdrive after the shield breaks.'] },
      evidenceText
    });

    const result = await executeQueuedGamingSourceIngestion('019fe3cd-8c01-7f01-8d2d-caa951bc4b9b', {
      action: 'ingest', schemaVersion: '1', submittedCount: 1, rejectedSources: [],
      sources: [{ submittedIndex: 0, canonicalUrl: url,
        game: 'Borderlands 4', gameKey: 'borderlands-4', origin: 'user_supplied' }]
    });

    expect(result.output.sources[0].status).toBe('stored');
    const persisted = persistGamingSourceRevisionMock.mock.calls[0][0] as {
      records: Array<{ searchText: string; normalized: { text: string; structuredEvidence?: string } }>;
    };
    expect(persisted.records.length).toBeGreaterThan(1);
    expect(persisted.records[0].searchText).toContain(lateFact);
    expect(persisted.records[0].normalized.structuredEvidence).toBe(evidenceText);
    expect(persisted.records.every(record => record.normalized.text.length <= 2_000)).toBe(true);
    expect(persisted.records.slice(1).every(record => record.normalized.structuredEvidence === undefined
      && !record.searchText.includes(lateFact))).toBe(true);
  });

  it('keeps the full structured evidence bound searchable alongside maximum accepted metadata', async () => {
    const url = 'https://example.org/synthetic-build';
    const text = `${'Synthetic gameplay route. '.repeat(100).slice(0, 1_999)}X`;
    const title = 'Synthetic build '.padEnd(500, 't');
    const game = 'Synthetic Game '.padEnd(120, 'g');
    const patch = '1.'.padEnd(64, '2');
    const lateFact = 'Rotation: Activate the Zephyrglass Overdrive after the shield breaks.';
    const evidenceText = `${'Equipment: Synthetic armor. '.repeat(400).slice(0, 8_000 - lateFact.length)}${lateFact}`;
    resolveGamingDocumentMock.mockResolvedValueOnce(resolvedDocument(url, text, {
      metadata: { title: 'Synthetic build' }
    }));
    const normalized = await ingestGamingBuildResourceMock();
    ingestGamingBuildResourceMock.mockResolvedValueOnce({
      ...normalized, build: { ...normalized.build, title, game, patch }, evidenceText
    });

    const result = await executeQueuedGamingSourceIngestion('019fe3cd-8c01-7f01-8d2d-caa951bc4b9b', {
      action: 'ingest', schemaVersion: '1', submittedCount: 1, rejectedSources: [],
      sources: [{ submittedIndex: 0, canonicalUrl: url,
        game, gameKey: 'synthetic-game', origin: 'user_supplied' }]
    });

    expect(result.output.sources[0].status).toBe('stored');
    const persisted = persistGamingSourceRevisionMock.mock.calls[0][0] as {
      records: Array<{ searchText: string; normalized: { text: string; structuredEvidence?: string } }>;
    };
    expect(persisted.records).toHaveLength(1);
    expect(persisted.records[0].normalized.text).toHaveLength(2_000);
    expect(persisted.records[0].normalized.structuredEvidence).toHaveLength(8_000);
    expect(persisted.records[0].searchText).toBe([text, title, game, patch, evidenceText].join('\n\n'));
    expect(persisted.records[0].searchText).toHaveLength(10_692);
  });

  it.each([
    'Use this guide to defeat every boss in the new expansion. The Borderlands 4 route starts at the village checkpoint.',
    'Unlike Elden Ring, Borderlands 4 rewards aggressive use of gunfire. Keep moving between cover positions and save ammunition for the boss.'
  ])('does not interpret gameplay prose as a requested game: %s', async (passage) => {
    const url = 'https://mobalytics.gg/borderlands-4/builds';
    const text = passage.repeat(3);
    resolveGamingDocumentMock.mockResolvedValueOnce(resolvedDocument(url, text));
    const result = await executeQueuedGamingSourceIngestion('019fe3cd-8c01-7f01-8d2d-caa951bc4b9b', {
      action: 'ingest', schemaVersion: '1', submittedCount: 1, rejectedSources: [],
      sources: [{ submittedIndex: 0, canonicalUrl: url,
        game: 'Borderlands 4', gameKey: 'borderlands-4', origin: 'user_supplied' }]
    });
    expect(result.output.sources[0].status).toBe('stored');
    expect(persistGamingSourceRevisionMock).toHaveBeenCalledWith(expect.objectContaining({
      cleanedContent: text,
      gameKey: 'borderlands-4'
    }));
  });

  it.each([
    { url: 'https://example.org/Elden%20Ring/guide', title: 'Borderlands 4 progression guide' },
    { url: 'https://guides.example.org/article', title: 'Destiny 2 progression guide' }
  ])('still rejects a source game mismatch from its URL or metadata: $url', async ({ url, title }) => {
    resolveGamingDocumentMock.mockResolvedValueOnce(resolvedDocument(url, 'Borderlands 4 progression route. '.repeat(10), {
      metadata: { title }
    }));
    const result = await executeQueuedGamingSourceIngestion('019fe3cd-8c01-7f01-8d2d-caa951bc4b9b', {
      action: 'ingest', schemaVersion: '1', submittedCount: 1, rejectedSources: [],
      sources: [{ submittedIndex: 0, canonicalUrl: url,
        game: 'Borderlands 4', gameKey: 'borderlands-4', origin: 'user_supplied' }]
    });
    expect(result.output.sources[0]).toMatchObject({ status: 'rejected', error: { code: 'GAME_MISMATCH' } });
    expect(ingestGamingBuildResourceMock).not.toHaveBeenCalled();
    expect(persistGamingSourceRevisionMock).not.toHaveBeenCalled();
  });

  it.each([false, true])('reports prose document quality independently of build fields (truncated=%s)', async (truncated) => {
    const text = 'Borderlands 4 progression guide. Cross the canyon and activate the tower to open the eastern route. '.repeat(30);
    resolveGamingDocumentMock.mockResolvedValueOnce(resolvedDocument(
      'https://example.com/generic-guide', text, {
        metrics: { rawTextLength: text.length + (truncated ? 800 : 0), cleanedTextLength: text.length, truncated },
        // Raw capture truncation alone must not lower the persisted text quality.
        rawDocument: { body: '<html></html>', contentType: 'text/html', truncated: true }
      }
    ));
    ingestGamingBuildResourceMock.mockResolvedValueOnce({
      ...genericNormalizedGamingSource(''),
      quality: 'metadata-only'
    });
    const execution = await executeQueuedGamingSourceIngestion('019fe3cd-8c01-7f01-8d2d-caa951bc4b9b', {
      action: 'ingest', schemaVersion: '1', submittedCount: 1, rejectedSources: [],
      sources: [{ submittedIndex: 0, canonicalUrl: 'https://example.com/generic-guide',
        game: 'Borderlands 4', gameKey: 'borderlands-4', origin: 'user_supplied' }]
    });
    expect(execution.output.sources[0].status).toBe('stored');
    expect(execution.output.sources[0].warnings).toEqual(truncated ? ['EXTRACTION_PARTIAL'] : undefined);
    expect(persistGamingSourceRevisionMock).toHaveBeenCalledWith(expect.objectContaining({
      cleanedContent: text.trim(),
      provenance: expect.objectContaining({ resolverId: 'generic-html', resolverVersion: '1' }),
      extractionMetrics: expect.objectContaining({
        extractionQuality: truncated ? 'partial' : 'complete',
        structuredExtractionQuality: 'not_applicable',
        documentTruncated: truncated
      })
    }));
  });

  it('retains partial extraction warnings for catalog metadata even when the bounded response is complete', async () => {
    const text = 'Borderlands 4. Identifier test-guide. Publisher Synthetic Fixtures. Publication date 2026. Download options. Scanner synthetic. Addeddate today. '.repeat(3);
    resolveGamingDocumentMock.mockResolvedValueOnce(resolvedDocument('https://example.com/catalog', text));
    ingestGamingBuildResourceMock.mockResolvedValueOnce(genericNormalizedGamingSource(''));
    const result = await executeQueuedGamingSourceIngestion('019fe3cd-8c01-7f01-8d2d-caa951bc4b9b', {
      action: 'ingest', schemaVersion: '1', submittedCount: 1, rejectedSources: [],
      sources: [{ submittedIndex: 0, canonicalUrl: 'https://example.com/catalog',
        game: 'Borderlands 4', gameKey: 'borderlands-4', origin: 'user_supplied' }]
    });
    expect(result.output.sources[0].warnings).toEqual(['EXTRACTION_PARTIAL']);
    expect(persistGamingSourceRevisionMock).toHaveBeenCalledWith(expect.objectContaining({
      extractionMetrics: expect.objectContaining({ extractionQuality: 'metadata-only', structuredExtractionQuality: 'not_applicable' })
    }));
  });

  it('stores document-only resolver prose as a guide even when its identifier resembles a build URL', async () => {
    const text = 'Borderlands 4 progression route. Follow the canyon path and activate the eastern beacon to unlock the objective. '.repeat(10);
    resolveGamingDocumentMock.mockResolvedValueOnce(resolvedDocument('https://archive.org/details/synthetic_build_planner', text, {
      contentType: 'text/plain', rawDocument: undefined,
      resolution: { resolverId: 'archive-org', resolverVersion: '1', strategy: 'archive_djvu_text', documentType: 'text', supportsStructuredExtraction: false }
    }));
    const result = await executeQueuedGamingSourceIngestion('019fe3cd-8c01-7f01-8d2d-caa951bc4b9b', {
      action: 'ingest', schemaVersion: '1', submittedCount: 1, rejectedSources: [],
      sources: [{ submittedIndex: 0, canonicalUrl: 'https://archive.org/details/synthetic_build_planner',
        game: 'Borderlands 4', gameKey: 'borderlands-4', origin: 'user_supplied' }]
    });
    expect(result.output.sources[0]).toMatchObject({ status: 'stored', sourceType: 'article' });
    expect(result.output.sources[0].warnings).toBeUndefined();
    expect(persistGamingSourceRevisionMock).toHaveBeenCalledWith(expect.objectContaining({
      extractionMetrics: expect.objectContaining({ structuredExtractionQuality: 'not_applicable' }),
      records: [expect.objectContaining({ recordType: 'guide', normalized: expect.not.objectContaining({ equipment: expect.anything() }) })]
    }));
  });

  it('keeps the complete bounded guide searchable and hashes a change at its tail on refresh', async () => {
    const url = 'https://example.com/generic-guide';
    const prefix = 'Borderlands 4 progression route. '.repeat(6_000).slice(0, 159_900);
    const initialText = `${prefix}${'x'.repeat(70)} FINAL TOWER PASSAGE ALPHA`.padEnd(160_000, '.');
    const updatedText = `${initialText.slice(0, -5)}BETA.`;
    ingestGamingBuildResourceMock.mockResolvedValue(genericNormalizedGamingSource('Normalized metadata. '.repeat(100)));
    resolveGamingDocumentMock
      .mockResolvedValueOnce(resolvedDocument(url, initialText))
      .mockResolvedValueOnce(resolvedDocument(url, initialText))
      .mockResolvedValueOnce(resolvedDocument(url, updatedText));
    const queued = {
      action: 'ingest', schemaVersion: '1', submittedCount: 1, rejectedSources: [],
      sources: [{ submittedIndex: 0, canonicalUrl: url, game: 'Borderlands 4',
        gameKey: 'borderlands-4', origin: 'user_supplied' }]
    };
    await executeQueuedGamingSourceIngestion('019fe3cd-8c01-7f01-8d2d-caa951bc4b9b', queued);
    const refresh = { ...queued, action: 'refresh', sources: [{ ...queued.sources[0], origin: 'refresh' }] };
    await executeQueuedGamingSourceIngestion('019fe3cd-8c01-7f01-8d2d-caa951bc4b9b', refresh);
    await executeQueuedGamingSourceIngestion('019fe3cd-8c01-7f01-8d2d-caa951bc4b9b', refresh);
    const writes = persistGamingSourceRevisionMock.mock.calls.map(([value]) => value as {
      contentHash: string; cleanedContent: string; records: Array<{ searchText: string }>;
    });
    expect(writes).toHaveLength(3);
    expect(writes[0].cleanedContent).toBe(initialText.slice(0, 16_000));
    expect(writes[0].records.length).toBeGreaterThan(1);
    expect(writes[0].records.some(record => record.searchText.includes('FINAL TOWER PASSAGE ALPHA'))).toBe(true);
    expect(writes[1].contentHash).toBe(writes[0].contentHash);
    expect(writes[2].contentHash).not.toBe(writes[0].contentHash);
    expect(writes[2].records.at(-1)?.searchText).toContain('BETA.');
    expect(resolveGamingDocumentMock).toHaveBeenCalledTimes(3);
  });

  it('propagates cancellation after acquisition without normalizing or persisting a document', async () => {
    const controller = new AbortController();
    const aborted = new Error('Synthetic cancellation');
    resolveGamingDocumentMock.mockImplementationOnce(async (url: string) => {
      controller.abort(aborted);
      return resolvedDocument(url, 'Borderlands 4 progression guide. '.repeat(10));
    });
    await expect(executeQueuedGamingSourceIngestion('019fe3cd-8c01-7f01-8d2d-caa951bc4b9b', {
      action: 'ingest', schemaVersion: '1', submittedCount: 1, rejectedSources: [],
      sources: [{ submittedIndex: 0, canonicalUrl: 'https://example.com/generic-guide',
        game: 'Borderlands 4', gameKey: 'borderlands-4', origin: 'user_supplied' }]
    }, { signal: controller.signal })).rejects.toBe(aborted);
    expect(ingestGamingBuildResourceMock).not.toHaveBeenCalled();
    expect(persistGamingSourceRevisionMock).not.toHaveBeenCalled();
  });

  it('revises extraction identity when resolver policy changes without changing persisted content', async () => {
    const url = 'https://example.com/generic-guide';
    const text = 'Borderlands 4 progression route. Follow the canyon path to unlock the eastern beacon. '.repeat(10);
    const document = resolvedDocument(url, text);
    resolveGamingDocumentMock
      .mockResolvedValueOnce(document)
      .mockResolvedValueOnce(document)
      .mockResolvedValueOnce({
        ...document,
        resolution: { ...document.resolution, resolverVersion: '2' }
      });
    ingestGamingBuildResourceMock.mockResolvedValue(genericNormalizedGamingSource(''));
    const body = {
      action: 'refresh', schemaVersion: '1', submittedCount: 1, rejectedSources: [],
      sources: [{ submittedIndex: 0, canonicalUrl: url, game: 'Borderlands 4', gameKey: 'borderlands-4', origin: 'refresh' }]
    };
    for (let index = 0; index < 3; index += 1) {
      await executeQueuedGamingSourceIngestion('019fe3cd-8c01-7f01-8d2d-caa951bc4b9b', body);
    }
    const writes = persistGamingSourceRevisionMock.mock.calls.map(([value]) => value as {
      contentHash: string; extractorVersion: string; provenance: Record<string, unknown>;
    });
    expect(writes[1].extractorVersion).toBe(writes[0].extractorVersion);
    expect(writes[2].extractorVersion).not.toBe(writes[0].extractorVersion);
    expect(writes[2].contentHash).toBe(writes[0].contentHash);
    expect(writes[2].extractorVersion).toMatch(/^gaming-document-v1:[a-f0-9]{64}$/);
    expect(writes[2].extractorVersion.length).toBeLessThanOrEqual(120);
    expect(writes[2].provenance).toMatchObject({
      resolverVersion: '2', structuredExtractorVersion: '1', documentResolverVersion: 'gaming-document-v1'
    });
  });

  it('keeps an uncorroborated caller patch only as non-authoritative provenance', async () => {
    ingestGamingBuildResourceMock.mockResolvedValueOnce(
      genericNormalizedGamingSource('A general guide with no version declaration.')
    );

    const execution = await executeQueuedGamingSourceIngestion(
      '019fe3cd-8c01-7f01-8d2d-caa951bc4b9b',
      {
        action: 'ingest',
        schemaVersion: '1',
        sources: [{
          submittedIndex: 0,
          canonicalUrl: 'https://example.com/generic-guide',
          game: 'Borderlands 4',
          gameKey: 'borderlands-4',
          patchVersion: '9.9',
          origin: 'user_supplied'
        }],
        rejectedSources: [],
        submittedCount: 1
      }
    );

    const persisted = persistGamingSourceRevisionMock.mock.calls[0]?.[0] as {
      patch?: string;
      provenance: Record<string, unknown>;
      records: Array<{
        patch?: string;
        searchText: string;
        normalized: Record<string, unknown>;
      }>;
    };
    expect(persisted.patch).toBeUndefined();
    expect(persisted.provenance).toMatchObject({
      claimedPatchVersion: '9.9',
      verifiedPatchVersion: null,
      patchVerificationMethod: null
    });
    expect(persisted.records[0]?.patch).toBeUndefined();
    expect(persisted.records[0]?.normalized).not.toHaveProperty('patch');
    expect(persisted.records[0]?.searchText).not.toContain('9.9');
    expect(execution.output.sources[0]).not.toHaveProperty('patchVersion');
  });

  it('refreshes the original acquired URL from stored provenance while retaining the existing source key', async () => {
    const originalUrl = 'https://example.com/original-guide';
    const canonicalUrl = 'https://example.com/final-guide';
    const nextUrl = 'https://example.com/updated-guide';
    const sourceId = '019fe3cd-8c01-7f01-8d2d-caa951bc4ba0';
    getGamingSourceByIdMock.mockResolvedValue({ id: sourceId, canonicalUrl, game: 'Borderlands 4', gameKey: 'borderlands 4',
      sourceType: 'official', trustScore: 0.9, latestRevision: { patch: null, provenance: { requestedUrl: originalUrl } } });
    const queued = await refreshGamingSources({ action: 'refresh', payload: { sourceIds: [sourceId], idempotencyKey: 'redirect-refresh-original-1' } },
      { actorKey: 'redirect-fixture-actor' });
    expect(queued.statusCode).toBe(202);
    const body = (findOrCreateGptJobMock.mock.calls[0][0] as any).input.body;
    expect(body.sources[0]).toMatchObject({ canonicalUrl, acquisitionUrl: originalUrl, sourceId });
    const document = resolvedDocument(originalUrl, 'Borderlands 4 route guide save progress before crossing the checkpoint. '.repeat(20), {
      canonicalUrl: nextUrl, publicUrl: nextUrl,
      acquisition: { policyVersion: 'gaming-https-acquisition-v1', requestedUrl: originalUrl, finalUrl: nextUrl,
        redirectCount: 1, transitions: [{ fromUrl: originalUrl, toUrl: nextUrl, classification: 'same_origin', ruleId: 'gaming.redirect.same_origin' }] }
    });
    resolveGamingDocumentMock.mockResolvedValue(document);
    ingestGamingBuildResourceMock.mockResolvedValue(genericNormalizedGamingSource(''));
    await executeQueuedGamingSourceIngestion('019fe3cd-8c01-7f01-8d2d-caa951bc4b9b', body);
    expect(resolveGamingDocumentMock).toHaveBeenCalledWith(originalUrl, 1_000_000, expect.any(Object));
    expect(persistGamingSourceRevisionMock).toHaveBeenCalledWith(expect.objectContaining({ canonicalUrl, publicUrl: nextUrl,
      sourceType: 'supplied', trustScore: 0.25,
      provenance: expect.objectContaining({ requestedUrl: originalUrl, finalPublicUrl: nextUrl,
        acquisition: document.acquisition, finalSourcePolicy: expect.objectContaining({ authority: 'unreviewed' }) }) }));
  });

  it('binds unchanged prose approvals to requested/final identity and the verified acquisition policy', async () => {
    const { hashGamingApprovedDocument } = await import('../src/services/gamingSourceIngestion.js');
    const originalUrl = 'https://example.com/original-guide';
    const finalUrl = 'https://example.com/final-guide';
    const document = resolvedDocument(originalUrl, 'Borderlands 4 route guide checkpoint. '.repeat(20), {
      canonicalUrl: finalUrl, publicUrl: finalUrl,
      acquisition: { policyVersion: 'gaming-https-acquisition-v1', requestedUrl: originalUrl, finalUrl,
        redirectCount: 1, transitions: [{ fromUrl: originalUrl, toUrl: finalUrl, classification: 'same_origin', ruleId: 'gaming.redirect.same_origin' }] }
    });
    const originalHash = hashGamingApprovedDocument(document as any);
    for (const changed of [
      { ...document, requestedUrl: 'https://example.com/other-original' },
      { ...document, publicUrl: 'https://example.com/other-final' },
      { ...document, canonicalUrl: 'https://example.com/other-identity' },
      { ...document, acquisition: { ...(document.acquisition as object), policyVersion: 'changed-policy' } },
      { ...document, acquisition: undefined }
    ]) expect(hashGamingApprovedDocument(changed as any)).not.toBe(originalHash);
  });

  it.each([
    ['URL_BLOCKED', 'private_reserved_destination', undefined, 'URL_BLOCKED', false],
    ['REDIRECT_NOT_ALLOWED', 'UNAPPROVED_TRANSITION', 302, 'REDIRECT_NOT_ALLOWED', false],
    ['SOURCE_TIMEOUT', 'DEADLINE_EXCEEDED', undefined, 'FETCH_TIMEOUT', true],
    ['SOURCE_FETCH_FAILED', 'TRANSFER_LIMIT', undefined, 'RESPONSE_TOO_LARGE', false],
    ['SOURCE_FETCH_FAILED', 'DECODED_LIMIT', undefined, 'RESPONSE_TOO_LARGE', false],
    ['SOURCE_FETCH_FAILED', 'UNSUPPORTED_ENCODING', undefined, 'UNSUPPORTED_CONTENT_TYPE', false],
    ['SOURCE_FETCH_FAILED', 'UNSUPPORTED_CONTENT_TYPE', undefined, 'UNSUPPORTED_CONTENT_TYPE', false],
    ['SOURCE_FETCH_FAILED', 'CONDITIONAL_CONTENT_UNAVAILABLE', 304, 'FETCH_FAILED', false],
    ['SOURCE_INACCESSIBLE', 'HTTP_RESPONSE_UNUSABLE', 401, 'AUTHENTICATION_REQUIRED', false],
    ['SOURCE_INACCESSIBLE', 'HTTP_RESPONSE_UNUSABLE', 403, 'ACCESS_DENIED', false],
    ['SOURCE_FETCH_FAILED', 'HTTP_RESPONSE_UNUSABLE', 404, 'SOURCE_NOT_FOUND', false],
    ['SOURCE_FETCH_FAILED', 'HTTP_RESPONSE_UNUSABLE', 410, 'SOURCE_NOT_FOUND', false],
    ['SOURCE_FETCH_FAILED', 'HTTP_RESPONSE_UNUSABLE', 429, 'FETCH_FAILED', true],
    ['SOURCE_FETCH_FAILED', 'HTTP_RESPONSE_UNUSABLE', 503, 'FETCH_FAILED', true]
  ])('preserves bounded acquisition failure %s/%s in worker classification', async (code, subreason, status, expectedCode, retryable) => {
    resolveGamingDocumentMock.mockRejectedValueOnce(new MockGamingDocumentAcquisitionError(String(code), 'transport', String(subreason), 1, status as number | undefined));
    const result = await executeQueuedGamingSourceIngestion('019fe3cd-8c01-7f01-8d2d-caa951bc4b9b', {
      action: 'ingest', schemaVersion: '1', submittedCount: 1, rejectedSources: [],
      sources: [{ submittedIndex: 0, canonicalUrl: 'https://example.com/guide', game: 'Borderlands 4', gameKey: 'borderlands 4', origin: 'user_supplied' }]
    });
    expect(result.output.sources[0]).toMatchObject({ status: retryable ? 'failed' : 'rejected', error: { code: expectedCode, retryable } });
    expect(persistGamingSourceRevisionMock).not.toHaveBeenCalled();
  });

  it('stores observed equivalent redirect entries under their verified final canonical identity', async () => {
    const originalUrl = 'https://example.com/original-guide';
    const finalUrl = 'https://example.com/final-guide';
    resolveGamingDocumentMock.mockResolvedValue(resolvedDocument(originalUrl, 'Borderlands 4 route guide checkpoint. '.repeat(20), {
      canonicalUrl: finalUrl, publicUrl: finalUrl,
      acquisition: { policyVersion: 'gaming-https-acquisition-v1', requestedUrl: originalUrl, finalUrl, redirectCount: 1, transitions: [] }
    }));
    ingestGamingBuildResourceMock.mockResolvedValue(genericNormalizedGamingSource(''));
    await executeQueuedGamingSourceIngestion('019fe3cd-8c01-7f01-8d2d-caa951bc4b9b', {
      action: 'ingest', schemaVersion: '1', submittedCount: 1, rejectedSources: [],
      sources: [{ submittedIndex: 0, canonicalUrl: originalUrl, game: 'Borderlands 4', gameKey: 'borderlands 4', origin: 'user_supplied' }]
    });
    expect(persistGamingSourceRevisionMock).toHaveBeenCalledWith(expect.objectContaining({ canonicalUrl: finalUrl, publicUrl: finalUrl }));
  });

  it('promotes a caller patch only after an exact fetched-content match', async () => {
    const verifiedText = 'Borderlands 4 patch 9.9 progression equipment skills rotation '.repeat(8);
    resolveGamingDocumentMock.mockImplementationOnce(async (url: string) => resolvedDocument(
      url, verifiedText, { metadata: { title: 'Borderlands 4 Patch 9.9 Guide' } }
    ));
    ingestGamingBuildResourceMock.mockResolvedValueOnce(
      genericNormalizedGamingSource('Borderlands 4 patch 9.9 progression guide.')
    );

    await executeQueuedGamingSourceIngestion(
      '019fe3cd-8c01-7f01-8d2d-caa951bc4b9b',
      {
        action: 'ingest',
        schemaVersion: '1',
        sources: [{
          submittedIndex: 0,
          canonicalUrl: 'https://example.com/generic-guide',
          game: 'Borderlands 4',
          gameKey: 'borderlands-4',
          patchVersion: '9.9',
          origin: 'user_supplied'
        }],
        rejectedSources: [],
        submittedCount: 1
      }
    );

    expect(persistGamingSourceRevisionMock).toHaveBeenCalledWith(
      expect.objectContaining({
        patch: '9.9',
        provenance: expect.objectContaining({
          claimedPatchVersion: '9.9',
          verifiedPatchVersion: '9.9',
          patchVerificationMethod: 'fetched_content_exact_match'
        }),
        records: [expect.objectContaining({
          patch: '9.9',
          normalized: expect.objectContaining({ patch: '9.9' })
        })]
      })
    );
  });

  it('omits an overlong extracted patch from persistence and worker output', async () => {
    const overlongPatch = `patch-${'x'.repeat(59)}`;
    ingestGamingBuildResourceMock.mockResolvedValueOnce({
      ...genericNormalizedGamingSource('Borderlands 4 endgame build evidence.'),
      classification: {
        type: 'build_planner',
        confidence: 0.9,
        gameConfidence: 0.9,
        gameEvidence: [],
        extractionStrategy: 'visible_html',
        reason: 'test',
        signals: []
      },
      build: {
        game: 'Borderlands 4',
        title: 'Overlong Patch Build',
        patch: overlongPatch,
        equipment: [{ name: 'Test Weapon' }]
      }
    });

    const execution = await executeQueuedGamingSourceIngestion(
      '019fe3cd-8c01-7f01-8d2d-caa951bc4b9b',
      {
        action: 'ingest',
        schemaVersion: '1',
        sources: [{
          submittedIndex: 0,
          canonicalUrl: 'https://example.com/overlong-patch-build',
          game: 'Borderlands 4',
          gameKey: 'borderlands-4',
          origin: 'user_supplied'
        }],
        rejectedSources: [],
        submittedCount: 1
      }
    );

    expect(Array.from(overlongPatch)).toHaveLength(65);
    const persisted = persistGamingSourceRevisionMock.mock.calls[0]?.[0] as {
      patch?: string;
      provenance: Record<string, unknown>;
      records: Array<{
        normalized: Record<string, unknown>;
        patch?: string;
      }>;
    };
    expect(persisted.patch).toBeUndefined();
    expect(persisted.provenance).toMatchObject({
      claimedPatchVersion: null,
      verifiedPatchVersion: null,
      patchVerificationMethod: null
    });
    expect(persisted.records[0]?.patch).toBeUndefined();
    expect(persisted.records[0]?.normalized).not.toHaveProperty('patch');
    expect(JSON.stringify(persisted)).not.toContain(overlongPatch);
    expect(execution.output.sources[0]).not.toHaveProperty('patchVersion');
  });

  it('does not project arbitrary generic jobs through the domain status route', async () => {
    getJobByIdMock.mockResolvedValue({
      id: '019fe3cd-8c01-7f01-8d2d-caa951bc4b9b',
      job_type: 'gpt',
      status: 'completed',
      input: {
        gptId: 'arcanos-core',
        body: {},
        requestPath: '/gpt-access/jobs/create',
        executionModeReason: 'gpt_access_create_ai_job'
      }
    });

    const response = await getGamingSourceIngestionStatus(
      '019fe3cd-8c01-7f01-8d2d-caa951bc4b9b',
      { actorKey: 'actor-a' }
    );

    expect(response.statusCode).toBe(404);
    expect(response.payload).toEqual({
      ok: false,
      error: {
        code: 'GAMING_SOURCE_INGESTION_NOT_FOUND',
        message: 'The gaming-source ingestion was not found.'
      }
    });
  });

  it('does not expose another actor\'s gaming ingestion status', async () => {
    getJobByIdMock.mockResolvedValue({
      id: '019fe3cd-8c01-7f01-8d2d-caa951bc4b9b',
      job_type: 'gpt',
      status: 'pending',
      idempotency_scope_hash: 'different-actor-scope',
      input: {
        gptId: 'arcanos-gaming',
        requestPath: '/gpt-access/gaming/sources/ingestions',
        executionModeReason: 'gaming_source_ingestion',
        body: {
          action: 'ingest',
          schemaVersion: '1',
          sources: [{
            submittedIndex: 0,
            canonicalUrl: 'https://mobalytics.gg/borderlands-4/builds',
            game: 'Borderlands 4',
            gameKey: 'borderlands-4',
            origin: 'user_supplied'
          }],
          rejectedSources: [],
          submittedCount: 1
        }
      }
    });

    const response = await getGamingSourceIngestionStatus(
      '019fe3cd-8c01-7f01-8d2d-caa951bc4b9b',
      { actorKey: 'actor-a' }
    );

    expect(response.statusCode).toBe(404);
    expect(response.payload).toEqual({
      ok: false,
      error: {
        code: 'GAMING_SOURCE_INGESTION_NOT_FOUND',
        message: 'The gaming-source ingestion was not found.'
      }
    });
  });

  it('omits an overlong legacy patch from the public status projection', async () => {
    const ingestionId = '019fe3cd-8c01-7f01-8d2d-caa951bc4b9b';
    const overlongPatch = `patch-${'x'.repeat(59)}`;
    getJobByIdMock.mockResolvedValue({
      id: ingestionId,
      job_type: 'gpt',
      status: 'completed',
      idempotency_scope_hash: gamingSourceActorScopeHash('actor-a'),
      created_at: new Date('2026-08-08T12:00:00.000Z'),
      updated_at: new Date('2026-08-08T12:01:00.000Z'),
      completed_at: new Date('2026-08-08T12:01:00.000Z'),
      input: {
        gptId: 'arcanos-gaming',
        requestPath: '/gpt-access/gaming/sources/ingestions',
        executionModeReason: 'gaming_source_ingestion',
        body: {
          action: 'ingest',
          schemaVersion: '1',
          sources: [{
            submittedIndex: 0,
            canonicalUrl: 'https://example.com/overlong-patch-build',
            game: 'Borderlands 4',
            gameKey: 'borderlands-4',
            origin: 'user_supplied'
          }],
          rejectedSources: [],
          submittedCount: 1
        }
      },
      output: {
        ok: true,
        action: 'ingest',
        ingestionId,
        status: 'completed',
        counts: {
          total: 1,
          queued: 0,
          succeeded: 1,
          rejected: 0,
          failed: 0,
          recordsCreated: 1,
          recordsUpdated: 0
        },
        sources: [{
          submittedIndex: 0,
          status: 'stored',
          canonicalUrl: 'https://example.com/overlong-patch-build',
          sourceId: '019fe3cd-8c01-7f01-8d2d-caa951bc4ba0',
          sourceType: 'build_planner',
          patchVersion: overlongPatch,
          recordsCreated: 1,
          recordsUpdated: 0,
          fetchedAt: '2026-08-08T12:00:30.000Z',
          completedAt: '2026-08-08T12:00:31.000Z'
        }],
        createdAt: '2026-08-08T12:00:00.000Z',
        updatedAt: '2026-08-08T12:01:00.000Z',
        completedAt: '2026-08-08T12:01:00.000Z'
      }
    });

    const response = await getGamingSourceIngestionStatus(
      ingestionId,
      { actorKey: 'actor-a' }
    );
    const payload = response.payload as {
      sources: Array<{ patchVersion?: string }>;
    };

    expect(Array.from(overlongPatch)).toHaveLength(65);
    expect(response.statusCode).toBe(200);
    expect(payload.sources[0]).not.toHaveProperty('patchVersion');
    expect(JSON.stringify(payload)).not.toContain(overlongPatch);
  });

  it('keeps unexpected status lookup failures inside the closed Gaming 500 contract', async () => {
    getJobByIdMock.mockRejectedValue(new Error('unexpected status lookup failure'));

    const response = await getGamingSourceIngestionStatus(
      '019fe3cd-8c01-7f01-8d2d-caa951bc4b9b',
      { actorKey: 'actor-a' }
    );

    expect(response.statusCode).toBe(500);
    expect(response.payload).toEqual({
      ok: false,
      error: {
        code: 'GAMING_SOURCE_INTERNAL_ERROR',
        message: 'Failed to read gaming-source ingestion status.'
      }
    });
  });

  it.each(['cancelled', 'expired', 'failed'] as const)(
    'does not report queued sources for a terminal %s job without output',
    async (jobStatus) => {
      getJobByIdMock.mockResolvedValue({
        id: '019fe3cd-8c01-7f01-8d2d-caa951bc4b9b',
        job_type: 'gpt',
        status: jobStatus,
        idempotency_scope_hash: gamingSourceActorScopeHash('actor-a'),
        created_at: new Date('2026-08-08T12:00:00.000Z'),
        updated_at: new Date('2026-08-08T12:01:00.000Z'),
        completed_at: new Date('2026-08-08T12:01:00.000Z'),
        output: null,
        input: {
          gptId: 'arcanos-gaming',
          requestPath: '/gpt-access/gaming/sources/ingestions',
          executionModeReason: 'gaming_source_ingestion',
          body: {
            action: 'ingest',
            schemaVersion: '1',
            sources: [{
              submittedIndex: 0,
              canonicalUrl: 'https://mobalytics.gg/borderlands-4/builds',
              game: 'Borderlands 4',
              gameKey: 'borderlands-4',
              origin: 'user_supplied'
            }],
            rejectedSources: [],
            submittedCount: 1
          }
        }
      });

      const response = await getGamingSourceIngestionStatus(
        '019fe3cd-8c01-7f01-8d2d-caa951bc4b9b',
        { actorKey: 'actor-a' }
      );
      const payload = response.payload as {
        status: string;
        counts: { queued: number; failed: number };
        sources: Array<{ status: string; error?: { retryable: boolean } }>;
      };

      expect(response.statusCode).toBe(200);
      expect(payload.status).toBe(jobStatus);
      expect(payload.counts).toEqual(expect.objectContaining({ queued: 0, failed: 1 }));
      expect(payload.sources).toEqual([
        expect.objectContaining({
          status: 'failed',
          error: expect.objectContaining({ retryable: false })
        })
      ]);
    }
  );

  it('returns bounded stored knowledge with source provenance', async () => {
    searchActiveGamingKnowledgeMock.mockResolvedValue([{
      recordId: 'stored-build', revisionId: 'revision-build', recordType: 'build', relevance: 0.75,
      sourceId: '019fe3cd-8c01-7f01-8d2d-caa951bc4ba0',
      publicUrl: 'https://mobalytics.gg/borderlands-4/builds',
      title: 'Endgame Build',
      sourceType: 'supplied',
      patch: '1.2',
      revisionPatch: '1.2',
      fetchedAt: new Date('2026-08-08T12:00:00.000Z'),
      publishedAt: new Date('2026-08-07T12:00:00.000Z'),
      searchText: 'Endgame Build with Test Weapon',
      normalized: { patch: '1.2' },
      provenance: {
        verifiedPatchVersion: '1.2',
        patchVerificationMethod: 'extractor'
      }
    }]);

    const result = await buildStoredGamingKnowledgeContext({
      game: 'Borderlands 4',
      prompt: 'What is the endgame build?',
      mode: 'build',
      sourceIndexOffset: 2
    });

    expect(searchActiveGamingKnowledgeMock).toHaveBeenCalledWith(
      expect.objectContaining({
        gameKey: 'borderlands-4',
        mode: 'build'
      }),
      expect.objectContaining({
        queryTimeoutMs: expect.any(Number),
        signal: expect.any(Object)
      })
    );
    const remainingMs = (searchActiveGamingKnowledgeMock.mock.calls[0][1] as { queryTimeoutMs: number }).queryTimeoutMs;
    expect(remainingMs).toBeGreaterThan(0);
    expect(remainingMs).toBeLessThanOrEqual(1000);
    expect(result.context).toContain('[Source 3]');
    expect(result.context).toContain('Published: 2026-08-07T12:00:00.000Z');
    expect(result.sources).toEqual([
      expect.objectContaining({
        sourceId: '019fe3cd-8c01-7f01-8d2d-caa951bc4ba0',
        patchVersion: '1.2',
        verifiedPatchVersion: '1.2',
        fetchedAt: '2026-08-08T12:00:00.000Z',
        publishedAt: '2026-08-07T12:00:00.000Z'
      })
    ]);
  });

  it('returns the matching deep guide passage instead of the first 1200 characters', async () => {
    const passage = 'The luminous observatory gate opens after activating the azure prism beside the eastern waterfall.';
    searchActiveGamingKnowledgeMock.mockResolvedValue([{
      recordId: 'stored-passage', revisionId: 'revision-passage', recordType: 'guide', relevance: 0.75,
      sourceId: '019fe3cd-8c01-7f01-8d2d-caa951bc4ba0',
      publicUrl: 'https://example.com/generic-guide', title: 'Progression Guide', sourceType: 'supplied',
      patch: null, revisionPatch: null, fetchedAt: new Date('2026-08-08T12:00:00.000Z'), publishedAt: null,
      searchText: 'How do I find the route in this guide and what should I do? '.repeat(200) + passage,
      normalized: {}, provenance: {}
    }]);
    const result = await buildStoredGamingKnowledgeContext({
      game: 'Borderlands 4', prompt: 'How do I open the luminous observatory gate?', mode: 'guide'
    });
    expect(result.context).toContain(passage);
    expect(result.sources[0].snippet).toContain(passage);
    expect(result.sources[0].snippet.length).toBeLessThanOrEqual(1_200);
  });

  it('does not project an unverified historical patch claim as source metadata or prompt context', async () => {
    searchActiveGamingKnowledgeMock.mockResolvedValue([{
      recordId: 'stored-patch', revisionId: 'revision-patch', recordType: 'guide', relevance: 0.75,
      sourceId: '019fe3cd-8c01-7f01-8d2d-caa951bc4ba0',
      publicUrl: 'https://example.com/generic-guide',
      title: 'Generic Guide',
      sourceType: 'supplied',
      patch: '9.9',
      revisionPatch: '9.9',
      fetchedAt: new Date('2026-08-08T12:00:00.000Z'),
      publishedAt: null,
      searchText: 'Generic progression guide with equipment recommendations',
      normalized: { summary: 'Generic progression guide' },
      provenance: {
        claimedPatchVersion: '9.9',
        verifiedPatchVersion: null,
        patchVerificationMethod: null
      }
    }]);

    const result = await buildStoredGamingKnowledgeContext({
      game: 'Borderlands 4',
      prompt: 'What equipment recommendations should I use?',
      mode: 'guide'
    });

    expect(result.context).not.toContain('Patch:');
    expect(result.sources[0]).not.toHaveProperty('patchVersion');
    expect(result.sources[0]).not.toHaveProperty('verifiedPatchVersion');
  });

  it('load-sheds excess stored lookups and releases admission slots', async () => {
    let releaseLookups: ((records: unknown[]) => void) | undefined;
    const blockedLookup = new Promise<unknown[]>((resolve) => {
      releaseLookups = resolve;
    });
    searchActiveGamingKnowledgeMock.mockImplementation(() => blockedLookup);
    const lookupInput = {
      game: 'Borderlands 4',
      prompt: 'Where is the Zephyrglass Compass?',
      mode: 'guide' as const,
      queryTimeoutMs: 250
    };
    const admitted = Array.from({ length: 4 }, () =>
      buildStoredGamingKnowledgeContext(lookupInput)
    );
    await Promise.resolve();

    await expect(
      buildStoredGamingKnowledgeContext(lookupInput)
    ).resolves.toEqual({ context: '', sources: [] });
    expect(searchActiveGamingKnowledgeMock).toHaveBeenCalledTimes(4);

    releaseLookups?.([]);
    await expect(Promise.all(admitted)).resolves.toEqual(
      Array.from({ length: 4 }, () => ({ context: '', sources: [], sourceKnown: true }))
    );
    await expect(
      buildStoredGamingKnowledgeContext(lookupInput)
    ).resolves.toEqual({ context: '', sources: [], sourceKnown: true });
    expect(searchActiveGamingKnowledgeMock).toHaveBeenCalledTimes(5);
  });
});
