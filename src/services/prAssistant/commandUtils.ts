import { spawn, type SpawnOptions } from 'child_process';

function sanitizeArgs(args: string[]): string[] {
  return args.map(a => a.replace(/[^\w:/.-]/g, ''));
}

export function runCommand(command: string, args: string[], options: SpawnOptions = {}): Promise<{ stdout: string; stderr: string; }> {
  return new Promise((resolve, reject) => {
    const proc = spawn(command, sanitizeArgs(args), { ...options, shell: false });
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
