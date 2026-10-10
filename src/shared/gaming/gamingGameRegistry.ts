import { GAMING_GAME_REGISTRY_DATA } from './gamingGameRegistryData.js';
import type { GamingGameRegistry, GamingRegistryGame, GamingRegistryEditionKind } from './gamingGameRegistryTypes.js';
export type * from './gamingGameRegistryTypes.js';

/** Formatting only, shared with the existing stored-key API. */
export function normalizeGamingRegistryIdentity(value: string): string {
  return value.replace(/[™®©'’‘]/gu, '').normalize('NFKC').toLowerCase()
    .replace(/[^\p{L}\p{N}+]+/gu, '-').replace(/^-+|-+$/gu, '');
}
const record = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && !Array.isArray(value));
const literal = (value: unknown, limit = 120): value is string => typeof value === 'string' && value.length > 0
  && value.length <= limit && value === value.trim() && !/[\u0000-\u001f\u007f]/u.test(value);
function fail(): never { throw new Error('Invalid Gaming game registry configuration'); }
const allowedKeys = (value: Record<string, unknown>, keys: readonly string[]) => {
  if (Object.keys(value).some(key => !keys.includes(key))) fail();
};
const literals = (value: unknown, limit = 16): value is string[] => Array.isArray(value) && value.length <= limit
  && value.every(item => literal(item)) && new Set(value).size === value.length;
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') { for (const child of Object.values(value)) freeze(child); Object.freeze(value); }
  return value;
}
/** Closed bounded literals only: no configuration can name code, regexes, authority or storage policy. */
export function validateGamingGameRegistry(value: unknown): GamingGameRegistry {
  if (!record(value)) fail();
  allowedKeys(value, ['version', 'revision', 'games', 'topicVocabulary']);
  if (value.version !== 'gaming-game-registry/v1' || !literal(value.revision, 80)
    || !Array.isArray(value.games) || !value.games.length || value.games.length > 256
    || value.topicVocabulary !== undefined && !literals(value.topicVocabulary, 64)) fail();
  const ids = new Set<string>();
  const aliases = new Map<string, string>();
  for (const entry of value.games) {
    if (!record(entry)) fail();
    allowedKeys(entry, ['id', 'name', 'aliases', 'caseSensitiveAliases', 'related', 'editions', 'platforms', 'defaultEdition', 'provenance']);
    if (!literal(entry.id, 80) || !/^[a-z][a-z0-9-]*$/u.test(entry.id) || ids.has(entry.id)
      || !literal(entry.name) || !literals(entry.aliases) || !literals(entry.platforms, 8)
      || entry.caseSensitiveAliases !== undefined && (!literals(entry.caseSensitiveAliases)
        || !entry.caseSensitiveAliases.every(alias => (entry.aliases as string[]).includes(alias)))) fail();
    ids.add(entry.id);
    for (const name of [entry.id, entry.name, ...entry.aliases]) {
      const normalized = normalizeGamingRegistryIdentity(name);
      if (!normalized || aliases.has(normalized) && aliases.get(normalized) !== entry.id) fail();
      aliases.set(normalized, entry.id);
    }
    if (!Array.isArray(entry.related) || entry.related.length > 16 || !Array.isArray(entry.editions) || entry.editions.length > 16) fail();
    const editionIds = new Set<string>();
    const editionAliases = new Map<string, string>();
    for (const edition of entry.editions) {
      if (!record(edition)) fail();
      allowedKeys(edition, ['id', 'name', 'kind', 'aliases', 'platforms']);
      if (!literal(edition.id, 80) || !/^[a-z][a-z0-9-]*$/u.test(edition.id) || editionIds.has(edition.id)
        || !literal(edition.name) || !['base', 'edition', 'expansion', 'dlc', 'remaster'].includes(String(edition.kind))
        || !literals(edition.aliases) || !literals(edition.platforms, 8)) fail();
      editionIds.add(edition.id);
      for (const name of [edition.name, ...edition.aliases]) {
        const normalized = normalizeGamingRegistryIdentity(name);
        if (!normalized || editionAliases.has(normalized) && editionAliases.get(normalized) !== edition.id) fail();
        editionAliases.set(normalized, edition.id);
      }
    }
    if (entry.defaultEdition !== undefined && (!literal(entry.defaultEdition, 80) || !editionIds.has(entry.defaultEdition))) fail();
    if (!record(entry.provenance)) fail();
    allowedKeys(entry.provenance, ['reviewedAt', 'references']);
    if (!literal(entry.provenance.reviewedAt, 10) || !/^\d{4}-\d{2}-\d{2}$/u.test(entry.provenance.reviewedAt)
      || !Number.isFinite(Date.parse(entry.provenance.reviewedAt))
      || new Date(entry.provenance.reviewedAt).toISOString().slice(0, 10) !== entry.provenance.reviewedAt
      || !literals(entry.provenance.references, 8)
      || !entry.provenance.references.length) fail();
  }
  for (const entry of value.games) for (const relation of entry.related) {
    if (!record(relation)) fail();
    allowedKeys(relation, ['id', 'kind']);
    if (!literal(relation.id, 80) || !ids.has(relation.id) || relation.id === entry.id
      || !['sequel', 'related', 'remaster'].includes(String(relation.kind))) fail();
  }
  return freeze(structuredClone(value) as unknown as GamingGameRegistry);
}
export const GAMING_GAME_REGISTRY = validateGamingGameRegistry(GAMING_GAME_REGISTRY_DATA);

export function resolveGamingRegistryGame(value: string, registry = GAMING_GAME_REGISTRY): GamingRegistryGame | undefined {
  const normalized = normalizeGamingRegistryIdentity(value);
  return registry.games.find(entry => entry.id === normalized
    || [entry.name, ...entry.aliases].some(alias => normalizeGamingRegistryIdentity(alias) === normalized));
}
export function gamingRegistryLiteralPattern(value: string): string {
  return value.normalize('NFKC').split(/\s+/u).map(part => part.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')).join('[\\s-]+');
}
/** Longest titles win, including configured relatives; matching is recognition only. */
export function detectGamingRegistryAlias(value: string, leading = false, wholeNameOnly = false,
  registry = GAMING_GAME_REGISTRY): GamingRegistryGame | undefined {
  const subject = value.normalize('NFKC').trim();
  const matches = registry.games.flatMap(entry => [entry.name, ...entry.aliases].flatMap(alias => {
    const sensitive = entry.caseSensitiveAliases?.includes(alias);
    const pattern = new RegExp(`${leading ? '^' : '(?:^|[^\\p{L}\\p{N}])'}(${gamingRegistryLiteralPattern(alias)})${wholeNameOnly ? '$' : '(?=$|[^\\p{L}\\p{N}])'}`, sensitive ? 'u' : 'iu');
    const match = pattern.exec(subject);
    return match ? [{ entry, length: match[1].length, index: match.index }] : [];
  }));
  return matches.sort((left, right) => right.length - left.length || left.index - right.index)[0]?.entry;
}
export function normalizeGamingRegistryEdition(game: string, value?: string, registry = GAMING_GAME_REGISTRY): string | undefined {
  if (!value) return undefined;
  const identity = value.normalize('NFKC').trim().toLowerCase().replace(/\s+/gu, ' ');
  return resolveGamingRegistryGame(game, registry)?.editions.find(edition => [edition.name, ...edition.aliases]
    .some(alias => alias.normalize('NFKC').toLowerCase().replace(/\s+/gu, ' ') === identity))?.name;
}
export function gamingRegistryRecognizesEdition(game: string, value?: string, registry = GAMING_GAME_REGISTRY): boolean {
  return normalizeGamingRegistryEdition(game, value, registry) !== undefined;
}
export function gamingRegistryEditionKind(game: string, value?: string, registry = GAMING_GAME_REGISTRY): GamingRegistryEditionKind | undefined {
  const name = normalizeGamingRegistryEdition(game, value, registry);
  return name ? resolveGamingRegistryGame(game, registry)?.editions.find(edition => edition.name === name)?.kind : undefined;
}
export function gamingRegistryEditionChoices(game: string, registry = GAMING_GAME_REGISTRY): readonly string[] {
  return resolveGamingRegistryGame(game, registry)?.editions.filter(edition => edition.kind === 'edition').map(edition => edition.name) ?? [];
}
export function gamingRegistryExpansionNames(game?: string, registry = GAMING_GAME_REGISTRY): readonly string[] {
  return [...new Set((game ? [resolveGamingRegistryGame(game, registry)].filter((entry): entry is GamingRegistryGame => Boolean(entry))
    : registry.games).flatMap(entry => entry.editions.filter(edition => ['expansion', 'dlc'].includes(edition.kind))
      .flatMap(edition => [edition.name, ...edition.aliases])))];
}
/** Reviewed related titles and parent-relative names are recognition data only.
 * Callers must independently establish whether a mention owns a gameplay record. */
export function gamingRegistryRelatedScopeNames(game: string, registry = GAMING_GAME_REGISTRY): readonly string[] {
  const entry = resolveGamingRegistryGame(game, registry)
    ?? registry.games.find(candidate => gamingRegistrySourceGameMatchesRequest(game, candidate.name, registry));
  if (!entry) return [];
  const names = new Set<string>();
  for (const relation of entry.related) {
    const related = registry.games.find(candidate => candidate.id === relation.id);
    if (!related) continue;
    for (const title of [related.name, ...related.aliases]) {
      names.add(title);
      for (const parent of [entry.name, ...entry.aliases]) {
        const relative = new RegExp(`^${gamingRegistryLiteralPattern(parent)}[\\s:–—-]+(.+)$`, 'iu').exec(title)?.[1];
        if (relative) names.add(relative.trim());
      }
    }
  }
  return [...names];
}
export function gamingRegistrySourceGameMatchesRequest(sourceGame: string, requestGame: string,
  registry = GAMING_GAME_REGISTRY): boolean {
  const wanted = resolveGamingRegistryGame(requestGame, registry);
  const acquired = resolveGamingRegistryGame(sourceGame, registry);
  if (acquired) return wanted ? acquired.id === wanted.id : normalizeGamingRegistryIdentity(sourceGame) === normalizeGamingRegistryIdentity(requestGame);
  if (normalizeGamingRegistryIdentity(sourceGame) === normalizeGamingRegistryIdentity(requestGame)) return true;
  if (!wanted) return false;
  const identity = normalizeGamingRegistryIdentity(sourceGame);
  return [wanted.name, ...wanted.aliases].some(name => wanted.editions.filter(edition => edition.kind === 'edition')
    .some(edition => [edition.name, ...edition.aliases].some(alias => identity === `${normalizeGamingRegistryIdentity(name)}-${normalizeGamingRegistryIdentity(alias)}`)));
}
export function gamingRegistryDistinctScopeQualifier(game: string, suffix: string, registry = GAMING_GAME_REGISTRY): boolean {
  if (/^(?:ii|iii|iv|\d+|classic|remastered|remake|dlc|expansion)(?:-|$)/u.test(suffix)) return true;
  const entry = resolveGamingRegistryGame(game, registry) ?? registry.games.find(candidate => gamingRegistrySourceGameMatchesRequest(game, candidate.name, registry));
  if (!entry) return false;
  const names = entry.editions.flatMap(edition => [edition.name, ...edition.aliases]);
  for (const relation of entry.related) {
    const related = registry.games.find(candidate => candidate.id === relation.id)!;
    for (const title of [related.name, ...related.aliases]) for (const parent of [entry.name, ...entry.aliases]) {
      const identity = normalizeGamingRegistryIdentity(title), prefix = `${normalizeGamingRegistryIdentity(parent)}-`;
      if (identity.startsWith(prefix)) names.push(identity.slice(prefix.length));
    }
  }
  return names.some(name => suffix === normalizeGamingRegistryIdentity(name) || suffix.startsWith(`${normalizeGamingRegistryIdentity(name)}-`));
}

export interface GamingRegistryEditionScope {
  status: 'none' | 'verified' | 'unverified' | 'conflict'; edition?: string; exclusive: boolean;
}
/** Acquired source assertions only. References, titles and requests cannot choose the player's edition. */
export function readGamingRegistryEditionScope(document: { text: string; metadata?: { title?: string; headings?: string } },
  game: string, registry = GAMING_GAME_REGISTRY): GamingRegistryEditionScope {
  const entry = resolveGamingRegistryGame(game, registry);
  const editions = entry?.editions.filter(edition => edition.kind === 'edition') ?? [];
  if (!entry || !editions.length) return { status: 'none', exclusive: false };
  const gamePattern = [entry.name, ...entry.aliases].map(gamingRegistryLiteralPattern).join('|');
  const editionPattern = editions.flatMap(edition => [edition.name, ...edition.aliases]).sort((a, b) => b.length - a.length)
    .map(gamingRegistryLiteralPattern).join('|');
  const normalize = (value: string) => (normalizeGamingRegistryEdition(game, value, registry)
    ?? normalizeGamingRegistryEdition(game, value.replace(/-/gu, ' '), registry))!;
  const metadata = [document.metadata?.title, document.metadata?.headings].flatMap(value => {
    const match = new RegExp(`^(?:${gamePattern})[\\s-]+(${editionPattern})(?=$|[\\s:.,;!?-])`, 'iu').exec(value?.trim() ?? '');
    return match ? [normalize(match[1])] : [];
  });
  const text = document.text.slice(0, 32_000), assertions: string[] = [], declared: string[] = [];
  const unquoted = text.replace(/"[^"]*"|“[^”]*”|`[^`]*`|'[^']*'|‘[^’]*’/gu, quote => ' '.repeat(quote.length));
  for (const match of unquoted.matchAll(new RegExp(`\\b(?:in(?: the game)?|this (?:guide|build|walkthrough) (?:covers|is for))\\s+(?:${gamePattern})[\\s-]+(${editionPattern})(?=$|[^\\p{L}\\p{N}])`, 'giu'))) {
    const before = unquoted.slice(0, match.index).split(/[.!?;,\n]/u).at(-1) ?? '';
    if (/\b(?:unlike|compared(?:\s+to)?|comparison(?:\s+with)?|contrast(?:\s+to)?|similar(?:ly)?|rather\s+than|instead\s+of|as(?:\s+is\s+the\s+case)?|like)\s*$/iu.test(before)
      || /\b(?:not(?:\s+(?:apply|applicable|valid|available|supported|used|found|present|exist|included|be|for)){0,4}|(?:doesn|isn|aren|don|didn)['’]?t(?:\s+(?:apply|exist|work))?|without|except|excluding|unavailable|unsupported)\s*$/iu.test(before)) continue;
    assertions.push(normalize(match[1]));
  }
  for (const match of text.matchAll(new RegExp(`\\b(?:edition\\s*:\\s*|game\\s*:\\s*(?:${gamePattern})[\\s-]+)(${editionPattern})(?=\\s*[.;|\\n]|$)`, 'giu'))) {
    declared.push(normalize(match[1])); assertions.push(normalize(match[1]));
  }
  let exclusive = false;
  const scopeText = [document.metadata?.title, document.metadata?.headings, text].filter(Boolean).join('\n');
  for (const match of scopeText.matchAll(new RegExp(`\\b(${editionPattern})[ -]only\\b|\\b(?:requires?|only (?:works|is available) (?:in|on))\\s+(?:(?:${gamePattern})\\s+)?(${editionPattern})(?=$|[^\\p{L}\\p{N}])`, 'giu'))) {
    if (/\b(?:not|never|without|isn['’]?t|doesn['’]?t|aren['’]?t|don['’]?t)\s*$/iu.test(scopeText.slice(Math.max(0, match.index - 32), match.index))) continue;
    assertions.push(normalize(match[1] ?? match[2])); exclusive = true;
  }
  const unspecifiedEdition = [...text.matchAll(/\bedition\s*:\s*([^.;|\n]{1,120})(?=\s*[.;|\n]|$)/giu)]
    .some(match => !normalizeGamingRegistryEdition(game, match[1], registry));
  const choices = [...new Set(assertions)], titleEditions = [...new Set(metadata)];
  if (new Set(declared).size > 1 || declared.length && choices.some(value => value !== declared[0])
    || choices.length === 1 && titleEditions.some(value => value !== choices[0])) return { status: 'conflict', exclusive };
  if (unspecifiedEdition || choices.length > 1 || titleEditions.length > 1) return { status: 'unverified', exclusive };
  exclusive ||= new RegExp(`\\b(?:unlike|differs? from|different from)\\b[^.!?\\n]{0,80}\\b(?:${editionPattern})(?=$|[^\\p{L}\\p{N}])`, 'iu').test(text);
  return choices.length === 1 ? { status: 'verified', edition: choices[0], exclusive }
    : { status: titleEditions.length ? 'unverified' : 'none', exclusive };
}
