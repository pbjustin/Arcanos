export type PublicGamingGptId = 'arcanos-gaming' | 'gaming';

export function resolvePublicGamingGptIdFromPath(path: string): PublicGamingGptId | null {
  const lowerPath = path.toLowerCase();
  const normalizedPath = lowerPath.endsWith('/') ? lowerPath.slice(0, -1) : lowerPath;
  if (
    normalizedPath === '/gpt/arcanos-gaming'
    || normalizedPath === '/gpt/arcanos-gaming/evidence-retry'
  ) {
    return 'arcanos-gaming';
  }
  return normalizedPath === '/gpt/gaming' ? 'gaming' : null;
}
