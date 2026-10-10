import type { GamingGameRegistry, GamingRegistryGame } from './gamingGameRegistryTypes.js';

export const GAMING_LEGACY_EDITION_GAME = 'Minecraft';

const provenance = { reviewedAt: '2026-10-10', references: ['src/services/gamingGameDetection.ts', 'issues/1532'] };
const game = (id: string, name: string, aliases: string[] = []): GamingRegistryGame => ({
  id, name, aliases, related: [], editions: [], platforms: [], provenance
});

/** Recognition data only. Publisher authority, acquired evidence and storage permissions live elsewhere. */
export const GAMING_GAME_REGISTRY_DATA: GamingGameRegistry = {
  version: 'gaming-game-registry/v1', revision: '2026-10-10.1',
  topicVocabulary: ['samurai', 'katana', 'katanas', 'blade', 'blades', 'bleed', 'blood', 'dexterity',
    'strength', 'intelligence', 'faith', 'arcane', 'vigor', 'endurance', 'weapon', 'weapons',
    'beginner', 'beginners', 'starting', 'equipment', 'skills', 'talents'],
  games: [
    game('star-wars-the-old-republic', 'Star Wars: The Old Republic', ['The Old Republic', 'SWTOR']),
    { ...game('world-of-warcraft', 'World of Warcraft', ['WoW', 'WOW']), caseSensitiveAliases: ['WoW', 'WOW'] },
    { ...game('elden-ring', 'Elden Ring'), defaultEdition: 'base-game',
      related: [{ id: 'elden-ring-nightreign', kind: 'related' }], editions: [
        { id: 'base-game', name: 'base-game', kind: 'base', aliases: ['Base game'], platforms: [] },
        { id: 'shadow-of-the-erdtree', name: 'shadow of the erdtree', kind: 'expansion', aliases: ['Shadow of the Erdtree'], platforms: [] }
      ] },
    game('elden-ring-nightreign', 'Elden Ring Nightreign'),
    game('destiny-2', 'Destiny 2'), game('diablo-4', 'Diablo 4', ['Diablo IV']),
    { ...game('path-of-exile', 'Path of Exile'), related: [{ id: 'path-of-exile-2', kind: 'sequel' }] },
    game('path-of-exile-2', 'Path of Exile 2'),
    game('baldurs-gate-3', "Baldur's Gate 3", ['Baldurs Gate 3', 'Baldur’s Gate 3']),
    { ...game('minecraft', 'Minecraft'), related: [
      { id: 'minecraft-dungeons', kind: 'related' }, { id: 'minecraft-legends', kind: 'related' },
      { id: 'minecraft-story-mode', kind: 'related' }
    ], editions: [
      { id: 'java', name: 'Java', kind: 'edition', aliases: ['Java Edition'], platforms: ['PC'] },
      { id: 'bedrock', name: 'Bedrock', kind: 'edition', aliases: ['Bedrock Edition'], platforms: [] }
    ] },
    game('minecraft-dungeons', 'Minecraft Dungeons'), game('minecraft-legends', 'Minecraft Legends'),
    game('minecraft-story-mode', 'Minecraft Story Mode'),
    { ...game('league-of-legends', 'League of Legends', ['LoL', 'LOL']), caseSensitiveAliases: ['LoL', 'LOL'] },
    game('overwatch-2', 'Overwatch 2'), game('fortnite', 'Fortnite'),
    game('stardew-valley', 'Stardew Valley'), game('portal-2', 'Portal 2')
  ]
};
