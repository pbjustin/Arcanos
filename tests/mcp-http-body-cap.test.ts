import express, { type NextFunction, type Request, type Response } from 'express';
import { request as requestHttp, type IncomingHttpHeaders } from 'node:http';
import type { AddressInfo } from 'node:net';
import { gzipSync } from 'node:zlib';
import { afterAll, beforeEach, describe, expect, it, jest } from '@jest/globals';

const MCP_HTTP_BODY_LIMIT_BYTES = 1024 * 1024;
const trackedEnvironmentNames = [
  'NODE_ENV',
  'DATABASE_URL',
  'OPENAI_API_KEY',
  'RAILWAY_OPENAI_API_KEY',
  'API_KEY',
  'OPENAI_KEY',
  'RUN_WORKERS',
  'DISABLE_EXTERNAL_CALLS',
  'DISABLE_DIAGNOSTICS_CRON',
  'MCP_HTTP_BODY_LIMIT',
  'JSON_LIMIT',
] as const;
const originalEnvironment = new Map(
  trackedEnvironmentNames.map(name => [name, process.env[name]] as const)
);

process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = '';
process.env.OPENAI_API_KEY = '';
process.env.RAILWAY_OPENAI_API_KEY = '';
process.env.API_KEY = '';
process.env.OPENAI_KEY = '';
process.env.RUN_WORKERS = 'false';
process.env.DISABLE_EXTERNAL_CALLS = 'true';
process.env.DISABLE_DIAGNOSTICS_CRON = 'true';
process.env.MCP_HTTP_BODY_LIMIT = '8mb';
process.env.JSON_LIMIT = '10mb';

const unsafeExecutionGateMock = jest.fn((
  _req: Request,
  _res: Response,
  next: NextFunction
): void => next());

jest.unstable_mockModule('@core/init-openai.js', () => ({
  initOpenAI: jest.fn(),
}));
jest.unstable_mockModule('@core/diagnostics.js', () => ({
  setupDiagnostics: jest.fn(),
  writePublicHealthResponse: jest.fn(),
}));
jest.unstable_mockModule('@services/runtimeDiagnosticsService.js', () => ({
  runtimeDiagnosticsService: {
    logStartupSummary: jest.fn(async () => undefined),
    recordRequestCompletion: jest.fn(),
  },
}));
jest.unstable_mockModule('@transport/http/middleware/unsafeExecutionGate.js', () => ({
  unsafeExecutionGate: unsafeExecutionGateMock,
}));
jest.unstable_mockModule('@transport/http/gamingIngressAudit.js', () => ({
  gamingIngressAudit: (
    _req: Request,
    _res: Response,
    next: NextFunction
  ) => next(),
}));
const request = (await import('supertest')).default;
const {
  mcpHttpBodyParser,
  resolveMcpHttpBodyLimitBytes,
} = await import('../src/mcp/httpBodyParser.js');
const { createApp } = await import('../src/app.js');

type McpHttpBodyParserModule = typeof import('../src/mcp/httpBodyParser.js');

async function importMcpHttpBodyParserWithLimit(
  limit: string,
  jsonLimit: string = '10mb'
): Promise<McpHttpBodyParserModule> {
  const previousLimit = process.env.MCP_HTTP_BODY_LIMIT;
  const previousJsonLimit = process.env.JSON_LIMIT;
  let isolatedModule: McpHttpBodyParserModule | undefined;
  process.env.MCP_HTTP_BODY_LIMIT = limit;
  process.env.JSON_LIMIT = jsonLimit;
  try {
    await jest.isolateModulesAsync(async () => {
      isolatedModule = await import('../src/mcp/httpBodyParser.js');
    });
  } finally {
    if (previousLimit === undefined) {
      delete process.env.MCP_HTTP_BODY_LIMIT;
    } else {
      process.env.MCP_HTTP_BODY_LIMIT = previousLimit;
    }
    if (previousJsonLimit === undefined) {
      delete process.env.JSON_LIMIT;
    } else {
      process.env.JSON_LIMIT = previousJsonLimit;
    }
  }

  if (!isolatedModule) {
    throw new Error('Failed to load the isolated MCP HTTP body parser module.');
  }
  return isolatedModule;
}

function jsonBodyWithByteLength(byteLength: number): string {
  const emptyBody = JSON.stringify({ padding: '' });
  if (byteLength < Buffer.byteLength(emptyBody)) {
    throw new RangeError('Requested JSON body length is too small.');
  }
  const body = JSON.stringify({
    padding: 'x'.repeat(byteLength - Buffer.byteLength(emptyBody)),
  });
  expect(Buffer.byteLength(body)).toBe(byteLength);
  return body;
}

function buildMcpParserProbeApp(parser = mcpHttpBodyParser) {
  const app = express();
  app.post('/mcp', parser, (req, res) => {
    res.status(200).json({
      ok: true,
      paddingLength: typeof req.body?.padding === 'string'
        ? req.body.padding.length
        : null,
    });
  });
  app.use((_error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    res.status(400).json({ error: 'PARSER_REJECTED' });
  });
  return app;
}

type RawHttpResponse = {
  statusCode: number;
  headers: IncomingHttpHeaders;
  body: string;
};

async function postRawBody(params: {
  bodyChunks: readonly Buffer[];
  contentEncoding?: string;
  chunked?: boolean;
}): Promise<RawHttpResponse> {
  const app = buildMcpParserProbeApp();
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });

  try {
    const address = server.address() as AddressInfo;
    return await new Promise<RawHttpResponse>((resolve, reject) => {
      const headers: Record<string, string | number> = {
        'Content-Type': 'application/json',
      };
      if (params.contentEncoding) {
        headers['Content-Encoding'] = params.contentEncoding;
      }
      if (params.chunked) {
        headers['Transfer-Encoding'] = 'chunked';
      } else {
        headers['Content-Length'] = params.bodyChunks.reduce(
          (total, chunk) => total + chunk.length,
          0
        );
      }

      const pending = requestHttp({
        hostname: '127.0.0.1',
        port: address.port,
        path: '/mcp',
        method: 'POST',
        headers,
      }, response => {
        const responseChunks: Buffer[] = [];
        response.on('data', chunk => responseChunks.push(Buffer.from(chunk)));
        response.once('end', () => {
          resolve({
            statusCode: response.statusCode ?? 0,
            headers: response.headers,
            body: Buffer.concat(responseChunks).toString('utf8'),
          });
        });
      });
      pending.once('error', reject);
      for (const chunk of params.bodyChunks) {
        pending.write(chunk);
      }
      pending.end();
    });
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve());
    });
  }
}

describe('MCP HTTP body cap in the production application composition', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it.each([
    '/mcp',
    '/mcp/',
    '/MCP?transport=stream',
  ])('rejects JSON above 1 MiB on %s before downstream application gates', async path => {
    const response = await request(createApp())
      .post(path)
      .set('Content-Type', 'application/json')
      .send(jsonBodyWithByteLength(MCP_HTTP_BODY_LIMIT_BYTES + 1));

    expect(response.status).toBe(413);
    expect(response.body).toEqual({
      error: 'MCP_REQUEST_TOO_LARGE',
      message: 'MCP request body is too large.',
    });
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.headers.pragma).toBe('no-cache');
    expect(unsafeExecutionGateMock).not.toHaveBeenCalled();
  });

  it('accepts a JSON entity exactly at the hard limit', async () => {
    const response = await request(buildMcpParserProbeApp())
      .post('/mcp')
      .set('Content-Type', 'application/json')
      .send(jsonBodyWithByteLength(MCP_HTTP_BODY_LIMIT_BYTES));

    expect(response.status).toBe(200);
    expect(response.body.ok).toBe(true);
  });

  it('rejects an oversized chunked entity without Content-Length', async () => {
    const body = Buffer.from(
      jsonBodyWithByteLength(MCP_HTTP_BODY_LIMIT_BYTES + 1),
      'utf8'
    );
    const midpoint = Math.floor(body.length / 2);
    const response = await postRawBody({
      bodyChunks: [body.subarray(0, midpoint), body.subarray(midpoint)],
      chunked: true,
    });

    expect(response.statusCode).toBe(413);
    expect(JSON.parse(response.body)).toEqual({
      error: 'MCP_REQUEST_TOO_LARGE',
      message: 'MCP request body is too large.',
    });
    expect(response.headers['cache-control']).toBe('no-store');
  });

  it('applies the limit to inflated JSON while preserving small gzip requests', async () => {
    const oversized = gzipSync(Buffer.from(
      jsonBodyWithByteLength(MCP_HTTP_BODY_LIMIT_BYTES + 1),
      'utf8'
    ));
    const rejected = await postRawBody({
      bodyChunks: [oversized],
      contentEncoding: 'gzip',
    });
    const accepted = await postRawBody({
      bodyChunks: [gzipSync(Buffer.from(JSON.stringify({ padding: 'small' })))],
      contentEncoding: 'gzip',
    });

    expect(rejected.statusCode).toBe(413);
    expect(accepted.statusCode).toBe(200);
    expect(JSON.parse(accepted.body)).toEqual({
      ok: true,
      paddingLength: 5,
    });
  });

  it('preserves malformed JSON as a 400 parser rejection', async () => {
    const response = await request(createApp())
      .post('/mcp')
      .set('Content-Type', 'application/json')
      .send('{');

    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({
      error: 'invalid request schema',
      code: 400,
    });
    expect(unsafeExecutionGateMock).not.toHaveBeenCalled();
  });

  it('preserves GET /mcp as method-not-allowed', async () => {
    const response = await request(createApp()).get('/mcp');

    expect(response.status).toBe(405);
    expect(response.headers.allow).toBe('POST');
  });

  it('does not apply the MCP cap to a neighboring JSON route', async () => {
    const response = await request(createApp())
      .post('/diag/echo')
      .set('Content-Type', 'application/json')
      .send(jsonBodyWithByteLength(MCP_HTTP_BODY_LIMIT_BYTES + 1));

    expect(response.status).toBe(200);
    expect(response.body.bodyKeys).toEqual(['padding']);
    expect(unsafeExecutionGateMock).toHaveBeenCalledTimes(1);
  });

  it.each([
    '/mcp-adjacent',
    '/gpt-access/mcp',
  ])('does not apply the MCP transport cap to %s', async path => {
    const response = await request(createApp())
      .post(path)
      .set('Content-Type', 'application/json')
      .send(jsonBodyWithByteLength(MCP_HTTP_BODY_LIMIT_BYTES + 1));

    expect(response.status).not.toBe(413);
  });

  it('keeps the configured limit downward-only and fails closed on invalid values', () => {
    expect(resolveMcpHttpBodyLimitBytes(undefined)).toBe(MCP_HTTP_BODY_LIMIT_BYTES);
    expect(resolveMcpHttpBodyLimitBytes('8mb')).toBe(MCP_HTTP_BODY_LIMIT_BYTES);
    expect(resolveMcpHttpBodyLimitBytes('512kb')).toBe(512 * 1024);
    expect(resolveMcpHttpBodyLimitBytes('1mb', '256kb')).toBe(256 * 1024);
    expect(resolveMcpHttpBodyLimitBytes('128kb', '256kb')).toBe(128 * 1024);
    expect(resolveMcpHttpBodyLimitBytes('1mb', '2048bytes')).toBe(2048);
    expect(resolveMcpHttpBodyLimitBytes('1mb', '1\u212Ab')).toBe(1);
    expect(resolveMcpHttpBodyLimitBytes('2048')).toBe(2048);
    expect(resolveMcpHttpBodyLimitBytes('0')).toBe(0);
    expect(() => resolveMcpHttpBodyLimitBytes('not-a-byte-limit')).toThrow(
      'MCP_HTTP_BODY_LIMIT must be a non-negative byte value'
    );
    expect(() => resolveMcpHttpBodyLimitBytes('-1')).toThrow(
      'MCP_HTTP_BODY_LIMIT must be a non-negative byte value'
    );
    expect(() => resolveMcpHttpBodyLimitBytes('1mb', 'not-a-byte-limit')).toThrow(
      'option limit "not-a-byte-limit" is invalid'
    );
  });

  it('constructs the parser with a valid configured limit below 1 MiB', async () => {
    const loweredLimitBytes = 512 * 1024;
    const loweredModule = await importMcpHttpBodyParserWithLimit('512kb');
    const app = buildMcpParserProbeApp(loweredModule.mcpHttpBodyParser);

    const accepted = await request(app)
      .post('/mcp')
      .set('Content-Type', 'application/json')
      .send(jsonBodyWithByteLength(loweredLimitBytes));
    const rejected = await request(app)
      .post('/mcp')
      .set('Content-Type', 'application/json')
      .send(jsonBodyWithByteLength(loweredLimitBytes + 1));

    expect(accepted.status).toBe(200);
    expect(rejected.status).toBe(413);
    expect(rejected.body).toEqual({
      error: 'MCP_REQUEST_TOO_LARGE',
      message: 'MCP request body is too large.',
    });
  });

  it('constructs a reject-all-nonempty parser for an explicit zero limit', async () => {
    const zeroLimitModule = await importMcpHttpBodyParserWithLimit('0');
    const response = await request(buildMcpParserProbeApp(
      zeroLimitModule.mcpHttpBodyParser
    ))
      .post('/mcp')
      .set('Content-Type', 'application/json')
      .send('{}');

    expect(response.status).toBe(413);
  });

  it('constructs the parser with a stricter global JSON limit', async () => {
    const globalLimitBytes = 256 * 1024;
    const globallyLimitedModule = await importMcpHttpBodyParserWithLimit(
      '1mb',
      '256kb'
    );
    const app = buildMcpParserProbeApp(globallyLimitedModule.mcpHttpBodyParser);

    const accepted = await request(app)
      .post('/mcp')
      .set('Content-Type', 'application/json')
      .send(jsonBodyWithByteLength(globalLimitBytes));
    const rejected = await request(app)
      .post('/mcp')
      .set('Content-Type', 'application/json')
      .send(jsonBodyWithByteLength(globalLimitBytes + 1));

    expect(accepted.status).toBe(200);
    expect(rejected.status).toBe(413);
  });

  it('rejects an invalid configured limit while loading the parser module', async () => {
    await expect(importMcpHttpBodyParserWithLimit('not-a-byte-limit')).rejects.toThrow(
      'MCP_HTTP_BODY_LIMIT must be a non-negative byte value'
    );
  });

  it('preserves invalid global JSON limit startup rejection', async () => {
    await expect(importMcpHttpBodyParserWithLimit(
      '1mb',
      'not-a-byte-limit'
    )).rejects.toThrow('option limit "not-a-byte-limit" is invalid');
  });
});

afterAll(() => {
  for (const [name, value] of originalEnvironment) {
    if (value === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = value;
    }
  }
});
