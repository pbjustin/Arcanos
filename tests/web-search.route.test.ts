import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const webSearchAgentMock = jest.fn(async () => buildSearchResult());

jest.unstable_mockModule('@services/webSearchAgent.js', () => ({
  webSearchAgent: webSearchAgentMock
}));

const express = (await import('express')).default;
const request = (await import('supertest')).default;
const router = (await import('../src/routes/web-search.js')).default;

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use(router);
  return app;
}

function buildSearchResult() {
  return {
    query: 'test',
    sessionId: 'ws_test',
    searchPacketVersion: 'search-packet/v1',
    clearPolicyVersion: 'clear-2.0-web-search/v1',
    providerRequested: 'auto',
    providerUsed: 'duckduckgo-lite',
    intent: {
      query: 'test',
      queryHash: 'abc',
      providerRequested: 'auto',
      synthesize: false,
      traverseLinks: false,
      allowDomains: [],
      denyDomains: []
    },
    policy: {
      pageMaxChars: 9000,
      includePageContent: true,
      traversalDepth: 1,
      maxTraversalPages: 2,
      sameDomainOnly: true,
      traversalLinkLimit: 3
    },
    searchResults: [],
    sources: [],
    answer: null,
    notes: [],
    clear: {
      clarity: 1,
      leverage: 1,
      efficiency: 1,
      alignment: 1,
      resilience: 1,
      overall: 1,
      decision: 'allow',
      notes: 'ok'
    }
  };
}

describe('web-search route', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    webSearchAgentMock.mockResolvedValue(buildSearchResult());
  });

  it('returns validation error for missing query', async () => {
    const response = await request(buildApp()).post('/api/web/search').send({});

    expect(response.status).toBe(400);
    expect(response.body.error).toBe('Validation failed');
    expect(webSearchAgentMock).not.toHaveBeenCalled();
  });

  it('validates traversal bounds', async () => {
    const response = await request(buildApp())
      .post('/api/web/search')
      .send({ query: 'test', traversalDepth: 3 });

    expect(response.status).toBe(400);
    expect(response.body.details).toContain('traversalDepth: Number must be less than or equal to 2');
    expect(webSearchAgentMock).not.toHaveBeenCalled();
  });

  it('returns structured response with packet metadata', async () => {
    const response = await request(buildApp())
      .post('/api/web/search')
      .send({ query: 'test', traverseLinks: true });

    expect(response.status).toBe(200);
    expect(response.body.ok).toBe(true);
    expect(response.body.clear.decision).toBe('allow');
    expect(response.body.searchPacketVersion).toBe('search-packet/v1');
    expect(response.body.clearPolicyVersion).toBe('clear-2.0-web-search/v1');
    expect(webSearchAgentMock).toHaveBeenCalledWith('test', expect.objectContaining({
      traverseLinks: true
    }));
  });

  it('maps agent failures to a stable error payload', async () => {
    webSearchAgentMock.mockRejectedValueOnce(new Error('provider unavailable'));

    const response = await request(buildApp())
      .post('/api/web/search')
      .send({ query: 'test' });

    expect(response.status).toBe(500);
    expect(response.body.ok).toBe(false);
    expect(response.body.error).toBe('WEB_SEARCH_FAILED');
    expect(response.body.message).toBe('provider unavailable');
  });
});
