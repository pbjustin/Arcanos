import { describe, expect, it } from '@jest/globals';

import {
  buildControlPlaneCliWrapperSummary,
  getControlPlaneDeepDiagnostics,
} from '@services/controlPlane/deepDiagnostics.js';

describe('getControlPlaneDeepDiagnostics', () => {
  it('summarizes ARCANOS Core control-plane verification without claiming live Trinity confirmation', () => {
    const diagnostics = getControlPlaneDeepDiagnostics();

    expect(diagnostics.ok).toBe(true);
    expect(diagnostics.gptWhitelist).toEqual(expect.objectContaining({
      enabled: true,
      containsArcanosCore: true,
      gptId: 'arcanos-core',
      policyPath: 'src/services/controlPlane/gptPolicy.ts',
    }));
    expect(diagnostics.gptWhitelist.allowedWorkflows).toEqual(expect.arrayContaining([
      'control_plane.route.trinity.request',
      'control_plane.route.verify',
      'railway.cli.readonly',
      'arcanos.cli.readonly',
      'arcanos.mcp.documented_tools',
    ]));
    expect(diagnostics.gptWhitelist.deniedCapabilities).toEqual(expect.arrayContaining([
      'secrets.read.raw',
      'production.mutate.unapproved',
      'mcp.undocumented_tools',
    ]));

    expect(diagnostics.trinityRouting).toEqual(expect.objectContaining({
      implemented: true,
      requestable: true,
      lastRouteStatus: 'UNKNOWN_ROUTE',
      verificationPath: 'src/services/controlPlane/routeVerification.ts',
    }));
    expect(diagnostics.trinityRouting.metadataFields).toEqual(expect.arrayContaining([
      '_route',
      'routeDecision',
      'routingStages',
      'pipeline',
    ]));
    expect(diagnostics.safetyFlags).toEqual({
      readOnly: true,
      executesCli: false,
      callsOpenAI: false,
      mutatesState: false,
      createsJobs: false,
      deploys: false,
      invokesMcpTools: false,
      routesThroughWritingPipeline: false,
    });
  });

  it('summarizes CLI allowlists, MCP policy, approval gates, audit, redaction, and tests', () => {
    const diagnostics = getControlPlaneDeepDiagnostics();

    expect(diagnostics.railwayCliWrapper).toEqual(expect.objectContaining({
      implemented: true,
      allowlistEnabled: true,
      restrictedCommandsRequireApproval: true,
    }));
    expect(diagnostics.railwayCliWrapper.readOnlyOperations).toEqual(expect.arrayContaining([
      'railway.status',
      'railway.whoami',
    ]));
    expect(diagnostics.railwayCliWrapper.restrictedOperations).toEqual(expect.arrayContaining([
      'railway.deploy',
    ]));

    expect(diagnostics.arcanosCliWrapper).toEqual(expect.objectContaining({
      implemented: true,
      allowlistEnabled: true,
      restrictedCommandsRequireApproval: false,
    }));
    expect(diagnostics.arcanosCliWrapper.readOnlyOperations).toEqual(expect.arrayContaining([
      'arcanos.status',
      'arcanos.inspect',
      'arcanos.mcp.list-tools',
    ]));

    expect(diagnostics.mcpPolicy).toEqual(expect.objectContaining({
      implemented: true,
      documentedToolsOnly: true,
      schemaValidationEnabled: true,
    }));
    expect(diagnostics.mcpPolicy.registeredTools).toEqual(expect.arrayContaining([
      'control_plane.invoke',
      'agents.list',
      'modules.list',
      'ops.health_report',
    ]));

    expect(diagnostics.approvalGates).toEqual(expect.objectContaining({
      implemented: true,
    }));
    expect(diagnostics.approvalGates.protectedActions).toEqual(expect.arrayContaining([
      'deploy',
      'production_mutation',
      'secret_change',
      'railway.deploy',
    ]));

    expect(diagnostics.auditLogging).toEqual(expect.objectContaining({
      implemented: true,
      secretRedactionEnabled: true,
      auditPath: 'src/services/controlPlane/audit.ts',
    }));
    expect(diagnostics.tests).toEqual(expect.objectContaining({
      present: true,
    }));
    expect(diagnostics.tests.knownTestFiles).toEqual(expect.arrayContaining([
      'tests/control-plane-gpt-policy.test.ts',
      'tests/control-plane-route-verification.test.ts',
      'tests/control-plane-executor.test.ts',
    ]));

    const serialized = JSON.stringify(diagnostics);
    expect(serialized).not.toContain('sk-');
    expect(serialized).not.toContain('Bearer ');
  });

  it('treats an empty CLI allowlist as unavailable rather than approval-gated or unsafe', () => {
    const summary = buildControlPlaneCliWrapperSummary({
      provider: 'railway-cli',
      allowlistEntries: [],
      legacyEntries: [],
    });

    expect(summary).toEqual({
      implemented: false,
      allowlistEnabled: false,
      restrictedCommandsRequireApproval: false,
      readOnlyOperations: [],
      restrictedOperations: [],
    });
  });
});
