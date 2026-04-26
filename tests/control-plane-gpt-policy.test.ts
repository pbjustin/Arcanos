import { describe, expect, it, jest } from '@jest/globals';

import {
  ARCANOS_CORE_CONTROL_PLANE_POLICY,
  evaluateControlPlaneGptPolicy,
  executeControlPlaneOperation,
  sanitizeControlPlaneAuditEvent,
  verifyControlPlaneRouteMetadata,
  type ControlPlaneAuditEvent,
} from '@services/controlPlane/index.js';
import type { ControlPlaneInvokeRequestPayload } from '@arcanos/protocol';

function buildRequest(overrides: Partial<ControlPlaneInvokeRequestPayload> = {}): ControlPlaneInvokeRequestPayload {
  return {
    operation: 'control-plane.route.trinity.request',
    provider: 'backend-api',
    gptId: 'arcanos-core',
    target: { resource: 'trinity-route' },
    environment: 'local',
    scope: 'backend:read',
    params: {},
    dryRun: false,
    traceId: 'trace-control-plane-gpt-1',
    requestedBy: 'test-runner',
    ...overrides,
  };
}

function buildAuditSink() {
  const events: ControlPlaneAuditEvent[] = [];
  return {
    events,
    auditEmitter: (event: ControlPlaneAuditEvent) => {
      events.push(event);
    },
  };
}

describe('control-plane GPT policy', () => {
  it('accepts arcanos-core for the Trinity routing request workflow', () => {
    const decision = evaluateControlPlaneGptPolicy({
      gptId: 'arcanos-core',
      workflow: 'control_plane.route.trinity.request',
    });

    expect(decision).toEqual(expect.objectContaining({
      ok: true,
      gptId: 'arcanos-core',
      whitelisted: true,
      reason: 'gpt_control_plane_whitelisted',
    }));
  });

  it('denies unknown GPT IDs', () => {
    const decision = evaluateControlPlaneGptPolicy({
      gptId: 'unknown-gpt',
      workflow: 'control_plane.route.trinity.request',
    });

    expect(decision).toEqual(expect.objectContaining({
      ok: false,
      gptId: 'unknown-gpt',
      whitelisted: false,
      reason: 'gpt_not_control_plane_whitelisted',
    }));
  });

  it('denies GPT-scoped workflows when gptId is omitted', () => {
    const decision = evaluateControlPlaneGptPolicy({
      workflow: 'control_plane.route.trinity.request',
    });

    expect(decision).toEqual(expect.objectContaining({
      ok: false,
      gptId: null,
      whitelisted: false,
      reason: 'gpt_identity_required_for_workflow',
    }));
  });

  it('denies disabled GPT policy entries', () => {
    const decision = evaluateControlPlaneGptPolicy({
      gptId: 'arcanos-core',
      workflow: 'control_plane.route.trinity.request',
      policies: [
        {
          ...ARCANOS_CORE_CONTROL_PLANE_POLICY,
          enabled: false,
        },
      ],
    });

    expect(decision).toEqual(expect.objectContaining({
      ok: false,
      gptId: 'arcanos-core',
      reason: 'gpt_control_plane_policy_disabled',
    }));
  });

  it('denies raw secret access even for whitelisted GPT IDs', () => {
    const decision = evaluateControlPlaneGptPolicy({
      gptId: 'arcanos-core',
      workflow: 'control_plane.inspect',
      requestedCapability: 'secrets.read.raw',
    });

    expect(decision).toEqual(expect.objectContaining({
      ok: false,
      gptId: 'arcanos-core',
      reason: 'capability_denied:secrets.read.raw',
    }));
  });

  it('allows arcanos-core to request Trinity routing without confirming Trinity success', async () => {
    const audit = buildAuditSink();

    const response = await executeControlPlaneOperation(buildRequest(), {
      auditEmitter: audit.auditEmitter,
    });

    expect(response.ok).toBe(true);
    expect(response.result).toEqual(expect.objectContaining({
      allowed: true,
      trinityRequested: true,
      trinityConfirmed: false,
      routeStatus: 'REQUEST_ALLOWED_UNCONFIRMED',
    }));
    expect(audit.events[0]).toEqual(expect.objectContaining({
      status: 'accepted',
      details: expect.objectContaining({
        gptPolicy: expect.objectContaining({
          gptId: 'arcanos-core',
          whitelisted: true,
        }),
      }),
    }));
  });

  it('denies non-whitelisted GPT IDs before executing a control-plane workflow', async () => {
    const audit = buildAuditSink();

    const response = await executeControlPlaneOperation(
      buildRequest({ gptId: 'unknown-gpt' }),
      { auditEmitter: audit.auditEmitter }
    );

    expect(response.ok).toBe(false);
    expect(response.error?.code).toBe('ERR_CONTROL_PLANE_GPT_POLICY');
    expect(audit.events[0]).toEqual(expect.objectContaining({
      status: 'denied',
      details: expect.objectContaining({
        gptPolicy: expect.objectContaining({
          reason: 'gpt_not_control_plane_whitelisted',
        }),
      }),
    }));
  });

  it('does not let a whitelisted GPT bypass required permission scopes', async () => {
    const response = await executeControlPlaneOperation(
      buildRequest({ scope: 'repo:read' }),
      { auditEmitter: buildAuditSink().auditEmitter }
    );

    expect(response.ok).toBe(false);
    expect(response.error?.code).toBe('ERR_CONTROL_PLANE_SCOPE');
    expect(response.error?.details).toEqual(expect.objectContaining({
      missingScopes: ['backend:read'],
      gptPolicy: expect.objectContaining({
        gptId: 'arcanos-core',
        whitelisted: true,
      }),
    }));
  });

  it('preserves approval gates for destructive or gated operations', async () => {
    const runner = { run: jest.fn() };

    const response = await executeControlPlaneOperation(
      buildRequest({
        operation: 'npm.run.build',
        provider: 'codex-ide',
        target: { resource: 'repository' },
        scope: 'repo:verify',
      }),
      {
        commandRunner: runner,
        approvalTokenReader: () => undefined,
        auditEmitter: buildAuditSink().auditEmitter,
      }
    );

    expect(response.ok).toBe(false);
    expect(response.error?.code).toBe('ERR_CONTROL_PLANE_APPROVAL');
    expect(runner.run).not.toHaveBeenCalled();
  });

  it('does not confirm Trinity routing from whitelist membership alone', () => {
    const verification = verifyControlPlaneRouteMetadata({
      gptId: 'arcanos-core',
      metadata: {},
    });

    expect(verification).toEqual(expect.objectContaining({
      gptWhitelisted: true,
      trinityConfirmed: false,
      routeStatus: 'UNKNOWN',
    }));
  });

  it('classifies direct fast-path route metadata without claiming Trinity confirmation', () => {
    const verification = verifyControlPlaneRouteMetadata({
      gptId: 'arcanos-core',
      metadata: {
        routeDecision: {
          path: 'fast_path',
          reason: 'query_and_wait_direct_action',
          queueBypassed: true,
        },
        directAction: {
          inline: true,
          queueBypassed: true,
          orchestrationBypassed: true,
          action: 'query_and_wait',
        },
        _route: {
          gptId: 'arcanos-core',
          module: 'GPT:DIRECT_ACTION',
          action: 'query_and_wait',
          route: 'direct_action',
        },
      },
    });

    expect(verification).toEqual(expect.objectContaining({
      gptWhitelisted: true,
      trinityConfirmed: false,
      routeStatus: 'DIRECT_FAST_PATH',
      route: 'direct_action',
      path: 'fast_path',
      module: 'GPT:DIRECT_ACTION',
      queueBypassed: true,
      orchestrationBypassed: true,
    }));
  });

  it('confirms Trinity only when route metadata proves the Trinity pipeline', () => {
    const verification = verifyControlPlaneRouteMetadata({
      gptId: 'arcanos-core',
      metadata: {
        pipeline: 'trinity',
        _route: {
          module: 'ARCANOS:CORE',
          route: 'orchestrated',
        },
        routeDecision: {
          path: 'orchestrated_path',
        },
      },
    });

    expect(verification).toEqual(expect.objectContaining({
      gptWhitelisted: true,
      trinityConfirmed: true,
      routeStatus: 'TRINITY_CONFIRMED',
    }));
  });

  it('redacts secrets before audit events are emitted', () => {
    const bearerFixture = `Bearer ${'a'.repeat(24)}`;
    const keyFixture = ['api', '_key=', 'b'.repeat(24)].join('');
    const authorizationKey = ['author', 'ization'].join('');
    const apiKeyName = ['api', 'Key'].join('');
    const sanitized = sanitizeControlPlaneAuditEvent({
      auditId: 'cp_test',
      status: 'accepted',
      operation: 'control-plane.route.verify',
      provider: 'backend-api',
      environment: 'local',
      traceId: 'trace-control-plane-gpt-2',
      requestedBy: 'test-runner',
      approvalStatus: 'not_required',
      dryRun: false,
      details: {
        [authorizationKey]: bearerFixture,
        nested: {
          [apiKeyName]: keyFixture,
        },
      },
    });

    const serialized = JSON.stringify(sanitized);
    expect(serialized).not.toContain(bearerFixture);
    expect(serialized).not.toContain(keyFixture);
    expect(serialized).toContain('[REDACTED]');
  });
});
