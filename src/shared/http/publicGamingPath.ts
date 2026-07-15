export type PublicGamingGptId = 'arcanos-gaming' | 'gaming';
export type PublicGamingPathOperation = 'query' | 'canary' | 'evidence_retry';

export type PublicGamingPath = {
  gptId: PublicGamingGptId;
  operation: PublicGamingPathOperation;
};

export function resolvePublicGamingPath(path: string): PublicGamingPath | null {
  const lowerPath = path.toLowerCase();
  const normalizedPath = lowerPath.endsWith('/') ? lowerPath.slice(0, -1) : lowerPath;
  if (normalizedPath === '/gpt/arcanos-gaming/canary') {
    return { gptId: 'arcanos-gaming', operation: 'canary' };
  }
  if (normalizedPath === '/gpt/arcanos-gaming/evidence-retry') {
    return { gptId: 'arcanos-gaming', operation: 'evidence_retry' };
  }
  if (normalizedPath === '/gpt/arcanos-gaming') {
    return { gptId: 'arcanos-gaming', operation: 'query' };
  }
  if (normalizedPath === '/gpt/gaming') {
    return { gptId: 'gaming', operation: 'query' };
  }
  return null;
}

export function resolvePublicGamingGptIdFromPath(path: string): PublicGamingGptId | null {
  return resolvePublicGamingPath(path)?.gptId ?? null;
}
