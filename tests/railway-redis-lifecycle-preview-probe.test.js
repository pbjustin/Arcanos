import { readFileSync } from 'node:fs';

import { describe, expect, it, jest } from '@jest/globals';
import Ajv2020 from 'ajv/dist/2020.js';

import {
  ProbeConfigurationError,
  collectObservation,
  evaluateOutageObservations,
  evaluateRecoveryObservations,
  parseArgs,
  requestJson,
  resolveExecutionPolicy,
  runProbe
} from '../scripts/railway-redis-lifecycle-preview-probe.js';

const EXPLICIT_TARGET_ARGS = [
  '--target', 'isolated-preview',
  '--base-url', 'https://arcanos-redis-preview-1.up.railway.app',
  '--environment', 'arcanos-redis-lifecycle-preview-20260722-1',
  '--environment-id', '11111111-1111-4111-8111-111111111111',
  '--web-service-id', '22222222-2222-4222-8222-222222222222',
  '--web-deployment-id', '33333333-3333-4333-8333-333333333333'
];

function healthResult({ uptime, phase, redisReady, redisStatus, redisCode, retryScheduled }) {
  return {
    status: 200,
    latencyMs: 8,
    errorCode: null,
    sensitiveContentObserved: false,
    body: {
      timestamp: new Date(Date.parse('2026-07-22T12:00:00.000Z') + (uptime * 1000)).toISOString(),
      uptime,
      startup: {
        phase,
        listener_bound: true
      },
      dependencies: {
        redis: {
          ready: redisReady,
          status: redisStatus,
          code: redisCode,
          retry_scheduled: retryScheduled
        }
      }
    }
  };
}

function readinessResult({ ready, code, recoveryCount = null }) {
  return {
    status: ready ? 200 : 503,
    latencyMs: 9,
    errorCode: null,
    sensitiveContentObserved: false,
    body: {
      ready,
      status: ready ? 'healthy' : 'unhealthy',
      checks: [{
        name: 'redis',
        healthy: ready,
        ...(code ? { code } : {}),
        metadata: recoveryCount === null ? {} : { recoveryCount }
      }]
    }
  };
}

function outageObservation(sequence = 1) {
  return {
    sequence,
    observedAt: `2026-07-22T12:00:0${sequence}.000Z`,
    health: {
      status: 200,
      latencyMs: 8,
      errorCode: null,
      serverTimestamp: `2026-07-22T12:00:${String(10 + sequence).padStart(2, '0')}.000Z`,
      startupPhase: 'DEGRADED',
      listenerBound: true,
      uptimeSeconds: 10 + sequence,
      redisReady: false,
      redisStatus: 'degraded',
      redisCode: 'REDIS_DEPENDENCY_UNAVAILABLE',
      retryScheduled: true
    },
    healthz: {
      status: 200,
      latencyMs: 7,
      errorCode: null,
      serverTimestamp: `2026-07-22T12:00:${String(10 + sequence).padStart(2, '0')}.010Z`,
      startupPhase: 'DEGRADED',
      listenerBound: true,
      uptimeSeconds: 10 + sequence,
      redisReady: false,
      redisStatus: 'degraded',
      redisCode: 'REDIS_DEPENDENCY_UNAVAILABLE',
      retryScheduled: true
    },
    readyz: {
      status: 503,
      latencyMs: 9,
      errorCode: null,
      ready: false,
      readinessStatus: 'unhealthy',
      redisHealthy: false,
      redisCode: 'REDIS_DEPENDENCY_UNAVAILABLE',
      recoveryCount: null
    },
    sensitiveContentObserved: false
  };
}

function readyObservation(sequence = 2) {
  return {
    sequence,
    observedAt: `2026-07-22T12:00:0${sequence}.000Z`,
    health: {
      status: 200,
      latencyMs: 8,
      errorCode: null,
      serverTimestamp: `2026-07-22T12:00:${String(10 + sequence).padStart(2, '0')}.000Z`,
      startupPhase: 'READY',
      listenerBound: true,
      uptimeSeconds: 10 + sequence,
      redisReady: true,
      redisStatus: 'ready',
      redisCode: null,
      retryScheduled: false
    },
    healthz: {
      status: 200,
      latencyMs: 7,
      errorCode: null,
      serverTimestamp: `2026-07-22T12:00:${String(10 + sequence).padStart(2, '0')}.010Z`,
      startupPhase: 'READY',
      listenerBound: true,
      uptimeSeconds: 10 + sequence,
      redisReady: true,
      redisStatus: 'ready',
      redisCode: null,
      retryScheduled: false
    },
    readyz: {
      status: 200,
      latencyMs: 9,
      errorCode: null,
      ready: true,
      readinessStatus: 'healthy',
      redisHealthy: true,
      redisCode: null,
      recoveryCount: 1
    },
    sensitiveContentObserved: false
  };
}

describe('railway-redis-lifecycle-preview-probe', () => {
  it('is a no-network dry run with no ambient target fallback by default', async () => {
    const fetchFn = jest.fn();
    const report = await runProbe(parseArgs([]), { fetchFn });

    expect(report).toEqual(expect.objectContaining({
      mode: 'DRY_RUN',
      phase: null,
      target: null,
      executed: false,
      networkAttempted: false
    }));
    expect(report.summary.status).toBe('DRY_RUN');
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('contains no Railway control-plane or mutating HTTP execution path', () => {
    const source = readFileSync(
      new URL('../scripts/railway-redis-lifecycle-preview-probe.js', import.meta.url),
      'utf8'
    );

    expect(source).not.toMatch(/node:child_process|execFile|execSync|spawnSync/u);
    expect(source).not.toMatch(/method:\s*['"](?:POST|PUT|PATCH|DELETE)['"]/u);
  });

  it('requires paired execution and network authorization flags', () => {
    const config = parseArgs([
      ...EXPLICIT_TARGET_ARGS,
      '--phase', 'outage',
      '--execute'
    ]);

    expect(() => resolveExecutionPolicy(config)).toThrow(
      expect.objectContaining({
        name: 'ProbeConfigurationError',
        code: 'NETWORK_AUTHORIZATION_FLAGS_MUST_MATCH'
      })
    );
  });

  it('rejects partial targets, production, and non-isolated environment names', () => {
    expect(() => resolveExecutionPolicy(parseArgs(['--phase', 'outage']))).toThrow(ProbeConfigurationError);

    const production = parseArgs([
      ...EXPLICIT_TARGET_ARGS,
      '--phase', 'outage'
    ]);
    production.baseUrl = 'https://acranos-production.up.railway.app';
    expect(() => resolveExecutionPolicy(production)).toThrow(
      expect.objectContaining({ code: 'TARGET_NOT_ISOLATED_PREVIEW' })
    );

    const productionAlias = parseArgs([
      ...EXPLICIT_TARGET_ARGS,
      '--phase', 'outage'
    ]);
    productionAlias.baseUrl = 'https://arcanos-v2-production.up.railway.app';
    expect(() => resolveExecutionPolicy(productionAlias)).toThrow(
      expect.objectContaining({ code: 'TARGET_NOT_ISOLATED_PREVIEW' })
    );

    const wrongEnvironment = parseArgs([
      ...EXPLICIT_TARGET_ARGS,
      '--phase', 'outage'
    ]);
    wrongEnvironment.environment = 'production';
    expect(() => resolveExecutionPolicy(wrongEnvironment)).toThrow(
      expect.objectContaining({ code: 'INVALID_ISOLATED_PREVIEW_ENVIRONMENT' })
    );

    const unboundedTimeout = parseArgs([
      ...EXPLICIT_TARGET_ARGS,
      '--phase', 'outage',
      '--request-timeout-ms', '2001'
    ]);
    expect(() => resolveExecutionPolicy(unboundedTimeout)).toThrow(
      expect.objectContaining({ code: 'PROBE_LIMIT_EXCEEDED' })
    );
  });

  it('allows a complete explicit target to be validated without network access', async () => {
    const fetchFn = jest.fn();
    const report = await runProbe(parseArgs([
      ...EXPLICIT_TARGET_ARGS,
      '--phase', 'outage'
    ]), { fetchFn });

    expect(report.summary.status).toBe('DRY_RUN');
    expect(report.target.environmentId).toBe('11111111-1111-4111-8111-111111111111');
    expect(report.limits).toEqual({
      maxSamples: 5,
      intervalMs: 1000,
      requestTimeoutMs: 2000
    });
    expect(report.checks[0].code).toBe('EXPLICIT_TARGET_VALIDATED_NO_NETWORK');
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('passes outage evidence only when liveness stays reachable and readiness is degraded', () => {
    const evaluation = evaluateOutageObservations([
      outageObservation(1),
      outageObservation(2)
    ]);

    expect(evaluation.passed).toBe(true);
    expect(evaluation.livenessFailures).toBe(0);
    expect(evaluation.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'response_latency_bounded', status: 'PASS' }),
      expect.objectContaining({ name: 'listener_bound', status: 'PASS' }),
      expect.objectContaining({ name: 'stable_dependency_error', status: 'PASS' }),
      expect.objectContaining({ name: 'retry_scheduled', status: 'PASS' })
    ]));
  });

  it('fails outage evidence when any endpoint exceeds the serialized latency bound', () => {
    const slowObservation = outageObservation(1);
    slowObservation.readyz.latencyMs = 2001;

    const evaluation = evaluateOutageObservations([slowObservation], {
      requestTimeoutMs: 2000
    });

    expect(evaluation.passed).toBe(false);
    expect(evaluation.checks).toContainEqual(expect.objectContaining({
      name: 'response_latency_bounded',
      status: 'FAIL',
      code: 'RESPONSE_LATENCY_BOUND_EXCEEDED'
    }));
  });

  it('requires a degraded-to-ready transition, stable process start time, and a recovery count', () => {
    const passing = evaluateRecoveryObservations([
      outageObservation(1),
      readyObservation(2)
    ]);
    const restarted = readyObservation(2);
    restarted.health.uptimeSeconds = 1;
    const failing = evaluateRecoveryObservations([
      outageObservation(1),
      restarted
    ]);
    const replaced = readyObservation(2);
    replaced.health.serverTimestamp = '2026-07-22T12:00:22.000Z';
    replaced.healthz.serverTimestamp = '2026-07-22T12:00:22.010Z';
    const replacement = evaluateRecoveryObservations([
      outageObservation(1),
      replaced
    ]);

    expect(passing.passed).toBe(true);
    expect(passing.readinessTransitionObserved).toBe(true);
    expect(failing.passed).toBe(false);
    expect(failing.checks).toContainEqual(expect.objectContaining({
      name: 'uptime_monotonic',
      status: 'FAIL'
    }));
    expect(replacement.checks).toContainEqual(expect.objectContaining({
      name: 'uptime_monotonic',
      status: 'PASS'
    }));
    expect(replacement.checks).toContainEqual(expect.objectContaining({
      name: 'process_start_time_stable',
      status: 'FAIL',
      code: 'PROCESS_REPLACEMENT_OBSERVED'
    }));
  });

  it('requires both liveness payloads to converge on Redis ready', () => {
    const inconsistentReady = readyObservation(2);
    inconsistentReady.healthz.redisReady = false;
    inconsistentReady.healthz.redisStatus = 'degraded';
    inconsistentReady.healthz.redisCode = 'REDIS_DEPENDENCY_UNAVAILABLE';

    const evaluation = evaluateRecoveryObservations([
      outageObservation(1),
      inconsistentReady
    ]);

    expect(evaluation.passed).toBe(false);
    expect(evaluation.checks).toContainEqual(expect.objectContaining({
      name: 'redis_ready',
      status: 'FAIL'
    }));
  });

  it('runs a bounded GET-only recovery probe and stops after the transition', async () => {
    const states = [
      {
        uptime: 20,
        phase: 'DEGRADED',
        redisReady: false,
        redisStatus: 'degraded',
        redisCode: 'REDIS_DEPENDENCY_UNAVAILABLE',
        retryScheduled: true,
        ready: false,
        recoveryCount: null
      },
      {
        uptime: 21,
        phase: 'DEGRADED',
        redisReady: false,
        redisStatus: 'degraded',
        redisCode: 'REDIS_DEPENDENCY_UNAVAILABLE',
        retryScheduled: true,
        ready: false,
        recoveryCount: null
      },
      {
        uptime: 22,
        phase: 'READY',
        redisReady: true,
        redisStatus: 'ready',
        redisCode: null,
        retryScheduled: false,
        ready: true,
        recoveryCount: 1
      }
    ];
    let requestCount = 0;
    const requestFn = jest.fn((url) => {
      const state = states[Math.floor(requestCount / 3)];
      requestCount += 1;
      return Promise.resolve(url.endsWith('/readyz')
        ? readinessResult({
          ready: state.ready,
          code: state.redisCode,
          recoveryCount: state.recoveryCount
        })
        : healthResult(state));
    });
    const sleep = jest.fn(() => Promise.resolve());
    let timeIndex = 0;
    const now = () => new Date(1_753_185_600_000 + (timeIndex += 1) * 1000);

    const report = await runProbe(parseArgs([
      ...EXPLICIT_TARGET_ARGS,
      '--phase', 'recovery',
      '--max-samples', '5',
      '--interval-ms', '1',
      '--execute',
      '--allow-network'
    ]), { requestFn, sleep, now });

    expect(report.summary).toEqual(expect.objectContaining({
      status: 'PASS',
      sampleCount: 3,
      livenessFailures: 0,
      readinessTransitionObserved: true
    }));
    expect(requestFn).toHaveBeenCalledTimes(9);
    expect(requestFn.mock.calls.every(([, options]) => options === undefined || options.method === undefined)).toBe(true);
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it('detects sensitive or low-level dependency details without copying them into evidence', async () => {
    const fetchFn = jest.fn(() => Promise.resolve(new Response(JSON.stringify({
      error: 'ECONNREFUSED redis://user:secret@host:6379'
    }), {
      status: 503,
      headers: { 'content-type': 'application/json' }
    })));

    const result = await requestJson('https://preview.up.railway.app/health', {
      fetchFn,
      requestTimeoutMs: 100
    });

    expect(result.sensitiveContentObserved).toBe(true);
    expect(JSON.stringify({
      status: result.status,
      latencyMs: result.latencyMs,
      errorCode: result.errorCode,
      sensitiveContentObserved: result.sensitiveContentObserved
    })).not.toContain('secret');
    expect(fetchFn).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({
      method: 'GET',
      redirect: 'error'
    }));

    const policy = resolveExecutionPolicy(parseArgs([
      ...EXPLICIT_TARGET_ARGS,
      '--phase', 'outage',
      '--execute',
      '--allow-network'
    ]));
    const observation = await collectObservation(policy, 1, {
      requestFn: () => Promise.resolve(result),
      now: () => new Date('2026-07-22T12:00:00.000Z')
    });
    expect(observation.sensitiveContentObserved).toBe(true);
    expect(JSON.stringify(observation)).not.toContain('secret');
    expect(JSON.stringify(observation)).not.toContain('redis://');
  });

  it('emits reports that conform to the evidence schema', async () => {
    const schema = JSON.parse(readFileSync(
      new URL('../schemas/redis-lifecycle-preview-evidence.schema.json', import.meta.url),
      'utf8'
    ));
    const validate = new Ajv2020({ strict: false, validateFormats: false }).compile(schema);
    const dryRun = await runProbe(parseArgs([]));
    const liveShape = {
      ...dryRun,
      mode: 'EXECUTE',
      phase: 'recovery',
      target: {
        category: 'isolated-preview',
        baseUrl: 'https://arcanos-redis-preview-1.up.railway.app',
        environment: 'arcanos-redis-lifecycle-preview-20260722-1',
        environmentId: '11111111-1111-4111-8111-111111111111',
        webServiceId: '22222222-2222-4222-8222-222222222222',
        webDeploymentId: '33333333-3333-4333-8333-333333333333'
      },
      executed: true,
      networkAttempted: true,
      startedAt: '2026-07-22T12:00:00.000Z',
      completedAt: '2026-07-22T12:00:02.000Z',
      summary: {
        status: 'PASS',
        sampleCount: 2,
        livenessFailures: 0,
        readinessTransitionObserved: true
      },
      observations: [outageObservation(1), readyObservation(2)],
      checks: [{ name: 'readiness_transition', status: 'PASS', code: 'READINESS_TRANSITIONED_TO_READY' }]
    };

    expect(validate(dryRun)).toBe(true);
    expect(validate(liveShape)).toBe(true);
  });
});
