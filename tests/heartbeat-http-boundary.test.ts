import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { Readable } from 'node:stream';

import express from 'express';
import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it, jest } from '@jest/globals';

import { logger } from '../src/platform/logging/structuredLogging.js';
import { PURPOSE_BOUND_CREDENTIAL_ENV_NAMES } from '../src/shared/security/purposeBoundCredential.js';

const controlPlaneToken = 'heartbeat-boundary-token-for-offline-tests-1234567890';
const environmentNames = [
  ...PURPOSE_BOUND_CREDENTIAL_ENV_NAMES,
  'ARCANOS_CONTROL_PLANE_PRINCIPAL_ID',
  'ARCANOS_CONTROL_PLANE_SCOPES',
  'ALLOW_ALL_GPTS',
  'TRUSTED_GPT_IDS',
];
const originalEnvironment = new Map(environmentNames.map((name) => [name, process.env[name]]));
process.env.ALLOW_ALL_GPTS = 'false';
process.env.TRUSTED_GPT_IDS = '';

const { default: heartbeatRouter } = await import('../src/routes/heartbeat.js');
const { HEARTBEAT_BODY_LIMIT_BYTES, createHeartbeatHttpBoundary } = await import(
  '../src/services/controlPlane/heartbeatHttpBoundary.js'
);

const authenticationEnvironment = Object.freeze({
  ARCANOS_CONTROL_PLANE_ACCESS_TOKEN: controlPlaneToken,
  ARCANOS_CONTROL_PLANE_PRINCIPAL_ID: 'operator:heartbeat-offline-tests',
  ARCANOS_CONTROL_PLANE_SCOPES: 'mcp:invoke',
}) as NodeJS.ProcessEnv;
const validHeartbeat = {
  timestamp: '2026-10-02T04:24:33.000Z',
  mode: 'online',
  payload: {
    write_override: false,
    db_write_enable: true,
    suppression_level: 'normal',
    confirmation: 'operator-confirmed',
  },
};
const expectedMessage = 'Heartbeat acknowledged. Mode: online, write operations enabled, '
  + 'suppression level: normal. Confirmation: operator-confirmed.';

function buildApp(options: {
  authenticationEnvironment?: NodeJS.ProcessEnv;
  maxRequests?: number;
  standalone?: boolean;
  repeatBoundary?: boolean;
  logEntries?: unknown[][];
  throwOnLog?: boolean;
} = {}): express.Express {
  const app = express();
  app.set('trust proxy', true);
  if (options.logEntries || options.throwOnLog) {
    app.use((req, _res, next) => {
      req.logger = {
        info: (event: string, details?: unknown): void => {
          if (options.throwOnLog) {
            throw new Error('Synthetic telemetry failure');
          }
          options.logEntries?.push([event, details]);
        },
        warn: (): void => undefined,
        error: (): void => undefined,
      } as typeof req.logger;
      next();
    });
  }
  if (!options.standalone) {
    const boundary = createHeartbeatHttpBoundary({
      authenticationEnvironment: options.authenticationEnvironment ?? authenticationEnvironment,
      maxRequests: options.maxRequests ?? 100,
      windowMs: 60_000,
    });
    app.post('/heartbeat', boundary);
    if (options.repeatBoundary) {
      app.post('/heartbeat', boundary);
    }
    app.use(express.json({ limit: '10mb' }));
  }
  app.use('/', heartbeatRouter);
  app.get('/health', (_req, res) => res.status(200).json({ status: 'ok' }));
  app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status((error as { status?: number }).status ?? 500).json({ code: 'BROAD_PARSER_REJECTED' });
  });
  return app;
}

function authenticatedPost(app: express.Express) {
  return request(app).post('/heartbeat').set('Authorization', `Bearer ${controlPlaneToken}`);
}

function paddedHeartbeat(byteLength: number): string {
  const serialized = JSON.stringify(validHeartbeat);
  return serialized + ' '.repeat(byteLength - Buffer.byteLength(serialized));
}

async function sendChunkedHeartbeat(app: express.Express, body: string) {
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Expected a local TCP test listener');
  }
  try {
    return await new Promise<{ status: number; body: unknown }>((resolve, reject) => {
      const pending = httpRequest({
        hostname: '127.0.0.1',
        port: address.port,
        path: '/heartbeat',
        method: 'POST',
        headers: {
          Authorization: `Bearer ${controlPlaneToken}`,
          'Content-Type': 'application/json',
          'Transfer-Encoding': 'chunked',
          'X-Confirmed': 'yes',
        },
      }, (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.on('error', reject);
        response.on('end', () => {
          try {
            resolve({
              status: response.statusCode ?? 0,
              body: JSON.parse(Buffer.concat(chunks).toString('utf8')),
            });
          } catch (error) {
            reject(error);
          }
        });
      });
      pending.on('error', reject);
      pending.write(body.slice(0, 97));
      pending.write(body.slice(97, 2048));
      pending.end(body.slice(2048));
    });
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  }
}

describe('heartbeat HTTP ingress boundary', () => {
  beforeEach(() => {
    for (const name of PURPOSE_BOUND_CREDENTIAL_ENV_NAMES) {
      delete process.env[name];
    }
    process.env.ARCANOS_CONTROL_PLANE_ACCESS_TOKEN = controlPlaneToken;
    process.env.ARCANOS_CONTROL_PLANE_PRINCIPAL_ID = 'operator:heartbeat-offline-tests';
    process.env.ARCANOS_CONTROL_PLANE_SCOPES = 'mcp:invoke';
    jest.spyOn(console, 'log').mockImplementation(() => undefined);
  });

  it.each([
    ['missing authentication', authenticationEnvironment, undefined, 401, 'CONTROL_PLANE_AUTH_REQUIRED'],
    ['invalid bearer', authenticationEnvironment, 'Bearer invalid-offline-test-token', 401, 'CONTROL_PLANE_AUTH_REQUIRED'],
    ['unavailable configuration', Object.freeze({}), undefined, 503, 'CONTROL_PLANE_AUTH_UNAVAILABLE'],
    ['read-only scope', Object.freeze({ ...authenticationEnvironment, ARCANOS_CONTROL_PLANE_SCOPES: 'arcanos:read' }), `Bearer ${controlPlaneToken}`, 403, 'CONTROL_PLANE_SCOPE_DENIED'],
  ])('rejects %s without reading the body stream', (_name, environment, authorization, status, code) => {
    let readCalls = 0;
    const unreadBody = new Readable({ read(): void { readCalls += 1; } });
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      'content-length': String(10 * 1024 * 1024),
      'x-confirmed': 'yes',
      ...(authorization ? { authorization: String(authorization) } : {}),
    };
    const req = Object.assign(unreadBody, {
      method: 'POST',
      url: '/heartbeat',
      originalUrl: '/heartbeat',
      headers,
      rawHeaders: Object.entries(headers).flat(),
      get: (name: string) => headers[name.toLowerCase()],
      header: (name: string) => headers[name.toLowerCase()],
    }) as unknown as express.Request;
    let responseBody: unknown;
    let responseStatus = 0;
    const res = {
      set: (): unknown => res,
      setHeader: (): unknown => res,
      status: (value: number): unknown => { responseStatus = value; return res; },
      json: (value: unknown): unknown => { responseBody = value; return res; },
    } as unknown as express.Response;
    const next = jest.fn();

    createHeartbeatHttpBoundary({ authenticationEnvironment: environment as NodeJS.ProcessEnv })(req, res, next);

    expect(responseStatus).toBe(status);
    expect(responseBody).toEqual(expect.objectContaining({ error: expect.objectContaining({ code }) }));
    expect(next).not.toHaveBeenCalled();
    expect(readCalls).toBe(0);
    expect(unreadBody.listenerCount('data')).toBe(0);
    expect(unreadBody.listenerCount('readable')).toBe(0);
    unreadBody.destroy();
  });

  it.each(['{"timestamp":', paddedHeartbeat(HEARTBEAT_BODY_LIMIT_BYTES + 1)])(
    'rejects unauthenticated malformed or oversized HTTP input before broad parsing', async (body) => {
      const response = await request(buildApp()).post('/heartbeat')
        .set('X-Confirmed', 'yes').set('Content-Type', 'application/json').send(body);

      expect(response.status).toBe(401);
      expect(response.body.error.code).toBe('CONTROL_PLANE_AUTH_REQUIRED');
      expect(response.body.code).not.toBe('BROAD_PARSER_REJECTED');
      expect(response.headers['x-confirmation-challenge']).toBeUndefined();
      expect(response.headers['cache-control']).toBe('no-store');
    }
  );

  it.each(['/HeArTbEaT', '/heartbeat/'])('protects Express-compatible path %s before broad parsing', async (path) => {
    const app = buildApp();
    const denied = await request(app).post(path).set('X-Confirmed', 'yes')
      .set('Content-Type', 'application/json').send(paddedHeartbeat(HEARTBEAT_BODY_LIMIT_BYTES + 1));
    const accepted = await request(app).post(path).set('Authorization', `Bearer ${controlPlaneToken}`)
      .set('X-Confirmed', 'yes').send(validHeartbeat);

    expect(denied.status).toBe(401);
    expect(denied.body.error.code).toBe('CONTROL_PLANE_AUTH_REQUIRED');
    expect(denied.body.code).not.toBe('BROAD_PARSER_REJECTED');
    expect(accepted.status).toBe(200);
    expect(accepted.body).toEqual({ message: expectedMessage });
  });

  it('preserves the valid acknowledgement while requiring authentication and confirmation', async () => {
    const logEntries: unknown[][] = [];
    const app = buildApp({ logEntries });
    const pending = await authenticatedPost(app).send(validHeartbeat);
    expect(pending.status).toBe(403);
    expect(pending.body.confirmationRequired).toBe(true);
    expect(logEntries).toEqual([]);

    const response = await authenticatedPost(app)
      .set('X-Confirmed', `token:${pending.headers['x-confirmation-challenge']}`).send(validHeartbeat);

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ message: expectedMessage });
    expect(response.headers['cache-control']).toBe('no-store');
    expect(logEntries).toEqual([['heartbeat.received', { writeOverride: false, dbWriteEnabled: true }]]);
    expect(Object.isFrozen(authenticationEnvironment)).toBe(true);
  });

  it.each([
    ['malformed JSON', '{"private_body_sentinel":', 'application/json', undefined, 400],
    ['malformed vendor JSON', '{"private_body_sentinel":', 'application/heartbeat+json', undefined, 400],
    ['a scalar body', '"private_body_sentinel"', 'application/json', undefined, 400],
    ['compressed content', '{}', 'application/json', 'gzip', 415],
    ['a non-JSON media type', '{}', 'text/plain', undefined, 415],
  ])('returns a fixed error for %s', async (_name, body, contentType, encoding, status) => {
    const pending = authenticatedPost(buildApp()).set('X-Confirmed', 'yes').set('Content-Type', String(contentType));
    if (encoding) {
      pending.set('Content-Encoding', String(encoding));
    }
    const response = await pending.send(body);

    expect(response.status).toBe(status);
    expect(response.body.error.code).toBe('HEARTBEAT_REQUEST_INVALID');
    expect(JSON.stringify(response.body)).not.toContain('private_body_sentinel');
    expect(response.headers['x-confirmation-challenge']).toBeUndefined();
    expect(response.body.code).not.toBe('BROAD_PARSER_REJECTED');
  });

  it('accepts JSON suffix media types with the same strict payload contract', async () => {
    const response = await authenticatedPost(buildApp()).set('X-Confirmed', 'yes')
      .set('Content-Type', 'application/heartbeat+json').send(JSON.stringify(validHeartbeat));

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ message: expectedMessage });
  });

  it('admits exactly 4 KiB and rejects one byte over for known-length bodies', async () => {
    expect(HEARTBEAT_BODY_LIMIT_BYTES).toBe(4096);
    const app = buildApp();
    const exact = await authenticatedPost(app).set('X-Confirmed', 'yes')
      .set('Content-Type', 'application/json').send(paddedHeartbeat(HEARTBEAT_BODY_LIMIT_BYTES));
    const oversized = await authenticatedPost(app).set('X-Confirmed', 'yes')
      .set('Content-Type', 'application/json').send(paddedHeartbeat(HEARTBEAT_BODY_LIMIT_BYTES + 1));

    expect(exact.status).toBe(200);
    expect(exact.body).toEqual({ message: expectedMessage });
    expect(oversized.status).toBe(413);
    expect(oversized.body.error.code).toBe('HEARTBEAT_REQUEST_INVALID');
    expect(oversized.body.code).not.toBe('BROAD_PARSER_REJECTED');
  });

  it('enforces the same inclusive cap on chunked bodies without Content-Length', async () => {
    const app = buildApp();
    const exact = await sendChunkedHeartbeat(app, paddedHeartbeat(HEARTBEAT_BODY_LIMIT_BYTES));
    const oversized = await sendChunkedHeartbeat(app, paddedHeartbeat(HEARTBEAT_BODY_LIMIT_BYTES + 1));

    expect(exact).toEqual({ status: 200, body: { message: expectedMessage } });
    expect(oversized.status).toBe(413);
    expect(oversized.body).toEqual(expect.objectContaining({
      error: expect.objectContaining({ code: 'HEARTBEAT_REQUEST_INVALID' }),
    }));
  });

  it.each([
    ['an extra top-level field', { ...validHeartbeat, private_body_sentinel: 'discard-me' }],
    ['an extra payload field', { ...validHeartbeat, payload: { ...validHeartbeat.payload, private_body_sentinel: 'discard-me' } }],
    ['an array body', [validHeartbeat]],
    ['a missing timestamp', { mode: validHeartbeat.mode, payload: validHeartbeat.payload }],
    ['an invalid timestamp', { ...validHeartbeat, timestamp: 'yesterday' }],
    ['a non-boolean write override', { ...validHeartbeat, payload: { ...validHeartbeat.payload, write_override: 'false' } }],
    ['a non-boolean database flag', { ...validHeartbeat, payload: { ...validHeartbeat.payload, db_write_enable: 1 } }],
    ['an oversized mode', { ...validHeartbeat, mode: 'x'.repeat(65) }],
    ['a mode containing a newline', { ...validHeartbeat, mode: 'online\nforged-log' }],
    ['an oversized suppression level', { ...validHeartbeat, payload: { ...validHeartbeat.payload, suppression_level: 'x'.repeat(65) } }],
    ['an oversized confirmation', { ...validHeartbeat, payload: { ...validHeartbeat.payload, confirmation: 'x'.repeat(129) } }],
    ['a non-ASCII confirmation', { ...validHeartbeat, payload: { ...validHeartbeat.payload, confirmation: '確認' } }],
  ])('rejects %s before confirmation or telemetry', async (_name, body) => {
    const logEntries: unknown[][] = [];
    const response = await authenticatedPost(buildApp({ logEntries })).send(body);

    expect(response.status).toBe(400);
    expect(JSON.stringify(response.body)).not.toContain('private_body_sentinel');
    expect(response.headers['x-confirmation-challenge']).toBeUndefined();
    expect(logEntries).toEqual([]);
  });

  it('limits the authenticated principal across caller-selected addresses and identities', async () => {
    const app = buildApp({ maxRequests: 1 });
    const first = await authenticatedPost(app).set('X-Confirmed', 'yes')
      .set('X-Forwarded-For', '198.51.100.1').set('X-Session-ID', 'caller-session-one')
      .set('X-Client-ID', 'caller-one').send(validHeartbeat);
    const second = await authenticatedPost(app).set('X-Confirmed', 'yes')
      .set('X-Forwarded-For', '198.51.100.2').set('X-Session-ID', 'caller-session-two')
      .set('X-Client-ID', 'caller-two').set('Content-Type', 'application/json').send('{"timestamp":');

    expect(first.status).toBe(200);
    expect(first.headers['x-ratelimit-remaining']).toBe('0');
    expect(second.status).toBe(429);
    expect(second.headers['x-ratelimit-bucket']).toBe('heartbeat-principal');
    expect(Number(second.headers['retry-after'])).toBeGreaterThan(0);
    expect(second.headers['x-confirmation-challenge']).toBeUndefined();
  });

  it('does not charge invalid bearers against the authenticated principal limit', async () => {
    const app = buildApp({ maxRequests: 1 });
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const denied = await request(app).post('/heartbeat').set('Authorization', 'Bearer invalid-offline-test-token')
        .set('X-Confirmed', 'yes').send(validHeartbeat);
      expect(denied.status).toBe(401);
    }
    const accepted = await authenticatedPost(app).set('X-Confirmed', 'yes').send(validHeartbeat);
    expect(accepted.status).toBe(200);
  });

  it('charges quota once when the same boundary and the router boundary run together', async () => {
    const app = buildApp({ maxRequests: 1, repeatBoundary: true });
    const accepted = await authenticatedPost(app).set('X-Confirmed', 'yes').send(validHeartbeat);
    const throttled = await authenticatedPost(app).set('X-Confirmed', 'yes').send(validHeartbeat);

    expect(accepted.status).toBe(200);
    expect(accepted.headers['x-ratelimit-remaining']).toBe('0');
    expect(throttled.status).toBe(429);
  });

  it('keeps the standalone router protected and parses its valid bounded JSON body', async () => {
    const app = buildApp({ standalone: true });
    const denied = await request(app).post('/heartbeat').set('X-Confirmed', 'yes')
      .set('Content-Type', 'application/json').send('{"timestamp":');
    const accepted = await authenticatedPost(app).set('X-Confirmed', 'yes').send(validHeartbeat);

    expect(denied.status).toBe(401);
    expect(denied.body.error.code).toBe('CONTROL_PLANE_AUTH_REQUIRED');
    expect(accepted.status).toBe(200);
    expect(accepted.body).toEqual({ message: expectedMessage });
  });

  it('bounds accepted telemetry to booleans even when every text field is at its limit', async () => {
    const logEntries: unknown[][] = [];
    const response = await authenticatedPost(buildApp({ logEntries })).set('X-Confirmed', 'yes').send({
      timestamp: validHeartbeat.timestamp,
      mode: 'm'.repeat(64),
      payload: {
        write_override: true,
        db_write_enable: false,
        suppression_level: 's'.repeat(64),
        confirmation: 'c'.repeat(128),
      },
    });

    expect(response.status).toBe(200);
    expect(logEntries).toEqual([['heartbeat.received', { writeOverride: true, dbWriteEnabled: false }]]);
    expect(Buffer.byteLength(JSON.stringify(logEntries))).toBeLessThan(128);
    const routeSource = readFileSync(new URL('../src/routes/heartbeat.ts', import.meta.url), 'utf8');
    expect(routeSource).not.toMatch(/(?:appendFileSync|writeFileSync|mkdirSync|existsSync)/u);
    expect(routeSource).not.toMatch(/from\s+['"](?:node:)?fs['"]/u);
    expect(routeSource).not.toContain('heartbeat.log');
  });

  it('preserves correlation in the structured fallback telemetry', async () => {
    const info = jest.spyOn(logger, 'info').mockImplementation(() => undefined);
    const app = express();
    app.use((req, _res, next) => {
      req.requestId = 'heartbeat-request-id';
      req.traceId = 'heartbeat-trace-id';
      next();
    });
    app.post('/heartbeat', createHeartbeatHttpBoundary({ authenticationEnvironment }));
    app.use('/', heartbeatRouter);
    const response = await authenticatedPost(app).set('X-Confirmed', 'yes').send(validHeartbeat);

    expect(response.status).toBe(200);
    expect(info).toHaveBeenCalledWith('heartbeat.received', {
      requestId: 'heartbeat-request-id',
      traceId: 'heartbeat-trace-id',
      writeOverride: false,
      dbWriteEnabled: true,
    });
  });

  it('preserves acknowledgement if the existing telemetry sink fails', async () => {
    const response = await authenticatedPost(buildApp({ throwOnLog: true }))
      .set('X-Confirmed', 'yes').send(validHeartbeat);

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ message: expectedMessage });
  });

  it('applies the heartbeat boundary before the broad application JSON parser', () => {
    const appSource = readFileSync(new URL('../src/app.ts', import.meta.url), 'utf8');
    const boundaryIndex = appSource.indexOf("app.post('/heartbeat', heartbeatHttpBoundary)");
    const broadParserIndex = appSource.indexOf('app.use(express.json({ limit: config.limits.jsonLimit }))');

    expect(boundaryIndex).toBeGreaterThan(-1);
    expect(broadParserIndex).toBeGreaterThan(boundaryIndex);
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
