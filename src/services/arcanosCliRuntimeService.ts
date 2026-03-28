import { execFile } from 'node:child_process';
import { access } from 'node:fs/promises';
import path from 'node:path';

const DEFAULT_CLI_TIMEOUT_MS = 2500;
const MAX_CLI_OUTPUT_BYTES = 256 * 1024;

export type ArcanosCliRuntimeCommand =
  | 'status'
  | 'workers'
  | 'logs_recent'
  | 'inspect_self_heal';

export interface ArcanosCliRunResult {
  available: boolean;
  command: ArcanosCliRuntimeCommand;
  cliPath: string | null;
  stdout: string;
  stderr: string;
  parsedOutput: unknown | null;
  exitCode: number | null;
  timedOut: boolean;
  error: string | null;
}

interface ResolvedCliExecutable {
  executable: string;
  executableArgs: string[];
  displayPath: string;
}

function resolveCliCandidates(): string[] {
  const configured = process.env.ARCANOS_CLI_BIN?.trim();
  const candidates = [
    configured || null,
    path.resolve(process.cwd(), 'packages', 'cli', 'dist', 'index.js'),
    path.resolve(process.cwd(), 'node_modules', '.bin', process.platform === 'win32' ? 'arcanos.cmd' : 'arcanos'),
  ];

  return candidates.filter((candidate): candidate is string => typeof candidate === 'string' && candidate.length > 0);
}

async function resolveCliExecutable(): Promise<ResolvedCliExecutable | null> {
  for (const candidate of resolveCliCandidates()) {
    try {
      await access(candidate);
      if (candidate.endsWith('.js') || candidate.endsWith('.mjs') || candidate.endsWith('.cjs')) {
        return {
          executable: process.execPath,
          executableArgs: [candidate],
          displayPath: candidate,
        };
      }

      return {
        executable: candidate,
        executableArgs: [],
        displayPath: candidate,
      };
    } catch {
      continue;
    }
  }

  return null;
}

function buildCliArgs(command: ArcanosCliRuntimeCommand, baseUrl: string): string[] {
  const sharedArgs = ['--json', '--base-url', baseUrl];

  switch (command) {
    case 'status':
      return ['status', ...sharedArgs];
    case 'workers':
      return ['workers', ...sharedArgs];
    case 'logs_recent':
      return ['logs', '--recent', ...sharedArgs];
    case 'inspect_self_heal':
      return ['inspect', 'self-heal', ...sharedArgs];
  }
}

function parseJsonOutput(stdout: string): unknown | null {
  const trimmed = stdout.trim();
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) {
    return null;
  }

  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

export async function isArcanosCliAvailable(): Promise<boolean> {
  return Boolean(await resolveCliExecutable());
}

export async function runArcanosCLI(
  command: ArcanosCliRuntimeCommand,
  options: {
    baseUrl: string;
    timeoutMs?: number;
  }
): Promise<ArcanosCliRunResult> {
  const resolved = await resolveCliExecutable();
  if (!resolved) {
    return {
      available: false,
      command,
      cliPath: null,
      stdout: '',
      stderr: '',
      parsedOutput: null,
      exitCode: null,
      timedOut: false,
      error: 'arcanos_cli_unavailable',
    };
  }

  const timeoutMs = options.timeoutMs ?? DEFAULT_CLI_TIMEOUT_MS;
  const args = [...resolved.executableArgs, ...buildCliArgs(command, options.baseUrl)];

  return await new Promise<ArcanosCliRunResult>((resolve) => {
    execFile(
      resolved.executable,
      args,
      {
        timeout: timeoutMs,
        windowsHide: true,
        maxBuffer: MAX_CLI_OUTPUT_BYTES,
      },
      (error, stdout, stderr) => {
        const executionError = error as (NodeJS.ErrnoException & { killed?: boolean }) | null;
        const exitCode =
          typeof executionError?.code === 'number'
            ? Number(executionError.code)
            : error
            ? 1
            : 0;
        const timedOut = Boolean(executionError?.killed);
        resolve({
          available: true,
          command,
          cliPath: resolved.displayPath,
          stdout,
          stderr,
          parsedOutput: parseJsonOutput(stdout),
          exitCode,
          timedOut,
          error: error ? (error.message || 'arcanos_cli_execution_failed') : null,
        });
      }
    );
  });
}
