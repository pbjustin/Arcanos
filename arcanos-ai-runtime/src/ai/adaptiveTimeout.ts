export const BASE_TIMEOUT = 20000;
export const MAX_TIMEOUT = 120000;

const MODEL_SPEED: Record<string, number> = {
  "gpt-5": 12,
  "gpt-4o": 8,
  "gpt-3.5-turbo": 5,
  "default": 8
};

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export function computeTimeout(
  model: string,
  input: string,
  expectedOutput = 1500
): number {
  const total = estimateTokens(input) + expectedOutput;
  const speed = MODEL_SPEED[model] ?? MODEL_SPEED.default;

  const dynamic = BASE_TIMEOUT + total * speed;
  return Math.min(dynamic, MAX_TIMEOUT);
}
