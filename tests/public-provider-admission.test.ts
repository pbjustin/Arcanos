import express from 'express';
import { describe, expect, it } from '@jest/globals';

import {
  PUBLIC_PROVIDER_RATE_LIMIT_BUCKET,
  createPublicProviderRateLimitMiddleware,
  isPublicProviderAdmissionRequest,
} from '../src/transport/http/middleware/publicProviderAdmission.js';
import {
  createRateLimitMiddleware,
  getRequestActorKey,
} from '../src/platform/runtime/security.js';
import {
  normalizePublicProviderRateLimitMax,
  normalizePublicProviderRateLimitWindowMs,
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
    ['/dispatch', { target: 'gpt', action: 'dag.run.create' }],
    ['/dispatch', { gptId: 'arcanos-core', action: 'dag.run.create', executionMode: 'dag' }],
    ['/dispatch', { executionMode: 'gpt', prompt: 'Run the workflow now.' }],
    ['/dispatch', { prompt: 'Answer this question.' }],
  ] as const)('admits public provider work at POST %s', (path, body) => {
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
  ] as const)('excludes non-public-provider work at POST %s', (path, body) => {
    expect(isPublicProviderAdmissionRequest({
      method: 'POST',
      path,
      body,
    }, { legacyGptRoutesEnabled: true })).toBe(false);
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

  it('charges one constant-key budget exactly once across duplicate mounts', async () => {
    const limiter = createPublicProviderRateLimitMiddleware({
      maxRequests: 2,
      windowMs: 60_000,
    });
    const app = express();
    app.use(limiter);
    app.use(limiter);
    app.post(['/first', '/second', '/third'], (_req, res) => {
      res.json({ ok: true });
    });

    const first = await request(app)
      .post('/first')
      .set('x-session-id', 'caller-a')
      .set('Authorization', 'Bearer caller-a')
      .set('x-forwarded-for', '198.51.100.1');
    const second = await request(app)
      .post('/second')
      .set('x-session-id', 'caller-b')
      .set('Authorization', 'Bearer caller-b')
      .set('x-forwarded-for', '198.51.100.2');
    const third = await request(app)
      .post('/third')
      .set('x-session-id', 'caller-c')
      .set('Authorization', 'Bearer caller-c')
      .set('x-forwarded-for', '198.51.100.3');

    expect(first.status).toBe(200);
    expect(first.headers['x-ratelimit-remaining']).toBe('1');
    expect(second.status).toBe(200);
    expect(second.headers['x-ratelimit-remaining']).toBe('0');
    expect(third.status).toBe(429);
    expect(third.headers['x-ratelimit-bucket']).toBe(PUBLIC_PROVIDER_RATE_LIMIT_BUCKET);
    expect(third.headers['cache-control']).toBe('no-store');
  });

  it('falls back from unsafe or operationally unbounded ceiling values', async () => {
    expect(normalizePublicProviderRateLimitMax('1')).toBe(1);
    for (const invalidMax of ['0', '-1', '1.5', 'not-a-number']) {
      expect(normalizePublicProviderRateLimitMax(invalidMax)).toBe(100);
    }

    expect(normalizePublicProviderRateLimitWindowMs('1000')).toBe(1000);
    for (const invalidWindow of ['0', '999', '-1', '1000.5', 'not-a-number']) {
      expect(normalizePublicProviderRateLimitWindowMs(invalidWindow)).toBe(15 * 60 * 1000);
    }

    expect(normalizePublicProviderRateLimitMax(Number.MAX_SAFE_INTEGER + 1)).toBe(100);
    expect(normalizePublicProviderRateLimitWindowMs(30 * 24 * 60 * 60 * 1000 + 1)).toBe(
      15 * 60 * 1000
    );

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
      maxRequests: 2,
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
      .send({ originalPrompt: 'current guide' });
    const canonical = await request(app)
      .post('/gpt/arcanos-core')
      .send({ action: 'query' });
    const denied = await request(app)
      .post('/gpt/guide')
      .send({ action: 'query' });

    expect(rerouted.status).toBe(200);
    expect(rerouted.headers['x-ratelimit-remaining']).toBe('1');
    expect(canonical.status).toBe(200);
    expect(canonical.headers['x-ratelimit-remaining']).toBe('0');
    expect(denied.status).toBe(429);
  });

  it('keeps caller-level fairness limits in addition to the instance ceiling', async () => {
    const hardCeiling = createPublicProviderRateLimitMiddleware({
      maxRequests: 3,
      windowMs: 60_000,
    });
    const fairnessLimit = createRateLimitMiddleware({
      bucketName: 'representative-route-fairness',
      maxRequests: 1,
      windowMs: 60_000,
      keyGenerator: (req) => getRequestActorKey(req),
    });
    const app = express();
    app.use(hardCeiling);
    app.use(fairnessLimit);
    app.post('/provider', (_req, res) => {
      res.json({ ok: true });
    });

    const actorA = await request(app).post('/provider').set('x-session-id', 'actor-a');
    const actorB = await request(app).post('/provider').set('x-session-id', 'actor-b');
    const repeatedActorA = await request(app).post('/provider').set('x-session-id', 'actor-a');
    const actorCAfterFairnessDenial = await request(app)
      .post('/provider')
      .set('x-session-id', 'actor-c');

    expect(actorA.status).toBe(200);
    expect(actorB.status).toBe(200);
    expect(repeatedActorA.status).toBe(429);
    expect(repeatedActorA.headers['x-ratelimit-bucket']).toBe('representative-route-fairness');
    expect(repeatedActorA.headers['x-ratelimit-limit']).toBe('1');
    expect(actorCAfterFairnessDenial.status).toBe(429);
    expect(actorCAfterFairnessDenial.headers['x-ratelimit-bucket']).toBe(
      PUBLIC_PROVIDER_RATE_LIMIT_BUCKET
    );
  });
});
