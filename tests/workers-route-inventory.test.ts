import { describe, expect, it } from '@jest/globals';

import { isWorkerInventoryFile } from '../src/routes/workers.js';

describe('workers route inventory', () => {
  it('does not import the executable job runner while building status inventory', () => {
    expect(isWorkerInventoryFile('jobRunner.js')).toBe(false);
    expect(isWorkerInventoryFile('shared-utils.js')).toBe(false);
    expect(isWorkerInventoryFile('metricsAgent.js')).toBe(true);
  });
});
