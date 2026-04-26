import { describe, expect, it } from '@jest/globals';

import {
  validateProtocolCommandData,
  validateProtocolCommandPayload,
  type ControlPlaneInvokeRequestPayload,
  type ControlPlaneInvokeResponseData,
} from '@arcanos/protocol';

function buildRequestPayload(overrides: Partial<ControlPlaneInvokeRequestPayload> = {}): ControlPlaneInvokeRequestPayload {
  return {
    operation: 'git.status',
    provider: 'codex-ide',
    target: { resource: 'repository' },
    environment: 'local',
    scope: 'repo:read',
    params: {},
    traceId: 'trace-control-plane-1',
    requestedBy: 'test-runner',
    ...overrides,
  };
}

describe('control-plane protocol schema', () => {
  it('validates a schema-first control-plane request without requiring dryRun to be supplied', () => {
    const payload = buildRequestPayload();
    delete payload.dryRun;

    const validation = validateProtocolCommandPayload('control-plane.invoke', payload);

    expect(validation).toEqual({ ok: true, issues: [] });
  });

  it('rejects control-plane requests that omit the explicit operation name', () => {
    const payload = buildRequestPayload() as Partial<ControlPlaneInvokeRequestPayload>;
    delete payload.operation;

    const validation = validateProtocolCommandPayload('control-plane.invoke', payload);

    expect(validation.ok).toBe(false);
    expect(validation.issues.map((issue) => issue.instancePath)).toContain('/');
  });

  it('validates the required response envelope data shape', () => {
    const responseData: ControlPlaneInvokeResponseData = {
      ok: true,
      operation: 'git.status',
      provider: 'codex-ide',
      environment: 'local',
      result: { dryRun: true },
      auditId: 'cp_test',
      warnings: [],
      redactedOutput: { dryRun: true },
    };

    const validation = validateProtocolCommandData('control-plane.invoke', responseData);

    expect(validation).toEqual({ ok: true, issues: [] });
  });
});
