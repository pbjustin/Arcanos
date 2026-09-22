import { randomUUID } from 'node:crypto';

/** Synthetic transport data only; no application hydration or persistence logic. */
export function createSessionContextScenario() {
  const marker = `palette-${randomUUID()}`;
  return {
    marker,
    sessionId: `synthetic-session-${randomUUID()}`,
    firstPrompt: `For this illustration, my preferred palette code is ${marker}. Acknowledge the preference briefly.`,
    secondPrompt: 'Which palette code did I choose for this illustration?',
  };
}

export interface SyntheticResponsesRequest {
  model: string;
  instructions?: string;
  input: Array<{ role: string; content: unknown }> | string;
  text?: { format?: { name?: string } };
  store?: boolean;
}

/**
 * The provider has no fixture/session state. Its answer can only depend on the
 * actual Responses API input handed to it by the production request mapper.
 */
export function respondFromObservedInput(request: SyntheticResponsesRequest) {
  const observedInput = JSON.stringify(request.input);
  const marker = observedInput.match(/palette-[0-9a-f-]{36}/u)?.[0];
  const answer = marker
    ? `Your selected palette code is ${marker}.`
    : 'No earlier palette code is available in this conversation.';
  const outputText = request.text?.format?.name?.startsWith('trinity_structured_reasoning')
    ? JSON.stringify({
        response_mode: 'answer', achievable_subtasks: ['Use the supplied conversation'],
        blocked_subtasks: [], user_visible_caveats: [], claim_tags: [],
        final_answer: answer,
        ...(request.text.format.name === 'trinity_structured_reasoning_compact' ? {} : {
          reasoning_steps: ['Read the supplied conversation'],
          assumptions: [], constraints: [], tradeoffs: [], alternatives_considered: [],
          chosen_path_justification: 'Use only the supplied conversation.',
        }),
      })
    : request.instructions?.includes('CLEAR principles')
      ? JSON.stringify({ clarity: 5, leverage: 5, efficiency: 5, alignment: 5, resilience: 5, overall: 5 })
      : answer;
  return {
    id: `synthetic-response-${randomUUID()}`,
    model: request.model,
    created_at: 1_790_000_000,
    status: 'completed',
    output_text: outputText,
    output: [],
    usage: { input_tokens: 120, output_tokens: 24, total_tokens: 144 },
  };
}

/** Clone on both sides, like JSON storage, so references cannot fake durability. */
export function createSyntheticDurableMemory() {
  const rows = new Map<string, unknown>();
  const reads: string[] = [];
  const writes: Array<{ key: string; value: unknown }> = [];
  let unavailable = false;
  return {
    reads,
    writes,
    reset() { rows.clear(); reads.length = 0; writes.length = 0; unavailable = false; },
    setUnavailable(value: boolean) { unavailable = value; },
    peek(key: string) { return structuredClone(rows.get(key) ?? null); },
    async load(key: string) {
      reads.push(key);
      if (unavailable) throw new Error('Synthetic durable memory unavailable');
      return structuredClone(rows.get(key) ?? null);
    },
    async save(key: string, value: unknown) {
      writes.push({ key, value: structuredClone(value) });
      if (unavailable) throw new Error('Synthetic durable memory unavailable');
      rows.set(key, structuredClone(value));
    },
  };
}
