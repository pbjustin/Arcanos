import { getOpenAIClient, generateMockResponse } from './openai.js';
import { runThroughBrain } from '../logic/trinity.js';
import { mapErrorToFriendlyMessage } from '../utils/errorMessageMapper.js';

/**
 * Handles a basic ARCANOS prompt by routing it through the Trinity brain.
 * Falls back to a mocked response when the OpenAI client isn't available.
 * Includes enhanced error handling for network reachability and API issues.
 *
 * @param prompt - User provided prompt text
 * @returns AI response object
 */
export async function handleArcanosPrompt(prompt: string) {
  //audit Assumption: prompt must be a non-empty string
  if (!prompt || typeof prompt !== 'string') {
    throw new Error('Invalid prompt');
  }

  const client = getOpenAIClient();

  // When no OpenAI API key is configured we return a mock response
  //audit Assumption: missing client triggers mock response
  if (!client) {
    return generateMockResponse(prompt, 'ask');
  }

  try {
    // Route the prompt through the main Trinity brain processing
    const output = await runThroughBrain(client, prompt);
    return output;
  } catch (error: unknown) {
    //audit Assumption: map errors to friendly message when possible
    const friendlyMessage = mapErrorToFriendlyMessage(error);
    if (friendlyMessage) {
      throw new Error(friendlyMessage);
    }

    throw error;
  }
}
