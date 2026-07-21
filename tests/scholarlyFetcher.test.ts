import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const mockAxiosGet = jest.fn();
const mockGetScholarlyApiConfig = jest.fn();

jest.unstable_mockModule('axios', () => ({
  default: { get: mockAxiosGet },
}));

jest.unstable_mockModule('@platform/runtime/scholarly.js', () => ({
  getScholarlyApiConfig: mockGetScholarlyApiConfig,
}));

const { searchScholarly } = await import('../src/services/scholarlyFetcher.js');

describe('searchScholarly', () => {
  beforeEach(() => {
    mockGetScholarlyApiConfig.mockReturnValue({
      endpoint: 'https://api.crossref.test/works',
      timeoutMs: 1_000,
      defaultRows: 3,
    });
    mockAxiosGet.mockResolvedValue({
      data: { message: { items: [] } },
    });
  });

  it('does not inherit a GET request body from Object.prototype', async () => {
    const previousDataDescriptor = Object.getOwnPropertyDescriptor(Object.prototype, 'data');
    Object.defineProperty(Object.prototype, 'data', {
      configurable: true,
      enumerable: false,
      value: 'polluted-body',
      writable: true,
    });

    try {
      await expect(searchScholarly('safe query')).resolves.toEqual([]);
      const requestConfig = mockAxiosGet.mock.calls[0]?.[1] as Record<string, unknown>;

      expect(Object.hasOwn(requestConfig, 'data')).toBe(true);
      expect(requestConfig.data).toBeUndefined();
    } finally {
      if (previousDataDescriptor) {
        Object.defineProperty(Object.prototype, 'data', previousDataDescriptor);
      } else {
        Reflect.deleteProperty(Object.prototype, 'data');
      }
    }
  });
});
