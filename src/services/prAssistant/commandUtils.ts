import { spawn, type ChildProcess, type SpawnOptions } from 'child_process';
import { existsSync } from 'fs';
import { delimiter, dirname, join } from 'path';

const FORCE_KILL_DELAY_MS = 1000;

interface ResolvedCommand {
  executable: string;
  args: string[];
}

function resolveNodeCliCommand(command: string, args: string[]): ResolvedCommand | null {
  if (command !== 'npm' && command !== 'npx') {
    return null;
  }

  const cliFileName = command === 'npm' ? 'npm-cli.js' : 'npx-cli.js';
  const candidatePaths: string[] = [];
  const npmExecPath = process.env.npm_execpath;
  if (npmExecPath) {
    candidatePaths.push(command === 'npm'
      ? npmExecPath
      : join(dirname(npmExecPath), cliFileName));
  }

  const npmShimPath = findWindowsShimOnPath('npm.cmd');
  if (npmShimPath !== 'npm.cmd') {
    candidatePaths.push(join(dirname(npmShimPath), 'node_modules', 'npm', 'bin', cliFileName));
  }

  const cliPath = candidatePaths.find(candidatePath => existsSync(candidatePath));
  if (!cliPath) {
    return null;
  }

  return {
    executable: process.execPath,
    args: [cliPath, ...args]
  };
}

function quoteWindowsCmdArg(value: string): string {
  if (value.length === 0) {
    return '""';
  }

  return `"${value.replace(/"/g, '""')}"`;
}

function findWindowsShimOnPath(shimCommand: string): string {
  const pathValue = process.env.Path ?? process.env.PATH ?? '';
  const pathEntries = pathValue.split(delimiter).filter(Boolean);

  for (const entry of pathEntries) {
    const candidate = join(entry, shimCommand);
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  return shimCommand;
}

function resolvePlatformCommand(command: string, args: string[]): ResolvedCommand {
  //audit Assumption: Windows resolves npm/npx through .cmd shims; risk: ENOENT when spawning bare command; invariant: equivalent command executable is selected per platform; handling: map npm/npx/node-gyp to .cmd on win32.
  if (process.platform !== 'win32') {
    return { executable: command, args };
  }

  const nodeCliCommand = resolveNodeCliCommand(command, args);
  if (nodeCliCommand) {
    return nodeCliCommand;
  }
  if (command === 'npm' || command === 'npx') {
    throw new Error(`Unable to resolve ${command} CLI without invoking cmd.exe`);
  }

  const commandMap: Record<string, string> = {
    'node-gyp': 'node-gyp.cmd',
    tsc: 'tsc.cmd',
    jest: 'jest.cmd',
    eslint: 'eslint.cmd',
    'ts-node': 'ts-node.cmd'
  };
  const shimCommand = commandMap[command];
  if (!shimCommand) {
    return { executable: command, args };
  }

  return {
    executable: 'cmd.exe',
    args: ['/d', '/s', '/c', `"${[
      quoteWindowsCmdArg(findWindowsShimOnPath(shimCommand)),
      ...args.map(quoteWindowsCmdArg)
    ].join(' ')}"`]
  };
}

function formatCommandFailure(command: string, args: string[], failureReason: string, stderr: string): string {
  const commandDetails = `Command failed with ${failureReason}: ${command} ${args.join(' ')}`;
  const stderrDetails = stderr.trimEnd();
  return stderrDetails ? `${stderrDetails}\n${commandDetails}` : commandDetails;
}

function killProcessTree(proc: ChildProcess, signal: NodeJS.Signals): void {
  const pid = proc.pid;
  if (!pid) {
    return;
  }

  if (process.platform === 'win32') {
    try {
      const killer = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], {
        stdio: 'ignore',
        windowsHide: true
      });
      killer.on('error', () => undefined);
      killer.unref();
    } catch {
      proc.kill(signal);
    }
    return;
  }

  try {
    process.kill(-pid, signal);
  } catch {
    proc.kill(signal);
  }
}

export function runCommand(command: string, args: string[], options: SpawnOptions = {}): Promise<{ stdout: string; stderr: string; }> {
  return new Promise((resolve, reject) => {
    const resolved = resolvePlatformCommand(command, args);
    const timeoutMs = typeof options.timeout === 'number' && Number.isFinite(options.timeout)
      ? options.timeout
      : undefined;
    const spawnOptions: SpawnOptions = { ...options, shell: false };
    delete spawnOptions.timeout;
    if (process.platform === 'win32' && spawnOptions.windowsHide === undefined) {
      spawnOptions.windowsHide = true;
    }
    if (process.platform === 'win32' && resolved.executable.toLowerCase() === 'cmd.exe') {
      spawnOptions.windowsVerbatimArguments = true;
    }
    if (process.platform !== 'win32' && spawnOptions.detached === undefined) {
      spawnOptions.detached = true;
    }
    const proc = spawn(resolved.executable, resolved.args, spawnOptions);
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    let cleanupKillHandle: ReturnType<typeof setTimeout> | undefined;

    proc.stdout?.on('data', d => { stdout += d; });
    proc.stderr?.on('data', d => { stderr += d; });

    function settle(action: () => void): void {
      if (settled) {
        return;
      }
      settled = true;
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
        timeoutHandle = undefined;
      }
      action();
    }

    if (timeoutMs && timeoutMs > 0) {
      timeoutHandle = setTimeout(() => {
        timedOut = true;
        killProcessTree(proc, 'SIGTERM');
        cleanupKillHandle = setTimeout(() => {
          if (proc.exitCode === null && proc.signalCode === null) {
            killProcessTree(proc, 'SIGKILL');
          }
        }, FORCE_KILL_DELAY_MS);
        settle(() => reject(new Error(`Command timed out after ${timeoutMs}ms: ${command} ${args.join(' ')}`)));
      }, timeoutMs);
    }

    proc.on('error', error => {
      if (cleanupKillHandle) {
        clearTimeout(cleanupKillHandle);
      }
      settle(() => reject(error));
    });

    proc.on('close', (code, signal) => {
      if (cleanupKillHandle) {
        clearTimeout(cleanupKillHandle);
      }
      if (settled) {
        return;
      }

      if (code === 0) {
        settle(() => resolve({ stdout, stderr }));
        return;
      }

      if (timedOut) {
        settle(() => reject(new Error(`Command timed out after ${timeoutMs}ms: ${command} ${args.join(' ')}`)));
        return;
      }

      const failureReason = signal ? `signal ${signal}` : `exit code ${code ?? 'unknown'}`;
      settle(() => reject(new Error(formatCommandFailure(command, args, failureReason, stderr))));
    });
  });
}
