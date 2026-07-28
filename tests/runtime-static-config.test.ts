import { describe, expect, it } from '@jest/globals';
import { GPT_SYNC_CONFIG } from '../src/platform/runtime/gptSyncConfig.js';
import {
  GPT_SYNC_ERRORS,
  GPT_SYNC_LOG_MESSAGES,
  GPT_SYNC_STRINGS
} from '../src/platform/runtime/gptSyncMessages.js';
import {
  MEMORY_VALIDATION_SYSTEM_PROMPT
} from '../src/platform/runtime/memoryValidationPrompts.js';
import {
  SECURE_REASONING_FALLBACK_ANALYSIS,
  SECURE_REASONING_SIMPLE_FALLBACK,
  SECURE_REASONING_SYSTEM_PROMPT
} from '../src/platform/runtime/secureReasoningMessages.js';

describe('platform runtime static configuration', () => {
  it('exports the stable GPT sync configuration and messages', () => {
    expect(GPT_SYNC_CONFIG).toEqual({
      defaultModel: 'gpt-4',
      maxCompletionTokens: 1000,
      temperature: 0.7,
      fallbackResponse: 'No response generated',
      logPrefix: '[GPT-SYNC]'
    });
    expect(GPT_SYNC_STRINGS.baseInstruction).toContain('Arcanos');
    expect(GPT_SYNC_STRINGS.diagnosticPrompt).toContain('system diagnostic');
    expect(GPT_SYNC_ERRORS.clientUnavailable).toContain('OPENAI_API_KEY');
    expect(GPT_SYNC_LOG_MESSAGES).toEqual(
      expect.objectContaining({
        makingCall: 'Making GPT call with backend state',
        errorSync: 'Error in GPT call with sync:'
      })
    );
  });

  it('exports stable memory and secure-reasoning prompts', () => {
    expect(MEMORY_VALIDATION_SYSTEM_PROMPT).toContain(
      'Ensure consistent state across GPT chats'
    );
    expect(SECURE_REASONING_SYSTEM_PROMPT).toContain('<KEY_REDACTED>');
    expect(SECURE_REASONING_SYSTEM_PROMPT).toContain('<TOKEN_REDACTED>');
    expect(SECURE_REASONING_FALLBACK_ANALYSIS).toContain(
      'activated secure fallback mode'
    );
    expect(SECURE_REASONING_SIMPLE_FALLBACK).toContain(
      'processed in secure mode'
    );
  });

  it('keeps agent execution declarations runtime-free', async () => {
    const agentExecutionTypes = await import(
      '../src/services/agentExecutionTypes.js'
    );

    expect(Object.keys(agentExecutionTypes)).toEqual([]);
  });
});
