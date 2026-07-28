import { readFileSync } from 'node:fs';
import { describe, expect, it } from '@jest/globals';

const attributes = new Set(
  readFileSync(
    new URL('../.gitattributes', import.meta.url),
    'utf8'
  )
    .replace(/\r\n?/gu, '\n')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
);

describe('cross-platform executable line endings', () => {
  it('keeps shell entrypoints and hash-pinned projectors on LF', () => {
    for (const rule of [
      '*.sh text eol=lf',
      'scripts/gate-r1-railway-metadata-projector.js text eol=lf',
      'scripts/gate-r1-tcp-proxy-projector.js text eol=lf',
      'scripts/gate-r2-retirement-state-projector.js text eol=lf',
      'scripts/gate-r2-validator-reference-projector.js text eol=lf'
    ]) {
      expect(attributes).toContain(rule);
    }
  });
});
