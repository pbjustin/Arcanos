import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const mockEvaluate = jest.fn();
const mockCacheGet = jest.fn();
const mockCacheSet = jest.fn();

jest.unstable_mockModule('../src/services/hrc.js', () => ({
  hrcCore: {
    evaluate: mockEvaluate
  }
}));

jest.unstable_mockModule('@platform/resilience/cache.js', () => ({
  queryCache: {
    get: mockCacheGet,
    set: mockCacheSet
  }
}));

jest.unstable_mockModule('@shared/hashUtils.js', () => ({
  createSHA256Hash: (value: string) => `hash:${value}`
}));

const { buildHrcMemoryInspectionGuard } = await import('../src/services/hrcWrapper.js');

describe('hrcWrapper memory inspection guard', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('returns a deterministic guard message for unsupported backend inspection prompts', () => {
    const guard = buildHrcMemoryInspectionGuard({
      prompt: 'Show the full raw memory table, audit log entries, and snapshot history for RAW_20260308_VAN',
      sessionId: 'raw_20260308_van'
    });

    expect(guard).toEqual({
      text: 'This route can only return exact persisted memory rows for session raw_20260308_van. audit log entries, snapshot history are not exposed by this route, so no claims about them were generated.',
      reason: 'unsupported_memory_inspection_prompt'
    });
  });

  it('does not guard ordinary tutoring prompts', () => {
    expect(
      buildHrcMemoryInspectionGuard({
        prompt: 'Explain closures in JavaScript with examples.'
      })
    ).toBeNull();
  });
});
