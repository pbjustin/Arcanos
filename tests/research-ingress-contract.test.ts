import express, { type NextFunction, type Request, type Response } from 'express';
import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import request from 'supertest';

const mockBridgeResearch = jest.fn();
const mockRequestResearchViaHub = jest.fn();
const mockConfirmGate = jest.fn(
  (_req: Request, _res: Response, next: NextFunction) => next(),
);

jest.unstable_mockModule('@services/researchHub.js', () => ({
  connectResearchBridge: jest.fn(() => ({
    requestResearch: mockBridgeResearch,
    subscribe: jest.fn(),
  })),
  requestResearchViaHub: mockRequestResearchViaHub,
}));

jest.unstable_mockModule('@transport/http/middleware/confirmGate.js', () => ({
  confirmGate: mockConfirmGate,
}));

const { createResearchRouter } = await import('../src/routes/_core/researchRoute.js');
const { default: ArcanosResearch } = await import('../src/services/arcanos-research.js');
const {
  buildResearchModulePreflightPayload,
  extractBoundedResearchDispatchPromptText,
  normalizeResearchHttpRequest,
  normalizeResearchModulePayload,
  ResearchRequestValidationError,
} = await import('../src/shared/researchRequest.js');

const RESEARCH_URL_MAX_ITEMS = 10;
const RESEARCH_TOPIC_MAX_LENGTH = 500;
const RESEARCH_URL_MAX_LENGTH = 2_048;
const RESEARCH_URLS_MAX_AGGREGATE_LENGTH = 16_384;

function buildResult(topic = 'bounded topic') {
  return {
    topic,
    insight: 'bounded result',
    sourcesProcessed: 0,
    sources: [],
    failedUrls: [],
    generatedAt: '2026-08-04T00:00:00.000Z',
    model: 'mock',
  };
}

function buildApp(path: string, sdk = false) {
  const app = express();
  app.use(express.json());
  app.use(createResearchRouter({
    path,
    bridgeName: sdk ? 'SDK:RESEARCH' : 'ROUTE:RESEARCH',
    ...(sdk
      ? {
          formatUrlValidationError: (payload) => ({
            success: false as const,
            ...payload,
          }),
        }
      : {}),
  }));
  return app;
}

describe('research HTTP ingress contract', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockBridgeResearch.mockResolvedValue(buildResult());
  });

  it.each([
    {
      name: 'supplied URL count',
      urls: Array.from({ length: RESEARCH_URL_MAX_ITEMS + 1 }, () => ' '),
    },
    {
      name: 'raw URL item length',
      urls: ['u'.repeat(RESEARCH_URL_MAX_LENGTH + 1)],
    },
    {
      name: 'aggregate raw URL length',
      urls: [
        ...Array.from(
          { length: RESEARCH_URLS_MAX_AGGREGATE_LENGTH / RESEARCH_URL_MAX_LENGTH },
          () => 'u'.repeat(RESEARCH_URL_MAX_LENGTH),
        ),
        'x',
      ],
    },
  ])('rejects an over-limit $name before the command bridge', async ({ urls }) => {
    const response = await request(buildApp('/commands/research'))
      .post('/commands/research')
      .send({ topic: 'bounded topic', urls });

    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({
      error: 'Validation failed',
      details: [expect.any(String)],
    });
    expect(mockConfirmGate).not.toHaveBeenCalled();
    expect(mockBridgeResearch).not.toHaveBeenCalled();
  });

  it('preserves the SDK validation envelope for an over-limit request', async () => {
    const response = await request(buildApp('/research', true))
      .post('/research')
      .send({
        topic: 'bounded topic',
        urls: Array.from({ length: RESEARCH_URL_MAX_ITEMS + 1 }, () => ' '),
      });

    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({
      success: false,
      error: 'Validation failed',
      details: [expect.any(String)],
    });
    expect(mockConfirmGate).not.toHaveBeenCalled();
    expect(mockBridgeResearch).not.toHaveBeenCalled();
  });

  it('preserves the SDK validation envelope for an over-limit raw topic', async () => {
    const response = await request(buildApp('/research', true))
      .post('/research')
      .send({
        topic: `${' '.repeat(RESEARCH_TOPIC_MAX_LENGTH)}x`,
        urls: [],
      });

    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({
      success: false,
      error: 'Validation failed',
      details: [expect.stringContaining('JavaScript String.length units')],
    });
    expect(mockConfirmGate).not.toHaveBeenCalled();
    expect(mockBridgeResearch).not.toHaveBeenCalled();
  });

  it.each([
    ['padded raw topic', `${' '.repeat(RESEARCH_TOPIC_MAX_LENGTH)}x`],
    ['blank raw topic', ' '.repeat(RESEARCH_TOPIC_MAX_LENGTH + 1)],
  ])('rejects an over-limit %s before the command bridge', async (_name, topic) => {
    const response = await request(buildApp('/commands/research'))
      .post('/commands/research')
      .send({ topic, urls: [] });

    expect(response.status).toBe(400);
    expect(mockConfirmGate).not.toHaveBeenCalled();
    expect(mockBridgeResearch).not.toHaveBeenCalled();
  });

  it('accepts the exact raw topic boundary', async () => {
    const topic = 't'.repeat(RESEARCH_TOPIC_MAX_LENGTH);
    const response = await request(buildApp('/commands/research'))
      .post('/commands/research')
      .send({ topic, urls: [] });

    expect(response.status).toBe(200);
    expect(mockConfirmGate).toHaveBeenCalledTimes(1);
    expect(mockBridgeResearch).toHaveBeenCalledWith({ topic, urls: [] });
  });

  it('counts non-BMP topics in JavaScript String.length units', async () => {
    const exactTopic = '😀'.repeat(RESEARCH_TOPIC_MAX_LENGTH / 2);
    const app = buildApp('/commands/research');

    const accepted = await request(app)
      .post('/commands/research')
      .send({ topic: exactTopic, urls: [] });
    const rejected = await request(app)
      .post('/commands/research')
      .send({ topic: `${exactTopic}x`, urls: [] });

    expect(exactTopic.length).toBe(RESEARCH_TOPIC_MAX_LENGTH);
    expect(accepted.status).toBe(200);
    expect(rejected.status).toBe(400);
    expect(mockConfirmGate).toHaveBeenCalledTimes(1);
    expect(mockBridgeResearch).toHaveBeenCalledTimes(1);
    expect(mockBridgeResearch).toHaveBeenCalledWith({ topic: exactTopic, urls: [] });
  });

  it('preserves distinct Unicode topic input without lossy sanitization', async () => {
    const app = buildApp('/commands/research');

    expect((await request(app)
      .post('/commands/research')
      .send({ topic: 'café', urls: [] })).status).toBe(200);
    expect((await request(app)
      .post('/commands/research')
      .send({ topic: 'caf', urls: [] })).status).toBe(200);

    expect(mockBridgeResearch).toHaveBeenNthCalledWith(1, { topic: 'café', urls: [] });
    expect(mockBridgeResearch).toHaveBeenNthCalledWith(2, { topic: 'caf', urls: [] });
  });

  it('enforces exact and over-limit non-BMP URL item and aggregate boundaries', async () => {
    const exactItem = '😀'.repeat(RESEARCH_URL_MAX_LENGTH / 2);
    const exactAggregateUrls = Array.from(
      { length: RESEARCH_URLS_MAX_AGGREGATE_LENGTH / RESEARCH_URL_MAX_LENGTH },
      () => exactItem,
    );
    const app = buildApp('/commands/research');

    const exactItemResponse = await request(app)
      .post('/commands/research')
      .send({ topic: 'exact non-BMP URL item', urls: [exactItem] });
    const exactAggregateResponse = await request(app)
      .post('/commands/research')
      .send({ topic: 'exact non-BMP URL aggregate', urls: exactAggregateUrls });
    const overItemResponse = await request(app)
      .post('/commands/research')
      .send({ topic: 'over non-BMP URL item', urls: [`${exactItem}x`] });
    const overAggregateResponse = await request(app)
      .post('/commands/research')
      .send({ topic: 'over non-BMP URL aggregate', urls: [...exactAggregateUrls, 'x'] });

    expect(exactItem.length).toBe(RESEARCH_URL_MAX_LENGTH);
    expect(exactItemResponse.status).toBe(200);
    expect(exactAggregateResponse.status).toBe(200);
    expect(overItemResponse.status).toBe(400);
    expect(overAggregateResponse.status).toBe(400);
    expect(mockConfirmGate).toHaveBeenCalledTimes(2);
    expect(mockBridgeResearch).toHaveBeenCalledTimes(2);
  });

  it('uses one URL descriptor snapshot for HTTP normalization', () => {
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

    expect(normalizeResearchHttpRequest({
      topic: 'single HTTP URL snapshot',
      urls,
    })).toMatchObject({
      topic: 'single HTTP URL snapshot',
      urls: ['https://example.com/first-snapshot'],
    });
    expect(indexDescriptorReads).toBe(1);
  });

  it('rejects accessor-backed HTTP URL entries without invoking them', () => {
    const urlGetter = jest.fn(() => 'https://example.com/accessor');
    const urls = new Array<string>(1);
    Object.defineProperty(urls, '0', {
      configurable: true,
      enumerable: true,
      get: urlGetter,
    });

    expect(() => normalizeResearchHttpRequest({
      topic: 'HTTP accessor safety',
      urls,
    })).toThrow(ResearchRequestValidationError);
    expect(urlGetter).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: 'supplied URL count',
      urls: Array.from(
        { length: RESEARCH_URL_MAX_ITEMS },
        (_, index) => `https://example.com/${index}`,
      ),
    },
    {
      name: 'raw URL item length',
      urls: ['u'.repeat(RESEARCH_URL_MAX_LENGTH)],
    },
    {
      name: 'aggregate raw URL length',
      urls: Array.from(
        { length: RESEARCH_URLS_MAX_AGGREGATE_LENGTH / RESEARCH_URL_MAX_LENGTH },
        () => 'u'.repeat(RESEARCH_URL_MAX_LENGTH),
      ),
    },
  ])('accepts the inclusive $name boundary', async ({ urls }) => {
    const response = await request(buildApp('/commands/research'))
      .post('/commands/research')
      .send({ topic: 'bounded topic', urls });

    expect(response.status).toBe(200);
    expect(mockBridgeResearch).toHaveBeenCalledWith({
      topic: 'bounded topic',
      urls,
    });
  });
});

describe('ARCANOS research module pre-normalization contract', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockRequestResearchViaHub.mockResolvedValue(buildResult());
  });

  it.each([
    {
      name: 'blank URL count',
      payload: {
        topic: 'bounded topic',
        urls: Array.from({ length: RESEARCH_URL_MAX_ITEMS + 1 }, () => ' '),
      },
    },
    {
      name: 'padded raw URL length',
      payload: {
        topic: 'bounded topic',
        urls: [`${' '.repeat(RESEARCH_URL_MAX_LENGTH)}x`],
      },
    },
    {
      name: 'padded raw topic length',
      payload: {
        topic: `${' '.repeat(500)}x`,
        urls: [],
      },
    },
  ])('rejects $name before normalization can shrink it', async ({ payload }) => {
    await expect(ArcanosResearch.actions.run(payload))
      .rejects.toMatchObject({ code: 'RESEARCH_REQUEST_INVALID' });
    expect(mockRequestResearchViaHub).not.toHaveBeenCalled();
  });

  it('forwards a normalized request at the inclusive limits', async () => {
    const urls = Array.from(
      { length: RESEARCH_URL_MAX_ITEMS },
      (_, index) => ` https://example.com/${index} `,
    );

    await ArcanosResearch.actions.run({
      topic: ' bounded topic ',
      urls,
    });

    expect(mockRequestResearchViaHub).toHaveBeenCalledWith('ARCANOS:RESEARCH', {
      topic: 'bounded topic',
      urls: urls.map((url) => url.trim()),
      metadata: undefined,
    });
  });
});

describe('canonical GPT research payload preflight', () => {
  it('uses Research module alias order inside an explicit payload', () => {
    const payload = buildResearchModulePreflightPayload({
      payload: {
        message: 'short lower-priority alias',
        prompt: 'p'.repeat(RESEARCH_TOPIC_MAX_LENGTH + 1),
      },
    });

    expect(() => normalizeResearchModulePayload(payload))
      .toThrow(ResearchRequestValidationError);
  });

  it('does not reject an ignored lower-priority explicit-payload alias', () => {
    const payload = buildResearchModulePreflightPayload({
      payload: {
        message: 'm'.repeat(RESEARCH_TOPIC_MAX_LENGTH + 1),
        prompt: ' selected explicit prompt ',
      },
    });

    expect(normalizeResearchModulePayload(payload)).toMatchObject({
      topic: 'selected explicit prompt',
      urls: [],
    });
  });

  it('fails closed on enumerable accessors in an explicit payload without invoking them', () => {
    const promptGetter = jest.fn(() => 'p'.repeat(RESEARCH_TOPIC_MAX_LENGTH + 1));
    const explicitPayload: Record<string, unknown> = {
      message: 'bounded lower-priority alias',
    };
    Object.defineProperty(explicitPayload, 'prompt', {
      configurable: true,
      enumerable: true,
      get: promptGetter,
    });

    expect(() => buildResearchModulePreflightPayload({ payload: explicitPayload }))
      .toThrow('Research explicit payload fields must be plain data properties.');
    expect(promptGetter).not.toHaveBeenCalled();
  });

  it('checks the raw message that dispatcher precedence promotes over prompt', () => {
    const payload = buildResearchModulePreflightPayload({
      prompt: 'short fallback',
      message: 'm'.repeat(501),
    });

    expect(() => normalizeResearchModulePayload(payload))
      .toThrow(ResearchRequestValidationError);
  });

  it('does not let a lower-precedence prompt replace the dispatcher-selected message', () => {
    const payload = buildResearchModulePreflightPayload({
      prompt: 'p'.repeat(501),
      message: ' selected message ',
    });

    expect(normalizeResearchModulePayload(payload)).toMatchObject({
      topic: 'selected message',
      urls: [],
    });
  });

  it('rejects an oversized blank higher-priority topic alias before fallback', () => {
    expect(() => normalizeResearchModulePayload({
      topic: ' '.repeat(RESEARCH_TOPIC_MAX_LENGTH + 1),
      prompt: 'valid fallback',
    })).toThrow(ResearchRequestValidationError);
  });

  it('bounds messages-array assembly before applying the topic contract', () => {
    const payload = buildResearchModulePreflightPayload({
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: 'm'.repeat(300) },
          { type: 'text', text: 'n'.repeat(300) },
        ],
      }],
    });

    expect(() => normalizeResearchModulePayload(payload))
      .toThrow(ResearchRequestValidationError);
  });

  it('mirrors falsey dispatcher alias precedence without inspecting messages', () => {
    expect(extractBoundedResearchDispatchPromptText({
      message: '',
      prompt: ' selected prompt ',
      messages: [{ role: 'user', content: 'm'.repeat(501) }],
    })).toBe('selected prompt');
  });

  it('trims message parts before joining with dispatcher newline parity', () => {
    const body = {
      messages: [{
        role: 'user',
        content: [
          ' alpha ',
          { type: 'text', text: ' beta ' },
        ],
      }],
    };

    expect(extractBoundedResearchDispatchPromptText(body)).toBe('alpha\nbeta');
    expect(normalizeResearchModulePayload(
      buildResearchModulePreflightPayload(body),
    )).toMatchObject({
      topic: 'alpha\nbeta',
      urls: [],
    });
  });

  it('rejects an oversized whitespace-only message part before trimming', () => {
    const payload = buildResearchModulePreflightPayload({
      messages: [{
        role: 'user',
        content: [{ type: 'text', text: ' '.repeat(RESEARCH_TOPIC_MAX_LENGTH + 1) }],
      }],
    });

    expect(() => normalizeResearchModulePayload(payload))
      .toThrow(ResearchRequestValidationError);
  });

  it('falls back from a blank latest user message to the earlier valid user message', () => {
    const body = {
      messages: [
        { role: 'user', content: ' earlier valid topic ' },
        { role: 'assistant', content: 'ignored assistant response' },
        { role: 'user', content: '   ' },
      ],
    };

    expect(extractBoundedResearchDispatchPromptText(body)).toBe('earlier valid topic');
    expect(normalizeResearchModulePayload(
      buildResearchModulePreflightPayload(body),
    )).toMatchObject({
      topic: 'earlier valid topic',
      urls: [],
    });
  });

  it('does not inspect a huge messages array hidden by a direct prompt', () => {
    const ignoredMessages = new Proxy(new Array(1_000_000), {
      getOwnPropertyDescriptor() {
        throw new Error('ignored messages must not be scanned');
      },
    });

    expect(extractBoundedResearchDispatchPromptText({
      prompt: 'selected direct prompt',
      messages: ignoredMessages,
    })).toBe('selected direct prompt');
  });

  it('resolves an earlier bounded user message past more than 500 ignored entries', () => {
    const body = {
      messages: [
        { role: 'user', content: ' earlier bounded topic ' },
        ...Array.from(
          { length: RESEARCH_TOPIC_MAX_LENGTH + 1 },
          () => ({ role: 'assistant', content: 'ignored assistant response' }),
        ),
      ],
    };

    expect(extractBoundedResearchDispatchPromptText(body))
      .toBe('earlier bounded topic');
    expect(normalizeResearchModulePayload(
      buildResearchModulePreflightPayload(body),
    )).toMatchObject({
      topic: 'earlier bounded topic',
      urls: [],
    });
  });

  it('accepts a late bounded text part after more than 500 ignored non-text parts', () => {
    const body = {
      messages: [{
        role: 'user',
        content: [
          ...Array.from(
            { length: RESEARCH_TOPIC_MAX_LENGTH + 1 },
            () => ({ type: 'image_url', image_url: { url: 'ignored' } }),
          ),
          { type: 'text', text: ' late bounded topic ' },
        ],
      }],
    };

    expect(extractBoundedResearchDispatchPromptText(body)).toBe('late bounded topic');
    expect(normalizeResearchModulePayload(
      buildResearchModulePreflightPayload(body),
    )).toMatchObject({
      topic: 'late bounded topic',
      urls: [],
    });
  });

  it('ignores accessor-backed prompt aliases without invoking them', () => {
    const promptGetter = jest.fn(() => 'accessor prompt');
    const body: Record<string, unknown> = { topic: 'safe data topic' };
    Object.defineProperty(body, 'prompt', {
      configurable: true,
      enumerable: true,
      get: promptGetter,
    });

    expect(normalizeResearchModulePayload(
      buildResearchModulePreflightPayload(body),
    )).toMatchObject({
      topic: 'safe data topic',
      urls: [],
    });
    expect(promptGetter).not.toHaveBeenCalled();
  });
});
