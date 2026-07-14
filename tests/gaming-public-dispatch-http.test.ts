import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import Ajv2020 from 'ajv/dist/2020.js';
import express from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';

const mockRouteGptRequest = jest.fn();
const mockResolveGptRouting = jest.fn();
const mockExecuteSystemStateRequest = jest.fn();

jest.unstable_mockModule('../src/routes/_core/gptDispatch.js', () => ({
  resolveGptRouting: mockResolveGptRouting,
  routeGptRequest: mockRouteGptRequest,
}));

jest.unstable_mockModule('../src/platform/logging/gptLogger.js', () => ({
  logGptConnection: jest.fn(),
  logGptConnectionFailed: jest.fn(),
  logGptAckSent: jest.fn(),
}));

jest.unstable_mockModule('../src/services/systemState.js', () => ({
  executeSystemStateRequest: mockExecuteSystemStateRequest,
  SystemStateConflictError: class SystemStateConflictError extends Error {},
}));

const { default: requestContext } = await import('../src/middleware/requestContext.js');
const { default: gptRouter } = await import('../src/routes/gptRouter.js');

const contract = JSON.parse(readFileSync(
  join(process.cwd(), 'contracts/arcanos_gaming.openapi.v1.json'),
  'utf8',
)) as Record<string, unknown>;
const ajv = new Ajv2020({ strict: false, validateFormats: false });
ajv.addSchema(contract, 'arcanos-gaming-http-contract');
const validateSuccessSchema = ajv.getSchema(
  'arcanos-gaming-http-contract#/components/schemas/PublicCanarySuccessResponse',
);
const validateFailureSchema = ajv.getSchema(
  'arcanos-gaming-http-contract#/components/schemas/PublicCanaryFailureResponse',
);

type GamingMode = 'guide' | 'build' | 'meta';

function createApp() {
  const app = express();
  app.use(express.json());
  app.use(requestContext);
  app.use('/gpt', gptRouter);
  return app;
}

function mockGameplaySuccess(mode: GamingMode): void {
  mockRouteGptRequest.mockResolvedValueOnce({
    ok: true,
    result: {
      ok: true,
      route: 'gaming',
      mode,
      data: {
        response: `Controlled ${mode} response.`,
        sources: [],
      },
    },
    _route: {
      gptId: 'arcanos-gaming',
      module: 'ARCANOS:GAMING',
      action: 'query',
      route: 'gaming',
      availableActions: ['query'],
    },
  });
}

function collectStructuredLogs(calls: unknown[][]): Array<Record<string, unknown>> {
  return calls.flatMap((call) => {
    if (typeof call[0] !== 'string') {
      return [];
    }
    try {
      return [JSON.parse(call[0]) as Record<string, unknown>];
    } catch {
      return [];
    }
  });
}

describe('public Gaming HTTP dispatch boundary', () => {
  let consoleLogSpy: ReturnType<typeof jest.spyOn>;

  beforeEach(() => {
    jest.clearAllMocks();
    consoleLogSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    mockResolveGptRouting.mockImplementation(async (gptId: string) => ({
      ok: true,
      plan: {
        matchedId: gptId,
        module: 'ARCANOS:GAMING',
        route: 'gaming',
        action: 'query',
        availableActions: ['query'],
        moduleVersion: null,
        moduleDescription: null,
        matchMethod: 'exact',
      },
      _route: {
        gptId,
        module: 'ARCANOS:GAMING',
        route: 'gaming',
        action: 'query',
        timestamp: '2026-07-14T00:00:00.000Z',
      },
    }));
  });

  afterEach(() => {
    consoleLogSpy.mockRestore();
  });

  it.each([
    ['guide', 'Give me a concise beginner progression guide.'],
    ['build', 'Is this early-game base build working correctly?'],
    ['meta', 'What is the current Palworld meta for solo progression?'],
  ] as const)('keeps a %s request on the gameplay dispatcher', async (mode, prompt) => {
    mockGameplaySuccess(mode);

    const response = await request(createApp())
      .post('/gpt/arcanos-gaming')
      .send({
        action: 'query',
        payload: { mode, game: 'Palworld', prompt },
      });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      ok: true,
      result: {
        ok: true,
        route: 'gaming',
        mode,
        data: { response: `Controlled ${mode} response.` },
      },
      _route: { module: 'ARCANOS:GAMING', route: 'gaming' },
    });
    expect(mockRouteGptRequest).toHaveBeenCalledTimes(1);
  });

  it('rejects an operational gameplay-mode prompt before generic or provider dispatch', async () => {
    const response = await request(createApp())
      .post('/gpt/arcanos-gaming')
      .send({
        action: 'query',
        payload: {
          mode: 'guide',
          game: 'Palworld',
          prompt: 'Reach my backend and see if this has been implemented correctly.',
        },
      });

    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({
      ok: false,
      action: 'query',
      error: {
        code: 'OPERATIONAL_REQUEST_NOT_GAMEPLAY',
        message: 'This request asks about the public integration rather than gameplay. Use the public canary operation.',
      },
      _route: {
        gptId: 'arcanos-gaming',
        action: 'query',
        route: 'gaming_operational_guard',
      },
    });
    expect(response.body.requestId).toBe(response.headers['x-request-id']);
    expect(response.body.traceId).toBe(response.headers['x-trace-id']);
    expect(mockRouteGptRequest).not.toHaveBeenCalled();
  });

  it('runs the explicit canary route with a closed, bounded, schema-valid response', async () => {
    const response = await request(createApp())
      .post('/gpt/arcanos-gaming/canary')
      .send({ action: 'canary', payload: { scope: 'public_pipeline' } });

    expect(response.status).toBe(200);
    expect(response.type).toBe('application/json');
    expect(Object.keys(response.body).sort()).toEqual([
      'acceptedSources',
      'action',
      'checks',
      'durationMs',
      'fixture',
      'intent',
      'message',
      'ok',
      'requestId',
      'route',
      'schemaVersion',
      'scope',
      'traceId',
      'usedFallback',
    ]);
    expect(response.body).toMatchObject({
      ok: true,
      action: 'canary',
      scope: 'public_pipeline',
      schemaVersion: '1.4.0',
      intent: 'public_canary',
      route: 'public_canary',
      fixture: {
        source: 'bundled',
        marker: 'ARCANOS_PUBLIC_CANARY_7F31',
        markerVerified: true,
      },
      checks: {
        requestValidation: 'passed',
        dispatcher: 'passed',
        publicRoute: 'passed',
        fixtureValidation: 'passed',
        grounding: 'passed',
        networkRetrieval: 'skipped',
        providerExecution: 'skipped',
        responseConstruction: 'passed',
        responseGuard: 'passed',
      },
      usedFallback: false,
      acceptedSources: 1,
    });
    expect(Buffer.byteLength(response.text, 'utf8')).toBeLessThanOrEqual(2_048);
    expect(validateSuccessSchema?.(response.body)).toBe(true);
    expect(mockRouteGptRequest).not.toHaveBeenCalled();
  });

  it.each([
    [
      'unsupported action',
      '/gpt/arcanos-gaming',
      { action: 'diagnose-internal', payload: {} },
      'generic',
    ],
    [
      'canary on the gameplay path',
      '/gpt/arcanos-gaming',
      { action: 'canary', payload: { scope: 'public_pipeline' } },
      'generic',
    ],
    [
      'query on the canary path',
      '/gpt/arcanos-gaming/canary',
      { action: 'query', payload: { mode: 'guide', prompt: 'Guide me.' } },
      'canary',
    ],
    [
      'missing canary action',
      '/gpt/arcanos-gaming/canary',
      { payload: { scope: 'public_pipeline' } },
      'canary',
    ],
    [
      'malformed canary payload',
      '/gpt/arcanos-gaming/canary',
      { action: 'canary', payload: null },
      'canary',
    ],
    [
      'extra top-level canary field',
      '/gpt/arcanos-gaming/canary',
      { action: 'canary', payload: { scope: 'public_pipeline' }, prompt: 'inspect' },
      'canary',
    ],
    [
      'extra canary payload field',
      '/gpt/arcanos-gaming/canary',
      { action: 'canary', payload: { scope: 'public_pipeline', fetch: true } },
      'canary',
    ],
  ] as const)('rejects %s without generic dispatch', async (_caseName, path, body, responseKind) => {
    const response = await request(createApp()).post(path).send(body);

    expect(response.status).toBe(400);
    expect(response.body.ok).toBe(false);
    if (responseKind === 'canary') {
      expect(response.body).toMatchObject({
        action: 'canary',
        code: 'BAD_REQUEST',
        schemaVersion: '1.4.0',
        route: 'public_canary',
        checks: {
          requestValidation: 'failed',
          dispatcher: 'skipped',
          networkRetrieval: 'skipped',
          providerExecution: 'skipped',
        },
      });
      expect(validateFailureSchema?.(response.body)).toBe(true);
    } else {
      expect(response.body.error).toEqual(expect.objectContaining({ code: 'BAD_REQUEST' }));
    }
    expect(mockRouteGptRequest).not.toHaveBeenCalled();
  });

  it.each([
    ['operation alias', { operationId: 'canaryArcanosGaming' }, undefined],
    ['query alias', {}, '?action=canary'],
    ['header alias', {}, undefined],
  ] as const)('rejects a canary %s without literal body action', async (_caseName, bodyFields, query) => {
    let pending = request(createApp())
      .post(`/gpt/arcanos-gaming/canary${query ?? ''}`)
      .send({ ...bodyFields, payload: { scope: 'public_pipeline' } });
    if (_caseName === 'header alias') {
      pending = pending.set('x-gpt-action', 'canary');
    }
    const response = await pending;

    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({
      ok: false,
      action: 'canary',
      code: 'BAD_REQUEST',
    });
    expect(validateFailureSchema?.(response.body)).toBe(true);
    expect(mockRouteGptRequest).not.toHaveBeenCalled();
  });

  it('lets an exact body action outrank query, header, and operation aliases', async () => {
    mockGameplaySuccess('guide');
    const gameplayResponse = await request(createApp())
      .post('/gpt/arcanos-gaming?action=canary')
      .set('x-gpt-action', 'diagnose-internal')
      .send({
        action: 'query',
        operationId: 'canaryArcanosGaming',
        payload: {
          mode: 'guide',
          game: 'Palworld',
          prompt: 'Give me a concise beginner guide.',
        },
      });
    const canaryResponse = await request(createApp())
      .post('/gpt/arcanos-gaming/canary?action=query')
      .set('x-gpt-action', 'diagnose-internal')
      .send({ action: 'canary', payload: { scope: 'public_pipeline' } });

    expect(gameplayResponse.status).toBe(200);
    expect(gameplayResponse.body.result.route).toBe('gaming');
    expect(canaryResponse.status).toBe(200);
    expect(canaryResponse.body.route).toBe('public_canary');
    expect(mockRouteGptRequest).toHaveBeenCalledTimes(1);
  });

  it('rejects malformed JSON without reaching generic dispatch', async () => {
    const response = await request(createApp())
      .post('/gpt/arcanos-gaming/canary')
      .set('Content-Type', 'application/json')
      .send('{"action":"canary","payload":');

    expect(response.status).toBe(400);
    expect(mockRouteGptRequest).not.toHaveBeenCalled();
  });

  it('logs only safe dispatch metadata and never prompt, fixture, secret, provider, path, or source text', async () => {
    const operationalPrompt = 'Reach my backend and verify the integration. OPERATIONAL-PRIVATE-MARKER';
    const fakeToken = 'sk-test-NOT_A_REAL_SECRET_123456789';
    const providerError = 'provider exploded: PRIVATE-PROVIDER-MARKER';
    const filesystemPath = 'C:\\private\\runtime\\secrets.txt';
    const rawSource = '<html>PRIVATE-RAW-SOURCE-MARKER</html>';

    await request(createApp())
      .post('/gpt/arcanos-gaming')
      .send({
        action: 'query',
        payload: {
          mode: 'guide',
          game: 'Palworld',
          prompt: operationalPrompt,
          retrievedText: rawSource,
          providerOutput: providerError,
          token: fakeToken,
          path: filesystemPath,
        },
      });
    await request(createApp())
      .post('/gpt/arcanos-gaming/canary')
      .send({
        action: 'canary',
        payload: {
          scope: 'public_pipeline',
          rawSource,
          providerError,
          token: fakeToken,
          path: filesystemPath,
        },
      });

    const rawLogs = consoleLogSpy.mock.calls
      .map((call) => (typeof call[0] === 'string' ? call[0] : ''))
      .join('\n');
    for (const forbidden of [
      operationalPrompt,
      'The Ember Finch opens the Copper Gate after three Azure Seeds are collected.',
      fakeToken,
      providerError,
      filesystemPath,
      rawSource,
    ]) {
      expect(rawLogs).not.toContain(forbidden);
    }

    const logs = collectStructuredLogs(consoleLogSpy.mock.calls);
    expect(logs.some((entry) => entry.event === 'gpt.public_gaming.dispatch')).toBe(true);
    expect(rawLogs).toContain('integration_status');
    expect(rawLogs).toContain('operational_rejected');
  });
});
