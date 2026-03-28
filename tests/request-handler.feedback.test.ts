import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

jest.unstable_mockModule('@services/openai.js', () => ({
  generateMockResponse: jest.fn(),
  hasValidAPIKey: () => true,
}));

jest.unstable_mockModule('@services/openai/clientBridge.js', () => ({
  getOpenAIClientOrAdapter: () => ({
    adapter: {},
    client: {},
  }),
}));

jest.unstable_mockModule('@shared/types/dto.js', () => ({
  aiRequestSchema: {
    safeParse: jest.fn(),
  },
}));

jest.unstable_mockModule('@shared/http/index.js', () => ({
  sendInternalErrorPayload: jest.fn(),
}));

const {
  flushRequestFeedbackWritesForTest,
  logRequestFeedback,
  resetRequestFeedbackWritesForTest,
} = await import('../src/transport/http/requestHandler.js');

describe('request feedback logging', () => {
  let tempDir = '';
  let feedbackPath = '';

  beforeEach(async () => {
    tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'arcanos-request-feedback-'));
    feedbackPath = path.join(tempDir, 'last-gpt-request.json');
    process.env.REQUEST_FEEDBACK_PATH = feedbackPath;
    resetRequestFeedbackWritesForTest();
    await fsp.rm(feedbackPath, { force: true });
  });

  afterEach(async () => {
    process.env.REQUEST_FEEDBACK_PATH = feedbackPath;
    resetRequestFeedbackWritesForTest();
    delete process.env.REQUEST_FEEDBACK_PATH;
    await fsp.rm(tempDir, { recursive: true, force: true });
  });

  it('writes request feedback asynchronously under load and retains the latest snapshot', async () => {
    await Promise.all(
      Array.from({ length: 40 }, (_, index) =>
        Promise.resolve().then(() => {
          logRequestFeedback(`prompt-${index}`, 'ask');
        }),
      ),
    );

    await flushRequestFeedbackWritesForTest();

    const persistedPayload = JSON.parse(await fsp.readFile(feedbackPath, 'utf8')) as {
      endpoint: string;
      prompt: string;
      timestamp: string;
    };

    expect(persistedPayload.endpoint).toBe('ask');
    expect(persistedPayload.prompt).toBe('prompt-39');
    expect(typeof persistedPayload.timestamp).toBe('string');
  });

  it('fails gracefully when the feedback path cannot be written', async () => {
    const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const blockingPath = path.join(tempDir, 'blocking-file');
    await fsp.writeFile(blockingPath, 'blocked', 'utf8');
    process.env.REQUEST_FEEDBACK_PATH = path.join(blockingPath, 'last-gpt-request.json');

    logRequestFeedback('prompt-failure', 'siri');

    await expect(flushRequestFeedbackWritesForTest()).resolves.toBeUndefined();
    expect(consoleErrorSpy).toHaveBeenCalled();

    consoleErrorSpy.mockRestore();
  });
});
