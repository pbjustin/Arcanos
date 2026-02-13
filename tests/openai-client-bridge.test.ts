import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const getOpenAIAdapterMock = jest.fn();
const getOrCreateClientMock = jest.fn();

let getOpenAIClientOrAdapter: typeof import('../src/services/openai/clientBridge.js').getOpenAIClientOrAdapter;

beforeEach(async () => {
  jest.resetModules();
  getOpenAIAdapterMock.mockReset();
  getOrCreateClientMock.mockReset();

  jest.unstable_mockModule('../src/adapters/openai.adapter.js', () => ({
    getOpenAIAdapter: getOpenAIAdapterMock,
  }));

  jest.unstable_mockModule('../src/services/openai/unifiedClient.js', () => ({
    getOrCreateClient: getOrCreateClientMock,
  }));

  ({ getOpenAIClientOrAdapter } = await import('../src/services/openai/clientBridge.js'));
});

describe('openai client bridge', () => {
  it('prefers initialized adapter path', () => {
    const client = { id: 'client' } as any;
    const adapter = { getClient: () => client } as any;
    getOpenAIAdapterMock.mockReturnValue(adapter);

    const result = getOpenAIClientOrAdapter();

    expect(result.adapter).toBe(adapter);
    expect(result.client).toBe(client);
    expect(getOrCreateClientMock).not.toHaveBeenCalled();
  });

  it('returns nulls when adapter and unified client are unavailable', () => {
    getOpenAIAdapterMock.mockImplementation(() => {
      throw new Error('adapter unavailable');
    });
    getOrCreateClientMock.mockReturnValue(null);

    const result = getOpenAIClientOrAdapter();

    expect(result.adapter).toBeNull();
    expect(result.client).toBeNull();
  });

  it('re-checks adapter after unified client initialization', () => {
    const client = { id: 'client' } as any;
    const adapter = { getClient: () => client } as any;

    getOpenAIAdapterMock
      .mockImplementationOnce(() => {
        throw new Error('adapter not initialized');
      })
      .mockImplementationOnce(() => adapter);
    getOrCreateClientMock.mockReturnValue(client);

    const result = getOpenAIClientOrAdapter();

    expect(getOrCreateClientMock).toHaveBeenCalledTimes(1);
    expect(result.adapter).toBe(adapter);
    expect(result.client).toBe(client);
  });
});
