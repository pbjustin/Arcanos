import { getOpenAIClient } from './openai.js';

// Correct fine-tuned model ID
const FT_MODEL = "ft:gpt-4.1-2025-04-14:personal:arcanos:C8Msdote";
const REASONING_MODEL = "gpt-5";

export async function arcanosQuery(prompt: string): Promise<string> {
  try {
    // Get OpenAI client - will return null if no API key
    const client = getOpenAIClient();
    
    if (!client) {
      // Return mock response when no API key is configured
      return `[MOCK ARCANOS QUERY] Two-step processing simulation:\n1. Fine-tuned model (${FT_MODEL}): Processing "${prompt.substring(0, 50)}${prompt.length > 50 ? '...' : ''}"\n2. GPT-5 reasoning: Enhanced analysis and safety audit\nResult: Mock refined response for your query.`;
    }

    // Step 1 → Fine-tuned GPT-4.1
    const ftResponse = await client.chat.completions.create({
      model: FT_MODEL,
      messages: [
        { role: "system", content: "You are ARCANOS core AI." },
        { role: "user", content: prompt },
      ],
    });

    const ftOutput = ftResponse.choices[0].message.content;

    // Step 2 → Reasoning with GPT-5
    const reasoningResponse = await client.chat.completions.create({
      model: REASONING_MODEL,
      messages: [
        { role: "system", content: "You are GPT-5 reasoning layer. Refine and audit the response for clarity, alignment, and safety." },
        { role: "user", content: `Original fine-tuned model output:\n${ftOutput}` },
      ],
    });

    return reasoningResponse.choices[0].message.content || '';

  } catch (error) {
    console.error("ARCANOS error:", error);
    throw error;
  }
}