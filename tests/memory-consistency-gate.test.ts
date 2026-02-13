import { describe, expect, it, jest } from '@jest/globals';
import express, { type Request, type Response } from 'express';
import request from 'supertest';
import { createMemoryConsistencyGate } from '../src/middleware/memoryConsistencyGate.js';
import type {
  DispatchMemorySnapshotV9,
  DispatchPatternBindingV9
} from '../src/types/dispatchV9.js';

type SnapshotRecord = {
  snapshot: DispatchMemorySnapshotV9;
  memoryVersion: string;
  loadedFrom: 'cache' | 'db' | 'created';
};

function createDispatchLoggerMock() {
  const loggerMock = {
    child: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn()
  };
  loggerMock.child.mockReturnValue(loggerMock);
  return loggerMock;
}

function createSnapshotRecord(
  memoryVersion: string,
  routeState: DispatchMemorySnapshotV9['route_state']
): SnapshotRecord {
  return {
    snapshot: {
      schema_version: 'v9',
      bindings_version: 'bindings-v9-test',
      version_id: `snapshot-${memoryVersion}`,
      monotonic_ts_ms: Date.parse(memoryVersion) || 1700000000000,
      memory_version: memoryVersion,
      trusted_snapshot_id: `snapshot-${memoryVersion}`,
      route_state: routeState,
      updated_at: memoryVersion,
      updated_by: 'test'
    },
    memoryVersion,
    loadedFrom: 'db'
  };
}

const TEST_BINDINGS: DispatchPatternBindingV9[] = [
  {
    id: 'api.ask',
    priority: 120,
    methods: ['POST'],
    exactPaths: ['/api/ask'],
    sensitivity: 'non-sensitive',
    conflictPolicy: 'refresh_then_reroute',
    rerouteTarget: '/api/ask',
    expectedRoute: '/api/ask'
  },
  {
    id: 'api.modules',
    priority: 100,
    methods: ['POST'],
    exactPaths: ['/api/commands/execute'],
    sensitivity: 'non-sensitive',
    conflictPolicy: 'refresh_then_reroute',
    rerouteTarget: '/api/ask',
    expectedRoute: '/api/commands/execute'
  },
  {
    id: 'api.gpt',
    priority: 110,
    methods: ['POST'],
    exactPaths: ['/api/gpt/run'],
    sensitivity: 'sensitive',
    conflictPolicy: 'strict_block',
    expectedRoute: '/api/gpt/run'
  },
  {
    id: 'api.default',
    priority: 1,
    methods: ['GET', 'POST'],
    pathRegexes: ['^/api(?:/.*)?$'],
    sensitivity: 'non-sensitive',
    conflictPolicy: 'refresh_then_reroute',
    rerouteTarget: '/api/ask',
    expectedRoute: '*'
  }
];

function createTestApp(options: {
  getSnapshot: jest.Mock;
  upsertRouteState?: jest.Mock;
  rollbackToTrustedSnapshot?: jest.Mock;
  getCachedSnapshot?: jest.Mock;
  recordTrace?: (name: string, attributes: Record<string, unknown>) => unknown;
}) {
  const app = express();
  app.use(express.json());
  const loggerMock = createDispatchLoggerMock();

  app.use(
    createMemoryConsistencyGate({
      enabled: true,
      shadowOnly: false,
      bindings: TEST_BINDINGS,
      bindingsVersion: 'bindings-v9-test',
      now: () => new Date('2026-02-06T05:00:00.000Z'),
      dispatchLogger: loggerMock as never,
      recordTrace:
        options.recordTrace ||
        ((name: string, attributes: Record<string, unknown>) => ({
          id: `${name}-trace`,
          timestamp: '2026-02-06T05:00:00.000Z',
          name,
          attributes
        })),
      snapshotStore: {
        getSnapshot: options.getSnapshot,
        getCachedSnapshot: options.getCachedSnapshot,
        rollbackToTrustedSnapshot: options.rollbackToTrustedSnapshot,
        upsertRouteState:
          options.upsertRouteState || (jest.fn(async () => undefined) as unknown as typeof options.getSnapshot)
      }
    })
  );

  app.get('/api/memory/health', (req, res) => {
    res.json({
      ok: true,
      decision: req.dispatchDecision
    });
  });

  app.post('/api/ask', (req, res) => {
    res.json({
      handled: 'ask',
      decision: req.dispatchDecision,
      rerouted: req.dispatchRerouted ?? false,
      body: req.body
    });
  });

  app.post('/api/commands/execute', (req, res) => {
    res.json({
      handled: 'commands',
      decision: req.dispatchDecision,
      rerouted: req.dispatchRerouted ?? false,
      body: req.body
    });
  });

  app.post('/api/gpt/run', (req, res) => {
    res.json({
      handled: 'gpt',
      decision: req.dispatchDecision
    });
  });

  return app;
}

describe('memoryConsistencyGate', () => {
  it('bypasses exempt routes', async () => {
    const getSnapshot = jest.fn();
    const app = createTestApp({ getSnapshot });

    const response = await request(app).get('/api/memory/health');
    expect(response.status).toBe(200);
    expect(response.body.ok).toBe(true);
    expect(response.headers['x-dispatch-decision']).toBe('allow');
    expect(response.headers['x-dispatch-binding']).toBe('api.readonly');
    expect(getSnapshot).not.toHaveBeenCalled();
  });

  it('allows valid route with matching memory version and sets headers', async () => {
    const memoryVersion = '2026-02-06T05:10:00.000Z';
    const getSnapshot = jest.fn(async () =>
      createSnapshotRecord(memoryVersion, {
        'POST /api/commands/execute': {
          expected_route: 'POST /api/commands/execute',
          last_validated_at: memoryVersion,
          hard_conflict: false
        }
      })
    );
    const upsertRouteState = jest.fn(async () => undefined);
    const recordTrace = jest.fn();
    const app = createTestApp({
      getSnapshot,
      upsertRouteState,
      recordTrace
    });

    const response = await request(app)
      .post('/api/commands/execute')
      .set('x-memory-version', memoryVersion)
      .send({ message: 'run command' });

    expect(response.status).toBe(200);
    expect(response.body.handled).toBe('commands');
    expect(response.body.decision).toBe('allow');
    expect(response.headers['x-dispatch-memory-version']).toBe(memoryVersion);
    expect(response.headers['x-dispatch-decision']).toBe('allow');
    expect(response.headers['x-dispatch-binding']).toBe('api.modules');
    expect(upsertRouteState).not.toHaveBeenCalled();
    expect(recordTrace).toHaveBeenCalledWith(
      'dispatch.v9.decision',
      expect.objectContaining({
        route_attempted: 'POST /api/commands/execute',
        memory_version: memoryVersion,
        decision: 'allow'
      })
    );
  });

  it('refreshes stale version once and allows when refreshed snapshot matches', async () => {
    const staleVersion = '2026-02-06T05:00:00.000Z';
    const freshVersion = '2026-02-06T05:00:01.000Z';
    const routeState = {
      'POST /api/commands/execute': {
        expected_route: 'POST /api/commands/execute',
        last_validated_at: freshVersion,
        hard_conflict: false
      }
    };
    const getSnapshot = jest
      .fn()
      .mockResolvedValueOnce(createSnapshotRecord(staleVersion, routeState))
      .mockResolvedValueOnce(createSnapshotRecord(freshVersion, routeState));

    const app = createTestApp({ getSnapshot });

    const response = await request(app)
      .post('/api/commands/execute')
      .set('x-memory-version', freshVersion)
      .send({ message: 'refresh please' });

    expect(response.status).toBe(200);
    expect(response.headers['x-dispatch-decision']).toBe('allow');
    expect(getSnapshot).toHaveBeenCalledTimes(2);
    expect(getSnapshot).toHaveBeenNthCalledWith(2, { forceRefresh: true });
  });

  it('reroutes non-sensitive unresolved conflicts to safe default dispatcher', async () => {
    const memoryVersion = '2026-02-06T05:20:00.000Z';
    const conflictSnapshot = createSnapshotRecord(memoryVersion, {
      'POST /api/commands/execute': {
        expected_route: 'POST /api/legacy',
        last_validated_at: memoryVersion,
        hard_conflict: false
      }
    });
    const getSnapshot = jest
      .fn()
      .mockResolvedValueOnce(conflictSnapshot)
      .mockResolvedValueOnce(conflictSnapshot);

    const app = createTestApp({ getSnapshot });

    const response = await request(app)
      .post('/api/commands/execute')
      .send({ message: 'reroute this command' });

    expect(response.status).toBe(200);
    expect(response.body.handled).toBe('ask');
    expect(response.body.decision).toBe('reroute');
    expect(response.body.rerouted).toBe(true);
    expect(response.body.body.dispatchReroute).toEqual(
      expect.objectContaining({
        originalRoute: 'POST /api/commands/execute',
        reason: 'route_drift',
        memoryVersion
      })
    );
    expect(response.headers['x-dispatch-decision']).toBe('reroute');
    expect(response.headers['x-dispatch-binding']).toBe('api.modules');
  });

  it('blocks sensitive unresolved conflicts with 409', async () => {
    const memoryVersion = '2026-02-06T05:30:00.000Z';
    const getSnapshot = jest
      .fn()
      .mockResolvedValueOnce(
        createSnapshotRecord(memoryVersion, {
          'POST /api/gpt/run': {
            expected_route: 'POST /api/legacy-gpt',
            last_validated_at: memoryVersion,
            hard_conflict: false
          }
        })
      )
      .mockResolvedValueOnce(
        createSnapshotRecord(memoryVersion, {
          'POST /api/gpt/run': {
            expected_route: 'POST /api/legacy-gpt',
            last_validated_at: memoryVersion,
            hard_conflict: false
          }
        })
      );
    const app = createTestApp({ getSnapshot });

    const response = await request(app).post('/api/gpt/run').send({ message: 'sensitive' });

    expect(response.status).toBe(409);
    expect(response.body.code).toBe('MEMORY_ROUTE_CONFLICT');
    expect(response.headers['x-dispatch-decision']).toBe('block');
    expect(response.headers['x-dispatch-binding']).toBe('api.gpt');
  });

  it('restores request state and returns 503 when reroute execution throws', async () => {
    const memoryVersion = '2026-02-06T05:40:00.000Z';
    const conflictSnapshot = createSnapshotRecord(memoryVersion, {
      'POST /api/commands/execute': {
        expected_route: 'POST /api/legacy',
        last_validated_at: memoryVersion,
        hard_conflict: false
      }
    });

    const middleware = createMemoryConsistencyGate({
      enabled: true,
      shadowOnly: false,
      bindings: TEST_BINDINGS,
      bindingsVersion: 'bindings-v9-test',
      now: () => new Date('2026-02-06T05:40:00.000Z'),
      dispatchLogger: createDispatchLoggerMock() as never,
      recordTrace: (_name: string, attributes: Record<string, unknown>) => {
        if (attributes.decision === 'reroute') {
          throw new Error('trace failure on reroute');
        }
        return {
          id: 'trace-ok',
          timestamp: '2026-02-06T05:40:00.000Z',
          name: 'dispatch.v9.decision',
          attributes
        };
      },
      snapshotStore: {
        getSnapshot: jest.fn(async () => conflictSnapshot),
        upsertRouteState: jest.fn(async () => undefined)
      }
    });

    const requestBody = { message: 'keep-original' };
    const req = {
      method: 'POST',
      path: '/api/commands/execute',
      url: '/api/commands/execute',
      headers: {},
      body: requestBody
    } as unknown as Request;

    const responseHeaders: Record<string, string> = {};
    const res = {
      setHeader: jest.fn((name: string, value: string) => {
        responseHeaders[name.toLowerCase()] = value;
      }),
      status: jest.fn().mockReturnThis(),
      json: jest.fn().mockReturnThis()
    } as unknown as Response;

    const next = jest.fn();
    await middleware(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect((res.status as jest.Mock).mock.calls[0][0]).toBe(503);
    expect((res.json as jest.Mock).mock.calls[0][0]).toEqual(
      expect.objectContaining({
        code: 'DISPATCH_FAILSAFE',
        route_attempted: 'POST /api/commands/execute'
      })
    );
    expect(req.method).toBe('POST');
    expect(req.url).toBe('/api/commands/execute');
    expect(req.body).toEqual(requestBody);
    expect(req.dispatchDecision).toBe('block');
    expect(responseHeaders['x-dispatch-decision']).toBe('block');
  });

  it('rolls back to trusted snapshot on baseline mismatch and re-evaluates once', async () => {
    const staleVersion = '2026-02-06T05:50:00.000Z';
    const staleSnapshot = createSnapshotRecord(staleVersion, {
      'POST /api/commands/execute': {
        expected_route: 'POST /api/commands/execute',
        last_validated_at: staleVersion,
        hard_conflict: false
      }
    });
    staleSnapshot.snapshot.monotonic_ts_ms = 100;

    const trustedVersion = '2026-02-06T05:50:01.000Z';
    const trustedSnapshot = createSnapshotRecord(trustedVersion, {
      'POST /api/commands/execute': {
        expected_route: 'POST /api/commands/execute',
        last_validated_at: trustedVersion,
        hard_conflict: false
      }
    });
    trustedSnapshot.snapshot.monotonic_ts_ms = 250;

    const getSnapshot = jest
      .fn()
      .mockResolvedValueOnce(staleSnapshot)
      .mockResolvedValueOnce(staleSnapshot);
    const rollbackToTrustedSnapshot = jest.fn(async () => trustedSnapshot);

    const app = createTestApp({
      getSnapshot,
      rollbackToTrustedSnapshot
    });

    const response = await request(app)
      .post('/api/commands/execute')
      .set('x-memory-baseline-ts', '200')
      .send({ message: 'trusted rollback' });

    expect(response.status).toBe(200);
    expect(response.headers['x-dispatch-decision']).toBe('allow');
    expect(getSnapshot).toHaveBeenCalledTimes(2);
    expect(rollbackToTrustedSnapshot).toHaveBeenCalledTimes(1);
  });

  it('blocks with unsafe contract when baseline mismatch persists without trusted snapshot', async () => {
    const staleVersion = '2026-02-06T05:52:00.000Z';
    const staleSnapshot = createSnapshotRecord(staleVersion, {
      'POST /api/commands/execute': {
        expected_route: 'POST /api/commands/execute',
        last_validated_at: staleVersion,
        hard_conflict: false
      }
    });
    staleSnapshot.snapshot.monotonic_ts_ms = 100;

    const getSnapshot = jest
      .fn()
      .mockResolvedValueOnce(staleSnapshot)
      .mockResolvedValueOnce(staleSnapshot);
    const rollbackToTrustedSnapshot = jest.fn(async () => null);

    const app = createTestApp({
      getSnapshot,
      rollbackToTrustedSnapshot
    });

    const response = await request(app)
      .post('/api/commands/execute')
      .set('x-memory-baseline-ts', '200')
      .send({ message: 'block unsafe' });

    expect(response.status).toBe(503);
    expect(response.body.error).toBe('UNSAFE_TO_PROCEED');
    expect(Array.isArray(response.body.conditions)).toBe(true);
    expect(response.body.conditions).toContain('MEMORY_VERSION_MISMATCH');
    expect(rollbackToTrustedSnapshot).toHaveBeenCalledTimes(1);
  });
});

