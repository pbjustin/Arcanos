export const OPENAI_CONVERSION_FROZEN_NOW_MS = Date.parse('2025-01-02T03:04:05.000Z');
export const OPENAI_CONVERSION_FROZEN_NOW_SECONDS =
  Math.floor(OPENAI_CONVERSION_FROZEN_NOW_MS / 1000);
export const OPENAI_CONVERSION_REQUESTED_MODEL = 'fixture-requested-model';

export interface LegacyUsageExpectation {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

export interface OpenAIResponseConversionExpectation {
  id: string;
  workerId: string;
  created: number;
  model: string;
  content: string;
  finishReason: 'stop' | 'length' | 'content_filter' | 'tool_calls';
  workerFinishReason: 'stop';
  usage: LegacyUsageExpectation;
  workerUsage: LegacyUsageExpectation;
  status: string | null;
  incompleteDetails: unknown;
  providerUsage: unknown;
  incomplete: boolean;
  truncated: boolean;
  contentFiltered: boolean;
}

export interface OpenAIResponseConversionFixture {
  name: string;
  categories: readonly string[];
  response: unknown;
  expected: OpenAIResponseConversionExpectation;
}

const ZERO_USAGE: LegacyUsageExpectation = {
  prompt_tokens: 0,
  completion_tokens: 0,
  total_tokens: 0
};

const FIXTURE_CREATED_AT = 1710000000;
const FIXTURE_MODEL = 'fixture-provider-model';

function defineFixture(
  name: string,
  categories: readonly string[],
  responseOverrides: Record<string, unknown>,
  expectedOverrides: Partial<OpenAIResponseConversionExpectation> = {}
): OpenAIResponseConversionFixture {
  const id = `resp_${name}`;

  return {
    name,
    categories,
    response: {
      id,
      object: 'response',
      created_at: FIXTURE_CREATED_AT,
      model: FIXTURE_MODEL,
      status: 'completed',
      ...responseOverrides
    },
    expected: {
      id,
      workerId: id,
      created: FIXTURE_CREATED_AT,
      model: FIXTURE_MODEL,
      content: '',
      finishReason: 'stop',
      workerFinishReason: 'stop',
      usage: ZERO_USAGE,
      workerUsage: ZERO_USAGE,
      status: 'completed',
      incompleteDetails: null,
      providerUsage: null,
      incomplete: false,
      truncated: false,
      contentFiltered: false,
      ...expectedOverrides
    }
  };
}

const largeFixtureText = 'large-response-fragment-'.repeat(384);

export const openAIResponseConversionFixtures: readonly OpenAIResponseConversionFixture[] = [
  defineFixture(
    'single_text',
    ['text', 'usage', 'metadata', 'unknown-fields'],
    {
      output_text: 'Hello from Responses.',
      output: [],
      usage: { input_tokens: 3, output_tokens: 4, total_tokens: 7 },
      metadata: { trace: 'provider-trace' },
      provider_specific: { retained_by_provider: true }
    },
    {
      content: 'Hello from Responses.',
      usage: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 },
      workerUsage: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 },
      providerUsage: { input_tokens: 3, output_tokens: 4, total_tokens: 7 }
    }
  ),
  defineFixture(
    'multiple_content_fragments',
    ['multiple-content-items', 'unknown-content-types'],
    {
      output: [
        {
          type: 'message',
          content: [
            { type: 'output_text', text: 'alpha' },
            { type: 'text', text: 'beta' },
            { type: 'custom_text', text: { value: 'gamma' } },
            { type: 'custom_content', content: 'delta' },
            { type: 'custom_value', value: 'epsilon' }
          ]
        }
      ]
    },
    { content: 'alphabetagammadeltaepsilon' }
  ),
  defineFixture(
    'multiple_output_items',
    ['multiple-output-items', 'ordering'],
    {
      output: [
        { type: 'message', content: [{ type: 'output_text', text: 'first' }] },
        { type: 'message', content: [{ type: 'output_text', text: 'second' }] },
        { type: 'message', content: [{ type: 'output_text', text: 'third' }] }
      ]
    },
    { content: 'firstsecondthird' }
  ),
  defineFixture(
    'whitespace_direct_text',
    ['empty-output-text', 'nested-text-fallback'],
    {
      output_text: ' \n\t ',
      output: [
        { type: 'message', content: [{ type: 'output_text', text: 'nested fallback' }] }
      ]
    },
    { content: 'nested fallback' }
  ),
  defineFixture(
    'empty_output',
    ['empty-output', 'missing-usage'],
    { output_text: '', output: [] }
  ),
  defineFixture(
    'refusal',
    ['refusal', 'field-omission-versus-null'],
    {
      output: [
        {
          type: 'message',
          content: [{ type: 'refusal', refusal: 'cannot comply' }]
        }
      ]
    }
  ),
  defineFixture(
    'safety_refusal',
    ['safety-refusal', 'content-filter', 'incomplete'],
    {
      status: 'incomplete',
      incomplete_details: { reason: 'content_filter' },
      output: [
        {
          type: 'message',
          content: [{ type: 'refusal', refusal: 'safety policy refusal' }]
        }
      ]
    },
    {
      finishReason: 'content_filter',
      status: 'incomplete',
      incompleteDetails: { reason: 'content_filter' },
      incomplete: true,
      contentFiltered: true
    }
  ),
  defineFixture(
    'truncated_max_output_tokens',
    ['truncated', 'incomplete', 'finish-reason'],
    {
      status: 'incomplete',
      incomplete_details: { reason: 'max_output_tokens' },
      output_text: 'partial answer'
    },
    {
      content: 'partial answer',
      finishReason: 'length',
      status: 'incomplete',
      incompleteDetails: { reason: 'max_output_tokens' },
      incomplete: true,
      truncated: true
    }
  ),
  defineFixture(
    'incomplete_unknown_reason',
    ['incomplete', 'unknown-incomplete-reason'],
    {
      status: 'incomplete',
      incomplete_details: { reason: 'provider_timeout' },
      output_text: 'provider returned a partial answer'
    },
    {
      content: 'provider returned a partial answer',
      finishReason: 'length',
      status: 'incomplete',
      incompleteDetails: { reason: 'provider_timeout' },
      incomplete: true,
      truncated: true
    }
  ),
  defineFixture(
    'provider_finish_reason_ignored',
    ['finish-reason', 'provider-specific-fields'],
    {
      finish_reason: 'length',
      output_text: 'provider finish reason is not consumed'
    },
    { content: 'provider finish reason is not consumed' }
  ),
  defineFixture(
    'usage_explicit_zero_total',
    ['usage', 'zero-values'],
    {
      output_text: 'usage total differs',
      usage: { input_tokens: 2, output_tokens: 3, total_tokens: 0 }
    },
    {
      content: 'usage total differs',
      usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 },
      workerUsage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 0 },
      providerUsage: { input_tokens: 2, output_tokens: 3, total_tokens: 0 }
    }
  ),
  defineFixture(
    'legacy_chat_usage',
    ['usage', 'legacy-fields'],
    {
      output_text: 'legacy usage shape',
      usage: { prompt_tokens: 4, completion_tokens: 6, total_tokens: 10 }
    },
    {
      content: 'legacy usage shape',
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 10 },
      workerUsage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 10 },
      providerUsage: { prompt_tokens: 4, completion_tokens: 6, total_tokens: 10 }
    }
  ),
  defineFixture(
    'malformed_usage',
    ['usage', 'malformed-provider-data'],
    {
      output_text: 'malformed usage shape',
      usage: { input_tokens: '3', output_tokens: null, total_tokens: Number.NaN }
    },
    {
      content: 'malformed usage shape',
      providerUsage: { input_tokens: '3', output_tokens: null, total_tokens: Number.NaN }
    }
  ),
  defineFixture(
    'function_call',
    ['tool-output', 'function-call', 'finish-reason'],
    {
      output: [
        {
          type: 'function_call',
          call_id: 'call_1',
          name: 'lookup_status',
          arguments: '{"id":"job_1"}'
        }
      ]
    },
    { finishReason: 'tool_calls' }
  ),
  defineFixture(
    'custom_tool_call',
    ['tool-output', 'unknown-fields', 'finish-reason'],
    {
      output: [
        { type: 'computer_tool_call', id: 'tool_1', payload: { action: 'inspect' } },
        { type: 'message', content: [{ type: 'output_text', text: 'tool selected' }] }
      ]
    },
    { content: 'tool selected', finishReason: 'tool_calls' }
  ),
  defineFixture(
    'unknown_content_type_with_text',
    ['unknown-content-types', 'provider-specific-fields'],
    {
      output: [
        {
          type: 'message',
          content: [{ type: 'provider_future_content', text: 'future text survives' }]
        }
      ]
    },
    { content: 'future text survives' }
  ),
  defineFixture(
    'malformed_output_array',
    ['malformed-arrays', 'malformed-provider-data'],
    {
      output: { type: 'message', content: [{ type: 'output_text', text: 'not scanned' }] }
    }
  ),
  defineFixture(
    'malformed_content_array',
    ['malformed-arrays', 'malformed-provider-data'],
    {
      output: [
        { type: 'message', content: 'not-an-array' },
        null,
        42
      ]
    }
  ),
  defineFixture(
    'null_fields',
    ['null-fields', 'missing-fields', 'generated-defaults'],
    {
      id: null,
      created_at: null,
      model: null,
      status: null,
      incomplete_details: null,
      output_text: null,
      output: null,
      usage: null
    },
    {
      id: `legacy_${OPENAI_CONVERSION_FROZEN_NOW_MS}`,
      workerId: `worker_legacy_${OPENAI_CONVERSION_FROZEN_NOW_MS}`,
      created: OPENAI_CONVERSION_FROZEN_NOW_SECONDS,
      model: OPENAI_CONVERSION_REQUESTED_MODEL,
      status: null
    }
  ),
  {
    name: 'missing_fields',
    categories: ['missing-fields', 'partial-provider-response', 'generated-defaults'],
    response: {},
    expected: {
      id: `legacy_${OPENAI_CONVERSION_FROZEN_NOW_MS}`,
      workerId: `worker_legacy_${OPENAI_CONVERSION_FROZEN_NOW_MS}`,
      created: OPENAI_CONVERSION_FROZEN_NOW_SECONDS,
      model: OPENAI_CONVERSION_REQUESTED_MODEL,
      content: '',
      finishReason: 'stop',
      workerFinishReason: 'stop',
      usage: ZERO_USAGE,
      workerUsage: ZERO_USAGE,
      status: null,
      incompleteDetails: null,
      providerUsage: null,
      incomplete: false,
      truncated: false,
      contentFiltered: false
    }
  },
  defineFixture(
    'partial_provider_response',
    ['partial-provider-response', 'malformed-output-items'],
    {
      status: 'in_progress',
      output: [null, { type: 'message' }, { content: [] }]
    },
    { status: 'in_progress' }
  ),
  defineFixture(
    'error_shaped_provider_response',
    ['error-shaped-provider-response', 'unknown-fields'],
    {
      status: 'failed',
      error: {
        code: 'provider_failure',
        message: 'provider error details'
      }
    },
    { status: 'failed' }
  ),
  defineFixture(
    'unicode',
    ['unicode', 'text'],
    {
      output_text: 'こんにちは 🌌 — café — مرحبًا — 𝄞'
    },
    { content: 'こんにちは 🌌 — café — مرحبًا — 𝄞' }
  ),
  defineFixture(
    'large_text',
    ['large-text', 'text'],
    {
      output_text: largeFixtureText
    },
    { content: largeFixtureText }
  )
];

export const invalidOpenAIResponseRoots: readonly {
  name: string;
  response: null | undefined;
}[] = [
  { name: 'null_response', response: null },
  { name: 'undefined_response', response: undefined }
];
