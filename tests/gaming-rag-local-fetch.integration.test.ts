import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from '@jest/globals';

import {
  buildGamingRagContext,
  clearGamingRagCache,
  isCitableGamingWebSource,
} from '../src/services/gamingWebContext.js';

const ENV_KEYS = [
  'ARCANOS_ALLOW_LOCALHOST_FETCH',
  'ARCANOS_GAMING_DISCOVERY_ENABLED',
  'ARCANOS_GAMING_RAG_CHUNK_CHARS',
  'ARCANOS_GAMING_RAG_ENABLED',
  'ARCANOS_GAMING_RAG_MAX_CHUNKS',
  'ARCANOS_GAMING_RAG_MAX_SOURCES',
  'ARCANOS_GAMING_WEB_CONTEXT_CHARS',
  'ARCANOS_GAMING_WEB_CONTEXT_FETCH_TIMEOUT_MS',
] as const;

const previousEnv = new Map<string, string | undefined>();
let server: Server;
let baseUrl = '';

function article(body: string): string {
  return `<!doctype html><html><head><title>Community gameplay article</title></head><body><main><article>${body}</article></main></body></html>`;
}

describe('Gaming RAG real local fetch integration', () => {
  beforeAll(async () => {
    for (const key of ENV_KEYS) {
      previousEnv.set(key, process.env[key]);
    }
    process.env.ARCANOS_ALLOW_LOCALHOST_FETCH = 'true';
    process.env.ARCANOS_GAMING_DISCOVERY_ENABLED = 'false';
    process.env.ARCANOS_GAMING_RAG_CHUNK_CHARS = '320';
    process.env.ARCANOS_GAMING_RAG_ENABLED = 'true';
    process.env.ARCANOS_GAMING_RAG_MAX_CHUNKS = '8';
    process.env.ARCANOS_GAMING_RAG_MAX_SOURCES = '4';
    process.env.ARCANOS_GAMING_WEB_CONTEXT_CHARS = '5000';
    process.env.ARCANOS_GAMING_WEB_CONTEXT_FETCH_TIMEOUT_MS = '2000';

    server = createServer((request, response) => {
      response.statusCode = 200;
      response.setHeader('Content-Type', 'text/html; charset=utf-8');
      if (request.url === '/wrong-game') {
        response.end(article(
          '<p>Elden Ring beginner guide route explains flask preparation, weapon upgrades, and safe progress through Stormveil Castle.</p>'
          + '<p>Players should confirm the nearby grace, save resources, and learn the boss attack windows before advancing.</p>'
        ));
        return;
      }
      response.end(article(
        '<p>Palworld version 0.9 progression guide evidence explains a reliable beginner route with concrete preparation steps.</p>'
        + '<p>Players should gather supplies, confirm the nearby landmark, and save before starting this Palworld objective.</p>'
      ));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  beforeEach(() => {
    clearGamingRagCache();
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    for (const key of ENV_KEYS) {
      const value = previousEnv.get(key);
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  });

  it('rejects a fetched wrong-game body introduction without exposing it as evidence', async () => {
    const result = await buildGamingRagContext({
      mode: 'guide',
      game: 'Factorio',
      prompt: 'Use this source for a Factorio progression guide.',
      guideUrl: `${baseUrl}/wrong-game`,
      guideUrls: [],
    });

    expect(result.sources).toEqual([{
      url: `${baseUrl}/wrong-game`,
      snippet: 'Relevant source retrieved, but readable article text was limited.',
    }]);
    expect(result.sources.some(isCitableGamingWebSource)).toBe(false);
    expect(result.context).not.toContain('Stormveil Castle');
  });

  it('does not satisfy a multi-version request from a fetched page covering only one version', async () => {
    const result = await buildGamingRagContext({
      mode: 'guide',
      game: 'Palworld',
      prompt: 'Compare Palworld versions 0.9 and 1.0.',
      guideUrl: `${baseUrl}/one-version`,
      guideUrls: [],
    });

    expect(result.sources.some(isCitableGamingWebSource)).toBe(true);
    expect(result.context).toContain('Palworld version 0.9');
    expect(result.currentEvidenceAvailable).toBe(false);
  });
});
