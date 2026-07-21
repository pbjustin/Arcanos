import { beforeAll, describe, expect, it, jest } from '@jest/globals';

const existsSyncMock = jest.fn(() => true);
const readFileSyncMock = jest.fn(() => {
  throw new Error(
    'credential-sentinel Authorization: Bearer token C:\\private\\prompts.json SELECT * FROM secrets'
  );
});
const loggerErrorMock = jest.fn();
const loggerInfoMock = jest.fn();

jest.unstable_mockModule('fs', () => ({
  existsSync: existsSyncMock,
  readFileSync: readFileSyncMock
}));
jest.unstable_mockModule('@platform/logging/structuredLogging.js', () => ({
  logger: {
    error: loggerErrorMock,
    info: loggerInfoMock,
    warn: jest.fn()
  }
}));
jest.unstable_mockModule('@services/safety/configIntegrity.js', () => ({
  assertProtectedConfigIntegrity: jest.fn()
}));

let prompts: typeof import('../src/platform/runtime/prompts.js');

beforeAll(async () => {
  prompts = await import('../src/platform/runtime/prompts.js');
});

describe('prompt configuration failure log hygiene', () => {
  it('returns the existing fallback without forwarding raw loader errors', () => {
    const fallback = prompts.getPromptsConfig();

    expect(fallback.arcanos.system_prompt).toBe('You are ARCANOS AI system.');
    expect(loggerInfoMock).not.toHaveBeenCalled();
    expect(loggerErrorMock).toHaveBeenCalledWith('Failed to load prompts configuration', {
      module: 'prompts',
      operation: 'loadConfig',
      errorCode: 'PROMPTS_CONFIG_LOAD_FAILED',
      errorClass: 'Error'
    });

    const serializedLogArguments = JSON.stringify(loggerErrorMock.mock.calls);
    expect(serializedLogArguments).not.toContain('credential-sentinel');
    expect(serializedLogArguments).not.toContain('Authorization');
    expect(serializedLogArguments).not.toContain('Bearer');
    expect(serializedLogArguments).not.toContain('C:\\\\private');
    expect(serializedLogArguments).not.toContain('SELECT *');
  });
});
