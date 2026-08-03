import express, { type Request } from 'express';
import { describe, expect, it, jest } from '@jest/globals';

import {
  PUBLIC_PROVIDER_CLIENT_RATE_LIMIT_BUCKET,
  PUBLIC_PROVIDER_RATE_LIMIT_BUCKET,
  createPublicProviderAdmissionMiddleware,
  createPublicProviderRateLimitMiddleware,
  isPublicProviderAdmissionRequest,
  normalizePublicProviderClientAddress,
  isTrustedRailwayEdgePeerAddress,
  resolvePublicProviderClientIdentity,
} from '../src/transport/http/middleware/publicProviderAdmission.js';
import {
  normalizePublicProviderClientRateLimitMax,
  normalizePublicProviderRateLimitMax,
  normalizePublicProviderRateLimitStoreMode,
  normalizePublicProviderRateLimitWindowMs,
  resolvePublicProviderRateLimitNamespace,
  resolvePublicProviderTrustRailwayRealIp,
} from '../src/platform/runtime/publicProviderRateLimitPolicy.js';
import { resolveDispatchLane } from '../src/shared/dispatch/universalDispatch.js';

const request = (await import('supertest')).default;

describe('public provider admission policy', () => {
  it.each([
    ['/gpt/arcanos-core', undefined],
    ['/api/openai/prompt', undefined],
    ['/arcanos-pipeline', undefined],
    ['/api/reusables', undefined],
    ['/siri', undefined],
    ['/backstage/book-gpt', undefined],
    ['/commands/research', undefined],
    ['/api/vision', undefined],
    ['/api/transcribe', undefined],
    ['/image', undefined],
    ['/api/arcanos/ask', undefined],
    ['/api/sim', undefined],
    ['/api/sim/', undefined],
    ['/api/ask-hrc', undefined],
    ['/query-finetune', undefined],
    ['/api/web/search', undefined],
    ['/arcanos', undefined],
    ['/write', undefined],
    ['/guide', undefined],
    ['/sim', undefined],
    ['/modules/core', undefined],
    ['/queryroute', undefined],
    ['/dispatch', { prompt: 'Answer this question.' }],
  ] as const)('admits public provider work at POST %s with %j', (path, body) => {
    expect(isPublicProviderAdmissionRequest({
      method: 'POST',
      path,
      body,
    }, { legacyGptRoutesEnabled: true })).toBe(true);
  });

  it.each([
    ['/healthz', undefined],
    ['/readyz', undefined],
    ['/api/openai/status', undefined],
    ['/api/reusables/health', undefined],
    ['/api/sim/health', undefined],
    ['/api/sim/examples', undefined],
    ['/gpt/arcanos-gaming/canary', undefined],
    ['/gpt/arcanos-gaming/evidence-retry', undefined],
    ['/api/control-plane/operations', undefined],
    ['/gpt-access/status', undefined],
    ['/mcp', undefined],
    ['/rag/query', undefined],
    ['/api/arcanos/dag/runs', undefined],
    ['/api/afol/decide', undefined],
    ['/api/assistants/sync', undefined],
    ['/api/self-heal/decide', undefined],
    ['/api/bridge/gpt', undefined],
    ['/backstage/book-event', undefined],
    ['/image/extra', undefined],
    ['/api/openai/prompt/extra', undefined],
    ['/dispatch', { target: 'dag', gptId: 'arcanos-core' }],
    ['/dispatch', { action: 'dag.run.create' }],
    ['/dispatch', { executionMode: 'dag' }],
    ['/dispatch', { executionMode: 'auto', prompt: 'Run the workflow now.' }],
    ['/dispatch', { target: 'mcp' }],
    ['/dispatch', { executionMode: 'tool' }],
    ['/dispatch', { target: 'gpt', action: 'dag.run.create' }],
    ['/dispatch', { gptId: 'arcanos-core', action: 'dag.run.create', executionMode: 'dag' }],
    ['/dispatch', { executionMode: 'gpt', prompt: 'Run the workflow now.' }],
    ['/dispatch', { action: 'ping' }],
    ['/dispatch', { prompt: 'ping' }],
    ['/dispatch', { target: 'gpt', action: 'runtime.inspect' }],
  ] as const)('excludes non-public-provider work at POST %s with %j', (path, body) => {
    expect(isPublicProviderAdmissionRequest({
      method: 'POST',
      path,
      body,
    }, { legacyGptRoutesEnabled: true })).toBe(false);
  });

  it('uses the resolved /dispatch payload prompt when deciding provider admission', () => {
    expect(isPublicProviderAdmissionRequest({
      method: 'POST',
      path: '/dispatch',
      body: {
        target: 'gpt',
        prompt: 'show me worker status',
        payload: { prompt: 'Write a haiku.' },
      },
    })).toBe(true);

    expect(isPublicProviderAdmissionRequest({
      method: 'POST',
      path: '/dispatch',
      body: {
        target: 'gpt',
        prompt: 'Write a haiku.',
        payload: { prompt: 'show me worker status' },
      },
    })).toBe(false);
  });

  it('excludes non-POST requests and disabled legacy aliases', () => {
    expect(isPublicProviderAdmissionRequest({
      method: 'GET',
      path: '/api/openai/prompt',
    })).toBe(false);

    for (const path of ['/arcanos', '/write', '/guide', '/sim', '/modules/core', '/queryroute']) {
      expect(isPublicProviderAdmissionRequest({
        method: 'POST',
        path,
      }, { legacyGptRoutesEnabled: false })).toBe(false);
    }
  });

  it('admits GET, HEAD, and POST /brain only while compatibility mode can reach provider work', () => {
    for (const method of ['GET', 'POST']) {
      expect(isPublicProviderAdmissionRequest({
        method,
        path: '/brain',
        body: { prompt: 'Write a concise answer.' },
      }, { askRouteMode: 'compat' })).toBe(true);

      expect(isPublicProviderAdmissionRequest({
        method,
        path: '/brain',
        body: { prompt: 'Write a concise answer.' },
      }, { askRouteMode: 'gone' })).toBe(false);
    }

    expect(isPublicProviderAdmissionRequest({
      method: 'GET',
      path: '/brain',
      query: { prompt: 'ping' },
    }, { askRouteMode: 'compat' })).toBe(false);

    expect(isPublicProviderAdmissionRequest({
      method: 'POST',
      path: '/brain',
      body: { prompt: 'Write a concise answer.' },
      query: { prompt: 'ping' },
    }, { askRouteMode: 'compat' })).toBe(true);
    expect(isPublicProviderAdmissionRequest({
      method: 'POST',
      path: '/brain',
      body: { prompt: 'ping' },
      query: { prompt: 'Write a concise answer.' },
    }, { askRouteMode: 'compat' })).toBe(false);
    expect(isPublicProviderAdmissionRequest({
      method: 'GET',
      path: '/brain',
      body: { prompt: 'ping' },
      query: { prompt: 'Write a concise answer.' },
    }, { askRouteMode: 'compat' })).toBe(true);
    expect(isPublicProviderAdmissionRequest({
      method: 'GET',
      path: '/brain',
      body: { prompt: 'Write a concise answer.' },
      query: { prompt: 'ping' },
    }, { askRouteMode: 'compat' })).toBe(false);

    expect(isPublicProviderAdmissionRequest({
      method: 'HEAD',
      path: '/brain',
      body: { prompt: 'Write a concise answer.' },
      query: { prompt: 'ping' },
    }, { askRouteMode: 'compat' })).toBe(true);

    for (const [method, body, query] of [
      ['POST', { mode: 'system_state' }, undefined],
      ['GET', undefined, { mode: 'system_state' }],
      ['HEAD', { mode: 'system_state' }, undefined],
    ] as const) {
      expect(isPublicProviderAdmissionRequest({
        method,
        path: '/brain',
        body,
        query,
      }, { askRouteMode: 'compat' })).toBe(false);
    }

    for (const [method, body, query] of [
      ['POST', { mode: 'system_review', prompt: 'ping' }, undefined],
      ['GET', undefined, { mode: 'system_review', prompt: 'ping' }],
      ['HEAD', { mode: 'system_review', prompt: 'ping' }, undefined],
    ] as const) {
      expect(isPublicProviderAdmissionRequest({
        method,
        path: '/brain',
        body,
        query,
      }, { askRouteMode: 'compat' })).toBe(true);
    }
  });

  it('excludes canonical GPT diagnostics and control actions from provider admission', () => {
    const candidates = [
      { body: { action: 'ping' } },
      { body: { prompt: 'ping' } },
      { body: { action: 'dag.capabilities' } },
      { body: { payload: { gpt_action: 'dag.dispatch' } } },
      { query: { action: 'dag.status' } },
      { gptActionHeader: 'dag.trace' },
      { arcanosActionHeader: 'mcp.list_tools' },
      { body: { action: 'get_status' } },
      { body: { action: 'system_state' } },
      { body: { prompt: 'Pull result for job job-123.' } },
    ];

    for (const candidate of candidates) {
      expect(isPublicProviderAdmissionRequest({
        method: 'POST',
        path: '/gpt/arcanos-core',
        ...candidate,
      })).toBe(false);
    }

    expect(isPublicProviderAdmissionRequest({
      method: 'POST',
      path: '/api/arcanos/ask',
      body: { mode: 'diagnostic' },
    })).toBe(false);
  });

  it('admits compatibility brain system_review before diagnostic prompt handling', () => {
    for (const [method, body, query] of [
      ['POST', { mode: 'system_review', prompt: 'ping' }, undefined],
      ['GET', undefined, { mode: 'system_review', prompt: 'ping' }],
      ['HEAD', { mode: 'system_review', prompt: 'ping' }, undefined],
    ] as const) {
      expect(isPublicProviderAdmissionRequest({
        method,
        path: '/brain',
        body,
        query,
      }, { askRouteMode: 'compat' })).toBe(true);
    }
  });

  it('matches compatibility GET /brain first-value query normalization', () => {
    expect(isPublicProviderAdmissionRequest({
      method: 'GET',
      path: '/brain',
      query: {
        mode: ['system_review', 'chat'],
        prompt: 'ping',
      },
    }, { askRouteMode: 'compat' })).toBe(true);

    expect(isPublicProviderAdmissionRequest({
      method: 'GET',
      path: '/brain',
      query: {
        mode: ['chat', 'system_review'],
        prompt: ['ping', 'Write a haiku.'],
      },
    }, { askRouteMode: 'compat' })).toBe(false);

    expect(isPublicProviderAdmissionRequest({
      method: 'GET',
      path: '/brain',
      query: {
        action: ['ping', 'query'],
        prompt: 'Write a haiku.',
      },
    }, { askRouteMode: 'compat' })).toBe(false);
  });

  it('matches compatibility brain sanitization and prompt-first alias precedence', () => {
    expect(isPublicProviderAdmissionRequest({
      method: 'POST',
      path: '/brain',
      body: { mode: 'system_\0review', prompt: 'ping' },
    }, { askRouteMode: 'compat' })).toBe(true);

    expect(isPublicProviderAdmissionRequest({
      method: 'POST',
      path: '/brain',
      body: { prompt: 'Write a haiku.', message: 'ping' },
    }, { askRouteMode: 'compat' })).toBe(true);

    expect(isPublicProviderAdmissionRequest({
      method: 'POST',
      path: '/brain',
      body: { prompt: 'ping', message: 'Write a haiku.' },
    }, { askRouteMode: 'compat' })).toBe(false);
  });

  it('matches API Arcanos prompt-first diagnostic input precedence', () => {
    expect(isPublicProviderAdmissionRequest({
      method: 'POST',
      path: '/api/arcanos/ask',
      body: { prompt: 'Write a haiku.', message: 'ping' },
    })).toBe(true);

    expect(isPublicProviderAdmissionRequest({
      method: 'POST',
      path: '/api/arcanos/ask',
      body: { prompt: 'ping', message: 'Write a haiku.' },
    })).toBe(false);

    expect(isPublicProviderAdmissionRequest({
      method: 'POST',
      path: '/api/arcanos/ask',
      body: { mode: 'diag\0nostic', prompt: 'Write a haiku.' },
    })).toBe(false);
  });

  it('preserves body, payload, query, and header action precedence for canonical GPT', () => {
    expect(isPublicProviderAdmissionRequest({
      method: 'POST',
      path: '/gpt/arcanos-core',
      body: { action: 'query', payload: { action: 'query' } },
      query: { action: 'dag.status' },
      gptActionHeader: 'dag.trace',
    })).toBe(true);

    expect(isPublicProviderAdmissionRequest({
      method: 'POST',
      path: '/gpt/arcanos-core',
      body: { action: 'query', payload: { action: 'dag.dispatch' } },
    })).toBe(false);

    expect(isPublicProviderAdmissionRequest({
      method: 'POST',
      path: '/gpt/arcanos-core',
      body: { payload: { action: 'query' } },
      query: { action: 'dag.status' },
      gptActionHeader: 'dag.trace',
    })).toBe(true);

    expect(isPublicProviderAdmissionRequest({
      method: 'POST',
      path: '/gpt/arcanos-core',
      query: { action: 'query' },
      gptActionHeader: 'dag.trace',
    })).toBe(true);
  });

  it('admits explicit provider query lanes even when their payload resembles a diagnostic', () => {
    expect(isPublicProviderAdmissionRequest({
      method: 'POST',
      path: '/gpt/arcanos-core',
      body: { action: 'query_and_wait', prompt: 'ping' },
    })).toBe(true);
    expect(isPublicProviderAdmissionRequest({
      method: 'POST',
      path: '/gpt/arcanos-core',
      body: { mode: 'diagnostic', prompt: 'ping' },
      query: { action: 'query' },
    })).toBe(true);
    expect(isPublicProviderAdmissionRequest({
      method: 'POST',
      path: '/gpt/arcanos-core',
      body: { prompt: 'ping' },
      gptActionHeader: 'query_and_wait',
    })).toBe(true);

    expect(isPublicProviderAdmissionRequest({
      method: 'POST',
      path: '/gpt/arcanos-core',
      body: { mode: 'diagnostic', prompt: 'Write a haiku.' },
    })).toBe(true);
    expect(isPublicProviderAdmissionRequest({
      method: 'POST',
      path: '/gpt/arcanos-core',
      body: { action: 'ping', prompt: 'Write a haiku.' },
    })).toBe(false);
    expect(isPublicProviderAdmissionRequest({
      method: 'POST',
      path: '/gpt/arcanos-core',
      body: {
        mode: 'diagnostic',
        action: 'generateBooking',
        prompt: 'Write a haiku.',
      },
    })).toBe(false);

    for (const candidate of [
      { body: { prompt: 'Write a haiku.', payload: { action: 'ping' } } },
      { body: { prompt: 'Write a haiku.' }, query: { action: 'ping' } },
      { body: { prompt: 'Write a haiku.' }, gptActionHeader: 'ping' },
    ]) {
      expect(isPublicProviderAdmissionRequest({
        method: 'POST',
        path: '/gpt/arcanos-core',
        ...candidate,
      })).toBe(true);
    }

    expect(isPublicProviderAdmissionRequest({
      method: 'POST',
      path: '/gpt/arcanos-core',
      body: {
        prompt: 'ping',
        payload: { prompt: 'Write a haiku.' },
      },
    })).toBe(true);

    expect(isPublicProviderAdmissionRequest({
      method: 'POST',
      path: '/gpt/arcanos-core',
      body: {
        prompt: 'ping',
        payload: { prompt: 'ping' },
      },
    })).toBe(false);
  });

  it('preserves exact automatic dispatch classification at the DAG threshold', () => {
    const atThreshold = resolveDispatchLane(
      { executionMode: 'auto', prompt: 'threshold' },
      () => ({ mode: 'dag', confidence: 0.85, reason: 'at_threshold' })
    );
    const belowThreshold = resolveDispatchLane(
      { executionMode: 'auto', prompt: 'below threshold' },
      () => ({ mode: 'dag', confidence: 0.849999, reason: 'below_threshold' })
    );

    expect(atThreshold).toMatchObject({
      lane: 'dag',
      reason: 'at_threshold:0.85',
    });
    expect(belowThreshold).toMatchObject({
      lane: 'gpt',
      reason: 'safe_fallback_gpt',
    });
  });

  it('charges one hierarchical budget exactly once and preserves global capacity on client denial', async () => {
    const limiter = createPublicProviderRateLimitMiddleware({
      clientIdentityResolver: (req) => String(req.header('x-test-client') ?? 'unknown'),
      clientMaxRequests: 2,
      maxRequests: 3,
      windowMs: 60_000,
    });
    const app = express();
    app.use(limiter);
    app.use(limiter);
    app.post(['/first', '/second', '/third', '/fourth', '/fifth'], (_req, res) => {
      res.json({ ok: true });
    });

    const first = await request(app)
      .post('/first')
      .set('x-test-client', 'caller-a');
    const second = await request(app)
      .post('/second')
      .set('x-test-client', 'caller-a');
    const third = await request(app)
      .post('/third')
      .set('x-test-client', 'caller-a');
    const fourth = await request(app)
      .post('/fourth')
      .set('x-test-client', 'caller-b');
    const fifth = await request(app)
      .post('/fifth')
      .set('x-test-client', 'caller-c');

    expect(first.status).toBe(200);
    expect(first.headers['x-ratelimit-remaining']).toBe('2');
    expect(second.status).toBe(200);
    expect(second.headers['x-ratelimit-remaining']).toBe('1');
    expect(third.status).toBe(429);
    expect(third.headers['x-ratelimit-bucket']).toBe(PUBLIC_PROVIDER_CLIENT_RATE_LIMIT_BUCKET);
    expect(third.headers['x-public-provider-global-remaining']).toBe('1');
    expect(third.headers['cache-control']).toBe('no-store');
    expect(fourth.status).toBe(200);
    expect(fourth.headers['x-ratelimit-remaining']).toBe('0');
    expect(fifth.status).toBe(429);
    expect(fifth.headers['x-ratelimit-bucket']).toBe(PUBLIC_PROVIDER_RATE_LIMIT_BUCKET);
  });

  it('preserves an earlier operation-specific rate policy until provider admission denies', async () => {
    const limiter = createPublicProviderRateLimitMiddleware({
      clientIdentityResolver: () => 'backstage-operator',
      clientMaxRequests: 10,
      maxRequests: 1,
      windowMs: 60_000,
    });
    const app = express();
    app.use((_req, res, next) => {
      res.set({
        'X-RateLimit-Limit': '10',
        'X-RateLimit-Remaining': '9',
        'X-RateLimit-Reset': '2030-01-01T00:00:00.000Z',
        'X-RateLimit-Bucket': 'backstage-mutation-principal',
      });
      next();
    });
    app.use(limiter);
    app.post('/provider', (_req, res) => res.json({ ok: true }));

    const admitted = await request(app).post('/provider');
    const denied = await request(app).post('/provider');

    expect(admitted.status).toBe(200);
    expect(admitted.headers['x-ratelimit-limit']).toBe('10');
    expect(admitted.headers['x-ratelimit-remaining']).toBe('9');
    expect(admitted.headers['x-ratelimit-reset']).toBe('2030-01-01T00:00:00.000Z');
    expect(admitted.headers['x-ratelimit-bucket']).toBe('backstage-mutation-principal');
    expect(admitted.headers['x-public-provider-client-remaining']).toBe('0');
    expect(admitted.headers['x-public-provider-global-remaining']).toBe('0');

    expect(denied.status).toBe(429);
    expect(denied.headers['x-ratelimit-limit']).toBe('1');
    expect(denied.headers['x-ratelimit-remaining']).toBe('0');
    expect(denied.headers['x-ratelimit-bucket']).toBe(PUBLIC_PROVIDER_RATE_LIMIT_BUCKET);
    expect(denied.headers['retry-after']).toBeDefined();
  });

  it('keeps the deployment bucket when the compatibility ceiling is one', async () => {
    const app = express();
    app.use(createPublicProviderRateLimitMiddleware({
      clientIdentityResolver: () => 'caller-a',
      maxRequests: 1,
      windowMs: 60_000,
    }));
    app.post('/provider', (_req, res) => res.json({ ok: true }));

    const admitted = await request(app).post('/provider');
    const denied = await request(app).post('/provider');

    expect(admitted.status).toBe(200);
    expect(denied.status).toBe(429);
    expect(denied.headers['x-ratelimit-bucket']).toBe(PUBLIC_PROVIDER_RATE_LIMIT_BUCKET);
    expect(denied.headers['x-ratelimit-limit']).toBe('1');
  });

  it('snapshots the legacy-route gate when the application admission middleware is built', async () => {
    const originalLegacyRouteMode = process.env.LEGACY_GPT_ROUTES;
    const rateLimit = jest.fn((
      _req: express.Request,
      res: express.Response
    ) => {
      res.status(429).json({ code: 'SNAPSHOTTED_LEGACY_ADMISSION' });
    });

    try {
      process.env.LEGACY_GPT_ROUTES = 'enabled';
      const enabledApp = express();
      enabledApp.use(createPublicProviderAdmissionMiddleware({
        rateLimitMiddleware: rateLimit,
      }));
      enabledApp.post('/write', (_req, res) => res.json({ ok: true }));
      process.env.LEGACY_GPT_ROUTES = 'disabled';

      const enabledResponse = await request(enabledApp).post('/write');
      expect(enabledResponse.status).toBe(429);
      expect(enabledResponse.body.code).toBe('SNAPSHOTTED_LEGACY_ADMISSION');
      expect(rateLimit).toHaveBeenCalledTimes(1);

      const disabledApp = express();
      disabledApp.use(createPublicProviderAdmissionMiddleware({
        rateLimitMiddleware: rateLimit,
      }));
      disabledApp.post('/write', (_req, res) => res.json({ ok: true }));
      process.env.LEGACY_GPT_ROUTES = 'enabled';

      const disabledResponse = await request(disabledApp).post('/write');
      expect(disabledResponse.status).toBe(200);
      expect(rateLimit).toHaveBeenCalledTimes(1);
    } finally {
      if (originalLegacyRouteMode === undefined) {
        delete process.env.LEGACY_GPT_ROUTES;
      } else {
        process.env.LEGACY_GPT_ROUTES = originalLegacyRouteMode;
      }
    }
  });

  it('falls back from unsafe or operationally unbounded ceiling values', async () => {
    expect(normalizePublicProviderRateLimitMax('1')).toBe(1);
    expect(normalizePublicProviderRateLimitMax('2')).toBe(2);
    for (const invalidMax of ['0', '-1', '1.5', 'not-a-number']) {
      expect(normalizePublicProviderRateLimitMax(invalidMax)).toBe(100);
    }
    expect(normalizePublicProviderClientRateLimitMax(undefined, 1)).toBe(1);
    expect(normalizePublicProviderClientRateLimitMax('20', 100)).toBe(20);
    expect(normalizePublicProviderClientRateLimitMax('100', 100)).toBe(20);
    expect(normalizePublicProviderClientRateLimitMax(undefined, 6)).toBe(5);

    expect(normalizePublicProviderRateLimitWindowMs('1000')).toBe(1000);
    for (const invalidWindow of ['0', '999', '-1', '1000.5', 'not-a-number']) {
      expect(normalizePublicProviderRateLimitWindowMs(invalidWindow)).toBe(15 * 60 * 1000);
    }

    expect(normalizePublicProviderRateLimitMax(Number.MAX_SAFE_INTEGER + 1)).toBe(100);
    expect(normalizePublicProviderRateLimitWindowMs(30 * 24 * 60 * 60 * 1000 + 1)).toBe(
      15 * 60 * 1000
    );
    expect(normalizePublicProviderRateLimitStoreMode('memory', 'production')).toBe('redis');
    expect(normalizePublicProviderRateLimitStoreMode('redis', 'development')).toBe('redis');
    expect(normalizePublicProviderRateLimitStoreMode(undefined, 'test')).toBe('memory');
    expect(resolvePublicProviderRateLimitNamespace({
      configuredNamespace: 'Prod_Web-1',
      nodeEnvironment: 'production',
    })).toBe('configured:prod_web-1');
    expect(resolvePublicProviderRateLimitNamespace({
      nodeEnvironment: 'production',
      railwayProjectId: 'project',
      railwayEnvironmentId: 'environment',
      railwayServiceId: 'service',
    })).toBe('railway:project:environment:service');
    expect(resolvePublicProviderRateLimitNamespace({
      configuredNamespace: 'shared-but-wrong',
      nodeEnvironment: 'production',
      railwayProjectId: 'project',
      railwayEnvironmentId: 'environment',
      railwayServiceId: 'service',
    })).toBe('railway:project:environment:service');
    expect(resolvePublicProviderRateLimitNamespace({
      configuredNamespace: 'invalid namespace',
      nodeEnvironment: 'production',
      railwayProjectId: 'project',
      railwayEnvironmentId: 'environment',
      railwayServiceId: 'service',
    })).toBe('railway:project:environment:service');
    expect(resolvePublicProviderRateLimitNamespace({
      configuredNamespace: 'invalid namespace',
      nodeEnvironment: 'production',
    })).toBeNull();
    expect(resolvePublicProviderRateLimitNamespace({
      nodeEnvironment: 'production',
    })).toBeNull();
    const completeRailwayIdentity = {
      railwayProjectId: 'project',
      railwayEnvironmentId: 'environment',
      railwayServiceId: 'service',
    };
    expect(resolvePublicProviderTrustRailwayRealIp('true', completeRailwayIdentity)).toBe(true);
    expect(resolvePublicProviderTrustRailwayRealIp('false', completeRailwayIdentity)).toBe(false);
    expect(resolvePublicProviderTrustRailwayRealIp('true', {
      ...completeRailwayIdentity,
      railwayServiceId: '',
    })).toBe(false);

    const unsafeMaxApp = express();
    unsafeMaxApp.use(createPublicProviderRateLimitMiddleware({
      maxRequests: 1_000_001,
      windowMs: 60_000,
    }));
    unsafeMaxApp.post('/provider', (_req, res) => res.json({ ok: true }));

    const unsafeMaxResponse = await request(unsafeMaxApp).post('/provider');
    expect(unsafeMaxResponse.status).toBe(200);
    expect(unsafeMaxResponse.headers['x-ratelimit-limit']).toBe('100');

    const unsafeWindowApp = express();
    unsafeWindowApp.use(createPublicProviderRateLimitMiddleware({
      maxRequests: 1,
      windowMs: Number.MAX_VALUE,
    }));
    unsafeWindowApp.post('/provider', (_req, res) => res.json({ ok: true }));

    const startedAt = Date.now();
    const unsafeWindowResponse = await request(unsafeWindowApp).post('/provider');
    const resetAt = Date.parse(String(unsafeWindowResponse.headers['x-ratelimit-reset']));
    expect(unsafeWindowResponse.status).toBe(200);
    expect(resetAt - startedAt).toBeGreaterThanOrEqual(14 * 60 * 1000);
    expect(resetAt - startedAt).toBeLessThanOrEqual(16 * 60 * 1000);
  });

  it('catches a generic GPT reroute without double charging canonical GPT requests', async () => {
    const limiter = createPublicProviderRateLimitMiddleware({
      clientIdentityResolver: (req) => String(req.header('x-test-client') ?? 'unknown'),
      clientMaxRequests: 2,
      maxRequests: 3,
      windowMs: 60_000,
    });
    const app = express();
    app.use(express.json());
    app.use((req, res, next) => {
      if (!isPublicProviderAdmissionRequest({
        method: req.method,
        path: req.path,
        body: req.body,
      })) {
        next();
        return;
      }
      limiter(req, res, next);
    });

    const gptRouter = express.Router();
    gptRouter.post('/arcanos-gaming/evidence-retry', (req, _res, next) => {
      req.url = '/arcanos-gaming';
      next('route');
    });
    gptRouter.post('/:gptId', limiter, (_req, res) => {
      res.json({ ok: true });
    });
    app.use('/gpt', gptRouter);

    const rerouted = await request(app)
      .post('/gpt/arcanos-gaming/evidence-retry')
      .set('x-test-client', 'caller-a')
      .send({ originalPrompt: 'current guide' });
    const canonical = await request(app)
      .post('/gpt/arcanos-core')
      .set('x-test-client', 'caller-a')
      .send({ action: 'query' });
    const clientDenied = await request(app)
      .post('/gpt/guide')
      .set('x-test-client', 'caller-a')
      .send({ action: 'query' });
    const otherCaller = await request(app)
      .post('/gpt/guide')
      .set('x-test-client', 'caller-b')
      .send({ action: 'query' });
    const globallyDenied = await request(app)
      .post('/gpt/guide')
      .set('x-test-client', 'caller-c')
      .send({ action: 'query' });

    expect(rerouted.status).toBe(200);
    expect(rerouted.headers['x-ratelimit-remaining']).toBe('2');
    expect(canonical.status).toBe(200);
    expect(canonical.headers['x-ratelimit-remaining']).toBe('1');
    expect(clientDenied.status).toBe(429);
    expect(clientDenied.headers['x-ratelimit-bucket']).toBe(
      PUBLIC_PROVIDER_CLIENT_RATE_LIMIT_BUCKET
    );
    expect(otherCaller.status).toBe(200);
    expect(otherCaller.headers['x-ratelimit-remaining']).toBe('0');
    expect(globallyDenied.status).toBe(429);
    expect(globallyDenied.headers['x-ratelimit-bucket']).toBe(
      PUBLIC_PROVIDER_RATE_LIMIT_BUCKET
    );
  });

  it('ignores caller-selected metadata unless Railway real-IP trust is explicit', async () => {
    const untrustedLimiter = createPublicProviderRateLimitMiddleware({
      clientMaxRequests: 1,
      maxRequests: 3,
      windowMs: 60_000,
    });
    const untrustedApp = express();
    untrustedApp.set('trust proxy', true);
    untrustedApp.use(untrustedLimiter);
    untrustedApp.post('/provider', (_req, res) => res.json({ ok: true }));

    const first = await request(untrustedApp)
      .post('/provider')
      .set('x-session-id', 'rotated-a')
      .set('Authorization', 'Bearer rotated-a')
      .set('x-forwarded-for', '198.51.100.1');
    const rotated = await request(untrustedApp)
      .post('/provider')
      .set('x-session-id', 'rotated-b')
      .set('Authorization', 'Bearer rotated-b')
      .set('x-forwarded-for', '198.51.100.2');

    expect(first.status).toBe(200);
    expect(rotated.status).toBe(429);
    expect(rotated.headers['x-ratelimit-bucket']).toBe(
      PUBLIC_PROVIDER_CLIENT_RATE_LIMIT_BUCKET
    );

    const directRailwayLimiter = createPublicProviderRateLimitMiddleware({
      clientMaxRequests: 1,
      maxRequests: 3,
      trustRailwayRealIp: true,
      windowMs: 60_000,
    });
    const directRailwayApp = express();
    directRailwayApp.use(directRailwayLimiter);
    directRailwayApp.post('/provider', (_req, res) => res.json({ ok: true }));

    const directRailwayA = await request(directRailwayApp)
      .post('/provider')
      .set('x-railway-edge', 'iad1')
      .set('x-real-ip', '198.51.100.10');
    const directRailwayB = await request(directRailwayApp)
      .post('/provider')
      .set('x-railway-edge', 'iad1')
      .set('x-real-ip', '198.51.100.11');

    expect(directRailwayA.status).toBe(200);
    expect(directRailwayB.status).toBe(429);

    const trustedRailwayLimiter = createPublicProviderRateLimitMiddleware({
      clientMaxRequests: 1,
      maxRequests: 3,
      railwayEdgePeerMatcher: () => true,
      trustRailwayRealIp: true,
      windowMs: 60_000,
    });
    const trustedRailwayApp = express();
    trustedRailwayApp.use(trustedRailwayLimiter);
    trustedRailwayApp.post('/provider', (_req, res) => res.json({ ok: true }));

    const railwayA = await request(trustedRailwayApp)
      .post('/provider')
      .set('x-railway-edge', 'iad1')
      .set('x-real-ip', '198.51.100.10');
    const railwayB = await request(trustedRailwayApp)
      .post('/provider')
      .set('x-railway-edge', 'iad1')
      .set('x-real-ip', '198.51.100.11');
    const railwayARepeated = await request(trustedRailwayApp)
      .post('/provider')
      .set('x-railway-edge', 'iad1')
      .set('x-real-ip', '198.51.100.10')
      .set('x-forwarded-for', '203.0.113.99');

    expect(railwayA.status).toBe(200);
    expect(railwayB.status).toBe(200);
    expect(railwayARepeated.status).toBe(429);
    expect(railwayARepeated.headers['x-public-provider-global-remaining']).toBe('1');

    const trustedPeerRequest = (headers: Request['headers']): Request => ({
      headers,
      socket: { remoteAddress: '100.64.0.8' },
    } as unknown as Request);
    const trustOptions = {
      railwayEdgePeerMatcher: () => true,
      trustRailwayRealIp: true,
    };
    for (const headers of [
      { 'x-real-ip': '198.51.100.20' },
      { 'x-railway-edge': 'invalid', 'x-real-ip': '198.51.100.20' },
      { 'x-railway-edge': ['iad1', 'ewr1'], 'x-real-ip': '198.51.100.20' },
      { 'x-railway-edge': 'iad1', 'x-real-ip': 'invalid' },
      { 'x-railway-edge': 'iad1', 'x-real-ip': '198.51.100.20, 198.51.100.21' },
    ] as Request['headers'][]) {
      expect(resolvePublicProviderClientIdentity(
        trustedPeerRequest(headers),
        trustOptions
      )).toBe('network:ipv4:100.64.0.8/32');
    }

    const authenticatedRequest = trustedPeerRequest({
      'x-railway-edge': 'iad1',
      'x-real-ip': '198.51.100.20',
    });
    authenticatedRequest.authenticatedActorKey = 'server-established-actor';
    expect(resolvePublicProviderClientIdentity(authenticatedRequest, trustOptions)).toBe(
      'actor:server-established-actor'
    );
  });

  it('canonicalizes IPv4-mapped callers and groups IPv6 privacy addresses by /64', () => {
    expect(normalizePublicProviderClientAddress('198.51.100.8')).toBe(
      'ipv4:198.51.100.8/32'
    );
    expect(normalizePublicProviderClientAddress('::ffff:198.51.100.8')).toBe(
      'ipv4:198.51.100.8/32'
    );
    expect(normalizePublicProviderClientAddress('2001:db8:abcd:12::1')).toBe(
      'ipv6:2001:0db8:abcd:0012::/64'
    );
    expect(normalizePublicProviderClientAddress('2001:0db8:abcd:0012:ffff::99')).toBe(
      'ipv6:2001:0db8:abcd:0012::/64'
    );
    expect(normalizePublicProviderClientAddress('not-an-ip')).toBeNull();
    expect(isTrustedRailwayEdgePeerAddress('100.64.0.1')).toBe(true);
    expect(isTrustedRailwayEdgePeerAddress('::ffff:100.127.255.254')).toBe(true);
    expect(isTrustedRailwayEdgePeerAddress('10.0.0.1')).toBe(false);
    expect(isTrustedRailwayEdgePeerAddress('fd12::1')).toBe(false);
  });
});
