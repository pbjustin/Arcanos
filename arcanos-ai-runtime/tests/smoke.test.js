import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

describe('runtime smoke', () => {
  it('runtime test harness is configured', () => {
    assert.equal(1 + 1, 2);
  });
});
