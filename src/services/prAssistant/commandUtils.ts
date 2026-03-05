import { spawn, type SpawnOptions } from 'child_process';

function sanitizeArgs(args: string[]): string[] {
  return args.map(a => a.replace(/[^\w:/.-]/g, ''));
}

function resolvePlatformCommand(command: string): string {
  //audit Assumption: Windows resolves npm/npx through .cmd shims; risk: ENOENT when spawning bare command; invariant: equivalent command executable is selected per platform; handling: map npm/npx/node-gyp to .cmd on win32.
  if (process.platform !== 'win32') {
    return command;
  }
  const commandMap: Record<string, string> = {
    npm: 'npm.cmd',
    npx: 'npx.cmd',
    'node-gyp': 'node-gyp.cmd'
  };
  return commandMap[command] || command;
}

export function runCommand(command: string, args: string[], options: SpawnOptions = {}): Promise<{ stdout: string; stderr: string; }> {
  return new Promise((resolve, reject) => {
    const executable = resolvePlatformCommand(command);
    const proc = spawn(executable, sanitizeArgs(args), { ...options, shell: false });
    let stdout = '';
    let stderr = '';

    proc.stdout?.on('data', d => { stdout += d; });
    proc.stderr?.on('data', d => { stderr += d; });
    proc.on('close', code => {
      if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        reject(new Error(stderr || `Command failed: ${command} ${args.join(' ')}`));
      }
    });
  });
}
