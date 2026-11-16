export type GamingRegistryEditionKind = 'base' | 'edition' | 'expansion' | 'dlc' | 'remaster';
export interface GamingRegistryEdition {
  id: string;
  name: string;
  kind: GamingRegistryEditionKind;
  aliases: readonly string[];
  platforms: readonly string[];
}
export interface GamingRegistryGame {
  id: string;
  name: string;
  aliases: readonly string[];
  /** Short ambiguous aliases are case sensitive in prose, but exact requests may resolve them. */
  caseSensitiveAliases?: readonly string[];
  related: readonly { id: string; kind: 'sequel' | 'related' | 'remaster' }[];
  editions: readonly GamingRegistryEdition[];
  platforms: readonly string[];
  /** Request interpretation only; never proof of an acquired edition. */
  defaultEdition?: string;
  provenance: { reviewedAt: string; references: readonly string[] };
}
export interface GamingGameRegistry {
  version: 'gaming-game-registry/v1';
  revision: string;
  games: readonly GamingRegistryGame[];
  /** Vocabulary recognition only; never source identity proof. */
  topicVocabulary?: readonly string[];
}
