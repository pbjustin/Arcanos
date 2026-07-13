import { createHash } from 'node:crypto';

import express from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';

import requestContext from '../src/middleware/requestContext.js';
import { getGamingCanaryAuditEnabled } from '../src/services/gamingConfig.js';
import {
  buildGamingIngressAuditData,
  GAMING_INGRESS_AUDIT_EVENT,
  gamingIngressAudit,
} from '../src/transport/http/gamingIngressAudit.js';
import errorHandler from '../src/transport/http/middleware/errorHandler.js';

const EXPECTED_PROMPT = 'Is Frost Mage viable this patch in World of Warcraft?';
const EXPECTED_PROMPT_SHA256 = 'faa37589a5ec8315c14c6a8aecae1172879a060a2965a5a60302d9fca21f2a89';
const CANDIDATE_URLS = [
  'https://one.example/wow',
  'https://two.example/wow',
  'https://three.example/wow',
  'https://four.example/wow',
];

type StructuredLog = {
  event?: string;
  requestId?: string;
  traceId?: string;
  data?: Record<string, unknown>;
};

function collectStructuredLogs(calls: unknown[][]): StructuredLog[] {
  return calls.flatMap((call) => {
    if (typeof call[0] !== 'string') {
      return [];
    }
    try {
      return [JSON.parse(call[0]) as StructuredLog];
    } catch {
      return [];
    }
  });
}

function buildAudit(prompt: string, payloadOverrides: Record<string, unknown> = {}) {
  return buildGamingIngressAuditData({
    body: {
      action: 'query',
      payload: {
        mode: 'meta',
        game: 'World of Warcraft',
        prompt,
        guideUrls: CANDIDATE_URLS,
        ...payloadOverrides,
      },
    },
    requestId: 'req-test',
    traceId: 'trace-test',
    timestamp: '2026-07-13T00:00:00.000Z',
  });
}

function createAuditApp(options: { jsonLimit?: string; duplicateMiddleware?: boolean } = {}) {
  const app = express();
  app.use(requestContext);
  app.use(express.json({ limit: options.jsonLimit ?? '10mb' }));
  app.post(
    '/gpt/arcanos-gaming',
    gamingIngressAudit,
    ...(options.duplicateMiddleware ? [gamingIngressAudit] : []),
    (req, res) => res.status(200).json({
      ok: true,
      requestId: req.requestId,
      traceId: req.traceId,
    })
  );
  app.post('/gpt/:gptId', (req, res) => res.status(200).json({
    ok: true,
    requestId: req.requestId,
    traceId: req.traceId,
  }));
  app.use(errorHandler);
  return app;
}

describe('Gaming ingress audit attestation', () => {
  let consoleLogSpy: ReturnType<typeof jest.spyOn>;
  const originalAuditEnabled = process.env.ARCANOS_GAMING_CANARY_AUDIT_ENABLED;
  const originalRailwayEnvironment = process.env.RAILWAY_ENVIRONMENT;
  const originalRailwayEnvironmentName = process.env.RAILWAY_ENVIRONMENT_NAME;

  beforeEach(() => {
    delete process.env.ARCANOS_GAMING_CANARY_AUDIT_ENABLED;
    delete process.env.RAILWAY_ENVIRONMENT;
    delete process.env.RAILWAY_ENVIRONMENT_NAME;
    consoleLogSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);
  });

  afterEach(() => {
    if (originalAuditEnabled === undefined) {
      delete process.env.ARCANOS_GAMING_CANARY_AUDIT_ENABLED;
    } else {
      process.env.ARCANOS_GAMING_CANARY_AUDIT_ENABLED = originalAuditEnabled;
    }
    if (originalRailwayEnvironment === undefined) {
      delete process.env.RAILWAY_ENVIRONMENT;
    } else {
      process.env.RAILWAY_ENVIRONMENT = originalRailwayEnvironment;
    }
    if (originalRailwayEnvironmentName === undefined) {
      delete process.env.RAILWAY_ENVIRONMENT_NAME;
    } else {
      process.env.RAILWAY_ENVIRONMENT_NAME = originalRailwayEnvironmentName;
    }
    consoleLogSpy.mockRestore();
  });

  it('hashes the exact parsed prompt UTF-8 bytes without normalization', () => {
    const audit = buildAudit(EXPECTED_PROMPT);

    expect(audit).toMatchObject({
      promptSha256: EXPECTED_PROMPT_SHA256,
      promptUtf8Bytes: 53,
      promptCodePointCount: 53,
      sortedPayloadKeys: ['game', 'guideUrls', 'mode', 'prompt'],
      urlFieldPresence: {
        url: false,
        urls: false,
        guideUrl: false,
        guideUrls: true,
      },
      urlFieldCounts: {
        url: 0,
        urls: 0,
        guideUrl: 0,
        guideUrls: 4,
      },
      totalCandidateFieldCount: 4,
    });
  });

  it.each([
    ['patch number', `${EXPECTED_PROMPT} Patch 11.2.`],
    ['balance claim', `${EXPECTED_PROMPT} Ice Lance was nerfed by 12%.`],
    ['search snippet', `${EXPECTED_PROMPT} Search says Frost is S-tier.`],
    ['trailing whitespace', `${EXPECTED_PROMPT} `],
    ['newline', `${EXPECTED_PROMPT}\n`],
    ['embedded URL', `${EXPECTED_PROMPT} https://example.com/wow`],
  ])('changes the exact hash when %s is appended', (_caseName, prompt) => {
    expect(buildAudit(prompt)?.promptSha256).not.toBe(EXPECTED_PROMPT_SHA256);
  });

  it('hashes Unicode using exact UTF-8 bytes and counts Unicode code points', () => {
    const prompt = 'Pokémon 🎮 build?';
    const audit = buildAudit(prompt);

    expect(audit?.promptSha256).toBe(createHash('sha256').update(prompt, 'utf8').digest('hex'));
    expect(audit?.promptUtf8Bytes).toBe(Buffer.byteLength(prompt, 'utf8'));
    expect(audit?.promptCodePointCount).toBe([...prompt].length);
  });

  it.each([
    ['url', 'https://one.example/wow', { url: 1, urls: 0, guideUrl: 0, guideUrls: 4 }],
    ['urls', ['https://one.example/wow', 'https://one.example/wow'], { url: 0, urls: 2, guideUrl: 0, guideUrls: 4 }],
    ['guideUrl', 'https://one.example/wow', { url: 0, urls: 0, guideUrl: 1, guideUrls: 4 }],
  ])('counts original %s placement before merging or deduplication', (field, value, expectedCounts) => {
    const audit = buildAudit(EXPECTED_PROMPT, { [field]: value });
    expect(audit?.urlFieldPresence).toMatchObject({ [field]: true });
    expect(audit?.urlFieldCounts).toEqual(expectedCounts);
  });

  it('contains no raw prompt, URL, secret-shaped game, or attacker-controlled key name', () => {
    const rawSecret = 'sk-test-secret-value-1234567890';
    const rawKey = 'https://secret.example/private';
    const audit = buildGamingIngressAuditData({
      body: {
        action: 'query',
        payload: {
          mode: 'meta',
          game: rawSecret,
          prompt: EXPECTED_PROMPT,
          guideUrls: CANDIDATE_URLS,
          [rawKey]: 'ignored',
        },
      },
      requestId: 'req-test',
      traceId: 'trace-test',
    });
    const serialized = JSON.stringify(audit);

    expect(audit?.game).toBe('[unsupported]');
    expect(audit?.sortedPayloadKeys).toContain('[unexpected]');
    expect(serialized).not.toContain(EXPECTED_PROMPT);
    expect(serialized).not.toContain(rawSecret);
    expect(serialized).not.toContain(rawKey);
    CANDIDATE_URLS.forEach((url) => expect(serialized).not.toContain(url));
  });

  it.each([
    ['GitHub token', ['ghp', 'abcdefghijklmnopqrstuvwxyz123456'].join('_')],
    ['overlong game', `safe-prefix-${'x'.repeat(120)}`],
  ])('replaces an unsupported %s without logging its raw value', (_caseName, game) => {
    const audit = buildGamingIngressAuditData({
      body: { action: 'query', payload: { mode: 'meta', game, prompt: EXPECTED_PROMPT } },
      requestId: 'req-test',
      traceId: 'trace-test',
    });
    const serialized = JSON.stringify(audit);
    expect(audit?.game).toBe('[unsupported]');
    expect(serialized).not.toContain(game);
  });

  it('does not hash non-string or over-limit prompts', () => {
    expect(buildAuditDataWithPrompt({ prompt: 'object' })).toBeNull();
    expect(buildAudit('x'.repeat(8_001))).toBeNull();
  });

  it('is disabled by default and enables only for an explicit true value', () => {
    expect(getGamingCanaryAuditEnabled()).toBe(false);
    process.env.ARCANOS_GAMING_CANARY_AUDIT_ENABLED = 'true';
    expect(getGamingCanaryAuditEnabled()).toBe(true);
    for (const disabledValue of ['false', '0', 'no', 'malformed']) {
      process.env.ARCANOS_GAMING_CANARY_AUDIT_ENABLED = disabledValue;
      expect(getGamingCanaryAuditEnabled()).toBe(false);
    }
    process.env.ARCANOS_GAMING_CANARY_AUDIT_ENABLED = 'true';
    process.env.RAILWAY_ENVIRONMENT = 'PrOdUcTiOn';
    expect(getGamingCanaryAuditEnabled()).toBe(false);
    process.env.RAILWAY_ENVIRONMENT = 'Arcanos-pr-1392';
    process.env.RAILWAY_ENVIRONMENT_NAME = 'PRODUCTION';
    expect(getGamingCanaryAuditEnabled()).toBe(false);
  });

  it('emits no audit event when the flag is disabled', async () => {
    await request(createAuditApp())
      .post('/gpt/arcanos-gaming')
      .send({
        action: 'query',
        payload: { mode: 'meta', game: 'World of Warcraft', prompt: EXPECTED_PROMPT },
      });
    const events = collectStructuredLogs(consoleLogSpy.mock.calls)
      .filter((entry) => entry.event === GAMING_INGRESS_AUDIT_EVENT);
    expect(events).toHaveLength(0);
  });

  it('emits no event without trusted request context', async () => {
    process.env.ARCANOS_GAMING_CANARY_AUDIT_ENABLED = 'true';
    const app = express();
    app.use(express.json());
    app.post('/gpt/arcanos-gaming', gamingIngressAudit, (_req, res) => {
      res.status(200).json({ ok: true });
    });
    await request(app).post('/gpt/arcanos-gaming').send({
      action: 'query',
      payload: { mode: 'meta', game: 'World of Warcraft', prompt: EXPECTED_PROMPT },
    });
    const events = collectStructuredLogs(consoleLogSpy.mock.calls)
      .filter((entry) => entry.event === GAMING_INGRESS_AUDIT_EVENT);
    expect(events).toHaveLength(0);
  });

  it('emits one canonical event whose IDs match response body and headers', async () => {
    process.env.ARCANOS_GAMING_CANARY_AUDIT_ENABLED = 'true';
    const response = await request(createAuditApp({ duplicateMiddleware: true }))
      .post('/gpt/arcanos-gaming')
      .set('x-request-id', 'invalid request id')
      .set('x-trace-id', 'invalid trace id')
      .send({
        action: 'query',
        payload: {
          mode: 'meta',
          game: 'World of Warcraft',
          prompt: EXPECTED_PROMPT,
          guideUrls: CANDIDATE_URLS,
        },
      });

    expect(response.status).toBe(200);
    const events = collectStructuredLogs(consoleLogSpy.mock.calls)
      .filter((entry) => entry.event === GAMING_INGRESS_AUDIT_EVENT);
    expect(events).toHaveLength(1);
    expect(events[0]?.requestId).toBe(response.body.requestId);
    expect(events[0]?.traceId).toBe(response.body.traceId);
    expect(events[0]?.data).toMatchObject({
      requestId: response.body.requestId,
      traceId: response.body.traceId,
      promptSha256: EXPECTED_PROMPT_SHA256,
      urlFieldCounts: { url: 0, urls: 0, guideUrl: 0, guideUrls: 4 },
    });
    expect(response.headers['x-request-id']).toBe(response.body.requestId);
    expect(response.headers['x-trace-id']).toBe(response.body.traceId);
  });

  it.each([
    ['/gpt/gaming', { action: 'query', payload: { prompt: EXPECTED_PROMPT } }],
    ['/gpt/arcanos-core', { action: 'query', payload: { prompt: EXPECTED_PROMPT } }],
    ['/gpt/arcanos-gaming/evidence-retry', { originalPrompt: EXPECTED_PROMPT }],
  ])('does not emit for out-of-scope route %s', async (path, body) => {
    process.env.ARCANOS_GAMING_CANARY_AUDIT_ENABLED = 'true';
    await request(createAuditApp()).post(path).send(body);
    const events = collectStructuredLogs(consoleLogSpy.mock.calls)
      .filter((entry) => entry.event === GAMING_INGRESS_AUDIT_EVENT);
    expect(events).toHaveLength(0);
  });

  it.each([
    ['malformed JSON', undefined],
    ['oversized JSON', '128b'],
  ])('keeps %s bounded before audit processing', async (caseName, jsonLimit) => {
    process.env.ARCANOS_GAMING_CANARY_AUDIT_ENABLED = 'true';
    const call = request(createAuditApp({ jsonLimit }))
      .post('/gpt/arcanos-gaming')
      .set('Content-Type', 'application/json');
    const response = caseName === 'malformed JSON'
      ? await call.send('{"action":')
      : await call.send({ action: 'query', payload: { prompt: 'x'.repeat(256) } });

    expect(response.status).toBe(400);
    expect(response.type).toBe('application/json');
    expect(response.body.requestId).toBe(response.headers['x-request-id']);
    expect(response.body.traceId).toBe(response.headers['x-trace-id']);
    const events = collectStructuredLogs(consoleLogSpy.mock.calls)
      .filter((entry) => entry.event === GAMING_INGRESS_AUDIT_EVENT);
    expect(events).toHaveLength(0);
  });
});

function buildAuditDataWithPrompt(prompt: unknown) {
  return buildGamingIngressAuditData({
    body: { action: 'query', payload: { mode: 'meta', prompt } },
    requestId: 'req-test',
    traceId: 'trace-test',
  });
}
