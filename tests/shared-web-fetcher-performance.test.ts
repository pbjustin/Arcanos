import { describe, expect, it } from '@jest/globals';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

describe('shared fetcher overlapping navigation density', () => {
  it('finishes a bounded deep/long document without duplicating navigation subtrees or truncating opt-in text', () => {
    // This is a generous process containment ceiling, not a microbenchmark.
    // The 184KB/2,006-element fixture is below existing document limits.
    const child = spawnSync(process.execPath, [fileURLToPath(new URL('./fixtures/web-fetcher-consumers/navigation-performance.cjs', import.meta.url))], {
      encoding: 'utf8', timeout: 8000, windowsHide: true
    });
    expect(child.error).toBeUndefined();
    expect(child.status).toBe(0);
    expect(JSON.parse(child.stdout)).toMatchObject({
      legacyLength: 9000, legacyPrefix: true,
      legacyLinks: [{ label: 'Read methods', url: 'https://research.example.org/methods' }],
      fullSelectedText: true, fullCombinedText: true, omittedFurniture: true, optedInLinks: []
    });
  }, 12000);
});
