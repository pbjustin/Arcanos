import { describe, expect, it } from '@jest/globals';
import {
  buildQueuedGptJobInput,
  parseQueuedGptJobInput
} from '../src/shared/gpt/asyncGptJob.js';

describe('async GPT job payload helpers', () => {
  it('bounds route metadata to the worker parser contract', () => {
    const longValue = 'x'.repeat(129);

    const payload = buildQueuedGptJobInput({
      gptId: 'arcanos-core',
      body: {},
      requestId: longValue,
      traceId: longValue,
      correlationId: longValue,
      routeHint: 'query',
      requestPath: '/gpt/arcanos-core'
    });

    expect(payload.requestId).toHaveLength(128);
    expect(payload.traceId).toHaveLength(128);
    expect(payload.correlationId).toHaveLength(128);
    expect(parseQueuedGptJobInput(payload).ok).toBe(true);
  });
});
