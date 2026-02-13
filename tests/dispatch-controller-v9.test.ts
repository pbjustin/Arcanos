import { describe, expect, it } from '@jest/globals';
import {
  decideAction,
  resolveBinding,
  validateAgainstSnapshot
} from '../src/services/dispatchControllerV9.js';
import type {
  DispatchAttemptV9,
  DispatchMemorySnapshotV9,
  DispatchPatternBindingV9
} from '../src/types/dispatchV9.js';

function createAttempt(method: string, path: string, intentHints: string[] = []): DispatchAttemptV9 {
  return {
    method,
    path,
    routeAttempted: `${method.toUpperCase()} ${path}`,
    intentHints
  };
}

function createSnapshot(routeAttempted: string, expectedRoute: string): DispatchMemorySnapshotV9 {
  const now = '2026-02-06T00:00:00.000Z';
  return {
    schema_version: 'v9',
    bindings_version: 'bindings-v1',
    version_id: 'snapshot-v1',
    monotonic_ts_ms: 1700000000000,
    memory_version: now,
    trusted_snapshot_id: 'snapshot-v1',
    route_state: {
      [routeAttempted]: {
        expected_route: expectedRoute,
        last_validated_at: now,
        hard_conflict: false
      }
    },
    updated_at: now,
    updated_by: 'test'
  };
}

describe('dispatchControllerV9', () => {
  it('selects the highest-priority exact binding with lexical tie-breaker', () => {
    const bindings: DispatchPatternBindingV9[] = [
      {
        id: 'z-binding',
        priority: 80,
        methods: ['POST'],
        exactPaths: ['/api/ask'],
        sensitivity: 'non-sensitive',
        conflictPolicy: 'refresh_then_reroute',
        rerouteTarget: '/api/ask',
        expectedRoute: '/api/ask'
      },
      {
        id: 'a-binding',
        priority: 80,
        methods: ['POST'],
        exactPaths: ['/api/ask'],
        sensitivity: 'non-sensitive',
        conflictPolicy: 'refresh_then_reroute',
        rerouteTarget: '/api/ask',
        expectedRoute: '/api/ask'
      },
      {
        id: 'fallback',
        priority: 1,
        methods: ['POST'],
        pathRegexes: ['^/api/.*$'],
        sensitivity: 'non-sensitive',
        conflictPolicy: 'refresh_then_reroute',
        rerouteTarget: '/api/ask',
        expectedRoute: '*'
      }
    ];

    const resolved = resolveBinding(createAttempt('POST', '/api/ask'), bindings);
    expect(resolved?.id).toBe('a-binding');
    expect(resolved?.matchKind).toBe('exact');
  });

  it('classifies stale version conflicts', () => {
    const binding: DispatchPatternBindingV9 = {
      id: 'api.ask',
      priority: 10,
      methods: ['POST'],
      exactPaths: ['/api/ask'],
      sensitivity: 'non-sensitive',
      conflictPolicy: 'refresh_then_reroute',
      rerouteTarget: '/api/ask',
      expectedRoute: '/api/ask'
    };
    const attempt = createAttempt('POST', '/api/ask');
    const snapshot = createSnapshot('POST /api/ask', 'POST /api/ask');
    const validation = validateAgainstSnapshot(binding, attempt, snapshot, '2026-02-05T00:00:00.000Z');

    expect(validation.valid).toBe(false);
    expect(validation.reason).toBe('stale_version');
  });

  it('uses monotonic baseline comparison when provided', () => {
    const binding: DispatchPatternBindingV9 = {
      id: 'api.ask',
      priority: 10,
      methods: ['POST'],
      exactPaths: ['/api/ask'],
      sensitivity: 'non-sensitive',
      conflictPolicy: 'refresh_then_reroute',
      rerouteTarget: '/api/ask',
      expectedRoute: '/api/ask'
    };
    const attempt = createAttempt('POST', '/api/ask');
    const snapshot = createSnapshot('POST /api/ask', 'POST /api/ask');

    const validWithBaseline = validateAgainstSnapshot(
      binding,
      attempt,
      snapshot,
      '1999-01-01T00:00:00.000Z',
      snapshot.monotonic_ts_ms - 1
    );
    expect(validWithBaseline.valid).toBe(true);

    const staleWithBaseline = validateAgainstSnapshot(
      binding,
      attempt,
      snapshot,
      snapshot.memory_version,
      snapshot.monotonic_ts_ms + 1
    );
    expect(staleWithBaseline.valid).toBe(false);
    expect(staleWithBaseline.reason).toBe('stale_version');
  });

  it('classifies route drift conflicts', () => {
    const binding: DispatchPatternBindingV9 = {
      id: 'api.modules',
      priority: 10,
      methods: ['POST'],
      exactPaths: ['/api/commands/execute'],
      sensitivity: 'sensitive',
      conflictPolicy: 'strict_block',
      expectedRoute: '/api/commands/execute'
    };
    const attempt = createAttempt('POST', '/api/commands/execute');
    const snapshot = createSnapshot('POST /api/commands/execute', 'POST /api/legacy');
    const validation = validateAgainstSnapshot(binding, attempt, snapshot);

    expect(validation.valid).toBe(false);
    expect(validation.reason).toBe('route_drift');
  });

  it('reports missing binding conflicts', () => {
    const attempt = createAttempt('POST', '/api/unknown');
    const snapshot = createSnapshot('POST /api/unknown', 'POST /api/unknown');
    const validation = validateAgainstSnapshot(null, attempt, snapshot);

    expect(validation.valid).toBe(false);
    expect(validation.reason).toBe('missing_binding');
  });

  it('maps decision policy matrix deterministically', () => {
    const validDecision = decideAction(
      { valid: true, reason: 'none', requiresSnapshotUpdate: false, hardConflict: false },
      'non-sensitive',
      'refresh_then_reroute'
    );
    expect(validDecision).toBe('allow');

    const rerouteDecision = decideAction(
      { valid: false, reason: 'route_drift', requiresSnapshotUpdate: false, hardConflict: false },
      'non-sensitive',
      'refresh_then_reroute'
    );
    expect(rerouteDecision).toBe('reroute');

    const blockSensitiveDecision = decideAction(
      { valid: false, reason: 'route_drift', requiresSnapshotUpdate: false, hardConflict: false },
      'sensitive',
      'refresh_then_reroute'
    );
    expect(blockSensitiveDecision).toBe('block');

    const blockStrictDecision = decideAction(
      { valid: false, reason: 'stale_version', requiresSnapshotUpdate: false, hardConflict: false },
      'non-sensitive',
      'strict_block'
    );
    expect(blockStrictDecision).toBe('block');
  });
});

