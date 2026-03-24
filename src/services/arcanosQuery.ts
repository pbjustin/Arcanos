import { getDefaultModel, getGPT5Model } from './openai.js';
import { ARCANOS_PROMPTS, buildMockArcanosResponse } from "@platform/runtime/arcanosPrompts.js";
import { getOpenAIClientOrAdapter } from './openai/clientBridge.js';

// Use centralized model configuration
const FT_MODEL = getDefaultModel();
const REASONING_MODEL = getGPT5Model();
const LITERAL_RESPONSE_PATTERNS = [
  /\b(?:reply|respond|answer|return|output|say)\s+with\s+exactly\b/i,
  /\b(?:reply|respond|answer|return|output|say)\s+verbatim\b/i,
  /\bexactly\s+one\s+word\b/i,
  /\breturn\s+only\b/i,
];

function buildFineTunedMessages(prompt: string) {
  return [
    { role: 'system' as const, content: ARCANOS_PROMPTS.system },
    { role: 'user' as const, content: prompt }
  ];
}

/**
 * Purpose: Detect prompts that require literal or verbatim output preservation.
 * Inputs/Outputs: Accepts the original user prompt and returns true when refinement risks violating explicit output constraints.
 * Edge cases: Treats mixed-case phrasing as equivalent and ignores prompts without strong literal cues.
 */
function requiresLiteralResponsePreservation(prompt: string): boolean {
  return LITERAL_RESPONSE_PATTERNS.some((literalPattern) => literalPattern.test(prompt));
}

/**
 * Purpose: Build the second-stage reasoning prompt with full user intent preserved.
 * Inputs/Outputs: Accepts the original prompt plus the fine-tuned candidate answer and returns chat messages for the reasoning layer.
 * Edge cases: Preserves empty candidate output so the reasoning layer can still attempt recovery when the first pass fails silently.
 */
function buildReasoningMessages(originalPrompt: string, fineTunedOutput: string) {
  return [
    { role: 'system' as const, content: ARCANOS_PROMPTS.reasoningLayer },
    {
      role: 'user' as const,
      content: [
        `Original user prompt:\n${originalPrompt}`,
        '',
        `Candidate fine-tuned output:\n${fineTunedOutput}`,
        '',
        'Return the final user-facing answer only.',
      ].join('\n'),
    }
  ];
}

/**
 * Purpose: Execute the ARCANOS two-stage query pipeline and return the final user-facing answer.
 * Inputs/Outputs: Accepts a text prompt and returns a finalized response string.
 * Edge cases: Falls back to mock output when no adapter is configured and preserves literal-response prompts by skipping the refinement pass.
 */
export async function arcanosQuery(prompt: string): Promise<string> {
  try {
    const { adapter } = getOpenAIClientOrAdapter();

    //audit Assumption: environments without an initialized adapter still need deterministic output for tests/local flows; failure risk: null dereference during local development; expected invariant: mock mode returns a string response; handling strategy: short-circuit to the mock builder.
    if (!adapter) {
      // Return mock response when no API key is configured
      return buildMockArcanosResponse(prompt, FT_MODEL);
    }

    // Step 1 → Fine-tuned GPT-4.1 (use adapter)
    const ftResponse = await adapter.responses.create({
      model: FT_MODEL,
      messages: buildFineTunedMessages(prompt)
    });

    const ftOutput = ftResponse.choices[0].message.content || '';

    //audit Assumption: exact/verbatim prompts should not be expanded by the reasoning layer; failure risk: second-pass commentary violates user constraints; expected invariant: literal prompts preserve the first-pass answer when available; handling strategy: bypass refinement for non-empty literal outputs.
    if (ftOutput.trim().length > 0 && requiresLiteralResponsePreservation(prompt)) {
      return ftOutput;
    }

    // Step 2 → Reasoning with GPT-5.1 (use adapter)
    const reasoningResponse = await adapter.responses.create({
      model: REASONING_MODEL,
      messages: buildReasoningMessages(prompt, ftOutput)
    });

    return reasoningResponse.choices[0].message.content || '';
  } catch (error) {
    console.error('ARCANOS error:', error);
    throw error;
  }
}
