import { describe, expect, test, beforeEach, afterEach, jest } from '@jest/globals';

const ORIGINAL_RECENT_LIMIT = process.env.TELEMETRY_RECENT_LOGS_LIMIT;

describe('telemetry limits', () => {
  beforeEach(() => {
    jest.resetModules();
  });

  afterEach(() => {
    process.env.TELEMETRY_RECENT_LOGS_LIMIT = ORIGINAL_RECENT_LIMIT;
    jest.resetModules();
  });

  test('falls back to default when TELEMETRY_RECENT_LOGS_LIMIT is invalid', async () => {
    process.env.TELEMETRY_RECENT_LOGS_LIMIT = 'not-a-number';

    const telemetry = await import('../src/utils/telemetry.js');

    telemetry.resetTelemetry();

    for (let i = 0; i < 150; i++) {
      telemetry.recordLogEvent({
        timestamp: new Date().toISOString(),
        level: 'info',
        message: `event-${i}`
      });
    }

    const snapshot = telemetry.getTelemetrySnapshot();
    expect(snapshot.traces.recentLogs).toHaveLength(100);
  });
});
