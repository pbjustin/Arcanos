import { redactSensitive } from '@shared/redaction.js';

import {
  ALLOWED_MCP_READ_TOOLS,
  CONTROL_PLANE_OPERATION_ALLOWLIST,
  listControlPlaneAllowlist,
} from './allowlist.js';
import { sanitizeControlPlaneAuditEvent } from './audit.js';
import { ARCANOS_CORE_GPT_ID, findControlPlaneGptPolicy } from './gptPolicy.js';
import { verifyControlPlaneRouteMetadata } from './routeVerification.js';
import { controlPlaneInvokeRequestSchema } from './schema.js';
import { getControlPlaneCapabilities } from './service.js';

const GPT_POLICY_PATH = 'src/services/controlPlane/gptPolicy.ts';
const ROUTE_VERIFICATION_PATH = 'src/services/controlPlane/routeVerification.ts';
const AUDIT_PATH = 'src/services/controlPlane/audit.ts';

const TRINITY_ROUTE_METADATA_FIELDS = [
  '_route',
  'routeDecision',
  'directAction',
  'pipeline',
  'routingStages',
  'outputControls.sourceEndpoint',
  'pipelineDebug',
  'gpt5Used',
  'activeModel',
] as const;

const KNOWN_TEST_FILES = [
  'tests/control-plane-gpt-policy.test.ts',
  'tests/control-plane-route-verification.test.ts',
  'tests/control-plane-executor.test.ts',
  'tests/control-plane.service.test.ts',
  'tests/control-plane.route.test.ts',
  'tests/control-plane-api.test.ts',
  'tests/mcp-control-plane-tools.test.ts',
  'tests/structured-logging-sanitization.test.ts',
] as const;

const TEST_COMMANDS = [
  'node scripts/run-jest.mjs --runTestsByPath tests/control-plane-deep-diagnostics.test.ts tests/control-plane-api.test.ts --coverage=false --runInBand',
] as const;

const IS_REDACTION_ENABLED = ((): boolean => {
  const redacted = redactSensitive({
    authorization: `Bearer ${'a'.repeat(24)}`,
    nested: {
      token: `sk-${'b'.repeat(24)}`,
    },
  });
  return JSON.stringify(redacted).includes('[REDACTED]');
})();

type DeepDiagnosticsRouteStatus = 'TRINITY_CONFIRMED' | 'DIRECT_FAST_PATH' | 'UNKNOWN_ROUTE';

export interface ControlPlaneDeepDiagnosticsResponse {
  ok: true;
  gptWhitelist: {
    enabled: boolean;
    containsArcanosCore: boolean;
    policyPath: string;
    gptId: string;
    allowedWorkflows: string[];
    deniedCapabilities: string[];
  };
  trinityRouting: {
    implemented: boolean;
    requestable: boolean;
    lastRouteStatus: DeepDiagnosticsRouteStatus;
    metadataFields: string[];
    verificationPath: string;
  };
  railwayCliWrapper: {
    implemented: boolean;
    allowlistEnabled: boolean;
    restrictedCommandsRequireApproval: boolean;
    readOnlyOperations: string[];
    restrictedOperations: string[];
  };
  arcanosCliWrapper: {
    implemented: boolean;
    allowlistEnabled: boolean;
    restrictedCommandsRequireApproval: boolean;
    readOnlyOperations: string[];
    restrictedOperations: string[];
  };
  mcpPolicy: {
    implemented: boolean;
    documentedToolsOnly: boolean;
    schemaValidationEnabled: boolean;
    registeredTools: string[];
  };
  approvalGates: {
    implemented: boolean;
    protectedActions: string[];
  };
  auditLogging: {
    implemented: boolean;
    secretRedactionEnabled: boolean;
    auditPath: string;
  };
  safetyFlags: {
    readOnly: true;
    executesCli: false;
    callsOpenAI: false;
    mutatesState: false;
    createsJobs: false;
    deploys: false;
    invokesMcpTools: false;
    routesThroughWritingPipeline: false;
  };
  tests: {
    present: boolean;
    commands: string[];
    knownTestFiles: string[];
  };
}

export type ControlPlaneCliProvider = 'railway-cli' | 'arcanos-cli';

export interface ControlPlaneCliWrapperSource {
  operation: string;
  readOnly: boolean;
  approvalRequired: boolean;
}

export interface ControlPlaneLegacyCliWrapperSource {
  adapter: string;
  operation: string;
  requiresApproval: boolean;
}

export interface ControlPlaneCliWrapperSummary {
  implemented: boolean;
  allowlistEnabled: boolean;
  restrictedCommandsRequireApproval: boolean;
  readOnlyOperations: string[];
  restrictedOperations: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function uniqueSorted(values: Iterable<string>): string[] {
  return Array.from(new Set(values)).sort();
}

function legacyOperationName(adapter: string, operation: string): string {
  const prefix = adapter === 'railway-cli'
    ? 'railway'
    : adapter === 'arcanos-cli'
      ? 'arcanos'
      : 'mcp';
  return `${prefix}.${operation}`;
}

export function buildControlPlaneCliWrapperSummary(params: {
  provider: ControlPlaneCliProvider;
  allowlistEntries: readonly ControlPlaneCliWrapperSource[];
  legacyEntries: readonly ControlPlaneLegacyCliWrapperSource[];
}): ControlPlaneCliWrapperSummary {
  const readOnlyOperations = uniqueSorted([
    ...params.allowlistEntries
      .filter((entry) => entry.readOnly)
      .map((entry) => entry.operation),
    ...params.legacyEntries
      .filter((entry) => !entry.requiresApproval)
      .map((entry) => legacyOperationName(params.provider, entry.operation)),
  ]);
  const restrictedEntries = [
    ...params.allowlistEntries
      .filter((entry) => !entry.readOnly || entry.approvalRequired)
      .map((entry) => ({
        operation: entry.operation,
        requiresApproval: entry.approvalRequired || !entry.readOnly,
      })),
    ...params.legacyEntries
      .filter((entry) => entry.requiresApproval)
      .map((entry) => ({
        operation: legacyOperationName(params.provider, entry.operation),
        requiresApproval: entry.requiresApproval,
      })),
  ];
  const restrictedOperations = uniqueSorted(restrictedEntries.map((entry) => entry.operation));

  return {
    implemented: params.allowlistEntries.length > 0 || params.legacyEntries.length > 0,
    allowlistEnabled: params.allowlistEntries.length > 0 || params.legacyEntries.length > 0,
    restrictedCommandsRequireApproval: restrictedEntries.length > 0
      && restrictedEntries.every((entry) => entry.requiresApproval),
    readOnlyOperations,
    restrictedOperations,
  };
}

function summarizeCliWrapper(provider: ControlPlaneCliProvider): ControlPlaneCliWrapperSummary {
  return buildControlPlaneCliWrapperSummary({
    provider,
    allowlistEntries: listControlPlaneAllowlist().filter((entry) => entry.provider === provider),
    legacyEntries: getControlPlaneCapabilities().operations.filter((entry) => entry.adapter === provider),
  });
}

function hasRedactionEnabled(): boolean {
  return IS_REDACTION_ENABLED;
}

export function redactControlPlaneDeepDiagnosticsResponse(payload: unknown): unknown {
  const redacted = redactSensitive(payload);
  if (!isRecord(payload) || !isRecord(redacted)) {
    return redacted;
  }

  const sourceAuditLogging = isRecord(payload.auditLogging) ? payload.auditLogging : null;
  const redactedAuditLogging = isRecord(redacted.auditLogging) ? redacted.auditLogging : null;
  if (
    sourceAuditLogging
    && redactedAuditLogging
    && typeof sourceAuditLogging.secretRedactionEnabled === 'boolean'
  ) {
    redactedAuditLogging.secretRedactionEnabled = sourceAuditLogging.secretRedactionEnabled;
  }

  return redacted;
}

export function getControlPlaneDeepDiagnostics(): ControlPlaneDeepDiagnosticsResponse {
  const policy = findControlPlaneGptPolicy(ARCANOS_CORE_GPT_ID);
  const allowlist = listControlPlaneAllowlist();
  const routeRequestSpec = CONTROL_PLANE_OPERATION_ALLOWLIST.find(
    (entry) => entry.operation === 'control-plane.route.trinity.request'
      && entry.provider === 'backend-api'
      && entry.readOnly
  );
  const mcpEntries = allowlist.filter((entry) => entry.provider === 'arcanos-mcp');
  const protectedActions = uniqueSorted([
    ...(policy?.requiresApprovalFor ?? []),
    ...allowlist
      .filter((entry) => entry.approvalRequired || !entry.readOnly)
      .map((entry) => entry.operation),
    ...getControlPlaneCapabilities().operations
      .filter((entry) => entry.requiresApproval)
      .map((entry) => legacyOperationName(entry.adapter, entry.operation)),
  ]);
  const response: ControlPlaneDeepDiagnosticsResponse = {
    ok: true,
    gptWhitelist: {
      enabled: policy?.enabled === true,
      containsArcanosCore: policy?.gptId === ARCANOS_CORE_GPT_ID,
      policyPath: GPT_POLICY_PATH,
      gptId: ARCANOS_CORE_GPT_ID,
      allowedWorkflows: [...(policy?.allowedWorkflows ?? [])],
      deniedCapabilities: [...(policy?.deniedCapabilities ?? [])],
    },
    trinityRouting: {
      implemented: typeof verifyControlPlaneRouteMetadata === 'function',
      requestable: Boolean(routeRequestSpec),
      lastRouteStatus: 'UNKNOWN_ROUTE',
      metadataFields: [...TRINITY_ROUTE_METADATA_FIELDS],
      verificationPath: ROUTE_VERIFICATION_PATH,
    },
    railwayCliWrapper: summarizeCliWrapper('railway-cli'),
    arcanosCliWrapper: summarizeCliWrapper('arcanos-cli'),
    mcpPolicy: {
      implemented: mcpEntries.length > 0,
      documentedToolsOnly: ALLOWED_MCP_READ_TOOLS.size > 0
        && mcpEntries.every((entry) => entry.readOnly),
      schemaValidationEnabled: typeof controlPlaneInvokeRequestSchema.safeParse === 'function',
      registeredTools: uniqueSorted([
        'control_plane.invoke',
        ...ALLOWED_MCP_READ_TOOLS,
      ]),
    },
    approvalGates: {
      implemented: protectedActions.length > 0,
      protectedActions,
    },
    auditLogging: {
      implemented: typeof sanitizeControlPlaneAuditEvent === 'function',
      secretRedactionEnabled: policy?.requiresSecretRedaction === true && hasRedactionEnabled(),
      auditPath: AUDIT_PATH,
    },
    safetyFlags: {
      readOnly: true,
      executesCli: false,
      callsOpenAI: false,
      mutatesState: false,
      createsJobs: false,
      deploys: false,
      invokesMcpTools: false,
      routesThroughWritingPipeline: false,
    },
    tests: {
      present: KNOWN_TEST_FILES.length > 0,
      commands: [...TEST_COMMANDS],
      knownTestFiles: [...KNOWN_TEST_FILES],
    },
  };

  return redactControlPlaneDeepDiagnosticsResponse(response) as ControlPlaneDeepDiagnosticsResponse;
}
