import {
  ACTION_PLAN_COMMAND_IDEMPOTENCY_SCOPE,
  canonicalizeJson,
  fingerprintCanonicalValue,
  hashScopedOpaqueValue,
} from '../src/services/actionPlanExecution/canonical.js';
import {
  ACTION_PLAN_SNAPSHOT_MAX_BYTES,
  actionExecutionSnapshotMatches,
  buildActionExecutionSnapshot,
} from '../src/services/actionPlanExecution/snapshot.js';
import { ActionPlanExecutionError } from '../src/services/actionPlanExecution/errors.js';
import { readActionPlanSnapshotSensitiveValues } from '../src/services/actionPlanExecution/auth.js';

const action = {
  id: 'action-1',
  planId: 'plan-1',
  agentId: 'agent-1',
  capability: 'terminal.run',
  params: { command: 'printf ok', nested: { z: 1, a: true } },
  timeoutMs: 30000,
  rollbackAction: null,
  sortOrder: 0,
};
const snapshotOptions = {
  planExecutionGeneration: 1,
  executorKind: 'python-daemon' as const,
  assignedExecutorPrincipalId: 'executor-1',
  agentCapabilities: ['terminal.run'],
};

describe('Phase 2E canonical identities', () => {
  it('sorts object keys while preserving array order and Unicode', () => {
    expect(canonicalizeJson({ z: '雪', a: [2, 1] })).toBe('{"a":[2,1],"z":"雪"}');
  });

  it('domain-separates idempotency identities and fingerprints', () => {
    const key = 'retry-key';
    expect(hashScopedOpaqueValue('claim', key)).not.toBe(hashScopedOpaqueValue('result', key));
    expect(fingerprintCanonicalValue(ACTION_PLAN_COMMAND_IDEMPOTENCY_SCOPE, {
      plan_id: 'plan-1', action_ids: ['a', 'b'],
    })).toHaveLength(64);
  });

  it('rejects non-finite canonical numbers', () => {
    expect(() => canonicalizeJson({ score: Number.NaN })).toThrow(TypeError);
  });
});

describe('Phase 2E immutable action snapshots', () => {
  it('builds a deterministic bounded snapshot without mutable run state', () => {
    const snapshot = buildActionExecutionSnapshot(action, snapshotOptions);
    expect(snapshot).toEqual({
      snapshot_version: 'action-execution-snapshot-v1',
      plan_id: 'plan-1',
      action_id: 'action-1',
      agent_id: 'agent-1',
      capability: 'terminal.run',
      params: { command: 'printf ok', nested: { a: true, z: 1 } },
      timeout_ms: 30000,
      sort_order: 0,
      plan_execution_generation: 1,
      executor_kind: 'python-daemon',
      assigned_executor_principal_id: 'executor-1',
      agent_capability_fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/u),
    });
    expect(actionExecutionSnapshotMatches(action, snapshot, snapshotOptions)).toBe(true);
    expect(actionExecutionSnapshotMatches({ ...action, sortOrder: 1 }, snapshot, snapshotOptions)).toBe(false);
  });

  it('rejects exact configured credential values without logging or returning them', () => {
    const credential = 'sensitive-value-for-test';
    const secretAction = { ...action, params: { command: credential } };
    let observed: unknown;
    try {
      buildActionExecutionSnapshot(secretAction, { ...snapshotOptions, sensitiveValues: [credential] });
    } catch (error) {
      observed = error;
    }
    expect(observed).toBeInstanceOf(ActionPlanExecutionError);
    expect(JSON.stringify(observed)).not.toContain(credential);
    expect((observed as ActionPlanExecutionError).code).toBe('ACTION_PLAN_ACTION_SNAPSHOT_UNAVAILABLE');
  });

  it('rejects a non-ActionPlan environment credential without exposing it in the error', () => {
    const credential = 'non-action-plan-provider-secret-sentinel';
    const sensitiveValues = readActionPlanSnapshotSensitiveValues({
      SYNTHETIC_PROVIDER_API_KEY: credential,
      ORDINARY_DISPLAY_VALUE: 'not-sensitive-by-name',
    });
    expect(sensitiveValues).toContain(credential);
    expect(sensitiveValues).not.toContain('not-sensitive-by-name');

    let observed: unknown;
    try {
      buildActionExecutionSnapshot(
        { ...action, params: { command: credential } },
        { ...snapshotOptions, sensitiveValues },
      );
    } catch (error) {
      observed = error;
    }
    expect(observed).toBeInstanceOf(ActionPlanExecutionError);
    expect(observed).toMatchObject({ code: 'ACTION_PLAN_ACTION_SNAPSHOT_UNAVAILABLE' });
    expect(JSON.stringify(observed)).not.toContain(credential);
    expect(String((observed as Error).message)).not.toContain(credential);
    expect(String((observed as Error).stack)).not.toContain(credential);
  });

  it('rejects unsupported depth, non-finite values, and oversized snapshots', () => {
    let nested: unknown = 'leaf';
    for (let index = 0; index < 10; index += 1) nested = { nested };
    expect(() => buildActionExecutionSnapshot({ ...action, params: nested }, snapshotOptions)).toThrow(ActionPlanExecutionError);
    expect(() => buildActionExecutionSnapshot({ ...action, params: { value: Infinity } }, snapshotOptions)).toThrow(ActionPlanExecutionError);
    expect(() => buildActionExecutionSnapshot({
      ...action,
      params: { value: 'x'.repeat(ACTION_PLAN_SNAPSHOT_MAX_BYTES) },
    }, snapshotOptions)).toThrow(ActionPlanExecutionError);
  });

  it.each(['__proto__', 'prototype', 'constructor'])(
    'rejects the prototype-sensitive key %s instead of dropping immutable evidence',
    key => {
      const params = JSON.parse(`{"${key}":{"polluted":true},"command":"synthetic"}`) as Record<string, unknown>;
      expect(Object.hasOwn(params, key)).toBe(true);
      expect(() => buildActionExecutionSnapshot({ ...action, params }, snapshotOptions)).toThrow(
        expect.objectContaining({ code: 'ACTION_PLAN_ACTION_SNAPSHOT_UNAVAILABLE' }),
      );
      expect(({} as { polluted?: boolean }).polluted).toBeUndefined();
    },
  );
});
