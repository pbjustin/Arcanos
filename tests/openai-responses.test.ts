import { describe, expect, it, jest } from '@jest/globals';

import {
  callStructuredResponse,
  createSafeResponsesParse,
  OpenAIResponseMalformedJsonError,
  OpenAIResponseRefusalError,
} from '../packages/arcanos-openai/src/responses.ts';

describe('openai responses helpers', () => {
  it('parses structured JSON through responses.create without SDK parse helpers', async () => {
    const create = jest.fn().mockResolvedValue({
      id: 'resp_1',
      model: 'gpt-4.1-mini',
      output_text: '{"answer":"ok"}',
      output: [],
    });

    const result = await callStructuredResponse<{ answer: string }>(
      { responses: { create } } as any,
      {
        model: 'gpt-4.1-mini',
        input: 'hello',
        text: { format: { type: 'json_object' } },
      },
      undefined,
      {
        validate: (value: unknown): value is { answer: string } =>
          typeof value === 'object' &&
          value !== null &&
          typeof (value as { answer?: unknown }).answer === 'string',
        source: 'test structured response',
      }
    );

    expect(create).toHaveBeenCalledTimes(1);
    expect(result.outputParsed).toEqual({ answer: 'ok' });
    expect(result.outputText).toBe('{"answer":"ok"}');
  });

  it('surfaces refusals explicitly', async () => {
    const create = jest.fn().mockResolvedValue({
      id: 'resp_refusal_1',
      model: 'gpt-4.1-mini',
      output: [
        {
          type: 'message',
          content: [{ type: 'refusal', refusal: 'cannot comply' }],
        },
      ],
    });

    await expect(
      callStructuredResponse(
        { responses: { create } } as any,
        {
          model: 'gpt-4.1-mini',
          input: 'hello',
          text: { format: { type: 'json_object' } },
        },
        undefined,
        { source: 'test refusal' }
      )
    ).rejects.toBeInstanceOf(OpenAIResponseRefusalError);
  });

  it('fails clearly on malformed JSON', async () => {
    const create = jest.fn().mockResolvedValue({
      id: 'resp_bad_json_1',
      model: 'gpt-4.1-mini',
      output_text: '{"answer":',
      output: [],
    });

    await expect(
      callStructuredResponse(
        { responses: { create } } as any,
        {
          model: 'gpt-4.1-mini',
          input: 'hello',
          text: { format: { type: 'json_object' } },
        },
        undefined,
        { source: 'test malformed json' }
      )
    ).rejects.toBeInstanceOf(OpenAIResponseMalformedJsonError);
  });

  it('creates a safe parse-compatible shape without private SDK promises', async () => {
    const create = jest.fn().mockResolvedValue({
      id: 'resp_parse_1',
      model: 'gpt-4.1-mini',
      output_text: '{"ok":true}',
      output: [],
    });

    const result = await createSafeResponsesParse<{ ok: boolean }>(
      { responses: { create } } as any,
      {
        model: 'gpt-4.1-mini',
        input: 'hello',
        text: { format: { type: 'json_object' } },
      },
      undefined,
      {
        validate: (value: unknown): value is { ok: boolean } =>
          typeof value === 'object' &&
          value !== null &&
          typeof (value as { ok?: unknown }).ok === 'boolean',
        source: 'test safe parse',
      }
    );

    expect(result.output_parsed).toEqual({ ok: true });
  });
});
