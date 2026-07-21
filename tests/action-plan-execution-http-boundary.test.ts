import express from 'express';
import request from 'supertest';
import {
  ACTION_PLAN_EXECUTION_BODY_LIMIT_BYTES,
  isActionPlanExecutionBoundedBodyRoute,
  readActionPlanIdempotencyKey,
} from '../src/services/actionPlanExecution/http.js';
import { phase2eActionPlanInputSchema } from '../src/shared/types/actionPlan.js';
import {
  createRateLimitMiddleware,
  getRequestActorKey,
  getRequestClientAddress,
} from '../src/platform/runtime/security.js';

describe('Phase 2E HTTP boundary', () => {
  it.each([
    ['/plans'],
    ['/plans/p/approve'],
    ['/plans/p/block'],
    ['/plans/p/expire'],
    ['/plans/p/execute'],
    ['/agents'],
    ['/agents/register'],
    ['/agents/a/heartbeat'],
    ['/agents/a/capabilities/grant'],
    ['/action-plan-executions/claim-next'],
    ['/plans/p/executions/r/claim'],
    ['/plans/p/executions/r/start'],
    ['/plans/p/executions/r/result'],
    ['/plans/p/execute/'],
    ['/plans/p/executions/r/result/'],
  ])('selects only the bounded POST parser for %s', path => {
    expect(isActionPlanExecutionBoundedBodyRoute('POST', path)).toBe(true);
    expect(isActionPlanExecutionBoundedBodyRoute('GET', path)).toBe(false);
  });

  it.each(['/plans', '/plans/p/executions/r/result'])(
    'enforces the 64 KiB limit before a broader global JSON parser for %s',
    async path => {
    const app = express();
    const bounded = express.json({ limit: '64kb', strict: true });
    app.use((req, res, next) => {
      if (isActionPlanExecutionBoundedBodyRoute(req.method, req.path)) bounded(req, res, next);
      else next();
    });
    app.use(express.json({ limit: '10mb' }));
    app.post('/plans', (_req, res) => res.json({ ok: true }));
    app.post('/plans/:planId/executions/:runId/result', (_req, res) => res.json({ ok: true }));
    app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      res.status((error as { status?: number }).status ?? 500).json({ code: 'BOUNDED_PARSE_REJECTED' });
    });

    const response = await request(app)
      .post(path)
      .set('Content-Type', 'application/json')
      .send(JSON.stringify({ value: 'x'.repeat(ACTION_PLAN_EXECUTION_BODY_LIMIT_BYTES) }));
    expect(response.status).toBe(413);
    expect(response.body).toEqual({ code: 'BOUNDED_PARSE_REJECTED' });
    },
  );

  it('rejects missing, duplicated, whitespace, and overlong idempotency keys', () => {
    const build = (value?: string, duplicate = false) => ({
      rawHeaders: value
        ? (duplicate ? ['Idempotency-Key', value, 'idempotency-key', value] : ['Idempotency-Key', value])
        : [],
      header: () => value,
    }) as unknown as express.Request;
    expect(() => readActionPlanIdempotencyKey(build('command-key-1'))).not.toThrow();
    for (const candidate of [undefined, '', ' leading', 'trailing ', 'x'.repeat(257)]) {
      expect(() => readActionPlanIdempotencyKey(build(candidate))).toThrow('invalid');
    }
    expect(() => readActionPlanIdempotencyKey(build('command-key-1', true))).toThrow('invalid');
  });

  it('strictly bounds ActionPlan creation fields, depth, and prototype-sensitive keys', () => {
    const valid = {
      created_by: 'user',
      origin: 'phase2e-test',
      idempotency_key: 'plan-key-1',
      actions: [{ agent_id: 'agent-1', capability: 'terminal.run', params: { command: 'synthetic' } }],
    };
    expect(phase2eActionPlanInputSchema.safeParse(valid).success).toBe(true);
    expect(phase2eActionPlanInputSchema.safeParse({ ...valid, unexpected: true }).success).toBe(false);

    let nested: unknown = 'leaf';
    for (let index = 0; index < 10; index += 1) nested = { nested };
    expect(phase2eActionPlanInputSchema.safeParse({
      ...valid,
      actions: [{ ...valid.actions[0], params: nested }],
    }).success).toBe(false);

    const poisonedParams = JSON.parse('{"__proto__":{"polluted":true}}');
    expect(phase2eActionPlanInputSchema.safeParse({
      ...valid,
      actions: [{ ...valid.actions[0], params: poisonedParams }],
    }).success).toBe(false);
    expect(({} as { polluted?: boolean }).polluted).toBeUndefined();
  });

  it('rejects non-JSON parameters and encoded plans outside the Phase 2E bounds', () => {
    const valid = {
      created_by: 'user' as const,
      origin: 'phase2e-test',
      idempotency_key: 'plan-key-1',
      actions: [{ agent_id: 'agent-1', capability: 'terminal.run', params: {} }],
    };

    expect(phase2eActionPlanInputSchema.safeParse({
      ...valid,
      actions: [{ ...valid.actions[0], params: { values: [null, 'text', true, 1, { nested: 'ok' }] } }],
    }).success).toBe(true);

    for (const invalid of [Number.NaN, Symbol('not-json')]) {
      expect(phase2eActionPlanInputSchema.safeParse({
        ...valid,
        actions: [{ ...valid.actions[0], params: { invalid } }],
      }).success).toBe(false);
    }

    const unserializableParams: Record<string, unknown> = {};
    Object.defineProperty(unserializableParams, 'toJSON', {
      enumerable: false,
      value: () => { throw new TypeError('test-only serialization failure'); },
    });
    expect(phase2eActionPlanInputSchema.safeParse({
      ...valid,
      actions: [{ ...valid.actions[0], params: unserializableParams }],
    }).success).toBe(false);

    expect(phase2eActionPlanInputSchema.safeParse({
      ...valid,
      actions: Array.from({ length: 3 }, (_, index) => ({
        agent_id: `agent-${index}`,
        capability: 'terminal.run',
        params: { payload: 'x'.repeat(22_000) },
      })),
    }).success).toBe(false);
  });

  it('shares a client bucket across rotating invalid credentials while keeping credential keys opaque', async () => {
    const app = express();
    const clientLimiter = createRateLimitMiddleware({
      bucketName: 'phase2e-client-test',
      maxRequests: 2,
      windowMs: 60_000,
      keyGenerator: req => `client:${getRequestClientAddress(req)}`,
    });
    const credentialLimiter = createRateLimitMiddleware({
      bucketName: 'phase2e-credential-test',
      maxRequests: 10,
      windowMs: 60_000,
      keyGenerator: req => `client:${getRequestClientAddress(req)}:${getRequestActorKey(req)}`,
    });
    app.use('/plans', clientLimiter, credentialLimiter);
    app.get('/plans', (_req, res) => res.status(401).json({ code: 'AUTH_REQUIRED' }));

    const tokens = ['invalid-one', 'invalid-two', 'invalid-three'];
    const responses = [];
    for (const token of tokens) {
      responses.push(await request(app).get('/plans').set('Authorization', `Bearer ${token}`));
    }
    expect(responses.map(response => response.status)).toEqual([401, 401, 429]);
    expect(responses[2].headers['x-ratelimit-bucket']).toBe('phase2e-client-test');
    expect(JSON.stringify(responses.map(response => response.body))).not.toContain(tokens[0]);
    expect(JSON.stringify(responses.map(response => response.body))).not.toContain(tokens[1]);
    expect(JSON.stringify(responses.map(response => response.body))).not.toContain(tokens[2]);
  });
});
