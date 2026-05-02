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
});
