import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const pipeline = jest.fn();
jest.unstable_mockModule('@core/logic/trinityWritingPipeline.js', () => ({
  runTrinityWritingPipeline: pipeline
}));
jest.unstable_mockModule('@transport/http/requestHandler.js', () => ({
  validateAIRequest: () => ({ client: {}, input: 'Review the supplied design only.' }),
  handleAIError: jest.fn(),
  logRequestFeedback: jest.fn()
}));
jest.unstable_mockModule('@transport/http/middleware/confirmGate.js', () => ({
  confirmGate: (_req: unknown, _res: unknown, next: () => void) => next()
}));

const express = (await import('express')).default;
const request = (await import('supertest')).default;
const router = (await import('../src/routes/ask.js')).default;
const app = express();
app.use(express.json());
app.use(router);

const content = {
  verdict: 'approved_with_risks', summary: 'The supplied design separates approval from execution.',
  strengths: ['An approval boundary is specified.'], risks: [], gaps: ['Tests are not supplied.'],
  recommendations: [], assumptions: ['Only the supplied design is assessed.'], confidence: 0.7
};

describe('system-review caller output contract', () => {
  beforeEach(() => {
    process.env.ASK_ROUTE_MODE = 'compat';
    pipeline.mockReset();
  });

  it('supplies the existing content schema in the prompt and retains the server envelope', async () => {
    pipeline.mockResolvedValue({ result: JSON.stringify(content) });
    const response = await request(app).post('/brain').send({ mode: 'system_review', prompt: 'Review this design.' });
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ ...content, mode: 'system_review', subject: 'intent_system', reviewVersion: 1 });
    expect(response.body.reviewedAt).toEqual(expect.any(String));
    const call = pipeline.mock.calls[0][0] as any;
    const contract = call.context.runOptions.finalOutputContract;
    expect(contract.schema.required).toEqual(expect.arrayContaining(Object.keys(content)));
    expect(Object.keys(contract.schema.properties)).not.toEqual(expect.arrayContaining(['mode', 'subject', 'reviewedAt', 'reviewVersion']));
    expect(call.input.prompt).toContain(JSON.stringify(contract.schema));
    expect(pipeline).toHaveBeenCalledTimes(1);
  });

  it.each(['{"summary":"A review without the required fields."}', '{"verdict":'])('rejects invalid content without reporting delivery success: %s', async raw => {
    pipeline.mockResolvedValue({ result: raw });
    const response = await request(app).post('/brain').send({ mode: 'system_review', prompt: 'Review this design.' });
    expect(response.status).toBe(500);
    expect(response.body.error).toMatch(/^SYSTEM_REVIEW_/);
    expect(response.body).not.toHaveProperty('verdict');
    expect(pipeline).toHaveBeenCalledTimes(1);
  });

  it('preserves final-output rejection as a failed caller response', async () => {
    pipeline.mockRejectedValue(new Error('Trinity structured output rejected: schema_mismatch'));
    const response = await request(app).post('/brain').send({ mode: 'system_review', prompt: 'Review this design.' });
    expect(response.status).toBe(500);
    expect(response.body).toMatchObject({ error: 'SYSTEM_REVIEW_EXECUTION_FAILED', details: ['Trinity structured output rejected: schema_mismatch'] });
    expect(pipeline).toHaveBeenCalledTimes(1);
  });
});
