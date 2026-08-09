import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const findOrCreateGptJobMock = jest.fn();
const getJobByIdMock = jest.fn();
const persistGamingSourceRevisionMock = jest.fn();
const getGamingSourceByIdMock = jest.fn();
const searchActiveGamingKnowledgeMock = jest.fn();
const fetchAndCleanDocumentMock = jest.fn();
const planAutonomousWorkerJobMock = jest.fn();
const ingestGamingBuildResourceMock = jest.fn();

let createGamingSourceIngestion: typeof import('../src/services/gamingSourceIngestion.js').createGamingSourceIngestion;
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
  fetchAndCleanDocumentMock.mockReset();
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
  fetchAndCleanDocumentMock.mockImplementation(async (
    _url: string,
    _maxChars: number,
    options: {
      onRawDocument?: (value: { body: string; contentType: string; truncated: boolean }) => void;
      onExtraction?: (value: Record<string, unknown>) => void;
    }
  ) => {
    options.onRawDocument?.({
      body: '<html><title>Borderlands 4 Endgame Build</title><body>Useful guide</body></html>',
      contentType: 'text/html',
      truncated: false
    });
    options.onExtraction?.({
      documentTitle: 'Borderlands 4 Endgame Build',
      headingText: 'Endgame Build',
      cleanedTextLength: 500
    });
    return {
      text: 'Borderlands 4 endgame build equipment skills rotation '.repeat(12),
      links: [],
      combined: ''
    };
  });
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
    persistGamingSourceRevision: persistGamingSourceRevisionMock,
    getGamingSourceById: getGamingSourceByIdMock,
    searchActiveGamingKnowledge: searchActiveGamingKnowledgeMock
  }));
  jest.unstable_mockModule('../src/shared/webFetcher.js', () => ({
    fetchAndCleanDocument: fetchAndCleanDocumentMock
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
    executeQueuedGamingSourceIngestion,
    getGamingSourceIngestionStatus,
    buildStoredGamingKnowledgeContext
  } = await import('../src/services/gamingSourceIngestion.js'));
});

describe('gaming source ingestion', () => {
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
      input: { body: { sources: Array<{ canonicalUrl: string }> } };
    };
    expect(queuedInput.input.body.sources).toHaveLength(1);
    expect(queuedInput.input.body.sources[0].canonicalUrl).toBe(
      'https://mobalytics.gg/borderlands-4/builds'
    );
    expect(JSON.stringify(queuedInput)).not.toContain('utm_source');
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
        payloadHash: expect.stringMatching(/^[a-f0-9]{64}$/)
      })]
    }));
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

  it('returns bounded stored knowledge with source provenance', async () => {
    searchActiveGamingKnowledgeMock.mockResolvedValue([{
      sourceId: '019fe3cd-8c01-7f01-8d2d-caa951bc4ba0',
      publicUrl: 'https://mobalytics.gg/borderlands-4/builds',
      title: 'Endgame Build',
      sourceType: 'supplied',
      patch: '1.2',
      revisionPatch: '1.2',
      fetchedAt: new Date('2026-08-08T12:00:00.000Z'),
      searchText: 'Endgame Build with Test Weapon'
    }]);

    const result = await buildStoredGamingKnowledgeContext({
      game: 'Borderlands 4',
      prompt: 'What is the endgame build?',
      mode: 'build',
      sourceIndexOffset: 2
    });

    expect(searchActiveGamingKnowledgeMock).toHaveBeenCalledWith(expect.objectContaining({
      gameKey: 'borderlands-4',
      mode: 'build'
    }));
    expect(result.context).toContain('[Source 3]');
    expect(result.sources).toEqual([
      expect.objectContaining({
        sourceId: '019fe3cd-8c01-7f01-8d2d-caa951bc4ba0',
        patchVersion: '1.2',
        fetchedAt: '2026-08-08T12:00:00.000Z'
      })
    ]);
  });
});
