import { describe, expect, it } from '@jest/globals';

const { buildInitialToolLoopTranscript, buildToolLoopContinuationRequest, extractReusableResponseOutputItems } =
  await import('../src/routes/ask/toolLoop.js');

describe('ask tool loop continuation', () => {
  it('uses previous_response_id only when response storage is available', () => {
    const transcript = buildInitialToolLoopTranscript('inspect dag status');
    const functionCall = {
      type: 'function_call',
      name: 'get_dag_run',
      call_id: 'call-1',
      arguments: '{"runId":"dagrun_1"}'
    };
    const functionCallOutput = {
      type: 'function_call_output' as const,
      call_id: 'call-1',
      output: '{"ok":true}'
    };

    const continuation = buildToolLoopContinuationRequest({
      instructions: 'use dag tools',
      maxOutputTokens: 256,
      model: 'gpt-4.1-mini',
      previousResponse: {
        id: 'resp-1',
        output: [functionCall]
      },
      storeResponses: true,
      tools: [],
      transcript,
      functionCallOutputs: [functionCallOutput]
    });

    expect(continuation.request.previous_response_id).toBe('resp-1');
    expect(continuation.request.input).toEqual([functionCallOutput]);
    expect(continuation.nextTranscript).toEqual([...transcript, functionCall, functionCallOutput]);
  });

  it('replays the local transcript when response storage is disabled', () => {
    const transcript = buildInitialToolLoopTranscript('inspect worker state');
    const assistantMessage = {
      type: 'message',
      role: 'assistant',
      content: [{ type: 'output_text', text: 'Calling the worker status tool.' }]
    };
    const functionCall = {
      type: 'function_call',
      name: 'get_worker_status',
      call_id: 'call-2',
      arguments: '{}'
    };
    const functionCallOutput = {
      type: 'function_call_output' as const,
      call_id: 'call-2',
      output: '{"ok":true}'
    };

    const continuation = buildToolLoopContinuationRequest({
      instructions: 'use worker tools',
      maxOutputTokens: 256,
      model: 'gpt-4.1-mini',
      previousResponse: {
        id: 'resp-2',
        output: [assistantMessage, functionCall]
      },
      storeResponses: false,
      tools: [],
      transcript,
      functionCallOutputs: [functionCallOutput]
    });

    expect(continuation.request.previous_response_id).toBeUndefined();
    expect(continuation.request.store).toBe(false);
    expect(continuation.request.input).toEqual([
      ...transcript,
      assistantMessage,
      functionCall,
      functionCallOutput
    ]);
    expect(continuation.nextTranscript).toEqual([
      ...transcript,
      assistantMessage,
      functionCall,
      functionCallOutput
    ]);
  });

  it('drops malformed response items instead of replaying them', () => {
    const reusableItems = extractReusableResponseOutputItems([
      null,
      'bad-item',
      { noType: true },
      { type: 'function_call', name: 'get_dag_capabilities', call_id: 'call-3', arguments: '{}' }
    ]);

    expect(reusableItems).toEqual([
      { type: 'function_call', name: 'get_dag_capabilities', call_id: 'call-3', arguments: '{}' }
    ]);
  });
});
