import { jest } from '@jest/globals';

export interface MockFetchRouteResult {
  status?: number;
  data?: unknown;
  headers?: Record<string, string>;
}

export type MockFetchRouteHandler = (url: string, init?: RequestInit) => MockFetchRouteResult | Promise<MockFetchRouteResult>;

export interface InstallMockFetchOptions {
  /**
   * Optional default handler if no route matches.
   */
  fallback?: MockFetchRouteHandler;
}

/**
 * Best-effort JSON body parser for tests.
 */
export function parseJsonBody(init?: RequestInit): Record<string, unknown> | null {
  const body = init?.body;
  if (!body || typeof body !== 'string') return null;
  try {
    return JSON.parse(body) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export function createJsonResponse(status: number, data: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json', ...headers }
  });
}

let originalFetch: typeof global.fetch | undefined;

/**
 * Installs a jest mock for global.fetch with simple route matching.
 *
 * Route matching is substring-based for convenience in tests.
 */
export function installMockFetch(
  routes: Record<string, MockFetchRouteHandler>,
  options: InstallMockFetchOptions = {}
): void {
  if (!originalFetch) {
    originalFetch = global.fetch;
  }

  global.fetch = jest.fn(async (input: any, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : (input?.url ?? String(input));
    for (const [match, handler] of Object.entries(routes)) {
      if (url.includes(match)) {
        const result = await handler(url, init);
        const status = result.status ?? 200;
        const data = result.data ?? {};
        return createJsonResponse(status, data, result.headers ?? {});
      }
    }

    if (options.fallback) {
      const result = await options.fallback(url, init);
      const status = result.status ?? 200;
      const data = result.data ?? {};
      return createJsonResponse(status, data, result.headers ?? {});
    }

    return createJsonResponse(404, { error: 'No mock route matched', url });
  }) as any;
}

export function uninstallMockFetch(): void {
  if (originalFetch) {
    global.fetch = originalFetch;
  }
}
