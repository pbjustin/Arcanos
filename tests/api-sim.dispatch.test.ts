import { type NextFunction, type Request, type Response } from 'express';
import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const mockRouteGptRequest = jest.fn();

jest.unstable_mockModule('@platform/runtime/security.js', () => ({
  createRateLimitMiddleware: () => (_req: Request, _res: Response, next: NextFunction) => next(),
  createValidationMiddleware: () => (_req: Request, _res: Response, next: NextFunction) => next()
}));

jest.unstable_mockModule('../src/routes/_core/gptDispatch.js', () => ({
  routeGptRequest: mockRouteGptRequest
}));

const { default: apiSimRouter } = await import('../src/routes/api-sim.js');

interface ApiSimTestResponse {
  status: number;
  body?: any;
  streamChunks?: string[];
  headers: Record<string, string>;
}

async function invokeApiSim(body: Record<string, unknown>): Promise<ApiSimTestResponse> {
  const normalizedHeaders: Record<string, string> = {
    'content-type': 'application/json'
  };

  const req = {
    method: 'POST',
    url: '/',
    originalUrl: '/api/sim',
    path: '/',
    headers: normalizedHeaders,
    body: { ...body },
    query: {},
    params: {},
    ip: '127.0.0.1',
    connection: { remoteAddress: '127.0.0.1' },
    header: jest.fn((name: string) => normalizedHeaders[name.toLowerCase()]),
    get: jest.fn((name: string) => normalizedHeaders[name.toLowerCase()]),
    logger: {
      debug: jest.fn(),
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn()
    },
    requestId: 'req_sim_test'
  } as unknown as Request;

  return await new Promise<ApiSimTestResponse>((resolve, reject) => {
    const responseHeaders: Record<string, string> = {};
    const streamChunks: string[] = [];
    const res = {
      statusCode: 200,
      headersSent: false,
      setHeader(field: string, value: string) {
        responseHeaders[field] = String(value);
        return this;
      },
      set(field: string | Record<string, string>, value?: string) {
        if (typeof field === 'string') {
          responseHeaders[field] = String(value ?? '');
        } else {
          for (const [headerName, headerValue] of Object.entries(field)) {
            responseHeaders[headerName] = String(headerValue);
          }
        }
        return this;
      },
      status(code: number) {
        this.statusCode = code;
        return this;
      },
      writeHead(code: number, headers: Record<string, string>) {
        this.statusCode = code;
        Object.assign(responseHeaders, headers);
        return this;
      },
      write(chunk: string) {
        streamChunks.push(chunk);
        return true;
      },
      end() {
        this.headersSent = true;
        resolve({
          status: this.statusCode,
          headers: { ...responseHeaders },
          streamChunks: [...streamChunks]
        });
        return this;
      },
      json(payload: unknown) {
        this.headersSent = true;
        resolve({
          status: this.statusCode,
          body: payload,
          headers: { ...responseHeaders }
        });
        return this;
      }
    } as unknown as Response & {
      statusCode: number;
      headersSent: boolean;
      writeHead: (code: number, headers: Record<string, string>) => void;
      write: (chunk: string) => boolean;
      end: () => void;
    };

    const next: NextFunction = (error?: unknown) => {
      if (error) {
        reject(error);
        return;
      }
      if (!(res as { headersSent: boolean }).headersSent) {
        reject(new Error('Route completed without sending a response'));
      }
    };

    (apiSimRouter as any).handle(req, res, next);
  });
}

describe('/api/sim dispatcher wiring', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('routes completed simulation requests through the dispatcher', async () => {
    mockRouteGptRequest.mockResolvedValue({
      ok: true,
      result: {
        mode: 'complete',
        scenario: 'Return exactly the text no-simulation',
        result: 'no-simulation',
        metadata: {
          model: 'ft:test-sim',
          tokensUsed: 41,
          timestamp: '2026-03-13T00:00:00.000Z',
          simulationId: 'sim_test_id'
        }
      },
      _route: {
        gptId: 'sim',
        timestamp: '2026-03-13T00:00:00.000Z'
      }
    });

    const response = await invokeApiSim({
      scenario: 'Return exactly the text no-simulation',
      context: 'Do not simulate anything.',
      parameters: {
        temperature: 0.2
      }
    });

    expect(mockRouteGptRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        gptId: 'sim',
        requestId: 'req_sim_test',
        body: {
          action: 'run',
          payload: {
            scenario: 'Return exactly the text no-simulation',
            context: 'Do not simulate anything.',
            parameters: {
              temperature: 0.2
            }
          }
        }
      })
    );
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      status: 'success',
      message: 'Simulation completed successfully',
      data: {
        scenario: 'Return exactly the text no-simulation',
        result: 'no-simulation',
        metadata: {
          model: 'ft:test-sim',
          tokensUsed: 41,
          simulationId: 'sim_test_id'
        }
      }
    });
  });

  it('streams dispatcher-backed simulation results over SSE', async () => {
    const stream = {
      async *[Symbol.asyncIterator]() {
        yield {
          choices: [{ delta: { content: 'no-' } }]
        };
        yield {
          choices: [{ delta: { content: 'simulation' } }]
        };
      }
    };

    mockRouteGptRequest.mockResolvedValue({
      ok: true,
      result: {
        mode: 'stream',
        scenario: 'Return exactly the text no-simulation',
        stream,
        metadata: {
          timestamp: '2026-03-13T00:00:00.000Z',
          simulationId: 'sim_stream_id'
        }
      },
      _route: {
        gptId: 'sim',
        timestamp: '2026-03-13T00:00:00.000Z'
      }
    });

    const response = await invokeApiSim({
      scenario: 'Return exactly the text no-simulation',
      parameters: {
        stream: true
      }
    });

    expect(response.status).toBe(200);
    expect(response.headers['Content-Type']).toBe('text/event-stream');
    expect(response.streamChunks?.join('')).toContain('no-');
    expect(response.streamChunks?.join('')).toContain('simulation');
    expect(response.streamChunks?.join('')).toContain('"type":"done"');
  });
});
