/**
 * OpenAI Response Parsing Utilities
 *
 * Centralized helpers for extracting text/usage from OpenAI Responses API and
 * legacy chat-completions shapes. Intended to be shared across server + workers.
 */

export interface NormalizedUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function asNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/**
 * Extracts concatenated text from an OpenAI "content" array.
 * Supports common part shapes: {type:'text'|'output_text'|'input_text', text?:string}.
 */
export function extractTextFromContentParts(
  content: unknown,
  opts: { includeOutputText?: boolean } = {}
): string {
  const includeOutputText = opts.includeOutputText ?? true;

  if (!Array.isArray(content)) return '';

  const out: string[] = [];

  for (const part of content) {
    if (!isObject(part)) continue;

    const type = typeof part.type === 'string' ? part.type : '';
    if (type === 'output_text' && !includeOutputText) continue;

    // Responses API parts usually store text at part.text (string).
    // Some internal transforms may store { text: { value: string } }.
    const direct = part.text;
    if (typeof direct === 'string') {
      out.push(direct);
      continue;
    }
    if (isObject(direct) && typeof direct.value === 'string') {
      out.push(direct.value);
      continue;
    }

    // Some legacy adapters use { content: string } or { value: string }.
    if (typeof (part as any).content === 'string') {
      out.push((part as any).content);
      continue;
    }
    if (typeof (part as any).value === 'string') {
      out.push((part as any).value);
      continue;
    }
  }

  return out.filter(Boolean).join('');
}

/**
 * Extracts the primary assistant output text from a Responses API response.
 * Falls back to scanning response.output[].content[] parts.
 */
export function extractResponseOutputText(response: unknown, fallback = ''): string {
  if (!isObject(response)) return fallback;

  // Official client exposes output_text convenience in many environments.
  const direct = (response as any).output_text;
  if (typeof direct === 'string' && direct.trim()) return direct;

  const output = (response as any).output;
  if (!Array.isArray(output)) return fallback;

  const chunks: string[] = [];

  for (const item of output) {
    if (!isObject(item)) continue;

    const content = (item as any).content;
    const extracted = extractTextFromContentParts(content, { includeOutputText: true });
    if (extracted) chunks.push(extracted);
  }

  const joined = chunks.join('');
  return joined || fallback;
}

/**
 * Normalizes usage from either Responses API or chat-completions response shapes.
 */
export function normalizeUsage(usage: unknown): NormalizedUsage {
  if (!isObject(usage)) {
    return { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
  }

  // Responses API (current): { input_tokens, output_tokens, total_tokens }
  const inputTokens = asNumber((usage as any).input_tokens);
  const outputTokens = asNumber((usage as any).output_tokens);
  const totalTokens = asNumber((usage as any).total_tokens);

  if (inputTokens || outputTokens || totalTokens) {
    return {
      promptTokens: inputTokens,
      completionTokens: outputTokens,
      totalTokens: totalTokens || inputTokens + outputTokens
    };
  }

  // Chat completions: { prompt_tokens, completion_tokens, total_tokens }
  const promptTokens = asNumber((usage as any).prompt_tokens);
  const completionTokens = asNumber((usage as any).completion_tokens);
  const chatTotal = asNumber((usage as any).total_tokens);

  return {
    promptTokens,
    completionTokens,
    totalTokens: chatTotal || promptTokens + completionTokens
  };
}
