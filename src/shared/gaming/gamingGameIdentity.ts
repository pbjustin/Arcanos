/** Formatting equivalence only: edition, sequel, expansion and platform words remain identity. */
export function normalizeGamingGameIdentity(game: string): string {
  return game.replace(/[™®©'’‘]/gu, '').normalize('NFKC').toLowerCase()
    .replace(/[^\p{L}\p{N}+]+/gu, '-').replace(/^-+|-+$/gu, '');
}

/** Closed edition aliases: punctuation and arbitrary qualifiers never become a recognized edition. */
export function normalizeGamingEditionIdentity(edition: string): string {
  const identity = edition.normalize('NFKC').trim().toLowerCase().replace(/\s+/gu, ' ');
  return identity === 'base game' || identity === 'base-game' ? 'base-game' : identity;
}

/** Missing edition evidence is never a match, including when the requested edition is absent. */
export function gamingEditionIdentitiesMatch(left?: string, right?: string): boolean {
  const leftIdentity = left === undefined ? '' : normalizeGamingEditionIdentity(left);
  const rightIdentity = right === undefined ? '' : normalizeGamingEditionIdentity(right);
  return Boolean(leftIdentity && rightIdentity && leftIdentity === rightIdentity);
}

/** An explicit edition narrows identity; an already complete title is not duplicated. */
export function resolveGamingGuideIdentity(game: string, edition?: string): string {
  const identity = normalizeGamingGameIdentity(game);
  const editionIdentity = edition ? normalizeGamingGameIdentity(edition) : '';
  if (!editionIdentity || identity === editionIdentity || identity.endsWith(`-${editionIdentity}`)) return identity;
  return `${identity}-${editionIdentity}`;
}

/** Preserve existing catalog numeral spellings without collapsing a sequel or edition. */
export function normalizeGamingEvidenceGameIdentity(game: string): string {
  const numerals: Record<string, string> = { ii: '2', iii: '3', iv: '4', v: '5', vi: '6', vii: '7', viii: '8', ix: '9', x: '10' };
  return normalizeGamingGameIdentity(game).split('-').map(part => numerals[part] ?? part).join('-');
}

/** Request interpretation only; never an assertion about acquired source metadata. */
export function resolveGamingRequestEdition(input: { game?: string; edition?: string; prompt?: string; question?: string }): string | undefined {
  if (input.edition) return normalizeGamingEditionIdentity(input.edition);
  const question = input.prompt ?? input.question ?? '';
  if (normalizeGamingGameIdentity(input.game ?? '') !== 'elden-ring') return undefined;
  if (/\bshadow[\s-]+of[\s-]+the[\s-]+erdtree\b/iu.test(question)) return 'shadow of the erdtree';
  // An unspecified expansion decision can materially change the answer.
  if (/\b(?:dlc|expansion)\b/iu.test(question)) return undefined;
  return 'base-game';
}

/** Unknown ordinary base-game metadata is not an explicit edition contradiction. */
export function gamingEditionEvidenceMatchesRequest(sourceEdition: string | undefined, requestEdition: string | undefined): boolean {
  return sourceEdition === undefined && (!requestEdition || normalizeGamingEditionIdentity(requestEdition) === 'base-game')
    || gamingEditionIdentitiesMatch(sourceEdition, requestEdition);
}
