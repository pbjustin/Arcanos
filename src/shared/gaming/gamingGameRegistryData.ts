import type { GamingGameRegistry, GamingRegistryGame } from './gamingGameRegistryTypes.js';

export const GAMING_LEGACY_EDITION_GAME = 'Minecraft';

const provenance = { reviewedAt: '2026-10-10', references: ['src/services/gamingGameDetection.ts', 'issues/1532'] };
const sourceAcceptanceProvenance = { reviewedAt: '2026-10-13', references: ['tests/gaming-source-acceptance-identity.test.ts'] };
const game = (id: string, name: string, aliases: string[] = []): GamingRegistryGame => ({
  id, name, aliases, related: [], editions: [], platforms: [], provenance
});

/** Recognition data only. Publisher authority, acquired evidence and storage permissions live elsewhere. */
export const GAMING_GAME_REGISTRY_DATA: GamingGameRegistry = {
  version: 'gaming-game-registry/v1', revision: '2026-11-15.3',
  topicVocabulary: ['samurai', 'katana', 'katanas', 'blade', 'blades', 'bleed', 'blood', 'dexterity',
    'strength', 'intelligence', 'faith', 'arcane', 'vigor', 'endurance', 'weapon', 'weapons',
    'beginner', 'beginners', 'starting', 'equipment', 'skills', 'talents', 'heavy', 'gunner', 'power', 'armor', 'armour'],
  games: [
    game('star-wars-the-old-republic', 'Star Wars: The Old Republic', ['The Old Republic', 'SWTOR']),
    { ...game('world-of-warcraft', 'World of Warcraft', ['WoW', 'WOW']), caseSensitiveAliases: ['WoW', 'WOW'] },
    { ...game('elden-ring', 'Elden Ring'), defaultEdition: 'base-game',
      guideTopics: [{ heading: 'Church of Elleh', entities: ['Church of Elleh', 'Smithing Table'],
        actions: [{ verbs: ['use', 'uses', 'using', 'spend', 'spends'], objects: ['Smithing Stone', 'Smithing Stones'] }] }],
      provenance: { reviewedAt: '2026-11-15', references: ['https://en.bandainamcoent.eu/elden-ring/news/elden-ring-early-game-tips'] },
      related: [{ id: 'elden-ring-nightreign', kind: 'related' }], editions: [
        { id: 'base-game', name: 'base-game', kind: 'base', aliases: ['Base game'], platforms: [] },
        { id: 'shadow-of-the-erdtree', name: 'shadow of the erdtree', kind: 'expansion', aliases: ['Shadow of the Erdtree'], platforms: [] }
      ] },
    game('elden-ring-nightreign', 'Elden Ring Nightreign'),
    { ...game('fallout-76', 'Fallout 76'), provenance: sourceAcceptanceProvenance },
    { ...game('fallout-4', 'Fallout 4'), provenance: sourceAcceptanceProvenance },
    { ...game('fallout-3', 'Fallout 3'), provenance: sourceAcceptanceProvenance },
    { ...game('fallout-new-vegas', 'Fallout: New Vegas', ['Fallout New Vegas']), provenance: sourceAcceptanceProvenance },
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
    game('stardew-valley', 'Stardew Valley'), game('portal-2', 'Portal 2'),
    game('grand-theft-auto-iii', 'Grand Theft Auto III', ['Grand Theft Auto 3', 'GTA III', 'GTA 3']),
    { ...game('grand-theft-auto-iv', 'Grand Theft Auto IV', ['Grand Theft Auto 4', 'GTA IV', 'GTA 4']),
      guideTopics: [{ heading: 'The Cousins Bellic', entities: ['Niko', 'Roman', 'Liberty City'], actions: [
        { verbs: ['climb off', 'climbs off', 'climbed off', 'step off', 'steps off', 'stepped off', 'get off', 'gets off', 'got off',
          'walk off', 'disembark', 'disembarks', 'disembarked', 'disembark from', 'disembarks from', 'disembarked from'],
          objects: ['boat', 'ship', 'ferry'], actors: ['Niko', 'Niko Bellic'] },
        { verbs: ['arrive', 'arrives', 'arrived', 'arriving', 'arrive in Liberty City', 'arrives in Liberty City', 'arrived in Liberty City',
          'arrive at the docks', 'arrives at the docks', 'arrived at the docks'],
          objects: ['by boat', 'by ship', 'by ferry', 'by a boat', 'on a boat', 'on the boat', 'on a ship', 'on the ship',
            'on a ferry', 'on the ferry', 'aboard a boat', 'aboard the boat', 'aboard a ship', 'aboard the ship'], actors: ['Niko', 'Niko Bellic'] }
      ] }],
      provenance: { reviewedAt: '2026-11-15', references: ['https://www.rockstargames.com/games/IV',
        'https://www.gta4.tv/gta4/guides/the-cousins-bellic'] } },
    game('grand-theft-auto-v', 'Grand Theft Auto V', ['Grand Theft Auto 5', 'GTA V', 'GTA 5']),
    { ...game('xenoblade-chronicles-2', 'Xenoblade Chronicles 2', ['XC2']),
      guideTopics: [{ heading: 'Driver Arts', entities: ['Rex', 'Pyra', 'auto attacks'],
        actions: [{ verbs: ['charge', 'charges', 'charging', 'recharge', 'recharges', 'recharging'],
          objects: ['Arts', 'Driver Arts'] }] }],
      provenance: { reviewedAt: '2026-11-15', references:
        ['https://www.nintendo.com/en-gb/News/2017/July/Get-up-to-speed-on-Xenoblade-Chronicles-2-s-world-and-combat--1244128.html'] } },
    { ...game('elite-dangerous', 'Elite Dangerous'),
      guideTopics: [{ heading: 'System Colonisation', entities: ['System Colonisation Contact', 'station services', 'Galaxy Map'],
        actions: [{ verbs: ['select', 'selects', 'selecting', 'choose', 'chooses'], objects: ['system', 'star system'] }] }],
      provenance: { reviewedAt: '2026-11-15', references:
        ['https://store.steampowered.com/news/posts/?appids=359320&enddate=1741174469&feed=steam_community_announcements'] } }
  ]
};
