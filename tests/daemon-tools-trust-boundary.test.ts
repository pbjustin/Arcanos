import { describe, expect, it, jest } from '@jest/globals';
import type OpenAI from 'openai';
import { tryDispatchDaemonTools } from '../src/routes/ask/daemonTools.js';

function createOpenAiClientWithToolArgs(toolName: string, argumentsJson: string): OpenAI {
  const createMock = jest.fn(async () => ({
    id: 'chatcmpl-test',
    created: 1770700000,
    model: 'gpt-4.1-mini',
    usage: {
      prompt_tokens: 10,
      completion_tokens: 5,
      total_tokens: 15
    },
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          tool_calls: [
            {
              id: 'tool-call-1',
              type: 'function',
              function: {
                name: toolName,
                arguments: argumentsJson
              }
            }
          ]
        },
        finish_reason: 'tool_calls'
      }
    ]
  }));

  return {
    chat: {
      completions: {
        create: createMock
      }
    }
  } as unknown as OpenAI;
}

describe('daemon tools trust boundary', () => {
  it('rejects malformed tool JSON and avoids queueing side effects', async () => {
    const client = createOpenAiClientWithToolArgs('run_command', '{invalid-json');
    const result = await tryDispatchDaemonTools(client, 'run this command', {
      source: 'daemon',
      instanceId: 'daemon-instance-1'
    });

    expect(result).not.toBeNull();
    expect(result && 'confirmation_required' in result).toBe(false);
    expect(result && 'result' in result && result.result).toContain('Unable to queue daemon actions');
  });

  it('rejects schema-invalid tool arguments', async () => {
    const client = createOpenAiClientWithToolArgs('run_command', JSON.stringify({ command: '' }));
    const result = await tryDispatchDaemonTools(client, 'run this command', {
      source: 'daemon',
      instanceId: 'daemon-instance-2'
    });

    expect(result).not.toBeNull();
    expect(result && 'confirmation_required' in result).toBe(false);
    expect(result && 'result' in result && result.result).toContain('Unable to queue daemon actions');
  });

  it('requires deterministic confirmation path for irreversible run_command', async () => {
    const client = createOpenAiClientWithToolArgs(
      'run_command',
      JSON.stringify({ command: 'echo "safety first"' })
    );
    const result = await tryDispatchDaemonTools(client, 'run this command', {
      source: 'daemon',
      instanceId: 'daemon-instance-3'
    });

    expect(result).not.toBeNull();
    expect(result && 'confirmation_required' in result ? result.confirmation_required : false).toBe(true);
    expect(result && 'confirmation_required' in result ? result.confirmation_token.length > 0 : false).toBe(
      true
    );
    expect(result && 'confirmation_required' in result ? result.pending_actions.length : 0).toBe(1);
    expect(
      result && 'confirmation_required' in result ? result.pending_actions[0]?.daemon : undefined
    ).toBe('run');
  });
});
