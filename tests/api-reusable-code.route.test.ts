import express from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const generateReusableCodeSnippetsMock = jest.fn();
const getOpenAIClientOrAdapterMock = jest.fn();

jest.unstable_mockModule('@services/reusableCodeGeneration.js', () => ({
  generateReusableCodeSnippets: generateReusableCodeSnippetsMock,
}));

jest.unstable_mockModule('@services/openai/clientBridge.js', () => ({
  getOpenAIClientOrAdapter: getOpenAIClientOrAdapterMock,
}));

const { default: reusableCodeRouter } = await import('../src/routes/api-reusable-code.ts');

describe('/api/reusables route', () => {
  const app = express();
  app.use(express.json());
  app.use(reusableCodeRouter);

  beforeEach(() => {
    jest.clearAllMocks();
    getOpenAIClientOrAdapterMock.mockReturnValue({
      client: { responses: { create: jest.fn() } },
      adapter: {},
    });
    generateReusableCodeSnippetsMock.mockResolvedValue({
      model: 'gpt-4.1',
      snippets: [
        {
          name: 'idGenerator',
          description: 'Generate IDs.',
          language: 'typescript',
          code: 'export const idGenerator = () => crypto.randomUUID();',
        },
      ],
      raw: '{"snippets":[]}',
      meta: {
        pipeline: 'trinity',
        bypass: false,
        sourceEndpoint: 'api.reusables',
        classification: 'writing',
        moduleId: 'REUSABLE:CODE',
        requestedAction: 'query',
        executionMode: 'request',
      },
    });
  });

  it('returns Trinity invariant metadata with successful reusable code output', async () => {
    const response = await request(app)
      .post('/api/reusables')
      .send({ target: 'idGenerator', includeDocs: false, language: 'typescript' });

    expect(response.status).toBe(200);
    expect(response.body).toEqual(expect.objectContaining({
      success: true,
      model: 'gpt-4.1',
      snippets: expect.any(Array),
      meta: expect.objectContaining({
        pipeline: 'trinity',
        bypass: false,
        sourceEndpoint: 'api.reusables',
        classification: 'writing',
      }),
    }));
  });
});
