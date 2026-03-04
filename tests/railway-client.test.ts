import { describe, it, expect, beforeAll, beforeEach, afterEach, jest } from '@jest/globals';
import { deployService, isRailwayApiConfigured, listProjects } from '../src/services/railwayClient.js';

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
    jest.useRealTimers();
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

  it('wraps low-level fetch failures with RailwayApiError context', async () => {
    process.env.RAILWAY_API_TOKEN = 'test-token-1234567890-railway-access';

    const fetchSpy = jest.fn().mockRejectedValue(new Error('connect ECONNRESET'));
    global.fetch = fetchSpy;

    await expect(deployService({ serviceId: 'svc-1' })).rejects.toThrow(/Railway API request failed/i);
  });

  it('aborts requests that exceed the configured timeout', async () => {
    process.env.RAILWAY_API_TOKEN = 'test-token-1234567890-railway-access';
    jest.useFakeTimers();

    const fetchSpy = jest.fn().mockImplementation((_url: string, init?: RequestInit) => (
      new Promise((_resolve, reject) => {
        const signal = init?.signal as AbortSignal | undefined;
        if (!signal) {
          return;
        }

        if (signal.aborted) {
          const abortError = new Error('Aborted');
          abortError.name = 'AbortError';
          reject(abortError);
          return;
        }

        const listener = () => {
          const abortError = new Error('Aborted');
          abortError.name = 'AbortError';
          reject(abortError);
        };

        if (typeof (signal as any).addEventListener === 'function') {
          (signal as any).addEventListener('abort', listener, { once: true });
        } else {
          (signal as any).onabort = listener;
        }
      })
    ));

    global.fetch = fetchSpy as unknown as typeof fetch;

    const pending = deployService({ serviceId: 'svc-timeout' });

    jest.runOnlyPendingTimers();

    await expect(pending).rejects.toThrow(/timed out/i);
  });

  it('falls back to root projects query when viewer field is unsupported', async () => {
    process.env.RAILWAY_API_TOKEN = 'test-token-1234567890-railway-access';

    const fetchSpy = jest.fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({
          errors: [{ message: 'Cannot query field "viewer" on type "Query".' }]
        })
      } as any)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({
          data: {
            projects: {
              edges: [
                {
                  node: {
                    id: 'proj-1',
                    name: 'Project One',
                    environments: [
                      {
                        id: 'env-1',
                        name: 'production',
                        services: [
                          {
                            id: 'svc-1',
                            name: 'api',
                            latestDeployment: {
                              id: 'dep-1',
                              status: 'SUCCESS',
                              createdAt: '2026-03-04T00:00:00.000Z'
                            }
                          }
                        ]
                      }
                    ]
                  }
                }
              ]
            }
          }
        })
      } as any);

    global.fetch = fetchSpy;

    const projects = await listProjects();

    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(projects).toHaveLength(1);
    expect(projects[0]).toMatchObject({
      id: 'proj-1',
      name: 'Project One'
    });
  });

  it('does not retry listProjects for non-schema GraphQL failures', async () => {
    process.env.RAILWAY_API_TOKEN = 'test-token-1234567890-railway-access';

    const fetchSpy = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        errors: [{ message: 'Unauthorized' }]
      })
    } as any);

    global.fetch = fetchSpy;

    await expect(listProjects()).rejects.toThrow(/Unauthorized/i);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});
