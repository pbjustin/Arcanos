import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import express from 'express';
import request from 'supertest';
import Ajv2020 from 'ajv/dist/2020.js';
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import {
  gamingArchiveGuideUrl, gamingArchiveStorageHost, gamingArchiveDerivativePath,
  gamingArchiveGuideText, gamingArchiveMetadata, gamingArchiveLandingHtml,
} from './testUtils/gamingArchiveFixtures.js';

const mockAxiosGet = jest.fn();
const mockProvider = jest.fn();
const mockStoredContext = jest.fn();
const mockRouteGptRequest = jest.fn();
const mockResolveGptRouting = jest.fn();

jest.unstable_mockModule('axios', () => ({ default: { get: mockAxiosGet } }));
jest.unstable_mockModule('node:dns/promises', () => ({
  Resolver: class {
    async resolve4() { return ['93.184.216.34']; }
    async resolve6() { return []; }
    cancel() {}
  },
}));
jest.unstable_mockModule('@core/logic/trinityWritingPipeline.js', () => ({
  runTrinityWritingPipeline: mockProvider,
  applyTrinityGenerationInvariant: jest.fn(() => { throw new Error('Unexpected non-Gaming invocation'); }),
}));
jest.unstable_mockModule('@services/openai/clientBridge.js', () => ({
  getOpenAIClientOrAdapter: () => ({ client: {} }),
  requireOpenAIClientOrAdapter: jest.fn(() => { throw new Error('Unexpected direct provider invocation'); }),
}));
jest.unstable_mockModule('@services/gamingSourceIngestion.js', () => ({ buildStoredGamingKnowledgeContext: mockStoredContext }));
jest.unstable_mockModule('@services/hrcWrapper.js', () => ({ evaluateWithHRC: jest.fn() }));
// The HTTP routing seam forwards to the real Gaming module below; no registry or persistent effects run.
jest.unstable_mockModule('../src/routes/_core/gptDispatch.js', () => ({
  resolveGptRouting: mockResolveGptRouting, routeGptRequest: mockRouteGptRequest,
}));
jest.unstable_mockModule('../src/platform/logging/gptLogger.js', () => ({
  logGptConnection: jest.fn(), logGptConnectionFailed: jest.fn(), logGptAckSent: jest.fn(),
}));
jest.unstable_mockModule('../src/services/systemState.js', () => ({
  executeSystemStateRequest: jest.fn(), SystemStateConflictError: class extends Error {},
}));

const { ArcanosGaming } = await import('../src/services/arcanos-gaming.js');
const { clearGamingRagCache } = await import('../src/services/gamingWebContext.js');
const { logger } = await import('../src/platform/logging/structuredLogging.js');
const { default: requestContext } = await import('../src/middleware/requestContext.js');
const { default: gptRouter } = await import('../src/routes/gptRouter.js');
const { default: errorHandler } = await import('../src/transport/http/middleware/errorHandler.js');

const contract = JSON.parse(readFileSync(join(process.cwd(), 'contracts/arcanos_gaming.openapi.v1.json'), 'utf8'));
const ajv = new Ajv2020({ strict: false, validateFormats: false });
ajv.addSchema(contract, 'gaming-archive-http');
const validateResponse = ajv.getSchema('gaming-archive-http#/components/schemas/GamingPublicResponse')!;
const envValues = {
  ARCANOS_GAMING_DISCOVERY_ENABLED: 'false', ARCANOS_GAMING_RAG_ENABLED: 'true',
  ARCANOS_GAMING_WEB_CONTEXT_CHARS: '5000', ARCANOS_GAMING_RAG_CHUNK_CHARS: '900',
  ARCANOS_GAMING_RAG_MAX_CHUNKS: '6', ARCANOS_GAMING_RAG_MAX_SOURCES: '4',
  ARCANOS_GAMING_CURATED_SOURCES_JSON: '[]',
};
let previousEnv: Record<string, string | undefined>;

function app() {
  const server = express();
  server.use(requestContext);
  server.use(express.json());
  server.use('/gpt', gptRouter);
  server.use(errorHandler);
  return server;
}

function query(guideUrl = gamingArchiveGuideUrl) {
  return request(app()).post('/gpt/arcanos-gaming').send({
    action: 'query', payload: {
      mode: 'guide', game: 'Kingdom Hearts HD 1.5 Remix',
      prompt: 'Use the supplied guide to explain the lantern checkpoint route and boss preparation.', guideUrl,
    },
  });
}

describe('Archive guide document reaches the Gaming provider and HTTP envelope', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    previousEnv = Object.fromEntries(Object.keys(envValues).map(key => [key, process.env[key]]));
    Object.assign(process.env, envValues);
    clearGamingRagCache();
    jest.spyOn(console, 'log').mockImplementation(() => undefined);
    mockStoredContext.mockResolvedValue({ context: '', sources: [] });
    mockProvider.mockResolvedValue({ result: 'Save at the lantern checkpoint before the boss encounter. [1]' });
    mockResolveGptRouting.mockResolvedValue({
      ok: true, plan: {
        matchedId: 'arcanos-gaming', module: 'ARCANOS:GAMING', route: 'gaming', action: 'query',
        availableActions: ['query'], moduleVersion: null, moduleDescription: null, matchMethod: 'exact',
      },
      _route: { gptId: 'arcanos-gaming', module: 'ARCANOS:GAMING', route: 'gaming', action: 'query' },
    });
    mockRouteGptRequest.mockImplementation(async ({ body }: { body: { payload: unknown } }) => ({
      ok: true, result: await ArcanosGaming.actions.query(body.payload),
      _route: { gptId: 'arcanos-gaming', module: 'ARCANOS:GAMING', route: 'gaming', action: 'query', availableActions: ['query'] },
    }));
    mockAxiosGet.mockImplementation(async (url: string, options: { headers: { Host: string } }) => {
      const path = new URL(url).pathname;
      if (options.headers.Host === 'archive.org' && path === '/metadata/KH1.5_guide') {
        return { data: JSON.stringify(gamingArchiveMetadata()), headers: { 'content-type': 'application/json' } };
      }
      if (options.headers.Host === gamingArchiveStorageHost && path === gamingArchiveDerivativePath) {
        return { data: gamingArchiveGuideText, headers: { 'content-type': 'text/plain' } };
      }
      throw new Error('Unexpected test HTTP target');
    });
  });

  afterEach(() => {
    clearGamingRagCache();
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    jest.restoreAllMocks();
  });

  it('passes actual fetched guide paragraphs through real extraction, ranking, module, and provider context', async () => {
    const response = await query();
    expect(response.status).toBe(200);
    expect(validateResponse(response.body)).toBe(true);
    expect(response.body.result).toMatchObject({ ok: true, data: { grounding: {
      groundingStatus: 'grounded', requestedSourceCount: 1, fetchedSourceCount: 1,
      fetchedSuppliedSourceCount: 1, groundedInSuppliedEvidence: true, suppliedEvidenceSourceCount: 1,
    } } });
    expect(response.body.result.data.grounding.usableSourceCount).toBeGreaterThanOrEqual(1);
    expect(response.body.result.data.grounding.citableSourceCount).toBeGreaterThanOrEqual(1);
    expect(response.body.result.data.grounding.selectedChunkCount).toBeGreaterThanOrEqual(1);
    expect(mockProvider).toHaveBeenCalledTimes(1);
    const providerPrompt = (mockProvider.mock.calls[0][0] as { input: { prompt: string } }).input.prompt;
    expect(providerPrompt).toContain('Follow the western path to the courtyard');
    expect(providerPrompt).not.toContain('Download Options');
    expect(response.body.result.data.sources[0].url).toBe(gamingArchiveGuideUrl);
    expect(JSON.stringify(response.body)).not.toContain(gamingArchiveStorageHost);
    expect(mockAxiosGet).toHaveBeenCalledTimes(2);
    for (const [url, options] of mockAxiosGet.mock.calls) {
      expect(new URL(url as string).hostname).toBe('93.184.216.34');
      expect(options).toMatchObject({ maxRedirects: 0, proxy: false, signal: expect.any(Object) });
    }
  });

  it.each([
    gamingArchiveLandingHtml,
    gamingArchiveLandingHtml.replace('Kingdom Hearts HD 1.5 Remix.', 'Kingdom Hearts HD 1.5 Remix beginner build and weapon manual for the complete walkthrough.'),
    gamingArchiveLandingHtml.replace('Kingdom Hearts HD 1.5 Remix.', 'How to use weapons in the Kingdom Hearts HD 1.5 Remix complete walkthrough.'),
  ])('rejects metadata-only HTML before provider invocation (including long catalog titles)', async (html) => {
    mockAxiosGet.mockResolvedValue({ data: html, headers: { 'content-type': 'text/html' } });
    const successLog = jest.spyOn(logger, 'info');
    const response = await query('https://guides.example.org/kh-guide');
    expect(response.status).toBe(200);
    expect(validateResponse(response.body)).toBe(true);
    expect(response.body.result).toMatchObject({ ok: false, error: {
      code: 'GAMING_SOURCE_UNREADABLE', details: { grounding: {
        groundingStatus: 'insufficient_evidence', fetchedSuppliedSourceCount: 1,
        usableSourceCount: 0, citableSourceCount: 0, selectedChunkCount: 0, groundedInSuppliedEvidence: false,
      } },
    } });
    expect(mockProvider).not.toHaveBeenCalled();
    expect(mockStoredContext).not.toHaveBeenCalled();
    expect(successLog).not.toHaveBeenCalledWith('gaming.backend.success', expect.anything());
    expect(successLog).not.toHaveBeenCalledWith('gaming.grounding.success', expect.anything());
  });

  it.each(['malformed', '404', 'timeout', 'no_derivative', 'ambiguous_manuals'])('returns a controlled source failure for Archive %s', async (failure) => {
    if (failure === '404' || failure === 'timeout') {
      mockAxiosGet.mockRejectedValue(Object.assign(new Error('Synthetic HTTP failure'), { code: failure === 'timeout' ? 'ETIMEDOUT' : 'ERR_BAD_REQUEST' }));
    } else {
      const metadata = gamingArchiveMetadata();
      if (failure === 'no_derivative') metadata.files = [];
      if (failure === 'ambiguous_manuals') {
        metadata.files.push({ name: 'Other Manual.txt', source: 'original', format: 'Text', size: '1000' });
      }
      mockAxiosGet.mockResolvedValue({ data: failure === 'malformed' ? '{broken' : JSON.stringify(metadata), headers: { 'content-type': 'application/json' } });
    }
    const response = await query();
    expect(response.status).toBe(200);
    expect(validateResponse(response.body)).toBe(true);
    expect(response.body.result).toMatchObject({ ok: false, error: {
      code: 'GAMING_SOURCE_UNAVAILABLE', details: { grounding: {
        groundingStatus: 'unavailable', usableSourceCount: 0, citableSourceCount: 0,
        selectedChunkCount: 0, groundedInSuppliedEvidence: false,
      } },
    } });
    expect(mockProvider).not.toHaveBeenCalled();
    expect(mockAxiosGet).toHaveBeenCalledTimes(1);
  });

  it('resolves www and reader-position URLs as one case-sensitive item across cache hits', async () => {
    const first = await request(app()).post('/gpt/arcanos-gaming').send({
      action: 'query', payload: {
        mode: 'guide', game: 'Kingdom Hearts HD 1.5 Remix',
        prompt: 'Use the supplied guide to explain the lantern checkpoint route and boss preparation.',
        guideUrls: [gamingArchiveGuideUrl, 'https://www.archive.org/details/KH1.5_guide/page/n4/mode/2up'],
      },
    });
    expect(first.body.result).toMatchObject({ ok: true, data: { grounding: {
      fetchedSourceCount: 1, suppliedEvidenceSourceCount: 1, groundedInSuppliedEvidence: true,
    } } });
    const second = await query('https://www.archive.org/details/KH1.5_guide/page/n4/mode/2up');
    expect(second.body.result.error).toBeUndefined();
    expect(second.body.result).toMatchObject({ ok: true, data: { grounding: { groundedInSuppliedEvidence: true } } });
    expect(mockAxiosGet).toHaveBeenCalledTimes(2);
    expect(mockProvider).toHaveBeenCalledTimes(2);
  });
});
