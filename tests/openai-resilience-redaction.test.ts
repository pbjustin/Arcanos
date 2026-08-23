import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const recordTraceEvent = jest.fn();
const markOperation = jest.fn();
const recordLogEvent = jest.fn();

jest.unstable_mockModule('@platform/logging/telemetry.js', () => ({
  recordTraceEvent,
  markOperation,
  recordLogEvent,
  getTelemetrySnapshot: jest.fn(() => ({ logs: [], traces: [], counters: {} })),
  onTelemetry: jest.fn(),
  resetTelemetry: jest.fn(),
}));

const { executeWithResilience } =
  await import('../src/services/openai/resilience.js');

describe('OpenAI resilience diagnostic redaction', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('retains the original rejection while recording only a fixed sensitive-context error', async () => {
    const privateProviderDetail = 'PRIVATE-NOTION-REQUEST-ECHO';
    const providerError = new Error(privateProviderDetail);

    await expect(executeWithResilience(
      async () => Promise.reject(providerError),
      { redactErrorDetails: true }
    )).rejects.toBe(providerError);

    expect(JSON.stringify(recordTraceEvent.mock.calls)).not.toContain(privateProviderDetail);
    expect(recordTraceEvent).toHaveBeenCalledWith(
      'openai.resilience.failure',
      expect.objectContaining({
        error: 'Sensitive-context provider request failed.',
      })
    );
  });

  it('records caller cancellation separately from provider failure telemetry', async () => {
    const cancellation = Object.assign(new Error('caller cancelled'), {
      name: 'AbortError',
    });

    await expect(executeWithResilience(
      async () => Promise.reject(cancellation),
      { shouldCountFailure: () => false }
    )).rejects.toBe(cancellation);

    expect(markOperation).toHaveBeenCalledWith('openai.cancelled');
    expect(markOperation).not.toHaveBeenCalledWith('openai.failure');
    expect(recordTraceEvent).toHaveBeenCalledWith(
      'openai.resilience.cancelled',
      expect.objectContaining({ state: expect.any(String) })
    );
    expect(recordTraceEvent).not.toHaveBeenCalledWith(
      'openai.resilience.failure',
      expect.anything()
    );
  });

  it('fails closed to provider failure telemetry when classification throws', async () => {
    const providerFailure = new Error('provider-originated failure');

    await expect(executeWithResilience(
      async () => Promise.reject(providerFailure),
      { shouldCountFailure: () => { throw new Error('classifier failed'); } }
    )).rejects.toBe(providerFailure);

    expect(markOperation).toHaveBeenCalledWith('openai.failure');
    expect(recordTraceEvent).toHaveBeenCalledWith(
      'openai.resilience.failure',
      expect.anything()
    );
  });
});
