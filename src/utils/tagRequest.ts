import { env } from './env.js';

export function tagRequest<T extends Record<string, unknown>>(
  req: T,
  gptId?: string,
  requestId?: string
): T & { gptTag: string } {
  const tagId = gptId || env.GPT_ID || 'ARCANOS';
  const suffix =
    typeof requestId === 'string' && requestId.trim().length > 0
      ? requestId
      : String(Date.now());
  const gptTag = `GPT-${tagId}-${suffix}`;
  return { ...req, gptTag };
}
