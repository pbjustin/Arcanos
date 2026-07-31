import { describe, expect, it } from '@jest/globals';
import {
  NATIVE_PR_PREVIEW_ALLOWED_GRAPH_FILES,
  findNativePrPreviewImportViolations,
  findUnsafeRuntimeSyntax,
} from '../scripts/check-native-pr-preview-imports.mjs';

describe('native PR preview import boundary', () => {
  it('keeps the contained application outside production side-effect modules', async () => {
    await expect(findNativePrPreviewImportViolations()).resolves.toEqual([]);
  });

  it('fails closed when the runtime graph gains an unreviewed module', async () => {
    const graphFiles = [
      ...NATIVE_PR_PREVIEW_ALLOWED_GRAPH_FILES,
      'src/config/openai.ts',
    ];
    const analyzeDependencies = async () => ({
      obj: () => Object.fromEntries(
        graphFiles.map((graphFile) => [graphFile, []])
      ),
      warnings: () => ({ skipped: [] }),
    });

    await expect(findNativePrPreviewImportViolations({
      analyzeDependencies,
    })).resolves.toContain(
      'unreviewed preview import: src/config/openai.ts'
    );
  });

  it.each([
    ['fetch("https://example.invalid")', 'forbidden fetch call'],
    ['globalThis.fetch("https://example.invalid")', 'forbidden runtime effect call'],
    ['setInterval(() => undefined, 1000)', 'forbidden setInterval call'],
    ['process.getBuiltinModule("node:fs")', 'forbidden runtime effect call'],
    ['express().listen(8080)', 'forbidden runtime effect call'],
  ])('rejects an ambient runtime effect: %s', (sourceText, expectedViolation) => {
    expect(findUnsafeRuntimeSyntax(
      'src/nativePrPreviewApplication.ts',
      sourceText
    )).toEqual([
      expect.stringContaining(expectedViolation),
    ]);
  });

  it.each([
    [
      [
        "import { spawn } from 'node:child_process';",
        "spawn(process.execPath, ['dist/start-server.js'], { env: process.env });",
      ].join('\n'),
      'forbidden child process spawn call',
    ],
    [
      "import { get } from 'node:http';",
      'forbidden runtime import binding "get:get"',
    ],
    [
      'express().listen(8080);',
      'forbidden runtime effect call',
    ],
    [
      [
        'function runNativePrApplicationPreview() {',
        '  const spawnSpec = buildNativePrApplicationSpawnSpec();',
        "  spawnProcess(process.execPath, ['dist/start-server.js'], 'web', { env: process.env });",
        '}',
      ].join('\n'),
      'unsafe native preview spawn call',
    ],
  ])('rejects Railway launcher effect drift: %s', (
    sourceText,
    expectedViolation
  ) => {
    expect(findUnsafeRuntimeSyntax(
      'scripts/start-railway-service.mjs',
      sourceText
    )).toEqual(expect.arrayContaining([
      expect.stringContaining(expectedViolation),
    ]));
  });
});
