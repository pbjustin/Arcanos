import { describe, expect, it, jest } from '@jest/globals';

type SessionMemoryControllerModule = typeof import('../src/transport/http/controllers/sessionMemoryController.js');

interface SessionMemoryControllerHarness {
  module: SessionMemoryControllerModule;
  getChannelMock: jest.Mock;
  getConversationMock: jest.Mock;
  saveMessageMock: jest.Mock;
  sendBadRequestMock: jest.Mock;
  sendInternalErrorCodeMock: jest.Mock;
}

/**
 * Load the session-memory controller with isolated service/http mocks.
 * Inputs/outputs: no inputs -> controller module plus dependency mocks.
 * Edge cases: module cache reset prevents handler-factory state from leaking between tests.
 */
async function loadSessionMemoryControllerHarness(): Promise<SessionMemoryControllerHarness> {
  jest.resetModules();

  const saveMessageMock = jest.fn(async () => undefined);
  const getChannelMock = jest.fn(async () => []);
  const getConversationMock = jest.fn(async () => []);
  const sendBadRequestMock = jest.fn();
  const sendInternalErrorCodeMock = jest.fn();

  jest.unstable_mockModule('@services/sessionMemoryService.js', () => ({
    saveMessage: saveMessageMock,
    getChannel: getChannelMock,
    getConversation: getConversationMock
  }));

  jest.unstable_mockModule('@shared/http/index.js', () => ({
    sendBadRequest: sendBadRequestMock,
    sendInternalErrorCode: sendInternalErrorCodeMock
  }));

  const module = await import('../src/transport/http/controllers/sessionMemoryController.js');
  return {
    module,
    getChannelMock,
    getConversationMock,
    saveMessageMock,
    sendBadRequestMock,
    sendInternalErrorCodeMock
  };
}

describe('sessionMemoryController', () => {
  it('saveDual normalizes the message once and persists both channels', async () => {
    const harness = await loadSessionMemoryControllerHarness();
    const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(1234567890);

    const res = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn()
    } as any;

    await harness.module.sessionMemoryController.saveDual({
      body: {
        sessionId: 'session-123',
        message: {
          role: 'assistant',
          content: '  Saved reply  ',
          tag: 'diag-tag',
          tokens: 7
        }
      }
    } as any, res);

    expect(harness.saveMessageMock).toHaveBeenNthCalledWith(1, 'session-123', 'conversations_core', {
      role: 'assistant',
      content: 'Saved reply',
      timestamp: 1234567890
    });
    expect(harness.saveMessageMock).toHaveBeenNthCalledWith(2, 'session-123', 'system_meta', {
      tokens: 7,
      audit_tag: 'diag-tag',
      timestamp: 1234567890
    });
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({ status: 'saved' });
    expect(harness.sendBadRequestMock).not.toHaveBeenCalled();
    expect(harness.sendInternalErrorCodeMock).not.toHaveBeenCalled();

    nowSpy.mockRestore();
  });

  it('getMeta uses the shared read handler and maps loader failures consistently', async () => {
    const harness = await loadSessionMemoryControllerHarness();
    harness.getChannelMock.mockRejectedValueOnce(new Error('db unavailable'));

    const res = { json: jest.fn() } as any;

    await harness.module.sessionMemoryController.getMeta({
      params: { sessionId: 'session-err' }
    } as any, res);

    expect(harness.getChannelMock).toHaveBeenCalledWith('session-err', 'system_meta');
    expect(harness.sendInternalErrorCodeMock).toHaveBeenCalledWith(res, 'Failed to retrieve meta data');
    expect(res.json).not.toHaveBeenCalled();
  });
});
