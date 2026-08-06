import { describe, expect, it, jest } from '@jest/globals';

const mockAxiosGet = jest.fn();
const mockResolve4 = jest.fn();
const mockResolve6 = jest.fn();
const mockCancel = jest.fn();

class MockResolver {
  resolve4(hostname: string): Promise<string[]> {
    return mockResolve4(hostname) as Promise<string[]>;
  }

  resolve6(hostname: string): Promise<string[]> {
    return mockResolve6(hostname) as Promise<string[]>;
  }

  cancel(): void {
    mockCancel();
  }
}

jest.unstable_mockModule('axios', () => ({
  default: {
    get: mockAxiosGet
  }
}));

jest.unstable_mockModule('node:dns/promises', () => ({
  Resolver: MockResolver
}));

const { fetchAndClean } = await import('../src/shared/webFetcher.js');

describe('web fetch cancellation', () => {
  it('cancels and settles both DNS families before rejecting without starting HTTP', async () => {
    let rejectIpv4!: (reason: unknown) => void;
    let rejectIpv6!: (reason: unknown) => void;
    let ipv4Settled = false;
    let ipv6Settled = false;
    mockResolve4.mockImplementationOnce(() => new Promise<string[]>((_resolve, reject) => {
      rejectIpv4 = (reason) => {
        ipv4Settled = true;
        reject(reason);
      };
    }));
    mockResolve6.mockImplementationOnce(() => new Promise<string[]>((_resolve, reject) => {
      rejectIpv6 = (reason) => {
        ipv6Settled = true;
        reject(reason);
      };
    }));
    mockCancel.mockImplementationOnce(() => {
      const cancelled = Object.assign(new Error('DNS query cancelled'), { code: 'ECANCELLED' });
      rejectIpv4(cancelled);
      rejectIpv6(cancelled);
    });
    const controller = new AbortController();

    const fetch = fetchAndClean('https://example.com/research', undefined, {
      signal: controller.signal,
      deadlineAt: Date.now() + 60_000
    });
    await Promise.resolve();
    controller.abort(Object.assign(new Error('client disconnected'), { name: 'AbortError' }));

    await expect(fetch).rejects.toThrow('client disconnected');
    expect(mockCancel).toHaveBeenCalledTimes(1);
    expect(ipv4Settled).toBe(true);
    expect(ipv6Settled).toBe(true);
    expect(mockAxiosGet).not.toHaveBeenCalled();
  });
});
