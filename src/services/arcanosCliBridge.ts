import crypto from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { invokeTool } from '@arcanos/cli/client';
import {
  DEFAULT_CLI_POLICY,
  buildCliPolicyAuditEvent,
  evaluateCliCommandPolicy,
  redactCliOutput,
  type CliPolicyConfig
} from '@arcanos/cli/security/cliPolicy';
import { logger } from '@platform/logging/structuredLogging.js';

const SERVICE_VERSION = '0.1.0';
const DEFAULT_BRIDGE_URL = 'http://127.0.0.1:8765';
const DEFAULT_OUTPUT_MAX_BYTES = 20000;
const DEFAULT_TIMEOUT_MS = 30000;
const MAX_PATCH_BYTES = 200_000;
const POLICY_PATH = path.resolve(process.cwd(), 'config', 'cli-policy.json');
const LOOPBACK_BRIDGE_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);
const BRIDGE_TOKEN_HEADER = 'x-arcanos-cli-bridge-token';
const BIDI_CONTROL_PATTERN = /[\u202A-\u202E\u2066-\u2069]/u;
const SECRET_VALUE_KEY_PATTERN = /(?:authorization|cookie|password|secret|token|api[_-]?key|private[_-]?key|database[_-]?url|railway[_-]?token|openai[_-]?api[_-]?key)/iu;
const SECRET_PATCH_PATH_PATTERN = /(?:^|\/)(?:\.env(?:\..*)?|\.npmrc|\.pypirc|\.netrc|\.ssh\/.+|[^/]*(?:secret|token|credential|private[_-]?key)[^/]*)$/iu;

const READONLY_REPO_TOOLS = new Set([
  'doctor.implementation',
  'repo.list',
  'repo.listTree',
  'repo.search',
  'repo.getStatus',
  'repo.getLog',
  'repo.getDiff'
]);

interface NormalizedCommandPayload {
  command: string;
  cwd: string | undefined;
  timeoutMs: number;
}

interface NormalizedPatchPayload {
  patch: string;
  cwd: string | undefined;
  timeoutMs: number;
}

interface BridgeRunResponse {
  ok: boolean;
  status: string;
  stdout?: string;
  stderr?: string;
  exitCode?: number | null;
  durationMs?: number;
  truncated?: boolean;
  auditId?: string;
  error?: {
    code: string;
    message: string;
  };
}

export const CLI_READONLY_ACTIONS = new Set([
  'status',
  'policy',
  'repoContext',
  'proposeCommand',
  'proposePatch',
  'tailAudit'
]);

export function isArcanosCliBridgeEnabled(): boolean {
  return process.env.ARCANOS_CLI_BRIDGE_ENABLED === 'true';
}

export function getArcanosCliSandboxRoot(): string {
  return path.resolve(process.env.ARCANOS_CLI_SANDBOX_ROOT || process.env.ARCANOS_WORKSPACE_ROOT || process.cwd());
}

export async function getArcanosCliStatus() {
  const enabled = isArcanosCliBridgeEnabled();
  const daemonReachable = enabled ? await isDaemonBridgeReachable() : false;
  return {
    enabled,
    daemonReachable,
    mode: 'localhost-http-python-daemon',
    policyLoaded: existsSync(POLICY_PATH),
    sandboxRoot: getArcanosCliSandboxRoot(),
    version: SERVICE_VERSION
  };
}

export function getArcanosCliPolicyMetadata() {
  const policy = loadCliPolicy();
  return {
    version: policy.version,
    sandboxRoot: getArcanosCliSandboxRoot(),
    defaultTimeoutMs: getDefaultTimeoutMs(policy),
    maxTimeoutMs: policy.timeoutPolicy.maxMs,
    outputMaxBytes: getOutputMaxBytes(policy),
    commandAllowPrefixes: policy.commandPolicy.allowPrefixes ?? [],
    commandDenyPatternCount: policy.commandPolicy.denyPatterns.length,
    redactionEnvNames: policy.redactionPolicy.envNames.map((name) => name.replace(/./g, '*'))
  };
}

export async function getArcanosCliRepoContext(payload: unknown) {
  assertArcanosCliBridgeEnabled();
  const record = isRecord(payload) ? payload : {};
  const toolId = typeof record.toolId === 'string' && record.toolId.trim().length > 0
    ? record.toolId.trim()
    : 'repo.getStatus';
  if (!READONLY_REPO_TOOLS.has(toolId)) {
    throw new Error('repoContext only supports read-only repository tools.');
  }

  const input = isRecord(record.input) ? record.input : {};
  const result = await invokeTool({
    toolId,
    inputs: input,
    transport: 'python',
    context: {
      cwd: getArcanosCliSandboxRoot(),
      environment: 'workspace'
    },
    caller: {
      id: 'gpt-access-cli-bridge',
      type: 'automation',
      scopes: ['repo:read', 'tools:invoke']
    }
  });

  return redactAndCap(result);
}

export function proposeArcanosCliCommand(payload: unknown) {
  const commandPayload = normalizeCommandPayload(payload);
  const policy = loadCliPolicy();
  const decision = evaluateCliCommandPolicy({
    command: commandPayload.command,
    cwd: commandPayload.cwd,
    workspaceRoot: getArcanosCliSandboxRoot(),
    timeoutMs: commandPayload.timeoutMs,
    policy
  });
  const proposalId = hashProposal({ kind: 'command', command: commandPayload.command, cwd: decision.cwd });

  logger.info('arcanos.cli.command.proposed', {
    proposalId,
    policy: buildCliPolicyAuditEvent(commandPayload.command, decision, new Date(), policy)
  });

  return {
    proposalId,
    allowed: decision.allowed,
    reason: decision.reason ?? null,
    commandPreview: redactCliOutput(commandPayload.command, policy),
    cwd: decision.cwd,
    timeoutMs: decision.timeoutMs,
    approvalAction: 'runApprovedCommand',
    confirmationRequiredForApproval: true
  };
}

export async function runArcanosCliApprovedCommand(payload: unknown) {
  assertArcanosCliBridgeEnabled();
  const proposal = proposeArcanosCliCommand(payload);
  if (!proposal.allowed) {
    return {
      ok: false,
      status: 'denied',
      proposal,
      error: {
        code: 'ARCANOS_CLI_POLICY_DENIED',
        message: 'Command is denied by ARCANOS CLI policy.'
      }
    };
  }
  const proposalCheck = verifyApprovedProposalId(payload, proposal.proposalId);
  if (!proposalCheck.ok) {
    return proposalCheck.response;
  }

  const commandPayload = normalizeCommandPayload(payload);
  return redactAndCap(await postBridgeJson('/commands/run', {
    command: commandPayload.command,
    cwd: proposal.cwd,
    timeoutSeconds: Math.ceil(proposal.timeoutMs / 1000)
  }));
}

export function proposeArcanosCliPatch(payload: unknown) {
  const patchPayload = normalizePatchPayload(payload);
  const cwdDecision = evaluateCliCommandPolicy({
    command: 'git diff',
    cwd: patchPayload.cwd,
    workspaceRoot: getArcanosCliSandboxRoot(),
    timeoutMs: patchPayload.timeoutMs,
    policy: loadCliPolicy()
  });
  const safePatch = validatePatchText(patchPayload.patch);
  const proposalId = hashProposal({ kind: 'patch', patch: patchPayload.patch, cwd: cwdDecision.cwd });

  return {
    proposalId,
    allowed: cwdDecision.allowed && safePatch.allowed,
    reason: cwdDecision.reason ?? safePatch.reason ?? null,
    patchBytes: Buffer.byteLength(patchPayload.patch, 'utf8'),
    cwd: cwdDecision.cwd,
    timeoutMs: cwdDecision.timeoutMs,
    approvalAction: 'applyApprovedPatch',
    confirmationRequiredForApproval: true
  };
}

export async function applyArcanosCliApprovedPatch(payload: unknown) {
  assertArcanosCliBridgeEnabled();
  const proposal = proposeArcanosCliPatch(payload);
  if (!proposal.allowed) {
    return {
      ok: false,
      status: 'denied',
      proposal,
      error: {
        code: 'ARCANOS_CLI_POLICY_DENIED',
        message: 'Patch is denied by ARCANOS CLI policy.'
      }
    };
  }
  const proposalCheck = verifyApprovedProposalId(payload, proposal.proposalId);
  if (!proposalCheck.ok) {
    return proposalCheck.response;
  }

  const patchPayload = normalizePatchPayload(payload);
  return redactAndCap(await postBridgeJson('/patches/apply', {
    patch: patchPayload.patch,
    cwd: proposal.cwd,
    timeoutSeconds: Math.ceil(proposal.timeoutMs / 1000)
  }));
}

export function tailArcanosCliAudit() {
  return {
    ok: true,
    events: [],
    message: 'Durable daemon audit tailing is not exposed through the GPT Access bridge yet.'
  };
}

function normalizeCommandPayload(payload: unknown): NormalizedCommandPayload {
  if (!isRecord(payload) || typeof payload.command !== 'string' || payload.command.trim().length === 0) {
    throw new Error('command must be a non-empty string.');
  }
  if (/[\r\n]/u.test(payload.command) || BIDI_CONTROL_PATTERN.test(payload.command)) {
    throw new Error('command contains unsupported control characters.');
  }

  return {
    command: payload.command.trim(),
    cwd: typeof payload.cwd === 'string' && payload.cwd.trim().length > 0 ? payload.cwd.trim() : undefined,
    timeoutMs: typeof payload.timeoutMs === 'number' ? payload.timeoutMs : DEFAULT_TIMEOUT_MS
  };
}

function assertArcanosCliBridgeEnabled(): void {
  if (!isArcanosCliBridgeEnabled()) {
    throw new Error('ARCANOS CLI bridge is disabled.');
  }
}

function verifyApprovedProposalId(
  payload: unknown,
  expectedProposalId: string
): { ok: true } | { ok: false; response: Record<string, unknown> } {
  const proposalId = isRecord(payload) && typeof payload.proposalId === 'string'
    ? payload.proposalId.trim()
    : '';
  if (proposalId.length === 0) {
    return {
      ok: false,
      response: {
        ok: false,
        status: 'proposal_required',
        error: {
          code: 'ARCANOS_CLI_PROPOSAL_REQUIRED',
          message: 'Approval requires the proposalId returned by the matching proposal action.'
        }
      }
    };
  }
  if (proposalId !== expectedProposalId) {
    return {
      ok: false,
      response: {
        ok: false,
        status: 'proposal_mismatch',
        error: {
          code: 'ARCANOS_CLI_PROPOSAL_MISMATCH',
          message: 'Approval proposalId does not match the approved payload.'
        }
      }
    };
  }
  return { ok: true };
}

function normalizePatchPayload(payload: unknown): NormalizedPatchPayload {
  if (!isRecord(payload) || typeof payload.patch !== 'string' || payload.patch.trim().length === 0) {
    throw new Error('patch must be a non-empty unified diff string.');
  }

  return {
    patch: payload.patch,
    cwd: typeof payload.cwd === 'string' && payload.cwd.trim().length > 0 ? payload.cwd.trim() : undefined,
    timeoutMs: typeof payload.timeoutMs === 'number' ? payload.timeoutMs : DEFAULT_TIMEOUT_MS
  };
}

function validatePatchText(patch: string): { allowed: boolean; reason?: string } {
  if (BIDI_CONTROL_PATTERN.test(patch)) {
    return { allowed: false, reason: 'patch_contains_unsupported_control_character' };
  }
  if (Buffer.byteLength(patch, 'utf8') > MAX_PATCH_BYTES) {
    return { allowed: false, reason: 'patch_too_large' };
  }
  const unsafePathReason = validatePatchPaths(patch);
  if (unsafePathReason) {
    return { allowed: false, reason: unsafePathReason };
  }
  if (/^diff --git a\/\.env\b|^\+\+\+ b\/\.env\b|^--- a\/\.env\b/im.test(patch)) {
    return { allowed: false, reason: 'patch_targets_env_file' };
  }
  if (/BEGIN (?:RSA |OPENSSH |EC |DSA )?PRIVATE KEY/i.test(patch)) {
    return { allowed: false, reason: 'patch_contains_private_key' };
  }
  if (/^new file mode 120000$/im.test(patch)) {
    return { allowed: false, reason: 'patch_symlink_not_allowed' };
  }
  return { allowed: true };
}

function validatePatchPaths(patch: string): string | null {
  for (const line of patch.split(/\r?\n/u)) {
    const match = /^(?:diff --git a\/(.+?) b\/(.+)|(?:---|\+\+\+) (?:a|b)\/(.+))$/u.exec(line);
    const headerMatch = /^(?:---|\+\+\+) ([^\t ]+)/u.exec(line);
    if (headerMatch && headerMatch[1] !== '/dev/null' && !/^[ab]\//u.test(headerMatch[1])) {
      return 'patch_path_outside_sandbox';
    }
    if (!match) {
      continue;
    }
    const paths = match.slice(1).filter((value): value is string => Boolean(value));
    for (const rawPath of paths) {
      const normalizedPath = rawPath.replace(/\\/gu, '/');
      if (
        normalizedPath.startsWith('/')
        || /^[a-zA-Z]:/u.test(normalizedPath)
        || normalizedPath.includes('../')
        || normalizedPath === '..'
      ) {
        return 'patch_path_outside_sandbox';
      }
      if (SECRET_PATCH_PATH_PATTERN.test(normalizedPath)) {
        return 'patch_targets_secret_file';
      }
    }
  }

  if (/^GIT binary patch$/im.test(patch) || /^literal \d+$/im.test(patch)) {
    return 'patch_binary_not_allowed';
  }

  return null;
}

async function isDaemonBridgeReachable(): Promise<boolean> {
  try {
    const response = await fetch(`${getBridgeUrl()}/health`, { method: 'GET' });
    return response.ok;
  } catch {
    return false;
  }
}

async function postBridgeJson(pathname: string, body: Record<string, unknown>): Promise<BridgeRunResponse> {
  const bridgeToken = process.env.ARCANOS_CLI_BRIDGE_TOKEN?.trim();
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (bridgeToken) {
    headers[BRIDGE_TOKEN_HEADER] = bridgeToken;
  }
  const bridgeUrl = getBridgeUrl();
  try {
    const response = await fetch(`${bridgeUrl}${pathname}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body)
    });
    const payload = await response.json() as BridgeRunResponse;
    return payload;
  } catch {
    return {
      ok: false,
      status: 'unavailable',
      error: {
        code: 'ARCANOS_CLI_DAEMON_UNREACHABLE',
        message: 'ARCANOS CLI daemon bridge is unreachable.'
      }
    };
  }
}

function getBridgeUrl(): string {
  const rawBridgeUrl = process.env.ARCANOS_CLI_BRIDGE_URL || DEFAULT_BRIDGE_URL;
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(rawBridgeUrl);
  } catch {
    throw new Error('ARCANOS CLI bridge URL is invalid.');
  }

  if (parsedUrl.protocol !== 'http:' || !LOOPBACK_BRIDGE_HOSTS.has(parsedUrl.hostname)) {
    throw new Error('ARCANOS CLI bridge URL must use HTTP loopback.');
  }

  parsedUrl.pathname = parsedUrl.pathname.replace(/\/+$/u, '');
  parsedUrl.search = '';
  parsedUrl.hash = '';
  return parsedUrl.toString().replace(/\/+$/u, '');
}

function loadCliPolicy(): CliPolicyConfig {
  if (!existsSync(POLICY_PATH)) {
    return DEFAULT_CLI_POLICY;
  }
  try {
    return mergeCliPolicyConfig(JSON.parse(readFileSync(POLICY_PATH, 'utf8')) as Partial<CliPolicyConfig>);
  } catch {
    return DEFAULT_CLI_POLICY;
  }
}

function mergeCliPolicyConfig(partial: Partial<CliPolicyConfig>): CliPolicyConfig {
  return {
    ...DEFAULT_CLI_POLICY,
    ...partial,
    commandPolicy: {
      ...DEFAULT_CLI_POLICY.commandPolicy,
      ...(partial.commandPolicy ?? {})
    },
    cwdSandbox: {
      ...DEFAULT_CLI_POLICY.cwdSandbox,
      ...(partial.cwdSandbox ?? {})
    },
    timeoutPolicy: {
      ...DEFAULT_CLI_POLICY.timeoutPolicy,
      ...(partial.timeoutPolicy ?? {})
    },
    outputPolicy: {
      ...DEFAULT_CLI_POLICY.outputPolicy,
      ...(partial.outputPolicy ?? {})
    },
    redactionPolicy: {
      ...DEFAULT_CLI_POLICY.redactionPolicy,
      ...(partial.redactionPolicy ?? {})
    }
  };
}

function redactAndCap(value: unknown): unknown {
  const policy = loadCliPolicy();
  if (typeof value === 'string') {
    return limitBytes(redactCliOutput(value, policy), getOutputMaxBytes(policy));
  }
  if (Array.isArray(value)) {
    return value.map(redactAndCap);
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, entryValue]) => {
        if (SECRET_VALUE_KEY_PATTERN.test(key)) {
          return [key, policy.redactionPolicy.replacement];
        }
        return [key, redactAndCap(entryValue)];
      })
    );
  }
  return value;
}

function limitBytes(value: string, maxBytes: number): string {
  const buffer = Buffer.from(value, 'utf8');
  if (buffer.byteLength <= maxBytes) {
    return value;
  }
  let end = maxBytes;
  while (end > 0 && (buffer[end] & 0xc0) === 0x80) {
    end -= 1;
  }
  return `${buffer.toString('utf8', 0, end)}\n[truncated]`;
}

function getDefaultTimeoutMs(policy: CliPolicyConfig): number {
  const raw = Number.parseInt(process.env.ARCANOS_CLI_COMMAND_TIMEOUT_MS || '', 10);
  return Number.isFinite(raw) && raw > 0 ? raw : policy.timeoutPolicy.defaultMs;
}

function getOutputMaxBytes(policy: CliPolicyConfig): number {
  const raw = Number.parseInt(process.env.ARCANOS_CLI_OUTPUT_MAX_BYTES || '', 10);
  return Number.isFinite(raw) && raw > 0 ? raw : Math.min(policy.outputPolicy.maxChars, DEFAULT_OUTPUT_MAX_BYTES);
}

function hashProposal(value: Record<string, unknown>): string {
  return `cli-${crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 16)}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
