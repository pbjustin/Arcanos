import { describe, it, expect } from '@jest/globals';

describe('runtime smoke', () => {
  it('runtime test harness is configured', () => {
    expect(1 + 1).toBe(2);
  });
});
