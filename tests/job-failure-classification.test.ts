import { describe, expect, it } from '@jest/globals';

import { classifyWorkerExecutionError } from '../src/services/workerAutonomyService.js';
import { classifyDagNodeFailureForWorkerRetry } from '../src/workers/jobFailureClassification.js';

describe('job failure classification', () => {
  it('treats deterministic budget and authentication failures as non-retryable', () => {
    expect(classifyWorkerExecutionError(new Error('openai_call_aborted_due_to_budget')).retryable).toBe(false);
    expect(
      classifyWorkerExecutionError(
        new Error('AI call budget exceeded for job:dag-node during trinity.')
      ).retryable
    ).toBe(false);
    expect(
      classifyWorkerExecutionError(
        new Error('401 Incorrect API key provided: sk-test')
      ).retryable
    ).toBe(false);
  });

  it('keeps generic transient aborts retryable', () => {
    expect(classifyWorkerExecutionError(new Error('Request was aborted.')).retryable).toBe(true);
    expect(classifyWorkerExecutionError(new Error('OpenAI rate limit timeout')).retryable).toBe(true);
  });

  it('preserves explicit non-retryable dag failure hints from nested result metadata', () => {
    const classifiedFailure = classifyDagNodeFailureForWorkerRetry({
      errorMessage: 'Request was aborted.',
      output: {
        nodeId: 'planner',
        output: {
          plannerExecution: {
            retryable: false
          }
        }
      }
    });

    expect(classifiedFailure).toEqual({
      message: 'Request was aborted.',
      retryable: false
    });
  });

  it('falls back to worker message classification when dag metadata has no retryability hint', () => {
    const classifiedFailure = classifyDagNodeFailureForWorkerRetry({
      errorMessage: 'openai_call_aborted_due_to_budget',
      output: {
        nodeId: 'audit',
        output: {
          durationMs: 24_698,
          errorMessage: 'openai_call_aborted_due_to_budget'
        }
      }
    });

    expect(classifiedFailure).toEqual({
      message: 'openai_call_aborted_due_to_budget',
      retryable: false
    });
  });
});
