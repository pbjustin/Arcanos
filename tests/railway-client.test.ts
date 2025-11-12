import { describe, it, expect, beforeAll, beforeEach, afterEach, jest } from '@jest/globals';
import { deployService, isRailwayApiConfigured } from '../src/services/railwayClient.js';

const ORIGINAL_TOKEN = process.env.RAILWAY_API_TOKEN;
let originalFetch: typeof fetch | undefined;

describe('railwayClient', () => {
  beforeAll(() => {
    originalFetch = global.fetch;
  });

  beforeEach(() => {
    delete process.env.RAILWAY_API_TOKEN;
  });

  afterEach(() => {
    jest.restoreAllMocks();
    if (ORIGINAL_TOKEN) {
      process.env.RAILWAY_API_TOKEN = ORIGINAL_TOKEN;
    } else {
      delete process.env.RAILWAY_API_TOKEN;
    }
    if (originalFetch) {
      global.fetch = originalFetch;
    } else {
      // @ts-expect-error - allow cleanup when fetch was not originally defined
      delete global.fetch;
    }
  });

  it('detects when the management token is not configured', () => {
    expect(isRailwayApiConfigured()).toBe(false);
  });

  it('throws a helpful error when attempting to deploy without a token', async () => {
    await expect(deployService({ serviceId: 'service-123' })).rejects.toThrow(/token/i);
  });

  it('sends authorized GraphQL request when token is present', async () => {
    process.env.RAILWAY_API_TOKEN = 'test-token-1234567890-railway-access';

    const mockResponse = {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        data: {
          deployService: {
            id: 'deployment-abc',
            status: 'DEPLOYING'
          }
        }
      })
    } as any;

    const fetchSpy = jest.fn().mockResolvedValue(mockResponse);
    global.fetch = fetchSpy;

    const result = await deployService({ serviceId: 'service-123', branch: 'main' });

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [, requestInit] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(requestInit.headers).toMatchObject({ Authorization: 'Bearer test-token-1234567890-railway-access' });

    expect(result).toEqual({ deploymentId: 'deployment-abc', status: 'DEPLOYING' });
  });
});
