import { describe, expect, it } from '@jest/globals';

import { convertResponseToLegacyChatCompletion } from '../src/services/openai/requestBuilders/convert.js';

describe('OpenAI Responses conversion metadata', () => {
  it('maps max_output_tokens incomplete responses to length and surfaces provider metadata', () => {
    const rawUsage = { input_tokens: 5, output_tokens: 16, total_tokens: 21 };

    const result = convertResponseToLegacyChatCompletion({
      id: 'resp_length_1',
      created_at: 1710000000,
      model: 'gpt-4.1-mini',
      object: 'response',
      status: 'incomplete',
      incomplete_details: { reason: 'max_output_tokens' },
      output_text: 'partial',
      output: [],
      usage: rawUsage
    } as any, 'fallback-model');

    expect(result.choices[0]?.finish_reason).toBe('length');
    expect(result.usage).toEqual({
      prompt_tokens: 5,
      completion_tokens: 16,
      total_tokens: 21
    });
    expect(result.provider_metadata).toEqual(expect.objectContaining({
      status: 'incomplete',
      incomplete_details: { reason: 'max_output_tokens' },
      usage: rawUsage,
      finish_reason: 'length',
      incomplete: true,
      truncated: true,
      length_truncated: true,
      content_filtered: false
    }));
    expect(result.response_status).toBe('incomplete');
    expect(result.incomplete).toBe(true);
    expect(result.truncated).toBe(true);
  });

  it('maps content-filter incomplete responses without marking them length-truncated', () => {
    const result = convertResponseToLegacyChatCompletion({
      id: 'resp_filter_1',
      created_at: 1710000000,
      model: 'gpt-4.1-mini',
      object: 'response',
      status: 'incomplete',
      incomplete_details: { reason: 'content_filter' },
      output_text: '',
      output: [],
      usage: { input_tokens: 2, output_tokens: 0, total_tokens: 2 }
    } as any, 'fallback-model');

    expect(result.choices[0]?.finish_reason).toBe('content_filter');
    expect(result.provider_metadata).toEqual(expect.objectContaining({
      finish_reason: 'content_filter',
      incomplete: true,
      truncated: false,
      length_truncated: false,
      content_filtered: true
    }));
    expect(result.content_filtered).toBe(true);
  });
});
