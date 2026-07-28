import cors from 'cors';
import express from 'express';
import request from 'supertest';
import { describe, expect, it } from '@jest/globals';
import {
  isValidCorsAllowedOrigins,
  parseCorsAllowedOrigins,
  resolveRuntimeCorsConfig,
} from '../src/platform/runtime/corsConfig.js';

function createCorsTestApp(
  nodeEnv: string,
  allowedOrigins: string | undefined,
) {
  const app = express();
  app.use(cors(resolveRuntimeCorsConfig(nodeEnv, allowedOrigins)));
  app.get('/resource', (_req, res) => {
    res.json({ ok: true });
  });
  return app;
}

describe('runtime CORS configuration', () => {
  it('preserves permissive reflected origins for local development', async () => {
    const app = createCorsTestApp('development', undefined);

    const response = await request(app)
      .get('/resource')
      .set('Origin', 'http://localhost:5173');

    expect(response.status).toBe(200);
    expect(response.headers['access-control-allow-origin']).toBe('http://localhost:5173');
    expect(response.headers['access-control-allow-credentials']).toBe('true');
  });

  it.each([
    ['production', undefined],
    ['staging', '   '],
    ['test', ' , , '],
  ])(
    'disables browser CORS by default in %s for an empty allowlist',
    async (nodeEnv, allowedOrigins) => {
      const app = createCorsTestApp(nodeEnv, allowedOrigins);

      const response = await request(app)
        .get('/resource')
        .set('Origin', 'https://untrusted.example');

      expect(response.status).toBe(200);
      expect(response.headers['access-control-allow-origin']).toBeUndefined();
      expect(response.headers['access-control-allow-credentials']).toBeUndefined();
    },
  );

  it('normalizes, deduplicates, and exactly matches configured origins', async () => {
    const rawOrigins = [
      ' https://APP.Example.test/ ',
      'http://localhost:3000',
      'https://app.example.test',
    ].join(',');
    const app = createCorsTestApp('production', rawOrigins);

    expect(parseCorsAllowedOrigins(rawOrigins)).toEqual({
      origins: ['https://app.example.test', 'http://localhost:3000'],
      valid: true,
    });

    const allowedResponse = await request(app)
      .get('/resource')
      .set('Origin', 'https://app.example.test');
    const deniedResponse = await request(app)
      .get('/resource')
      .set('Origin', 'https://subdomain.app.example.test');

    expect(allowedResponse.headers['access-control-allow-origin']).toBe(
      'https://app.example.test',
    );
    expect(allowedResponse.headers['access-control-allow-credentials']).toBe('true');
    expect(allowedResponse.headers.vary).toContain('Origin');
    expect(deniedResponse.headers['access-control-allow-origin']).toBeUndefined();
    expect(deniedResponse.headers['access-control-allow-credentials']).toBeUndefined();
  });

  it('does not emit browser CORS headers for configured requests without an Origin', async () => {
    const app = createCorsTestApp('production', 'https://app.example.test');

    const response = await request(app).get('/resource');

    expect(response.status).toBe(200);
    expect(response.headers['access-control-allow-origin']).toBeUndefined();
    expect(response.headers['access-control-allow-credentials']).toBeUndefined();
  });

  it.each([
    '*',
    'null',
    'ftp://files.example.test',
    'https://user:password@app.example.test',
    'https://app.example.test/path',
    'https://app.example.test?token=value',
    'https://app.example.test#fragment',
  ])('rejects unsafe or non-origin allowlist entry %s', (invalidOrigin) => {
    expect(isValidCorsAllowedOrigins(invalidOrigin)).toBe(false);
    expect(parseCorsAllowedOrigins(invalidOrigin)).toEqual({
      origins: [],
      valid: false,
    });
  });

  it('fails the entire allowlist closed when any configured entry is invalid', async () => {
    const app = createCorsTestApp(
      'production',
      'https://app.example.test,https://app.example.test/path',
    );

    const response = await request(app)
      .get('/resource')
      .set('Origin', 'https://app.example.test');

    expect(response.status).toBe(200);
    expect(response.headers['access-control-allow-origin']).toBeUndefined();
    expect(response.headers['access-control-allow-credentials']).toBeUndefined();
  });

  it('does not treat a configured wildcard as browser origin permission', async () => {
    const app = createCorsTestApp('production', '*');

    const response = await request(app)
      .get('/resource')
      .set('Origin', 'https://untrusted.example');

    expect(response.status).toBe(200);
    expect(response.headers['access-control-allow-origin']).toBeUndefined();
    expect(response.headers['access-control-allow-credentials']).toBeUndefined();
  });

  it('allows exact configured preflight requests and denies other origins', async () => {
    const app = createCorsTestApp('production', 'https://app.example.test');

    const allowedResponse = await request(app)
      .options('/resource')
      .set('Origin', 'https://app.example.test')
      .set('Access-Control-Request-Method', 'POST')
      .set('Access-Control-Request-Headers', 'authorization,content-type');
    const deniedResponse = await request(app)
      .options('/resource')
      .set('Origin', 'https://untrusted.example')
      .set('Access-Control-Request-Method', 'POST');

    expect(allowedResponse.status).toBe(204);
    expect(allowedResponse.headers['access-control-allow-origin']).toBe(
      'https://app.example.test',
    );
    expect(allowedResponse.headers['access-control-allow-credentials']).toBe('true');
    expect(allowedResponse.headers['access-control-allow-headers']).toBe(
      'authorization,content-type',
    );
    expect(deniedResponse.headers['access-control-allow-origin']).toBeUndefined();
    expect(deniedResponse.headers['access-control-allow-credentials']).toBeUndefined();
  });
});
