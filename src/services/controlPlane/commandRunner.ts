import { execFile } from 'node:child_process';

import type {
  ControlPlaneCommandPlan,
  ControlPlaneCommandResult,
  ControlPlaneCommandRunner,
} from './types.js';

function resolveExitCode(error: unknown): number {
  if (!error || typeof error !== 'object') {
    return 0;
  }
  const code = (error as { code?: unknown }).code;
  return typeof code === 'number' ? code : 1;
}

export async function runControlPlaneCommand(plan: ControlPlaneCommandPlan): Promise<ControlPlaneCommandResult> {
  const startedAt = Date.now();
  return new Promise((resolve) => {
    execFile(
      plan.executable,
      plan.args,
      {
        cwd: plan.cwd ?? process.cwd(),
        shell: false,
        windowsHide: true,
        timeout: plan.timeoutMs ?? 20_000,
        maxBuffer: plan.maxBufferBytes ?? 512 * 1024,
      },
      (error, stdout, stderr) => {
        resolve({
          exitCode: resolveExitCode(error),
          stdout: String(stdout ?? ''),
          stderr: String(stderr ?? ''),
          signal: error && typeof error === 'object'
            ? ((error as { signal?: string | null }).signal ?? null)
            : null,
          durationMs: Date.now() - startedAt,
        });
      }
    );
  });
}

export const defaultControlPlaneCommandRunner: ControlPlaneCommandRunner = Object.freeze({
  run: runControlPlaneCommand,
});
