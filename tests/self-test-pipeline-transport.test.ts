import fs from 'node:fs';

import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  jest,
} from '@jest/globals';

const updateStateMock = jest.fn();

jest.unstable_mockModule('../src/services/stateManager.js', () => ({
  updateState: updateStateMock,
}));

const { runSelfTestPipeline } = await import(
  '../src/services/selfTestPipeline.js'
);

const originalFetch = globalThis.fetch;
const fetchMock = jest.fn<typeof fetch>();
const testPrompt = {
  id: 'transport',
  prompt: 'Return a transport status.',
  expectation: 'A bounded response is returned.',
};

describe('self-test pipeline transport safety', () => {
  beforeEach(() => {
    updateStateMock.mockReset();
    fetchMock.mockReset();
    globalThis.fetch = fetchMock;
    jest.spyOn(fs, 'existsSync').mockReturnValue(true);
    jest.spyOn(fs, 'readFileSync').mockReturnValue('{"history":[]}');
    jest.spyOn(fs, 'writeFileSync').mockImplementation(() => undefined);
    jest.spyOn(fs, 'mkdirSync').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
    globalThis.fetch = originalFetch;
  });

  it('rejects redirects, supplies a timeout signal, and omits raw response previews', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({
      result: 'SENTINEL_MODEL_RESPONSE_CONTENT',
      activeModel: 'test-model',
      module: 'test-module',
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));

    const summary = await runSelfTestPipeline({
      baseUrl: 'http://127.0.0.1:8080',
      prompts: [testPrompt],
      targetModel: 'test-model',
      triggeredBy: 'operator:test',
    });

    const requestInit = fetchMock.mock.calls[0]?.[1];
    expect(requestInit?.redirect).toBe('error');
    expect(requestInit?.signal).toBeInstanceOf(AbortSignal);
    expect(summary.results[0]).toMatchObject({
      success: true,
      message: 'Model responded successfully',
    });
    expect(summary.results[0]?.responsePreview).toBeUndefined();
    expect(JSON.stringify(summary)).not.toContain(
      'SENTINEL_MODEL_RESPONSE_CONTENT'
    );
  });

  it('fails with a stable result when the response exceeds the byte cap', async () => {
    const oversizedBody = JSON.stringify({
      result: 'x'.repeat(256 * 1024),
      activeModel: 'test-model',
    });
    fetchMock.mockResolvedValue(new Response(oversizedBody, {
      status: 200,
      headers: {
        'content-length': String(Buffer.byteLength(oversizedBody, 'utf8')),
        'content-type': 'application/json',
      },
    }));

    const summary = await runSelfTestPipeline({
      baseUrl: 'http://127.0.0.1:8080',
      prompts: [testPrompt],
      targetModel: 'test-model',
    });

    expect(summary.results[0]).toMatchObject({
      success: false,
      message: 'Self-test request failed.',
    });
  });

  it('aborts a stalled request after the bounded timeout', async () => {
    jest.useFakeTimers();
    fetchMock.mockImplementation((_input, init) => (
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          reject(new Error('SENTINEL_ABORT_DETAIL'));
        }, { once: true });
      })
    ));

    const summaryPromise = runSelfTestPipeline({
      baseUrl: 'http://127.0.0.1:8080',
      prompts: [testPrompt],
      targetModel: 'test-model',
    });
    await jest.advanceTimersByTimeAsync(30_000);
    const summary = await summaryPromise;

    expect(summary.results[0]).toMatchObject({
      success: false,
      message: 'Self-test request failed.',
    });
    expect(JSON.stringify(summary)).not.toContain('SENTINEL_ABORT_DETAIL');
  });
});

afterAll(() => {
  globalThis.fetch = originalFetch;
});
