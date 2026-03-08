import type {
  ResponseCreateParamsNonStreaming,
  ResponseInputItem
} from 'openai/resources/responses/responses';

export type ToolLoopFunctionCallOutput = {
  type: 'function_call_output';
  call_id: string;
  output: string;
};

type ToolLoopContinuationParams = {
  instructions: string;
  maxOutputTokens: number;
  model: string;
  previousResponse: {
    id?: string | null;
    output?: unknown;
  };
  storeResponses: boolean;
  tools: Array<Record<string, unknown>>;
  transcript: ResponseInputItem[];
  functionCallOutputs: ToolLoopFunctionCallOutput[];
};

type ToolLoopContinuationRequest = {
  nextTranscript: ResponseInputItem[];
  request: ResponseCreateParamsNonStreaming;
};

/**
 * Build the initial local transcript for a stateless-capable tool loop.
 *
 * Inputs: the user prompt for the tool-enabled ask path.
 * Outputs: a transcript array that can be reused on later stateless follow-up turns.
 * Edge cases: empty prompts are preserved so the caller can keep one consistent input shape.
 */
export function buildInitialToolLoopTranscript(prompt: string): ResponseInputItem[] {
  return [{ role: 'user', content: prompt }];
}

/**
 * Build the next Responses API request for a tool loop.
 *
 * Inputs: model settings, the prior response, the current transcript, and tool outputs.
 * Outputs: the next request payload plus the next local transcript snapshot.
 * Edge cases: when response storage is disabled or the prior response id is missing, the function falls back to a fully stateless transcript replay.
 */
export function buildToolLoopContinuationRequest(
  params: ToolLoopContinuationParams
): ToolLoopContinuationRequest {
  const {
    instructions,
    maxOutputTokens,
    model,
    previousResponse,
    storeResponses,
    tools,
    transcript,
    functionCallOutputs
  } = params;
  const reusableResponseItems = extractReusableResponseOutputItems(previousResponse.output);
  const nextTranscript = [...transcript, ...reusableResponseItems, ...functionCallOutputs];

  const baseRequest: ResponseCreateParamsNonStreaming = {
    model,
    store: storeResponses,
    instructions,
    input: functionCallOutputs,
    tools: tools as unknown as ResponseCreateParamsNonStreaming['tools'],
    tool_choice: 'auto',
    max_output_tokens: maxOutputTokens
  };

  if (storeResponses && typeof previousResponse.id === 'string' && previousResponse.id.trim().length > 0) {
    //audit Assumption: a stored response id is only safe when storage is enabled and the id is present; failure risk: OpenAI rejects follow-up turns with a missing or non-persisted id; expected invariant: stateful chaining only occurs for persisted responses; handling strategy: gate previous_response_id behind the storage contract.
    return {
      nextTranscript,
      request: {
        ...baseRequest,
        previous_response_id: previousResponse.id,
        input: functionCallOutputs
      }
    };
  }

  //audit Assumption: stateless follow-up turns must replay local transcript state; failure risk: the model loses tool-call context or references a missing previous response; expected invariant: every follow-up call is self-contained when storage is off; handling strategy: append prior response items plus function outputs into the next input payload.
  return {
    nextTranscript,
    request: {
      ...baseRequest,
      store: false,
      input: nextTranscript
    }
  };
}

/**
 * Filter prior response items down to replay-safe input items.
 *
 * Inputs: arbitrary response output payload from the Responses API.
 * Outputs: reusable response items that can be sent back as stateless input.
 * Edge cases: invalid or non-array output payloads are discarded instead of poisoning the next request.
 */
export function extractReusableResponseOutputItems(output: unknown): ResponseInputItem[] {
  if (!Array.isArray(output)) {
    //audit Assumption: only array output payloads can be replayed into the next request; failure risk: malformed output corrupts the transcript; expected invariant: replay input is an array of response items; handling strategy: drop invalid output payloads.
    return [];
  }

  return output.filter((item): item is ResponseInputItem => {
    if (!item || typeof item !== 'object') {
      return false;
    }

    //audit Assumption: replayable output items must retain an explicit type tag; failure risk: untyped objects cause invalid Responses API input; expected invariant: each replay item declares a valid item type; handling strategy: keep only object items with a string type field.
    return typeof (item as { type?: unknown }).type === 'string';
  });
}
