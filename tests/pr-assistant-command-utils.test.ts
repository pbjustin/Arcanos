import { describe, expect, it } from '@jest/globals';

import { runCommand } from '../src/services/prAssistant/commandUtils.js';

describe('PR Assistant command utilities', () => {
  it('preserves complex CLI arguments when spawning without a shell', async () => {
    const complexArg = '(test-pr-assistant|gaming.direct-answer)\\.test\\.ts$';

    const result = await runCommand(process.execPath, [
      '-e',
      'process.stdout.write(process.argv[1])',
      complexArg
    ]);

    expect(result.stdout).toBe(complexArg);
  });

  it('includes command context when stderr is present on failure', async () => {
    await expect(runCommand(process.execPath, [
      '-e',
      'console.error("stderr details"); process.exit(7)'
    ])).rejects.toThrow(/stderr details[\s\S]*Command failed with exit code 7:/);
  });

  it('rejects at the timeout even if the child delays termination', async () => {
    const timeoutMs = 50;
    const startedAt = Date.now();

    await expect(runCommand(process.execPath, [
      '-e',
      [
        'process.on("SIGTERM", () => setTimeout(() => process.exit(0), 1000));',
        'setInterval(() => {}, 100);'
      ].join('')
    ], { timeout: timeoutMs })).rejects.toThrow(`Command timed out after ${timeoutMs}ms:`);

    expect(Date.now() - startedAt).toBeLessThan(500);
  });
});
