import { describe, expect, it, jest } from '@jest/globals';

import {
  callTextResponse,
  callStructuredResponse,
  createSafeResponsesParse,
  OpenAIResponseIncompleteError,
  OpenAIResponseLegacyConversionError,
  OpenAIResponseMalformedJsonError,
  OpenAIResponseRefusalError,
} from '../packages/arcanos-openai/src/responses.ts';

describe('openai responses helpers', () => {
  it('parses structured JSON through responses.create without SDK parse helpers', async () => {
    const create = jest.fn().mockResolvedValue({
      id: 'resp_1',
      model: 'gpt-4.1-mini',
      status: 'completed',
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

  it('extracts structured text from nested Responses API output parts', async () => {
    const create = jest.fn().mockResolvedValue({
      id: 'resp_nested_1',
      model: 'gpt-4.1-mini',
      status: 'completed',
      output: [
        {
          type: 'message',
          content: [
            { type: 'output_text', text: '{"answer":"nested"}' },
          ],
        },
      ],
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
        source: 'test nested response',
      }
    );

    expect(result.outputText).toBe('{"answer":"nested"}');
    expect(result.outputParsed).toEqual({ answer: 'nested' });
  });

  it('awaits the plain Promise returned by responses.create', async () => {
    const createResponse = {
      id: 'resp_private_helper_1',
      model: 'gpt-4.1-mini',
      output_text: 'plain text',
      output: [],
    };
    const create = jest.fn(() => Promise.resolve(createResponse));

    const result = await callTextResponse(
      { responses: { create } } as any,
      {
        model: 'gpt-4.1-mini',
        input: 'hello',
      }
    );

    expect(result.outputText).toBe('plain text');
    expect(create).toHaveBeenCalledTimes(1);

    const returnedPromise = create.mock.results[0]?.value as Promise<unknown>;
    const privatePromiseHelperName = ['_then', 'Unwrap'].join('');
    expect(typeof returnedPromise.then).toBe('function');
    expect(privatePromiseHelperName in returnedPromise).toBe(false);
  });

  it('surfaces refusals explicitly', async () => {
    const create = jest.fn().mockResolvedValue({
      id: 'resp_refusal_1',
      model: 'gpt-4.1-mini',
      status: 'completed',
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
      status: 'completed',
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
      status: 'completed',
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

  it.each([
    ['failed', { status: 'failed', error: { code: 'provider_failure' } }, 'terminal_status'],
    ['cancelled', { status: 'cancelled' }, 'terminal_status'],
    ['queued', { status: 'queued' }, 'pending_status'],
    ['in progress', { status: 'in_progress' }, 'pending_status'],
    ['unknown', { status: 'future_status' }, 'unsupported_status'],
    ['missing', {}, 'unsupported_status'],
    ['null', { status: null }, 'unsupported_status'],
  ])(
    'rejects %s lifecycle responses before accepting structured JSON',
    async (_name, responseOverrides, reason) => {
      const create = jest.fn().mockResolvedValue({
        id: 'resp_lifecycle_rejection',
        model: 'gpt-4.1-mini',
        output_text: '{"answer":"must not be accepted"}',
        output: [],
        ...responseOverrides,
      });

      let rejection: unknown;
      try {
        await callStructuredResponse(
          { responses: { create } } as any,
          {
            model: 'gpt-4.1-mini',
            input: 'hello',
            text: { format: { type: 'json_object' } },
          },
          undefined,
          { source: 'test lifecycle response' }
        );
      } catch (error) {
        rejection = error;
      }

      expect(rejection).toBeInstanceOf(OpenAIResponseLegacyConversionError);
      expect(rejection).toMatchObject({ reason });
    }
  );

  it('rejects valid partial JSON from incomplete responses', async () => {
    const create = jest.fn().mockResolvedValue({
      id: 'resp_incomplete_structured',
      model: 'gpt-4.1-mini',
      status: 'incomplete',
      incomplete_details: { reason: 'max_output_tokens' },
      output_text: '{"answer":"partial"}',
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
        { source: 'test incomplete response' }
      )
    ).rejects.toBeInstanceOf(OpenAIResponseIncompleteError);
  });

  it('rejects provider-parsed output from failed responses', async () => {
    const create = jest.fn().mockResolvedValue({
      id: 'resp_failed_preparsed',
      model: 'gpt-4.1-mini',
      status: 'failed',
      error: { code: 'provider_failure' },
      output_parsed: { answer: 'must not be accepted' },
      output: [],
    });

    await expect(
      callStructuredResponse(
        { responses: { create } } as any,
        {
          model: 'gpt-4.1-mini',
          input: 'hello',
          text: { format: { type: 'json_object' } },
        }
      )
    ).rejects.toBeInstanceOf(OpenAIResponseLegacyConversionError);
  });

  it('rejects provider-parsed output from incomplete responses', async () => {
    const create = jest.fn().mockResolvedValue({
      id: 'resp_incomplete_preparsed',
      model: 'gpt-4.1-mini',
      status: 'incomplete',
      incomplete_details: { reason: 'max_output_tokens' },
      output_parsed: { answer: 'partial' },
      output: [],
    });

    await expect(
      callStructuredResponse(
        { responses: { create } } as any,
        {
          model: 'gpt-4.1-mini',
          input: 'hello',
          text: { format: { type: 'json_object' } },
        }
      )
    ).rejects.toBeInstanceOf(OpenAIResponseIncompleteError);
  });

  it('does not disclose provider failure text in structured lifecycle errors', async () => {
    const providerMessage = 'sensitive provider diagnostic details';
    const create = jest.fn().mockResolvedValue({
      id: 'resp_failed_structured',
      model: 'gpt-4.1-mini',
      status: 'failed',
      error: {
        code: 'provider_failure',
        message: providerMessage,
      },
      output_text: '{"answer":"must not be accepted"}',
      output: [],
    });

    let rejection: unknown;
    try {
      await callStructuredResponse(
        { responses: { create } } as any,
        {
          model: 'gpt-4.1-mini',
          input: 'hello',
          text: { format: { type: 'json_object' } },
        },
        undefined,
        { source: 'test failed response' }
      );
    } catch (error) {
      rejection = error;
    }

    expect(rejection).toBeInstanceOf(OpenAIResponseLegacyConversionError);
    expect((rejection as Error).message).not.toContain(providerMessage);
  });
});
