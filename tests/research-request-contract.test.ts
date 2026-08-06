import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const mockResearchTopic = jest.fn();

jest.unstable_mockModule('../src/services/research.js', () => ({
  researchTopic: mockResearchTopic,
}));

const {
  observeResearchEvents,
  requestResearchViaHub,
} = await import('../src/services/researchHub.js');
const { runWithRequestAbortContext } = await import('@arcanos/runtime');

const RESEARCH_TOPIC_MAX_LENGTH = 500;
const RESEARCH_URL_MAX_ITEMS = 10;
const RESEARCH_URL_MAX_LENGTH = 2_048;
const RESEARCH_URLS_MAX_AGGREGATE_LENGTH = 16_384;

function buildResult(topic: string, urls: string[]) {
  return {
    topic,
    insight: 'bounded research result',
    sourcesProcessed: urls.length,
    sources: urls.map((url) => ({ url, summary: 'summary' })),
    failedUrls: [],
    generatedAt: '2026-08-04T00:00:00.000Z',
    model: 'mock',
  };
}

describe('research request contract', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockResearchTopic.mockImplementation(async (topic: string, urls: string[]) => (
      buildResult(topic, urls)
    ));
  });

  it.each([
    {
      name: 'topic length',
      topic: 't'.repeat(RESEARCH_TOPIC_MAX_LENGTH + 1),
      urls: [],
    },
    {
      name: 'supplied URL count before blank filtering',
      topic: 'bounded topic',
      urls: Array.from({ length: RESEARCH_URL_MAX_ITEMS + 1 }, () => ' '),
    },
    {
      name: 'raw URL item length',
      topic: 'bounded topic',
      urls: ['u'.repeat(RESEARCH_URL_MAX_LENGTH + 1)],
    },
    {
      name: 'aggregate raw URL length',
      topic: 'bounded topic',
      urls: [
        ...Array.from(
          { length: RESEARCH_URLS_MAX_AGGREGATE_LENGTH / RESEARCH_URL_MAX_LENGTH },
          () => 'u'.repeat(RESEARCH_URL_MAX_LENGTH),
        ),
        'x',
      ],
    },
  ])('rejects $name before hub events or research work', async ({ topic, urls }) => {
    const events: unknown[] = [];
    const unsubscribe = observeResearchEvents((event) => {
      events.push(event);
    });

    try {
      await expect(requestResearchViaHub('contract-test', { topic, urls }))
        .rejects.toMatchObject({ code: 'RESEARCH_REQUEST_INVALID' });
      expect(events).toEqual([]);
      expect(mockResearchTopic).not.toHaveBeenCalled();
    } finally {
      unsubscribe();
    }
  });

  it('accepts each inclusive public boundary', async () => {
    const exactAggregateUrls = Array.from(
      { length: RESEARCH_URLS_MAX_AGGREGATE_LENGTH / RESEARCH_URL_MAX_LENGTH },
      () => 'u'.repeat(RESEARCH_URL_MAX_LENGTH),
    );
    const exactCountUrls = Array.from(
      { length: RESEARCH_URL_MAX_ITEMS },
      (_, index) => `https://example.com/${index}`,
    );

    await expect(requestResearchViaHub('contract-test', {
      topic: 't'.repeat(RESEARCH_TOPIC_MAX_LENGTH),
      urls: exactAggregateUrls,
    })).resolves.toMatchObject({ sourcesProcessed: exactAggregateUrls.length });

    await expect(requestResearchViaHub('contract-test', {
      topic: 'exact count',
      urls: exactCountUrls,
    })).resolves.toMatchObject({ sourcesProcessed: RESEARCH_URL_MAX_ITEMS });

    expect(mockResearchTopic).toHaveBeenNthCalledWith(
      1,
      't'.repeat(RESEARCH_TOPIC_MAX_LENGTH),
      exactAggregateUrls,
      { requestId: expect.any(String) },
    );
    expect(mockResearchTopic).toHaveBeenNthCalledWith(
      2,
      'exact count',
      exactCountUrls,
      { requestId: expect.any(String) },
    );
  });

  it('counts non-BMP URL item and aggregate limits in JavaScript String.length units', async () => {
    const exactItem = '😀'.repeat(RESEARCH_URL_MAX_LENGTH / 2);
    const exactAggregateUrls = Array.from(
      { length: RESEARCH_URLS_MAX_AGGREGATE_LENGTH / RESEARCH_URL_MAX_LENGTH },
      () => exactItem,
    );
    const events: unknown[] = [];
    const unsubscribe = observeResearchEvents((event) => {
      events.push(event);
    });

    expect(exactItem.length).toBe(RESEARCH_URL_MAX_LENGTH);
    expect(exactAggregateUrls.reduce((total, url) => total + url.length, 0))
      .toBe(RESEARCH_URLS_MAX_AGGREGATE_LENGTH);

    try {
      await expect(requestResearchViaHub('contract-test', {
        topic: 'exact non-BMP URL item',
        urls: [exactItem],
      })).resolves.toMatchObject({ sourcesProcessed: 1 });
      await expect(requestResearchViaHub('contract-test', {
        topic: 'exact non-BMP URL aggregate',
        urls: exactAggregateUrls,
      })).resolves.toMatchObject({ sourcesProcessed: exactAggregateUrls.length });

      events.length = 0;
      await expect(requestResearchViaHub('contract-test', {
        topic: 'over non-BMP URL item',
        urls: [`${exactItem}x`],
      })).rejects.toMatchObject({ code: 'RESEARCH_REQUEST_INVALID' });
      await expect(requestResearchViaHub('contract-test', {
        topic: 'over non-BMP URL aggregate',
        urls: [...exactAggregateUrls, 'x'],
      })).rejects.toMatchObject({ code: 'RESEARCH_REQUEST_INVALID' });

      expect(events).toEqual([]);
      expect(mockResearchTopic).toHaveBeenCalledTimes(2);
    } finally {
      unsubscribe();
    }
  });

  it('normalizes one captured URL descriptor snapshot', async () => {
    const firstValue = ' https://example.com/first-snapshot ';
    const secondValue = 'https://example.com/second-snapshot';
    const target = [firstValue];
    let indexDescriptorReads = 0;
    const urls = new Proxy(target, {
      getOwnPropertyDescriptor(currentTarget, property) {
        const descriptor = Reflect.getOwnPropertyDescriptor(currentTarget, property);
        if (property !== '0' || !descriptor || !('value' in descriptor)) {
          return descriptor;
        }

        indexDescriptorReads += 1;
        return {
          ...descriptor,
          value: indexDescriptorReads === 1 ? firstValue : secondValue,
        };
      },
    });

    await requestResearchViaHub('contract-test', {
      topic: 'single URL snapshot',
      urls,
    });

    expect(indexDescriptorReads).toBe(1);
    expect(mockResearchTopic).toHaveBeenCalledWith(
      'single URL snapshot',
      ['https://example.com/first-snapshot'],
      { requestId: expect.any(String) },
    );
  });

  it('does not invoke accessor-backed request or URL fields', async () => {
    const topicGetter = jest.fn(() => 'accessor topic');
    const requestWithAccessor = {} as { topic: string; urls?: string[] };
    Object.defineProperty(requestWithAccessor, 'topic', {
      configurable: true,
      enumerable: true,
      get: topicGetter,
    });

    await expect(requestResearchViaHub('contract-test', requestWithAccessor))
      .rejects.toMatchObject({ code: 'RESEARCH_REQUEST_INVALID' });
    expect(topicGetter).not.toHaveBeenCalled();
    expect(mockResearchTopic).not.toHaveBeenCalled();

    const urlGetter = jest.fn(() => 'https://example.com/accessor');
    const urls = new Array<string>(1);
    Object.defineProperty(urls, '0', {
      configurable: true,
      enumerable: true,
      get: urlGetter,
    });

    await requestResearchViaHub('contract-test', {
      topic: 'accessor URL safety',
      urls,
    });

    expect(urlGetter).not.toHaveBeenCalled();
    expect(mockResearchTopic).toHaveBeenCalledWith(
      'accessor URL safety',
      [],
      { requestId: expect.any(String) },
    );
  });

  it('keeps the validated execution URLs isolated from started-event listeners', async () => {
    const originalUrls = ['https://example.com/original'];
    const unsubscribe = observeResearchEvents((event) => {
      if (event.type === 'started') {
        event.request.urls.push('https://example.com/injected-by-listener');
      }
    });

    try {
      await requestResearchViaHub('contract-test', {
        topic: 'listener isolation',
        urls: originalUrls,
      });
    } finally {
      unsubscribe();
    }

    expect(mockResearchTopic).toHaveBeenCalledWith(
      'listener isolation',
      ['https://example.com/original'],
      { requestId: expect.any(String) },
    );
    expect(originalUrls).toEqual(['https://example.com/original']);
  });

  it('retains under-limit invalid and duplicate URL strings without counting metadata', async () => {
    await requestResearchViaHub('contract-test', {
      topic: ' invalid URL compatibility ',
      urls: [' not-a-url ', 'not-a-url', 'https://example.com/valid'],
      metadata: {
        excludedFromUrlAggregate: 'm'.repeat(
          RESEARCH_URLS_MAX_AGGREGATE_LENGTH + 1,
        ),
      },
    });

    expect(mockResearchTopic).toHaveBeenCalledWith(
      'invalid URL compatibility',
      ['not-a-url', 'not-a-url', 'https://example.com/valid'],
      { requestId: expect.any(String) },
    );
  });

  it('rejects a pre-aborted request before hub events or research work', async () => {
    const controller = new AbortController();
    controller.abort(new Error('caller disconnected before admission'));
    const events: unknown[] = [];
    const unsubscribe = observeResearchEvents(event => events.push(event));

    try {
      await expect(requestResearchViaHub(
        'contract-test',
        { topic: 'must not start', urls: [] },
        { signal: controller.signal },
      )).rejects.toThrow('caller disconnected before admission');
      expect(events).toEqual([]);
      expect(mockResearchTopic).not.toHaveBeenCalled();
    } finally {
      unsubscribe();
    }
  });

  it('rejects a normalization-time abort before hub events or research work', async () => {
    const controller = new AbortController();
    const cancellation = Object.assign(new Error('caller disconnected during normalization'), {
      name: 'AbortError',
    });
    const events: unknown[] = [];
    const unsubscribe = observeResearchEvents(event => events.push(event));
    const request = new Proxy(
      { topic: 'must not start', urls: [] },
      {
        getOwnPropertyDescriptor(target, property) {
          if (property === 'topic' && !controller.signal.aborted) {
            controller.abort(cancellation);
          }
          return Reflect.getOwnPropertyDescriptor(target, property);
        },
      },
    );

    try {
      await expect(requestResearchViaHub(
        'contract-test',
        request,
        { signal: controller.signal },
      )).rejects.toBe(cancellation);
      expect(events).toEqual([]);
      expect(mockResearchTopic).not.toHaveBeenCalled();
    } finally {
      unsubscribe();
    }
  });

  it('rejects an expired ambient deadline before hub events or research work', async () => {
    const controller = new AbortController();
    const events: unknown[] = [];
    const unsubscribe = observeResearchEvents(event => events.push(event));

    try {
      const request = runWithRequestAbortContext(
        {
          requestId: 'expired-hub-deadline',
          controller,
          signal: controller.signal,
          deadlineAt: Date.now() - 1,
          timeoutMs: 1_000,
        },
        () => requestResearchViaHub(
          'contract-test',
          { topic: 'must not enter the hub', urls: [] },
        ),
      );

      await expect(Promise.resolve(request)).rejects.toMatchObject({
        name: 'AbortError',
        message: 'Research request parent deadline already expired',
      });
      expect(events).toEqual([]);
      expect(mockResearchTopic).not.toHaveBeenCalled();
    } finally {
      unsubscribe();
    }
  });

  it('rejects a deadline that expires during normalization before hub events or research work', async () => {
    const controller = new AbortController();
    const events: unknown[] = [];
    const unsubscribe = observeResearchEvents(event => events.push(event));
    const deadlineAt = 10_000;
    const now = jest.spyOn(Date, 'now')
      .mockReturnValueOnce(deadlineAt - 1)
      .mockReturnValue(deadlineAt);

    try {
      const request = runWithRequestAbortContext(
        {
          requestId: 'rolling-hub-deadline',
          controller,
          signal: controller.signal,
          deadlineAt,
          timeoutMs: 1_000,
        },
        () => requestResearchViaHub(
          'contract-test',
          { topic: 'must not start after deadline rollover', urls: [] },
        ),
      );

      await expect(Promise.resolve(request)).rejects.toMatchObject({
        name: 'AbortError',
        message: 'Research request parent deadline already expired',
      });
      expect(events).toEqual([]);
      expect(mockResearchTopic).not.toHaveBeenCalled();
    } finally {
      now.mockRestore();
      unsubscribe();
    }
  });

  it('forwards one signal and the hub request id to the workflow', async () => {
    const controller = new AbortController();
    const events: Array<{ type: string; requestId: string }> = [];
    const unsubscribe = observeResearchEvents(event => {
      events.push({ type: event.type, requestId: event.requestId });
    });

    try {
      await requestResearchViaHub(
        'contract-test',
        { topic: 'linked execution', urls: [] },
        { signal: controller.signal, timeoutMs: 3210 },
      );
    } finally {
      unsubscribe();
    }

    expect(events.map(event => event.type)).toEqual(['started', 'completed']);
    expect(mockResearchTopic).toHaveBeenCalledWith(
      'linked execution',
      [],
      {
        requestId: events[0]!.requestId,
        signal: controller.signal,
        timeoutMs: 3210,
      },
    );
  });

  it('emits failure rather than completion when cancellation wins the post-workflow race', async () => {
    const controller = new AbortController();
    const cancellation = Object.assign(new Error('caller disconnected after drain'), {
      name: 'AbortError',
    });
    mockResearchTopic.mockImplementationOnce(async (topic: string, urls: string[]) => {
      controller.abort(cancellation);
      return buildResult(topic, urls);
    });
    const events: Array<{ type: string }> = [];
    const unsubscribe = observeResearchEvents(event => events.push({ type: event.type }));

    try {
      await expect(requestResearchViaHub(
        'contract-test',
        { topic: 'completion race', urls: [] },
        { signal: controller.signal },
      )).rejects.toThrow('caller disconnected after drain');
    } finally {
      unsubscribe();
    }

    expect(events.map(event => event.type)).toEqual(['started', 'failed']);
  });
});
