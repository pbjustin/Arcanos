import path from "node:path";

import type { CliGlobalOptions, CliInvocation } from "./types.js";

const DEFAULT_BASE_URL = process.env.ARCANOS_BACKEND_URL ?? "http://127.0.0.1:3000";

export function parseCliInvocation(argv: string[]): CliInvocation {
  if (argv.length === 0) {
    return { kind: "help" };
  }

  if (argv.length === 1 && (argv[0] === "help" || argv[0] === "--help" || argv[0] === "-h")) {
    return { kind: "help" };
  }

  if (argv[0] === "protocol") {
    return {
      kind: "protocol",
      argv: argv.slice(1)
    };
  }

  const { positionals, options } = parseGlobalOptions(argv);
  const [command, ...rest] = positionals;

  switch (command) {
    case "ask":
      return {
        kind: "ask",
        prompt: requirePrompt("ask", rest),
        options
      };
    case "generate-and-wait":
      return {
        kind: "generate-and-wait",
        ...parseGenerateAndWaitArgs(rest),
        options
      };
    case "plan":
      return {
        kind: "plan",
        prompt: requirePrompt("plan", rest),
        options
      };
    case "exec":
      return {
        kind: "exec",
        prompt: rest.length > 0 ? rest.join(" ") : undefined,
        options
      };
    case "status":
      if (rest.length > 0) {
        throw new Error('`status` does not accept positional arguments.');
      }
      return {
        kind: "status",
        options
      };
    case "workers":
      if (rest.length > 0) {
        throw new Error('`workers` does not accept positional arguments.');
      }
      return {
        kind: "workers",
        options
      };
    case "logs":
      if (rest.length !== 1 || rest[0] !== "--recent") {
        throw new Error('Supported logs command: `arcanos logs --recent`.');
      }
      return {
        kind: "logs",
        recent: true,
        options
      };
    case "inspect":
      if (rest.length !== 1 || rest[0] !== "self-heal") {
        throw new Error('Supported inspect command: `arcanos inspect self-heal`.');
      }
      return {
        kind: "inspect",
        subject: "self-heal",
        options
      };
    case "doctor":
      if (rest.length !== 1 || rest[0] !== "implementation") {
        throw new Error('Supported doctor command: `arcanos doctor implementation`.');
      }
      return {
        kind: "doctor",
        subject: "implementation",
        options
      };
    case "help":
    case "--help":
    case "-h":
      return { kind: "help" };
    default:
      throw new Error(`Unknown command "${command}".`);
  }
}

export function renderUsage(): string {
  return [
    "Usage:",
    "  arcanos ask \"...\" [--json]",
    "  arcanos generate-and-wait --gpt <gpt-id> --prompt \"...\" [--timeout-ms <ms>] [--poll-interval-ms <ms>] [--json]",
    "  arcanos plan \"...\" [--json]",
    "  arcanos exec [\"...\"] [--json]",
    "  arcanos status [--json]",
    "  arcanos workers [--json]",
    "  arcanos logs --recent [--json]",
    "  arcanos inspect self-heal [--json]",
    "  arcanos doctor implementation [--json]",
    "  arcanos protocol <command> --payload-json '{}'",
    "",
    "Global options:",
    "  --json",
    "  --base-url <url>",
    "  --session-id <id>",
    "  --project-id <id>",
    "  --environment <workspace|sandbox|host|remote>",
    "  --cwd <path>",
    "  --shell <name>",
    "  --python-bin <path>",
    "  --transport <python|local>"
  ].join("\n");
}

function parseGlobalOptions(argv: string[]): {
  positionals: string[];
  options: CliGlobalOptions;
} {
  const positionals: string[] = [];
  const options: CliGlobalOptions = {
    json: false,
    baseUrl: DEFAULT_BASE_URL,
    cwd: process.cwd(),
    shell: process.env.ComSpec ?? process.env.SHELL,
    transport: "python",
    transportExplicit: false
  };

  for (let index = 0; index < argv.length; index += 1) {
    const currentArgument = argv[index];
    if (!currentArgument.startsWith("--")) {
      positionals.push(currentArgument);
      continue;
    }

    const isKnownGlobalFlag =
      currentArgument === "--json" ||
      currentArgument === "--base-url" ||
      currentArgument === "--session-id" ||
      currentArgument === "--project-id" ||
      currentArgument === "--environment" ||
      currentArgument === "--cwd" ||
      currentArgument === "--shell" ||
      currentArgument === "--python-bin" ||
      currentArgument === "--transport";

    if (!isKnownGlobalFlag && positionals.length > 0) {
      positionals.push(currentArgument);
      continue;
    }

    if (currentArgument === "--json") {
      options.json = true;
      continue;
    }

    const value = argv[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`Flag "${currentArgument}" requires a value.`);
    }

    switch (currentArgument) {
      case "--base-url":
        options.baseUrl = value.replace(/\/+$/, "");
        break;
      case "--session-id":
        options.sessionId = value;
        break;
      case "--project-id":
        options.projectId = value;
        break;
      case "--environment":
        options.environment = value;
        break;
      case "--cwd":
        options.cwd = path.resolve(value);
        break;
      case "--shell":
        options.shell = value;
        break;
      case "--python-bin":
        options.pythonBinary = value;
        break;
      case "--transport":
        if (value !== "python" && value !== "local") {
          throw new Error('Flag "--transport" must be "python" or "local".');
        }
        options.transport = value;
        options.transportExplicit = true;
        break;
      default:
        throw new Error(`Unknown flag "${currentArgument}".`);
    }

    index += 1;
  }

  return { positionals, options };
}

function requirePrompt(command: string, args: string[]): string {
  if (args.length === 0) {
    throw new Error(`\`${command}\` requires a prompt string.`);
  }

  return args.join(" ").trim();
}

function parseGenerateAndWaitArgs(args: string[]): {
  gptId: string;
  prompt: string;
  timeoutMs?: number;
  pollIntervalMs?: number;
} {
  let gptId: string | undefined;
  let prompt: string | undefined;
  let timeoutMs: number | undefined;
  let pollIntervalMs: number | undefined;

  for (let index = 0; index < args.length; index += 1) {
    const currentArgument = args[index];
    if (!currentArgument.startsWith("--")) {
      throw new Error('`generate-and-wait` only accepts --gpt, --prompt, --timeout-ms, and --poll-interval-ms.');
    }

    const nextValue = args[index + 1];
    if (!nextValue || nextValue.startsWith("--")) {
      throw new Error(`Flag "${currentArgument}" requires a value.`);
    }

    switch (currentArgument) {
      case "--gpt":
        gptId = nextValue.trim();
        break;
      case "--prompt":
        prompt = nextValue.trim();
        break;
      case "--timeout-ms":
        timeoutMs = parseNonNegativeIntegerFlag(currentArgument, nextValue);
        break;
      case "--poll-interval-ms":
        pollIntervalMs = parsePositiveIntegerFlag(currentArgument, nextValue);
        break;
      default:
        throw new Error(`Unknown flag "${currentArgument}" for \`generate-and-wait\`.`);
    }

    index += 1;
  }

  if (!gptId) {
    throw new Error('`generate-and-wait` requires --gpt <gpt-id>.');
  }

  if (!prompt) {
    throw new Error('`generate-and-wait` requires --prompt "...".');
  }

  return {
    gptId,
    prompt,
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    ...(pollIntervalMs !== undefined ? { pollIntervalMs } : {})
  };
}

function parseNonNegativeIntegerFlag(flagName: string, rawValue: string): number {
  const parsedValue = Number(rawValue);
  if (!Number.isFinite(parsedValue) || !Number.isInteger(parsedValue) || parsedValue < 0) {
    throw new Error(`Flag "${flagName}" must be a non-negative integer.`);
  }

  return parsedValue;
}

function parsePositiveIntegerFlag(flagName: string, rawValue: string): number {
  const parsedValue = Number(rawValue);
  if (!Number.isFinite(parsedValue) || !Number.isInteger(parsedValue) || parsedValue <= 0) {
    throw new Error(`Flag "${flagName}" must be a positive integer.`);
  }

  return parsedValue;
}
