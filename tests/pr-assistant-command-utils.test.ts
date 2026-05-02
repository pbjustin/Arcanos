import { describe, expect, it } from '@jest/globals';
import { existsSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { runCommand } from '../src/services/prAssistant/commandUtils.js';

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

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
    const timeoutMs = 100;

    const result = runCommand(process.execPath, [
      '-e',
      [
        'process.on("SIGTERM", () => setTimeout(() => process.exit(0), 4000));',
        'setInterval(() => {}, 100);'
      ].join('')
    ], { timeout: timeoutMs });

    await expect(Promise.race([
      result,
      delay(2000).then(() => {
        throw new Error('runCommand waited for child process close after timeout');
      })
    ])).rejects.toThrow(`Command timed out after ${timeoutMs}ms:`);

    await delay(1200);
  });

  it('terminates child process trees on timeout', async () => {
    const markerFile = join(tmpdir(), `arcanos-command-timeout-${process.pid}-${Date.now()}.txt`);
    rmSync(markerFile, { force: true });

    try {
      await expect(runCommand(process.execPath, [
        '-e',
        [
          'const { spawn } = require("child_process");',
          `const marker = ${JSON.stringify(markerFile)};`,
          'const childScript = ' + JSON.stringify([
            'const fs = require("fs");',
            'setTimeout(() => fs.writeFileSync(process.argv[1], "alive"), 1200);',
            'setTimeout(() => process.exit(0), 1500);'
          ].join('')) + ';',
          'spawn(process.execPath, ["-e", childScript, marker], { stdio: "ignore" });',
          'process.on("SIGTERM", () => setTimeout(() => process.exit(0), 2000));',
          'setInterval(() => {}, 100);'
        ].join('')
      ], { timeout: 100 })).rejects.toThrow('Command timed out after 100ms:');

      await delay(1800);
      expect(existsSync(markerFile)).toBe(false);
    } finally {
      rmSync(markerFile, { force: true });
    }
  });
});
