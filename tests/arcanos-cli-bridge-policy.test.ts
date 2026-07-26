import { describe, expect, it } from '@jest/globals';

import { isArcanosCliReadOnlyAction } from '../src/services/arcanosCliBridge.js';

describe('ARCANOS CLI bridge action policy', () => {
  it('exposes a predicate without publishing mutable policy state', async () => {
    expect(isArcanosCliReadOnlyAction('status')).toBe(true);
    expect(isArcanosCliReadOnlyAction(' proposePatch ')).toBe(true);
    expect(isArcanosCliReadOnlyAction('runApprovedCommand')).toBe(false);
    expect(isArcanosCliReadOnlyAction('applyApprovedPatch')).toBe(false);

    const bridgeExports = await import('../src/services/arcanosCliBridge.js');
    expect('CLI_READONLY_ACTIONS' in bridgeExports).toBe(false);
  });
});
