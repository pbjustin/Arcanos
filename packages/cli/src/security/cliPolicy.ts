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
      "ARCANOS_BACKSTAGE_BOOKER_ACCESS_TOKEN",
      "ARCANOS_BACKSTAGE_NOTION_ACCESS_TOKEN",
      "ARCANOS_BACKSTAGE_NOTION_UNIVERSE_PAGES_JSON",
      "ARCANOS_GAMING_SOURCE_ACCESS_TOKEN",
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
  let redacted = stripUnsafeCliOutputControls(value);
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

// Keep this explicit Unicode Default_Ignorable_Code_Point set mirrored with
// daemon-python/arcanos/cli/cli_policy.py.
const DEFAULT_IGNORABLE_CODE_POINT_PATTERN = /[\u00AD\u034F\u061C\u115F-\u1160\u17B4-\u17B5\u180B-\u180F\u200B-\u200F\u202A-\u202E\u2060-\u206F\u3164\uFE00-\uFE0F\uFEFF\uFFA0\uFFF0-\uFFF8\u{1BCA0}-\u{1BCA3}\u{1D173}-\u{1D17A}\u{E0000}-\u{E0FFF}]/gu;
const C1_CONTROL_STRING_INTRODUCERS = new Set([0x90, 0x98, 0x9D, 0x9E, 0x9F]);

function stripUnsafeCliOutputControls(value: string): string {
  const normalized = value.replace(DEFAULT_IGNORABLE_CODE_POINT_PATTERN, "");
  let sanitized = "";
  let index = 0;

  while (index < normalized.length) {
    const terminalSequenceEnd = consumeTerminalSequenceAt(normalized, index);
    if (terminalSequenceEnd !== undefined) {
      index = terminalSequenceEnd;
      continue;
    }

    const codePoint = normalized.codePointAt(index);
    if (codePoint === undefined) {
      break;
    }
    if (isUnsafeC0OrC1Control(codePoint)) {
      index += 1;
      continue;
    }

    const character = String.fromCodePoint(codePoint);
    sanitized += character;
    index += character.length;
  }

  return sanitized;
}

function isC0OrC1Control(codePoint: number): boolean {
  return codePoint <= 0x1F || (codePoint >= 0x7F && codePoint <= 0x9F);
}

function isUnsafeC0OrC1Control(codePoint: number): boolean {
  return codePoint <= 0x08
    || codePoint === 0x0B
    || codePoint === 0x0C
    || (codePoint >= 0x0E && codePoint <= 0x1F)
    || (codePoint >= 0x7F && codePoint <= 0x9F);
}

function isTerminalRecordBoundary(codePoint: number): boolean {
  return codePoint === 0x09
    || codePoint === 0x0A
    || codePoint === 0x0D
    || codePoint === 0x85
    || codePoint === 0x2028
    || codePoint === 0x2029;
}

function isTerminalSequenceIntroducer(codePoint: number): boolean {
  return codePoint === 0x1B
    || codePoint === 0x9B
    || C1_CONTROL_STRING_INTRODUCERS.has(codePoint);
}

function consumeCsiSequence(value: string, start: number): number {
  let index = start;
  let parsingIntermediates = false;

  while (index < value.length) {
    const codePoint = value.charCodeAt(index);
    if (isTerminalRecordBoundary(codePoint)) {
      return index;
    }
    if (isC0OrC1Control(codePoint)) {
      // Return the nested introducer so the outer scanner redispatches from it.
      if (isTerminalSequenceIntroducer(codePoint)) {
        return index;
      }
      index += 1;
      continue;
    }
    if (!parsingIntermediates && codePoint >= 0x30 && codePoint <= 0x3F) {
      index += 1;
      continue;
    }
    if (codePoint >= 0x20 && codePoint <= 0x2F) {
      parsingIntermediates = true;
      index += 1;
      continue;
    }
    if (codePoint >= 0x40 && codePoint <= 0x7E) {
      return index + 1;
    }
    return value.length;
  }

  return value.length;
}

function consumeGenericEscapeSequence(value: string, start: number): number {
  let index = start;

  while (index < value.length) {
    const codePoint = value.charCodeAt(index);
    if (isTerminalRecordBoundary(codePoint)) {
      return index;
    }
    if (isC0OrC1Control(codePoint)) {
      // Return the nested introducer so the outer scanner redispatches from it.
      if (isTerminalSequenceIntroducer(codePoint)) {
        return index;
      }
      index += 1;
      continue;
    }
    if (codePoint >= 0x20 && codePoint <= 0x2F) {
      index += 1;
      continue;
    }
    if (codePoint >= 0x30 && codePoint <= 0x7E) {
      return index + 1;
    }
    return value.length;
  }

  return value.length;
}

function consumeControlString(value: string, start: number, osc: boolean): number {
  let index = start;

  while (index < value.length) {
    const codePoint = value.charCodeAt(index);
    if (isTerminalRecordBoundary(codePoint)) {
      return index;
    }
    if (osc && codePoint === 0x07) {
      return index + 1;
    }
    if (codePoint === 0x9C) {
      return index + 1;
    }
    if (codePoint === 0x1B) {
      let terminatorIndex = index + 1;
      while (terminatorIndex < value.length && isC0OrC1Control(value.charCodeAt(terminatorIndex))) {
        const embeddedCodePoint = value.charCodeAt(terminatorIndex);
        if (isTerminalRecordBoundary(embeddedCodePoint)) {
          break;
        }
        if (osc && embeddedCodePoint === 0x07) {
          return terminatorIndex + 1;
        }
        if (embeddedCodePoint === 0x9C) {
          return terminatorIndex + 1;
        }
        terminatorIndex += 1;
      }
      if (terminatorIndex < value.length && value[terminatorIndex] === "\\") {
        return terminatorIndex + 1;
      }
      index = terminatorIndex;
      continue;
    }
    index += 1;
  }

  return value.length;
}

function consumeEscapeSequence(value: string, start: number): number {
  let commandIndex = start + 1;
  while (commandIndex < value.length) {
    const codePoint = value.charCodeAt(commandIndex);
    if (isTerminalRecordBoundary(codePoint)) {
      return commandIndex;
    }
    if (!isC0OrC1Control(codePoint)) {
      break;
    }
    if (isTerminalSequenceIntroducer(codePoint)) {
      return commandIndex;
    }
    commandIndex += 1;
  }
  if (commandIndex >= value.length) {
    return value.length;
  }

  const command = value[commandIndex];
  if (command === "[") {
    return consumeCsiSequence(value, commandIndex + 1);
  }
  if (command === "]") {
    return consumeControlString(value, commandIndex + 1, true);
  }
  if (command === "P" || command === "X" || command === "^" || command === "_") {
    return consumeControlString(value, commandIndex + 1, false);
  }
  return consumeGenericEscapeSequence(value, commandIndex);
}

function consumeTerminalSequenceAt(value: string, start: number): number | undefined {
  const codePoint = value.charCodeAt(start);
  if (codePoint === 0x1B) {
    return consumeEscapeSequence(value, start);
  }
  if (codePoint === 0x9B) {
    return consumeCsiSequence(value, start + 1);
  }
  if (C1_CONTROL_STRING_INTRODUCERS.has(codePoint)) {
    return consumeControlString(value, start + 1, codePoint === 0x9D);
  }
  return undefined;
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

const ASSIGNMENT_PADDING_PATTERN = "[\\u0009-\\u000D\\u001C-\\u0020\\u0085\\u00A0\\u1680\\u2000-\\u200A\\u2028\\u2029\\u202F\\u205F\\u3000\\uFEFF]*";

function redactNamedAssignment(value: string, envName: string, replacement: string): string {
  const pattern = new RegExp(
    "(?<![A-Za-z0-9_])(" + escapeRegExp(envName) + ASSIGNMENT_PADDING_PATTERN + "=" + ASSIGNMENT_PADDING_PATTERN + ")",
    "gi"
  );
  let cursor = 0;
  let redacted = "";
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(value)) !== null) {
    const assignmentStart = match.index;
    const valueStart = pattern.lastIndex;
    const firstCharacter = value[valueStart];

    if (firstCharacter === undefined) {
      continue;
    }

    let valueEnd: number;
    let redactedValue = replacement;

    if (firstCharacter === "\"" || firstCharacter === "'") {
      valueEnd = findAssignmentTokenEnd(value, valueStart);
      redactedValue = `${firstCharacter}${replacement}${firstCharacter}`;
    } else if (firstCharacter === "{" || firstCharacter === "[") {
      // Invalid, unclosed, or mismatched structured values consume the rest of the string.
      // This is intentionally fail-closed because a later whitespace boundary may
      // still be part of a multiline sensitive JSON value.
      const structuredEnd = findStructuredAssignmentValueEnd(value, valueStart);
      valueEnd = structuredEnd !== undefined
        && isStrictJsonAssignmentValue(value, valueStart, structuredEnd)
        ? findAssignmentTokenEnd(value, structuredEnd)
        : value.length;
    } else {
      valueEnd = findAssignmentTokenEnd(value, valueStart);
    }

    if (valueEnd === valueStart) {
      continue;
    }

    redacted += value.slice(cursor, assignmentStart);
    redacted += `${match[1]}${redactedValue}`;
    cursor = valueEnd;
    pattern.lastIndex = valueEnd;
  }

  return `${redacted}${value.slice(cursor)}`;
}

function findAssignmentTokenEnd(value: string, start: number): number {
  let quote: "\"" | "'" | undefined;

  for (let index = start; index < value.length; index += 1) {
    const character = value[index];
    if (character === "`" || (character === "$" && value[index + 1] === "(")) {
      return value.length;
    }

    if (quote !== undefined) {
      if (character === quote) {
        quote = undefined;
      } else if (quote === "\"" && character === "\\") {
        index += 1;
      }
      continue;
    }

    if (isAsciiAssignmentBoundary(character)) {
      return index;
    }
    if (character === "\"" || character === "'") {
      quote = character;
    } else if (character === "\\" || character === "^") {
      index += 1;
    }
  }

  return value.length;
}

function isAsciiAssignmentBoundary(character: string | undefined): boolean {
  return character !== undefined && /[\u0009\u000A\u000D\u0020]/.test(character);
}

const MAX_STRUCTURED_ASSIGNMENT_DEPTH = 64;

function findStructuredAssignmentValueEnd(value: string, start: number): number | undefined {
  const openingCharacter = value[start];
  if (openingCharacter !== "{" && openingCharacter !== "[") {
    return undefined;
  }

  const delimiters = [openingCharacter];
  let insideString = false;

  for (let index = start + 1; index < value.length; index += 1) {
    const character = value[index];

    if (insideString) {
      if (character === "\\") {
        index += 1;
      } else if (character === "\"") {
        insideString = false;
      }
      continue;
    }

    if (character === "\"") {
      insideString = true;
      continue;
    }

    if (character === "{" || character === "[") {
      if (delimiters.length >= MAX_STRUCTURED_ASSIGNMENT_DEPTH) {
        return undefined;
      }
      delimiters.push(character);
      continue;
    }

    if (character !== "}" && character !== "]") {
      continue;
    }

    const expectedOpeningCharacter = character === "}" ? "{" : "[";
    if (delimiters.at(-1) !== expectedOpeningCharacter) {
      return undefined;
    }

    delimiters.pop();
    if (delimiters.length === 0) {
      return index + 1;
    }
  }

  return undefined;
}

function isStrictJsonAssignmentValue(value: string, start: number, end: number): boolean {
  try {
    JSON.parse(value.slice(start, end));
    return true;
  } catch {
    return false;
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
