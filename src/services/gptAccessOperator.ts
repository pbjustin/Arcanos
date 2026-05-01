import crypto from 'node:crypto';
import type { Request } from 'express';
import { z } from 'zod';

import { getJobQueueSummary } from '@core/db/repositories/jobRepository.js';
import {
  executeControlPlaneOperation,
  getControlPlaneOperationSpec,
  type ControlPlaneCommandPlan,
  type ControlPlaneCommandRunner,
  type ControlPlaneCommandResult,
  type ControlPlaneResponse
} from '@services/controlPlane/index.js';
import { runControlPlaneCommand } from '@services/controlPlane/commandRunner.js';
import type { ControlPlaneProvider } from '@services/controlPlane/types.js';
import { sanitizeGptAccessPayload } from '@services/gptAccessGateway.js';
import {
  getGptAccessOperatorCommandSpec,
  GPT_ACCESS_OPERATOR_COMMAND_REGISTRY,
  type GptAccessOperatorCommandSpec
} from '@services/gptAccessOperatorRegistry.js';
import { runtimeDiagnosticsService } from '@services/runtimeDiagnosticsService.js';
import { buildSafetySelfHealSnapshot } from '@services/selfHealRuntimeInspectionService.js';
import { getWorkerControlStatus } from '@services/workerControlService.js';

type OperatorResult = { statusCode: number; payload: unknown };

export interface RunGptAccessOperatorCommandContext {
  requestId?: string;
  traceId?: string;
  requestedBy?: string;
  request?: Request;
}

export interface RunGptAccessOperatorCommandDependencies {
  registry?: ReadonlyMap<string, GptAccessOperatorCommandSpec>;
  executeControlPlane?: typeof executeControlPlaneOperation;
  getControlPlaneSpec?: typeof getControlPlaneOperationSpec;
  commandRunnerFactory?: (spec: GptAccessOperatorCommandSpec) => ControlPlaneCommandRunner;
}

const COMMAND_ID_PATTERN = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/;
const RAW_SHELL_TOKEN_PATTERN = /(\|\||&&|[`|<>;]|\$\(|\r|\n)/;

const operatorRunRequestSchema = z.object({
  command: z.string().trim().min(1).max(120),
  args: z.record(z.unknown()).optional().default({})
}).strict();

function buildOperatorAudit(context: RunGptAccessOperatorCommandContext | undefined, spec: GptAccessOperatorCommandSpec) {
  return {
    requestId: context?.requestId?.trim() || crypto.randomUUID(),
    traceId: context?.traceId?.trim() || crypto.randomUUID(),
    adapter: spec.adapter
  };
}

function buildOperatorError(
  statusCode: number,
  code: string,
  message: string,
  audit?: ReturnType<typeof buildOperatorAudit>
): OperatorResult {
  return {
    statusCode,
    payload: {
      ok: false,
      error: {
        code,
        message
      },
      ...(audit ? { audit } : {})
    }
  };
}

function containsRawShellToken(value: unknown): boolean {
  if (typeof value === 'string') {
    return RAW_SHELL_TOKEN_PATTERN.test(value);
  }
  if (!value || typeof value !== 'object') {
    return false;
  }
  if (Array.isArray(value)) {
    return value.some(containsRawShellToken);
  }
  return Object.values(value as Record<string, unknown>).some(containsRawShellToken);
}

function looksLikeRawShellCommand(command: string): boolean {
  return /\s/.test(command) || RAW_SHELL_TOKEN_PATTERN.test(command);
}

function validateNoArgs(args: Record<string, unknown>): boolean {
  return Object.keys(args).length === 0;
}

function truncateStringToBytes(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, 'utf8') <= maxBytes) {
    return value;
  }

  let output = '';
  let usedBytes = 0;
  for (const char of value) {
    const charBytes = Buffer.byteLength(char, 'utf8');
    if (usedBytes + charBytes > maxBytes) {
      break;
    }
    output += char;
    usedBytes += charBytes;
  }
  return `${output}\n[truncated]`;
}

function limitOperatorOutput(value: unknown, maxOutputBytes: number): unknown {
  if (typeof value === 'string') {
    return truncateStringToBytes(value, maxOutputBytes);
  }

  const rendered = JSON.stringify(value);
  if (!rendered || Buffer.byteLength(rendered, 'utf8') <= maxOutputBytes) {
    return value;
  }

  return {
    truncated: true,
    maxOutputBytes,
    preview: truncateStringToBytes(rendered, maxOutputBytes)
  };
}

function createBoundedControlPlaneCommandRunner(spec: GptAccessOperatorCommandSpec): ControlPlaneCommandRunner {
  return {
    async run(plan: ControlPlaneCommandPlan): Promise<ControlPlaneCommandResult> {
      const boundedPlan: ControlPlaneCommandPlan = {
        ...plan,
        timeoutMs: Math.min(plan.timeoutMs ?? spec.timeoutMs, spec.timeoutMs),
        maxBufferBytes: Math.min(plan.maxBufferBytes ?? spec.maxOutputBytes, spec.maxOutputBytes)
      };
      return runControlPlaneCommand(boundedPlan);
    }
  };
}

function mapControlPlaneStatus(response: ControlPlaneResponse): number {
  if (response.ok) {
    return 200;
  }

  switch (response.error?.code) {
    case 'ERR_CONTROL_PLANE_SCHEMA':
    case 'ERR_CONTROL_PLANE_BAD_REQUEST':
      return 400;
    case 'ERR_CONTROL_PLANE_DENIED':
    case 'ERR_CONTROL_PLANE_GPT_POLICY':
    case 'ERR_CONTROL_PLANE_SCOPE':
    case 'ERR_CONTROL_PLANE_APPROVAL':
      return 403;
    case 'ERR_CONTROL_PLANE_COMMAND_FAILED':
    case 'ERR_CONTROL_PLANE_EXECUTION':
      return 502;
    default:
      return 500;
  }
}

async function runInternalOperatorHandler(spec: GptAccessOperatorCommandSpec): Promise<unknown> {
  switch (spec.commandId) {
    case 'runtime.inspect':
      return runtimeDiagnosticsService.getHealthSnapshot();
    case 'workers.status':
      return getWorkerControlStatus();
    case 'queue.inspect':
      return getJobQueueSummary();
    case 'diagnostics':
      return {
        runtime: runtimeDiagnosticsService.getHealthSnapshot(),
        workers: await getWorkerControlStatus(),
        queue: await getJobQueueSummary(),
        selfHeal: buildSafetySelfHealSnapshot()
      };
    default:
      throw new Error('Operator handler is not implemented.');
  }
}

function isControlPlaneAdapter(adapter: GptAccessOperatorCommandSpec['adapter']): adapter is ControlPlaneProvider {
  return adapter !== 'gpt-access-internal';
}

async function runControlPlaneOperatorCommand(
  spec: GptAccessOperatorCommandSpec,
  audit: ReturnType<typeof buildOperatorAudit>,
  context: RunGptAccessOperatorCommandContext | undefined,
  dependencies: RunGptAccessOperatorCommandDependencies
): Promise<OperatorResult> {
  if (!isControlPlaneAdapter(spec.adapter) || !spec.operation || !spec.requiredControlPlaneScope) {
    return buildOperatorError(
      403,
      'GPT_ACCESS_SCOPE_DENIED',
      'Operator command is not backed by an approved control-plane operation.',
      audit
    );
  }

  const getSpec = dependencies.getControlPlaneSpec ?? getControlPlaneOperationSpec;
  const controlPlaneSpec = getSpec(spec.adapter, spec.operation);
  if (!controlPlaneSpec || controlPlaneSpec.readOnly !== true) {
    return buildOperatorError(
      403,
      'GPT_ACCESS_SCOPE_DENIED',
      'Operator command is not backed by a read-only control-plane allowlist entry.',
      audit
    );
  }

  const execute = dependencies.executeControlPlane ?? executeControlPlaneOperation;
  const commandRunnerFactory = dependencies.commandRunnerFactory ?? createBoundedControlPlaneCommandRunner;
  const response = await execute(
    {
      operation: spec.operation,
      provider: spec.adapter,
      target: { resource: spec.targetResource ?? spec.commandId },
      environment: 'local',
      scope: spec.requiredControlPlaneScope,
      params: {},
      dryRun: false,
      traceId: audit.traceId,
      requestedBy: context?.requestedBy ?? 'gpt-access-operator'
    },
    {
      request: context?.request,
      commandRunner: commandRunnerFactory(spec)
    }
  );

  if (!response.ok) {
    return {
      statusCode: mapControlPlaneStatus(response),
      payload: sanitizeGptAccessPayload({
        ok: false,
        command: spec.commandId,
        readOnly: spec.readOnly,
        error: response.error ?? {
          code: 'GPT_ACCESS_INTERNAL_ERROR',
          message: 'Control-plane operator command failed.'
        },
        audit
      })
    };
  }

  return {
    statusCode: 200,
    payload: sanitizeGptAccessPayload({
      ok: true,
      command: spec.commandId,
      readOnly: true,
      result: limitOperatorOutput(response.redactedOutput ?? response.result, spec.maxOutputBytes),
      audit
    })
  };
}

export async function runGptAccessOperatorCommand(
  body: unknown,
  context?: RunGptAccessOperatorCommandContext,
  dependencies: RunGptAccessOperatorCommandDependencies = {}
): Promise<OperatorResult> {
  if (
    (typeof body === 'string' && (looksLikeRawShellCommand(body) || containsRawShellToken(body))) ||
    containsRawShellToken(body)
  ) {
    return buildOperatorError(
      400,
      'GPT_ACCESS_VALIDATION_ERROR',
      'Raw shell content is not allowed for GPT access operator commands.'
    );
  }

  const parsed = operatorRunRequestSchema.safeParse(body);
  if (!parsed.success) {
    return buildOperatorError(
      400,
      'GPT_ACCESS_VALIDATION_ERROR',
      'Operator command request must include a command ID and an args object.'
    );
  }

  const command = parsed.data.command;
  if (!COMMAND_ID_PATTERN.test(command) || looksLikeRawShellCommand(command)) {
    return buildOperatorError(
      400,
      'GPT_ACCESS_VALIDATION_ERROR',
      'Operator command must be a safe command ID, not a shell command.'
    );
  }

  const registry = dependencies.registry ?? GPT_ACCESS_OPERATOR_COMMAND_REGISTRY;
  const spec = getGptAccessOperatorCommandSpec(command, registry);
  if (!spec) {
    return buildOperatorError(
      403,
      'GPT_ACCESS_SCOPE_DENIED',
      'Operator command is not allowlisted for GPT access.'
    );
  }

  const audit = buildOperatorAudit(context, spec);
  if (spec.readOnly !== true) {
    return buildOperatorError(
      403,
      'GPT_ACCESS_SCOPE_DENIED',
      'Operator command is not read-only.',
      audit
    );
  }

  if (!validateNoArgs(parsed.data.args)) {
    return buildOperatorError(
      400,
      'GPT_ACCESS_VALIDATION_ERROR',
      'Operator command does not accept arbitrary arguments.',
      audit
    );
  }

  try {
    if (spec.adapter === 'gpt-access-internal') {
      return {
        statusCode: 200,
        payload: sanitizeGptAccessPayload({
          ok: true,
          command: spec.commandId,
          readOnly: true,
          result: limitOperatorOutput(await runInternalOperatorHandler(spec), spec.maxOutputBytes),
          audit
        })
      };
    }

    return await runControlPlaneOperatorCommand(spec, audit, context, dependencies);
  } catch {
    return buildOperatorError(
      500,
      'GPT_ACCESS_INTERNAL_ERROR',
      'Operator command failed.',
      audit
    );
  }
}
