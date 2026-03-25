import { describe, expect, it } from '@jest/globals';

import {
  classifyStageFailureSignal,
  recordSelfHealingStageFailureSignal,
} from '../src/services/selfImprove/signals.js';

describe('self-heal stage failure signals', () => {
  it('prefers explicit timeout error codes over message matching', () => {
    expect(
      classifyStageFailureSignal({
        error: 'non-standard timeout wrapper',
        errorCode: 'openai_call_aborted_due_to_budget'
      })
    ).toBe('timeout_cluster');
  });

  it('falls back to message matching when no structured error code is provided', () => {
    expect(
      classifyStageFailureSignal({
        error: 'Request was aborted.'
      })
    ).toBe('timeout_cluster');
  });

  it('persists the supplied error code on recorded stage failures', () => {
    const signal = recordSelfHealingStageFailureSignal({
      stage: 'reasoning',
      tier: 'complex',
      error: 'openai_call_aborted_due_to_budget',
      errorCode: 'openai_call_aborted_due_to_budget',
      requestId: 'req-signal-1',
      sourceEndpoint: '/gpt/arcanos-core'
    });

    expect(signal).toMatchObject({
      errorCode: 'openai_call_aborted_due_to_budget',
      cluster: 'timeout_cluster',
    });
  });
});
