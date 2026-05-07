import path from "node:path";
import { existsSync, realpathSync } from "node:fs";

export interface CliPolicyConfig {
  version: number;
  cwdSandbox: {
    defaultRoot: string;
    allowSubdirectoriesOnly: boolean;
  };
  commandPolicy: {
    allowPrefixes?: string[];
    denyPatterns: string[];
  };
  outputPolicy: {
    maxChars: number;
    truncationMarker: string;
  };
  timeoutPolicy: {
    defaultMs: number;
    maxMs: number;
  };
  redactionPolicy: {
    replacement: string;
    envNames: string[];
  };
  patchPolicy: {
    maxBytes: number;
    secretPathPatterns: string[];
    denyContentPatterns: string[];
  };
}

export interface CliCommandPolicyInput {
  command: string;
  cwd?: string;
  workspaceRoot: string;
  timeoutMs?: number;
  policy?: CliPolicyConfig;
}

export interface CliPolicyDecision {
  allowed: boolean;
  reason?: string;
  matchedPattern?: string;
  cwd: string;
  timeoutMs: number;
}

export interface CliAuditEventRecord {
  event: "cli.command.policy";
  decision: "allowed" | "denied";
  reason?: string;
  command: string;
  cwd: string;
  timeoutMs: number;
  timestamp: string;
}

export const DEFAULT_CLI_POLICY: CliPolicyConfig = {
  version: 1,
  cwdSandbox: {
    defaultRoot: ".",
    allowSubdirectoriesOnly: true
  },
  commandPolicy: {
    allowPrefixes: [
      "git status",
      "git diff",
      "git log",
      "git show",
      "npm run probe",
      "npm run build:packages",
      "npm run validate:backend-cli:contract",
      "npm run validate:backend-cli:offline",
      "python validate_backend_cli_offline.py",
      "python -m pytest tests/"
    ],
    denyPatterns: [
      "\\brm\\s+-rf\\b",
      "\\bRemove-Item\\b.*\\s-(Recurse|r)\\b.*\\s-(Force|f)\\b",
      "\\bdel\\s+/[sfq]\\b",
      "\\bformat\\b",
      "\\bdd\\s+if=",
      "\\bmkfs(\\.|\\s)",
      "\\bshutdown\\b",
      "\\breboot\\b",
      "\\breg\\s+delete\\b",
      "(?:&&|\\|\\||[;|<>`]|\\$\\()",
      "[\\r\\n]",
      "\\.\\.[/\\\\]",
      "\\b(?:curl|wget|Invoke-WebRequest|iwr)\\b",
      "\\b(?:cat|type|Get-Content)\\s+\\.env\\b",
      "(?:^|\\s)--require\\b",
      "\\bchild_process\\b"
    ]
  },
  outputPolicy: {
    maxChars: 12000,
    truncationMarker: "\n[truncated]"
  },
  timeoutPolicy: {
    defaultMs: 30000,
    maxMs: 120000
  },
  redactionPolicy: {
    replacement: "[REDACTED]",
    envNames: [
      "ARCANOS_GPT_ACCESS_TOKEN",
      "DATABASE_URL",
      "OPENAI_API_KEY",
      "RAILWAY_TOKEN"
    ]
  },
  patchPolicy: {
    maxBytes: 200000,
    secretPathPatterns: [
      "(?:^|/)(?:\\.env(?:\\..*)?|\\.npmrc|\\.pypirc|\\.netrc|\\.ssh/.+|id_rsa|id_ed25519|[^/]*(?:secret|token|credential|private[_-]?key)[^/]*|[^/]*\\.(?:pem|key|p12|pfx))$"
    ],
    denyContentPatterns: [
      "BEGIN (?:RSA |OPENSSH |EC |DSA )?PRIVATE KEY",
      "^GIT binary patch$",
      "^Binary files ",
      "^new file mode 120000$"
    ]
  }
};

/**
 * Applies CLI command safety policy without executing the command.
 * Inputs/Outputs: command, cwd, workspace root, optional timeout; returns an allow/deny decision.
 * Edge cases: cwd must resolve inside the workspace root and timeout is clamped to policy bounds.
 */
export function evaluateCliCommandPolicy(input: CliCommandPolicyInput): CliPolicyDecision {
  const policy = input.policy ?? DEFAULT_CLI_POLICY;
  const cwdDecision = resolveSandboxedCwd({
    cwd: input.cwd,
    workspaceRoot: input.workspaceRoot,
    policy
  });
  const timeoutMs = resolveCliTimeoutMs(input.timeoutMs, policy);

  if (!cwdDecision.allowed) {
    return {
      allowed: false,
      reason: cwdDecision.reason,
      cwd: cwdDecision.cwd,
      timeoutMs
    };
  }

  const matchedPattern = findDeniedCommandPattern(input.command, policy);
  if (matchedPattern) {
    return {
      allowed: false,
      reason: "command_denied_by_policy",
      matchedPattern,
      cwd: cwdDecision.cwd,
      timeoutMs
    };
  }

  if (!isAllowedCommandPrefix(input.command, policy)) {
    return {
      allowed: false,
      reason: "command_not_allowlisted",
      cwd: cwdDecision.cwd,
      timeoutMs
    };
  }

  return {
    allowed: true,
    cwd: cwdDecision.cwd,
    timeoutMs
  };
}

function isAllowedCommandPrefix(command: string, policy: CliPolicyConfig): boolean {
  const allowPrefixes = policy.commandPolicy.allowPrefixes ?? [];
  if (allowPrefixes.length === 0) {
    return true;
  }

  const normalizedCommand = command.trim().toLowerCase();
  return allowPrefixes.some((prefix) => {
    const normalizedPrefix = prefix.trim().toLowerCase();
    return (
      normalizedCommand === normalizedPrefix
      || normalizedCommand.startsWith(`${normalizedPrefix} `)
    );
  });
}

export function resolveCliTimeoutMs(timeoutMs: number | undefined, policy: CliPolicyConfig = DEFAULT_CLI_POLICY): number {
  if (typeof timeoutMs !== "number" || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return policy.timeoutPolicy.defaultMs;
  }

  return Math.min(Math.trunc(timeoutMs), policy.timeoutPolicy.maxMs);
}

export function redactCliOutput(value: string, policy: CliPolicyConfig = DEFAULT_CLI_POLICY): string {
  let redacted = value;
  for (const envName of policy.redactionPolicy.envNames) {
    redacted = redactNamedAssignment(redacted, envName, policy.redactionPolicy.replacement);
  }

  redacted = redacted
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/g, `Bearer ${policy.redactionPolicy.replacement}`)
    .replace(/\bsk-[A-Za-z0-9_-]{12,}\b/g, policy.redactionPolicy.replacement)
    .replace(/\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9_]{20,}\b/g, policy.redactionPolicy.replacement)
    .replace(/\brwy_[A-Za-z0-9_=-]{20,}\b/gi, policy.redactionPolicy.replacement)
    .replace(/\b[A-Za-z][A-Za-z0-9+.-]*:\/\/[^\s"'`]*:[^\s"'`@]+@[^\s"'`]+/g, policy.redactionPolicy.replacement)
    .replace(/\b((?:token|secret|password|api[_-]?key|authorization|cookie)\s*=\s*)(["']?)[^\s"'`]+\2/gi, (_match, prefix: string, quote: string) => {
      return `${prefix}${quote}${policy.redactionPolicy.replacement}${quote}`;
    })
    .replace(/BEGIN [A-Z ]*PRIVATE KEY[\s\S]*?END [A-Z ]*PRIVATE KEY/gi, policy.redactionPolicy.replacement);

  return truncateCliOutput(redacted, policy);
}

export function redactCliEnv(
  env: Record<string, string | undefined>,
  policy: CliPolicyConfig = DEFAULT_CLI_POLICY
): Record<string, string | undefined> {
  const sensitiveNames = new Set(policy.redactionPolicy.envNames.map((name) => name.toLowerCase()));
  return Object.fromEntries(
    Object.entries(env).map(([key, value]) => [
      key,
      sensitiveNames.has(key.toLowerCase()) && value ? policy.redactionPolicy.replacement : value
    ])
  );
}

export function truncateCliOutput(value: string, policy: CliPolicyConfig = DEFAULT_CLI_POLICY): string {
  const maxChars = policy.outputPolicy.maxChars;
  if (value.length <= maxChars) {
    return value;
  }

  return `${value.slice(0, maxChars)}${policy.outputPolicy.truncationMarker}`;
}

export function buildCliPolicyAuditEvent(
  command: string,
  decision: CliPolicyDecision,
  now: Date = new Date(),
  policy: CliPolicyConfig = DEFAULT_CLI_POLICY
): CliAuditEventRecord {
  return {
    event: "cli.command.policy",
    decision: decision.allowed ? "allowed" : "denied",
    reason: decision.reason,
    command: redactCliOutput(command, policy),
    cwd: decision.cwd,
    timeoutMs: decision.timeoutMs,
    timestamp: now.toISOString()
  };
}

function findDeniedCommandPattern(command: string, policy: CliPolicyConfig): string | undefined {
  return policy.commandPolicy.denyPatterns.find((pattern) => new RegExp(pattern, "i").test(command));
}

function resolveSandboxedCwd(input: {
  cwd?: string;
  workspaceRoot: string;
  policy: CliPolicyConfig;
}): { allowed: boolean; cwd: string; reason?: string } {
  const workspaceRoot = path.resolve(input.workspaceRoot);
  const requestedCwd = path.resolve(workspaceRoot, input.cwd ?? input.policy.cwdSandbox.defaultRoot);
  const realWorkspaceRoot = resolveExistingRealPath(workspaceRoot);
  const realRequestedCwd = resolveExistingRealPath(requestedCwd);
  const relativePath = path.relative(realWorkspaceRoot, realRequestedCwd);
  const insideWorkspace = relativePath === "" || (!relativePath.startsWith("..") && !path.isAbsolute(relativePath));

  if (input.policy.cwdSandbox.allowSubdirectoriesOnly && !insideWorkspace) {
    return {
      allowed: false,
      cwd: realRequestedCwd,
      reason: "cwd_outside_workspace"
    };
  }

  return {
    allowed: true,
    cwd: realRequestedCwd
  };
}

function resolveExistingRealPath(value: string): string {
  return existsSync(value) ? realpathSync(value) : path.resolve(value);
}

function redactNamedAssignment(value: string, envName: string, replacement: string): string {
  const pattern = new RegExp("\\b(" + escapeRegExp(envName) + "\\s*=\\s*)([\"']?)([^\\s\"'`]+)([\"']?)", "gi");
  return value.replace(pattern, (_match, prefix: string, openQuote: string, _secret: string, closeQuote: string) => (
    `${prefix}${openQuote}${replacement}${closeQuote}`
  ));
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
