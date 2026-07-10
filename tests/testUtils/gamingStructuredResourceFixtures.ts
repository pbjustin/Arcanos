import { deflateRawSync } from 'node:zlib';

export type GamingStructuredFixtureResourceType =
  | 'build_planner'
  | 'loadout'
  | 'skill_tree'
  | 'calculator';

export interface GamingStructuredFixturePayload {
  game: string;
  title: string;
  role?: string;
  archetype?: string;
  activity?: string;
  patch?: string;
  character?: {
    class?: string;
    subclass?: string;
    specialization?: string;
    level?: number;
  };
  equipment?: Array<{
    slot?: string;
    name: string;
    category?: string;
    rarity?: string;
    upgrades?: string[];
    modifications?: string[];
    quantity?: number;
  }>;
  skills?: Array<{
    name: string;
    rank?: number;
    category?: string;
    modifiers?: string[];
  }>;
  stats?: Record<string, string | number>;
  rotation?: string[];
  talents?: string[];
  perks?: string[];
  traits?: string[];
  consumables?: string[];
  companions?: string[];
  utility?: string[];
  strengths?: string[];
  weaknesses?: string[];
  constraints?: string[];
  notes?: string[];
}

export interface GamingStructuredResourceFixture {
  id: string;
  game: string;
  resourceType: GamingStructuredFixtureResourceType;
  payload: GamingStructuredFixturePayload;
  jsonUrl: string;
  base64Url: string;
  deflateUrl: string;
  fragmentUrl: string;
  wrongGameUrl: string;
  articleUrl: string;
}

interface FixtureSeed {
  id: string;
  resourceType: GamingStructuredFixtureResourceType;
  origin: string;
  path: string;
  payload: GamingStructuredFixturePayload;
}

const seeds: FixtureSeed[] = [
  {
    id: 'space-sim-ship-planner',
    resourceType: 'build_planner',
    origin: 'https://shipyard-tools.example',
    path: '/ship-planner/share',
    payload: {
      game: 'Void Frontier',
      title: 'Kestrel Interceptor Fleet Fit',
      role: 'Tackle interceptor',
      activity: 'Fleet PvP',
      equipment: [
        { slot: 'high', name: 'Light Ion Blaster II', quantity: 3, upgrades: ['Null S'] },
        { slot: 'mid', name: '5MN Microwarpdrive II' },
        { slot: 'low', name: 'Nanofiber Internal Structure II' }
      ],
      skills: [{ name: 'Interceptors', rank: 5 }, { name: 'Navigation', rank: 5 }],
      stats: { effectiveHitPoints: 6120, maximumVelocity: 4375, capacitorStable: 'No' },
      strengths: ['Fast initial tackle', 'Small signature while moving'],
      weaknesses: ['Low sustained damage']
    }
  },
  {
    id: 'mmo-talent-calculator',
    resourceType: 'skill_tree',
    origin: 'https://talent-forge.example',
    path: '/talent-calculator/share',
    payload: {
      game: 'Elder Realms Online',
      title: 'Warden Raid Healer Talents',
      role: 'Raid healer',
      patch: '8.2',
      character: { class: 'Warden', specialization: 'Lifebinder', level: 80 },
      skills: [
        { name: 'Renewing Bloom', rank: 5, category: 'Restoration' },
        { name: 'Verdant Shelter', rank: 3, category: 'Restoration' }
      ],
      talents: ['Overflowing Growth', 'Nature\'s Reprieve', 'Shared Roots'],
      rotation: ['Maintain Renewing Bloom', 'Use Verdant Shelter for raid damage'],
      stats: { talentPointsSpent: 31, talentPointsAvailable: 31 }
    }
  },
  {
    id: 'arpg-skill-tree-share',
    resourceType: 'skill_tree',
    origin: 'https://passive-lab.example',
    path: '/skill-tree/build',
    payload: {
      game: 'Ashfall Exiles',
      title: 'Stormcaller Chain Lightning',
      archetype: 'Critical lightning caster',
      activity: 'Endgame mapping',
      character: { class: 'Arcanist', specialization: 'Stormcaller', level: 92 },
      equipment: [
        { slot: 'weapon', name: 'Tempest Scepter', rarity: 'Legendary', modifications: ['Chain +1 target'] },
        { slot: 'amulet', name: 'Eye of the Squall', rarity: 'Unique' }
      ],
      skills: [
        { name: 'Chain Lightning', rank: 20, modifiers: ['Arc Echo', 'Critical Surge'] },
        { name: 'Static Guard', rank: 14 }
      ],
      talents: ['Overcharged Conduits', 'Storm Dominion', 'Unstable Current'],
      stats: { criticalChance: '42%', lightningResistance: '75%', life: 4860 },
      constraints: ['Requires level 92 for the full tree']
    }
  },
  {
    id: 'shooter-weapon-loadout',
    resourceType: 'loadout',
    origin: 'https://loadout-bench.example',
    path: '/weapon-loadout/share',
    payload: {
      game: 'Strikepoint',
      title: 'VX-9 Close-Quarters Loadout',
      role: 'Entry fragger',
      equipment: [
        { slot: 'primary', name: 'VX-9 SMG', modifications: ['Compensator', 'Reflex Sight', 'Quick Magazine'] },
        { slot: 'secondary', name: 'P12 Sidearm' },
        { slot: 'tactical', name: 'Flash Grenade', quantity: 2 }
      ],
      perks: ['Lightweight', 'Quick Hands', 'Ghost Step'],
      stats: { damage: 31, fireRate: 860, magazineSize: 36 },
      strengths: ['Fast handling', 'Strong close-range time to kill'],
      weaknesses: ['Sharp damage falloff at range']
    }
  },
  {
    id: 'deck-builder',
    resourceType: 'build_planner',
    origin: 'https://deck-workshop.example',
    path: '/deck-builder/share',
    payload: {
      game: 'Mythic Circuit',
      title: 'Ember Tempo Deck',
      role: 'Tempo',
      equipment: [
        { name: 'Spark Runner', category: 'Unit', quantity: 4 },
        { name: 'Cinder Volley', category: 'Action', quantity: 4 },
        { name: 'Phoenix Relay', category: 'Relic', quantity: 2 }
      ],
      stats: { deckSize: 40, units: 22, actions: 14, relics: 4 },
      rotation: ['Develop low-cost units', 'Protect tempo with Cinder Volley', 'Close with Phoenix Relay'],
      constraints: ['Standard format']
    }
  },
  {
    id: 'racing-setup-calculator',
    resourceType: 'calculator',
    origin: 'https://setup-paddock.example',
    path: '/racing-setup/calculator',
    payload: {
      game: 'Apex Touring',
      title: 'Falcon GT Wet Sprint Setup',
      activity: 'Wet sprint race',
      equipment: [
        { slot: 'vehicle', name: 'Falcon GT3' },
        { slot: 'tires', name: 'Intermediate Compound' }
      ],
      stats: {
        frontTirePressurePsi: 26.4,
        rearTirePressurePsi: 26.1,
        frontWing: 8,
        rearWing: 11,
        brakeBias: '53.5%'
      },
      traits: ['Stable wet braking', 'High rear downforce'],
      weaknesses: ['Reduced straight-line speed']
    }
  },
  {
    id: 'strategy-army-composition',
    resourceType: 'build_planner',
    origin: 'https://army-foundry.example',
    path: '/army-builder/list',
    payload: {
      game: 'Iron Dominion',
      title: 'Solar Cohort 2000 Point Army',
      role: 'Combined arms',
      equipment: [
        { slot: 'commander', name: 'Solar Marshal', category: 'HQ', quantity: 1 },
        { name: 'Line Cohort', category: 'Infantry', quantity: 20, upgrades: ['Shield Array'] },
        { name: 'Sunlance Walker', category: 'Vehicle', quantity: 2 }
      ],
      stats: { points: 2000, commandPoints: 6, unitCount: 23 },
      strengths: ['Durable midfield control', 'Reliable anti-armor'],
      constraints: ['Matched play', 'Maximum 2000 points']
    }
  },
  {
    id: 'team-composition-planner',
    resourceType: 'build_planner',
    origin: 'https://squad-canvas.example',
    path: '/team-composition/planner',
    payload: {
      game: 'Chronicle Tactics',
      title: 'Frostbreak Expedition Team',
      role: 'Control and burst',
      activity: 'Frostbreak Citadel',
      companions: ['Mira the Vanguard', 'Quill the Arcanist', 'Sera the Medic', 'Rook the Scout'],
      skills: [
        { name: 'Glacial Lock', category: 'Control' },
        { name: 'Arc Cascade', category: 'Burst' },
        { name: 'Field Triage', category: 'Support' }
      ],
      utility: ['Armor break', 'Cleanse', 'Enemy grouping'],
      strengths: ['Layered crowd control', 'Safe burst window'],
      weaknesses: ['Long recovery after the burst window']
    }
  },
  {
    id: 'unknown-community-planner',
    resourceType: 'build_planner',
    origin: 'https://community-toolbox.example',
    path: '/custom-planner/shared',
    payload: {
      game: 'Frontier Guilds',
      title: 'Community Harvester Build',
      role: 'Resource gathering',
      equipment: [
        { slot: 'tool', name: 'Reinforced Harvester', upgrades: ['Yield Coil'] },
        { slot: 'pack', name: 'Surveyor Pack' }
      ],
      skills: [{ name: 'Efficient Extraction', rank: 4 }, { name: 'Field Survey', rank: 3 }],
      stats: { gatheringYield: 128, carryCapacity: 75 },
      notes: ['Unknown-domain fixture exercises the generic extractor']
    }
  }
];

function encodeJson(value: GamingStructuredFixturePayload): string {
  return JSON.stringify(value);
}

function toBase64Url(value: string | Uint8Array): string {
  return Buffer.from(value).toString('base64url');
}

function createFixture(seed: FixtureSeed): GamingStructuredResourceFixture {
  const json = encodeJson(seed.payload);
  const base64 = toBase64Url(json);
  const deflated = toBase64Url(deflateRawSync(Buffer.from(json, 'utf8')));
  const wrongGamePayload = encodeJson({
    ...seed.payload,
    game: 'Unrelated Test Game'
  });
  const game = encodeURIComponent(seed.payload.game);
  const resourceUrl = `${seed.origin}${seed.path}`;

  return {
    id: seed.id,
    game: seed.payload.game,
    resourceType: seed.resourceType,
    payload: seed.payload,
    jsonUrl: `${resourceUrl}?game=${game}&build=${encodeURIComponent(json)}`,
    base64Url: `${resourceUrl}?game=${game}&payload=${base64}`,
    deflateUrl: `${resourceUrl}?game=${game}&encoding=deflate-raw&payload=${deflated}`,
    fragmentUrl: `${resourceUrl}?game=${game}#build=${base64}`,
    wrongGameUrl: `${resourceUrl}?game=${encodeURIComponent('Unrelated Test Game')}&build=${encodeURIComponent(wrongGamePayload)}`,
    articleUrl: `${seed.origin}/guides/${seed.id}?game=${game}`
  };
}

export const gamingStructuredResourceFixtures: GamingStructuredResourceFixture[] = seeds.map(createFixture);
