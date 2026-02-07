import type OpenAI from 'openai';
import { MEMORY_VALIDATION_SYSTEM_PROMPT } from '../config/memoryValidationPrompts.js';

type ChatMessageParam = OpenAI.Chat.Completions.ChatCompletionMessageParam;

/**
 * Build OpenAI chat messages for memory validation.
 * Inputs: entryKey (string), stateVersion (string), entryData (unknown).
 * Outputs: ordered message array for OpenAI chat completions.
 * Edge cases: circular entryData throws during serialization to avoid partial validation payloads.
 */
export const buildMemoryValidationMessages = (
  entryKey: string,
  stateVersion: string,
  entryData: unknown,
): ChatMessageParam[] => {
  let serializedEntryData: string;

  try {
    //audit Assumption: JSON serialization is acceptable for validation; risk: circular data throws; invariant: output remains valid JSON text; handling: raise a structured error to caller.
    serializedEntryData = JSON.stringify(entryData);
  } catch (error) {
    //audit Assumption: serialization failure indicates invalid payload; risk: validation request becomes misleading; invariant: callers receive explicit failure; handling: throw structured error.
    throw new Error(`Failed to serialize memory validation payload: ${String(error)}`);
  }

  return [
    { role: 'system', content: MEMORY_VALIDATION_SYSTEM_PROMPT },
    {
      role: 'user',
      content: `Entry Key: ${entryKey}\nVersion: ${stateVersion}\nData: ${serializedEntryData}`,
    },
  ];
};
