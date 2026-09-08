/** Formatting equivalence only: edition, sequel, expansion and platform words remain identity. */
export function normalizeGamingGameIdentity(game: string): string {
  return game.replace(/[™®©'’‘]/gu, '').normalize('NFKC').toLowerCase()
    .replace(/[^\p{L}\p{N}+]+/gu, '-').replace(/^-+|-+$/gu, '');
}

/** An explicit edition narrows identity; an already complete title is not duplicated. */
export function resolveGamingGuideIdentity(game: string, edition?: string): string {
  const identity = normalizeGamingGameIdentity(game);
  const editionIdentity = edition ? normalizeGamingGameIdentity(edition) : '';
  if (!editionIdentity || identity === editionIdentity || identity.endsWith(`-${editionIdentity}`)) return identity;
  return `${identity}-${editionIdentity}`;
}
