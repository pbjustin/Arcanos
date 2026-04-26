import crypto from 'node:crypto';
import type { Request } from 'express';
import type { ZodError } from 'zod';

import { resolveErrorMessage } from '@core/lib/errors/index.js';
import { redactSensitive } from '@shared/redaction.js';

import {
  getControlPlaneOperationSpec,
} from './allowlist.js';
import { evaluateControlPlaneApproval } from './approval.js';
import { emitControlPlaneAuditEvent } from './audit.js';
import { defaultControlPlaneCommandRunner } from './commandRunner.js';
import { safeParseControlPlaneRequest } from './schema.js';
import type {
  ControlPlaneApprovalStatus,
  ControlPlaneAuditEvent,
  ControlPlaneCommandPlan,
  ControlPlaneOperationSpec,
  ControlPlaneRequest,
  ControlPlaneResponse,
  ExecuteControlPlaneOperationOptions,
} from './types.js';

function createAuditId(): string {
  return `cp_${crypto.randomUUID()}`;
}

function normalizeScopes(scope: string | string[]): Set<string> {
  return new Set(Array.isArray(scope) ? scope : [scope]);
}

function resolveMissingScopes(request: ControlPlaneRequest, spec: ControlPlaneOperationSpec): string[] {
  const grantedScopes = normalizeScopes(request.scope);
  return spec.requiredScopes.filter((scope) => !grantedScopes.has(scope));
}

function isSensitiveEnvironment(environmentName: string): boolean {
  const environment = environmentName.trim().toLowerCase();
  return environment.includes('prod') || environment.includes('production');
}

function requiresApproval(request: ControlPlaneRequest, spec: ControlPlaneOperationSpec): boolean {
  if (request.dryRun) {
    return false;
  }
  if (spec.approvalRequired) {
    return true;
  }
  return !spec.readOnly && isSensitiveEnvironment(request.environment);
}

function buildBaseResponse(
  auditId: string,
  request: Pick<ControlPlaneRequest, 'operation' | 'provider' | 'environment'>,
  ok: boolean,
  result: unknown,
  warnings: string[],
  redactedOutput: unknown,
  error?: { code: string; message: string; details?: unknown }
): ControlPlaneResponse {
  return {
    ok,
    operation: request.operation,
    provider: request.provider,
    environment: request.environment,
    result,
    auditId,
    warnings,
    redactedOutput,
    ...(error ? { error } : {}),
  };
}

function buildUnknownRequest(candidate: unknown): Pick<ControlPlaneRequest, 'operation' | 'provider' | 'environment' | 'traceId' | 'requestedBy' | 'dryRun'> {
  const raw = candidate && typeof candidate === 'object' ? candidate as Record<string, unknown> : {};
  return {
    operation: typeof raw.operation === 'string' && raw.operation.trim() ? raw.operation.trim() : 'unknown',
    provider: typeof raw.provider === 'string' && raw.provider.trim() ? raw.provider.trim() as ControlPlaneRequest['provider'] : 'local-command',
    environment: typeof raw.environment === 'string' && raw.environment.trim() ? raw.environment.trim() : 'unknown',
    traceId: typeof raw.traceId === 'string' && raw.traceId.trim() ? raw.traceId.trim() : 'unknown',
    requestedBy: typeof raw.requestedBy === 'string' && raw.requestedBy.trim() ? raw.requestedBy.trim() : 'unknown',
    dryRun: true,
  };
}

function emitAudit(
  request: Pick<ControlPlaneRequest, 'operation' | 'provider' | 'environment' | 'traceId' | 'requestedBy' | 'dryRun'>,
  auditId: string,
  status: ControlPlaneAuditEvent['status'],
  approvalStatus: ControlPlaneApprovalStatus,
  options: ExecuteControlPlaneOperationOptions,
  reason?: string,
  details?: Record<string, unknown>
): void {
  const event: ControlPlaneAuditEvent = {
    auditId,
    status,
    operation: request.operation,
    provider: request.provider,
    environment: request.environment,
    traceId: request.traceId,
    requestedBy: request.requestedBy,
    approvalStatus,
    dryRun: request.dryRun,
    ...(reason ? { reason } : {}),
    ...(details ? { details: redactSensitive(details) as Record<string, unknown> } : {}),
  };
  if (options.auditEmitter) {
    options.auditEmitter(event);
    return;
  }
  emitControlPlaneAuditEvent(event);
}

function redactCommandPlan(plan: ControlPlaneCommandPlan): ControlPlaneCommandPlan {
  return redactSensitive(plan) as ControlPlaneCommandPlan;
}

async function getDefaultMcpService() {
  const { arcanosMcpService } = await import('../arcanosMcp.js');
  return arcanosMcpService;
}

async function runBackendHealthCheck(options: ExecuteControlPlaneOperationOptions): Promise<unknown> {
  if (options.healthCheck) {
    return options.healthCheck();
  }
  const { runHealthCheck } = await import('@platform/logging/diagnostics.js');
  return runHealthCheck();
}

async function resolveMcpService(options: ExecuteControlPlaneOperationOptions) {
  return options.mcpService ?? await getDefaultMcpService();
}

function resolveRequestForMcp(request: Request | undefined): Request | undefined {
  return request && typeof request === 'object' && 'headers' in request ? request : undefined;
}

function formatSchemaError(error: ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.join('.') || '/'}: ${issue.message}`)
    .join('; ');
}

function buildCommandFailureError(commandResult: { exitCode: number; signal?: string | null }) {
  const signal = commandResult.signal ?? null;
  return {
    code: 'ERR_CONTROL_PLANE_COMMAND_FAILED',
    message: signal
      ? `Command failed with signal ${signal}.`
      : `Command failed with exit code ${commandResult.exitCode}.`,
    details: {
      exitCode: commandResult.exitCode,
      signal,
    },
  };
}

async function executeParsedControlPlaneOperation(
  request: ControlPlaneRequest,
  auditId: string,
  options: ExecuteControlPlaneOperationOptions
): Promise<ControlPlaneResponse> {
  const warnings: string[] = [];
  const spec = getControlPlaneOperationSpec(request.provider, request.operation);
  if (!spec) {
    const message = `Operation "${request.operation}" is not allowlisted for provider "${request.provider}".`;
    emitAudit(request, auditId, 'denied', 'not_required', options, message);
    return buildBaseResponse(
      auditId,
      request,
      false,
      null,
      warnings,
      null,
      { code: 'ERR_CONTROL_PLANE_DENIED', message }
    );
  }

  const missingScopes = resolveMissingScopes(request, spec);
  if (missingScopes.length > 0) {
    const message = 'Control-plane request is missing required permission scope.';
    emitAudit(request, auditId, 'denied', 'not_required', options, message, { missingScopes });
    return buildBaseResponse(
      auditId,
      request,
      false,
      null,
      warnings,
      { missingScopes },
      { code: 'ERR_CONTROL_PLANE_SCOPE', message, details: { missingScopes } }
    );
  }

  let plannedCommand: ControlPlaneCommandPlan | undefined;
  let plannedMcpTool: string | undefined;
  let plannedMcpArguments: Record<string, unknown> | undefined;
  try {
    if (spec.kind === 'command') {
      plannedCommand = spec.buildCommand(request);
    } else if (spec.kind === 'mcp-invoke') {
      plannedMcpTool = spec.resolveToolName(request);
      plannedMcpArguments = spec.buildToolArguments(request);
    }
  } catch (error) {
    const message = resolveErrorMessage(error);
    emitAudit(request, auditId, 'denied', 'not_required', options, message);
    return buildBaseResponse(
      auditId,
      request,
      false,
      null,
      warnings,
      null,
      { code: 'ERR_CONTROL_PLANE_BAD_REQUEST', message }
    );
  }

  const approvalDecision = evaluateControlPlaneApproval(
    request,
    requiresApproval(request, spec),
    options.approvalTokenReader
  );
  if (!approvalDecision.ok) {
    const message = approvalDecision.reason ?? 'Control-plane approval was rejected.';
    emitAudit(request, auditId, 'denied', approvalDecision.status, options, message);
    return buildBaseResponse(
      auditId,
      request,
      false,
      null,
      warnings,
      null,
      { code: 'ERR_CONTROL_PLANE_APPROVAL', message }
    );
  }

  if (request.dryRun) {
    const result = {
      dryRun: true,
      allowed: true,
      operation: request.operation,
      provider: request.provider,
      readOnly: spec.readOnly,
      approvalStatus: approvalDecision.status,
      requiredScopes: spec.requiredScopes,
      plan:
        spec.kind === 'command' && plannedCommand
          ? redactCommandPlan(plannedCommand)
          : spec.kind === 'mcp-invoke'
            ? redactSensitive({ toolName: plannedMcpTool, toolArguments: plannedMcpArguments })
            : { kind: spec.kind },
    };
    emitAudit(request, auditId, 'accepted', approvalDecision.status, options, 'dry-run accepted', { result });
    return buildBaseResponse(auditId, request, true, result, warnings, result);
  }

  try {
    if (spec.kind === 'command') {
      const command = plannedCommand ?? spec.buildCommand(request);
      const runner = options.commandRunner ?? defaultControlPlaneCommandRunner;
      const commandResult = await runner.run(command);
      const redactedResult = redactSensitive(commandResult);
      const ok = commandResult.exitCode === 0;
      emitAudit(
        request,
        auditId,
        ok ? 'accepted' : 'failed',
        approvalDecision.status,
        options,
        ok ? 'command completed' : 'command failed',
        { exitCode: commandResult.exitCode, signal: commandResult.signal ?? null, command: redactCommandPlan(command) }
      );
      return buildBaseResponse(
        auditId,
        request,
        ok,
        redactedResult,
        warnings,
        redactedResult,
        ok
          ? undefined
          : buildCommandFailureError(commandResult)
      );
    }

    if (spec.kind === 'mcp-list-tools') {
      const mcp = await resolveMcpService(options);
      const result = await mcp.listTools({ request: resolveRequestForMcp(options.request) });
      const redactedResult = redactSensitive(result);
      emitAudit(request, auditId, 'accepted', approvalDecision.status, options, 'mcp tools listed');
      return buildBaseResponse(auditId, request, true, redactedResult, warnings, redactedResult);
    }

    if (spec.kind === 'mcp-invoke') {
      const mcp = await resolveMcpService(options);
      const result = await mcp.invokeTool({
        toolName: plannedMcpTool ?? spec.resolveToolName(request),
        toolArguments: plannedMcpArguments ?? spec.buildToolArguments(request),
        request: resolveRequestForMcp(options.request),
      });
      const redactedResult = redactSensitive(result);
      emitAudit(request, auditId, 'accepted', approvalDecision.status, options, 'mcp tool invoked', { toolName: plannedMcpTool });
      return buildBaseResponse(auditId, request, true, redactedResult, warnings, redactedResult);
    }

    const health = await runBackendHealthCheck(options);
    const redactedHealth = redactSensitive(health);
    emitAudit(request, auditId, 'accepted', approvalDecision.status, options, 'backend health read');
    return buildBaseResponse(auditId, request, true, redactedHealth, warnings, redactedHealth);
  } catch (error) {
    const message = resolveErrorMessage(error);
    emitAudit(request, auditId, 'failed', approvalDecision.status, options, message);
    return buildBaseResponse(
      auditId,
      request,
      false,
      null,
      warnings,
      null,
      { code: 'ERR_CONTROL_PLANE_EXECUTION', message }
    );
  }
}

export async function executeControlPlaneOperation(
  candidate: unknown,
  options: ExecuteControlPlaneOperationOptions = {}
): Promise<ControlPlaneResponse> {
  const auditId = createAuditId();
  const parsed = safeParseControlPlaneRequest(candidate);
  if (!parsed.success) {
    const request = buildUnknownRequest(candidate);
    const message = `Control-plane request schema validation failed. ${formatSchemaError(parsed.error)}`;
    emitAudit(request, auditId, 'denied', 'not_required', options, message);
    return buildBaseResponse(
      auditId,
      request,
      false,
      null,
      [],
      null,
      { code: 'ERR_CONTROL_PLANE_SCHEMA', message }
    );
  }

  return executeParsedControlPlaneOperation(parsed.data as ControlPlaneRequest, auditId, options);
}
