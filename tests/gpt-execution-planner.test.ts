import { describe, expect, it } from '@jest/globals';

import { planGptControlExecution } from '../src/shared/gpt/gptExecutionPlanner.js';

describe('gpt execution planner', () => {
  it('honors an explicit summary override for runtime inspection', () => {
    const result = planGptControlExecution({
      action: 'runtime.inspect',
      promptText: 'full raw runtime inspection with everything included',
      payload: {
        detail: 'summary',
      },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }

    expect(result.plan).toEqual(
      expect.objectContaining({
        action: 'runtime.inspect',
        detail: 'summary',
        source: 'explicit',
        shouldUseAsync: false,
      }),
    );
    expect(result.plan.sections).toEqual(
      expect.arrayContaining(['workers', 'queues', 'memory', 'incidents']),
    );
  });

  it('infers summary detail from broad health prompts', () => {
    const result = planGptControlExecution({
      action: 'runtime.inspect',
      promptText: 'brief health overview',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }

    expect(result.plan.detail).toBe('summary');
    expect(result.plan.source).toBe('planner');
  });

  it('infers standard detail and relevant sections for investigative prompts', () => {
    const result = planGptControlExecution({
      action: 'runtime.inspect',
      promptText: 'Investigate workers queues and memory issues in the live runtime',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }

    expect(result.plan).toEqual(
      expect.objectContaining({
        action: 'runtime.inspect',
        detail: 'standard',
        source: 'planner',
      }),
    );
    expect(result.plan.sections).toEqual(
      expect.arrayContaining(['workers', 'queues', 'memory']),
    );
  });

  it('keeps explicit full detail and explicit section filtering', () => {
    const result = planGptControlExecution({
      action: 'runtime.inspect',
      payload: {
        detail: 'full',
        sections: ['workers', 'memory', 'workers'],
      },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }

    expect(result.plan).toEqual(
      expect.objectContaining({
        action: 'runtime.inspect',
        detail: 'full',
        source: 'explicit',
      }),
    );
    expect(result.plan.sections).toEqual(['workers', 'memory']);
  });

  it('defaults workers.status investigations to standard detail', () => {
    const result = planGptControlExecution({
      action: 'workers.status',
      promptText: 'Why are workers unhealthy and stuck?',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }

    expect(result.plan).toEqual(
      expect.objectContaining({
        action: 'workers.status',
        detail: 'standard',
      }),
    );
  });

  it('rejects invalid explicit detail values with a typed error', () => {
    const result = planGptControlExecution({
      action: 'runtime.inspect',
      payload: {
        detail: 'verbose',
      },
    });

    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }

    expect(result.error).toEqual(
      expect.objectContaining({
        code: 'INVALID_GPT_DETAIL',
      }),
    );
    expect(result.canonical).toEqual(
      expect.objectContaining({
        supportedDetail: 'summary, standard, full',
      }),
    );
  });
});
