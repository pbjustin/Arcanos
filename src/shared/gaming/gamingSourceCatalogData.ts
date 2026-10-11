import type { GamingMode } from '@services/gamingModes.js';

/** Repository-controlled candidate hints, not acquired identity or source authority. */
export const GAMING_SOURCE_CATALOG_VERSION = 'gaming-source-catalog/v1';
export const GAMING_SOURCE_CATALOG_REVISION = '2026-10-10.1';
export const GAMING_SOURCE_CATALOG_PROVENANCE = {
  origin: 'repository-defaults',
  migratedFrom: '200463b3aac65eb494f71d842c1e2b0378530bfb',
  reviewPolicy: 'owner-reviewed-data-changes'
} as const;

export type GamingCatalogSourceType = 'official' | 'patch_notes' | 'wiki' | 'curated' | 'supplied';
export interface GamingBuiltinCatalogSource {
  url: string;
  title: string;
  sourceType: GamingCatalogSourceType;
  topics: string[];
  modes: GamingMode[];
  stable: boolean;
}
export interface GamingBuiltinSourceCatalogEntry {
  game: string;
  sources: GamingBuiltinCatalogSource[];
}

export const GAMING_TRUSTED_DOMAIN_SCORES: Array<{ domain: string; score: number }> = [
  { domain: "bandainamcoent.com", score: 0.96 },
  { domain: "en.bandainamcoent.eu", score: 0.96 },
  { domain: "worldofwarcraft.blizzard.com", score: 0.96 },
  { domain: "blizzard.com", score: 0.94 },
  { domain: "swtor.com", score: 0.94 },
  { domain: "bungie.net", score: 0.94 },
  { domain: "diablo4.blizzard.com", score: 0.94 },
  { domain: "pathofexile.com", score: 0.94 },
  { domain: "wiki.fextralife.com", score: 0.76 },
  { domain: "fextralife.com", score: 0.74 },
  { domain: "wowhead.com", score: 0.82 },
  { domain: "icy-veins.com", score: 0.78 },
  { domain: "maxroll.gg", score: 0.78 },
  { domain: "swtorista.com", score: 0.78 },
  { domain: "vulkk.com", score: 0.74 },
  { domain: "bg3.wiki", score: 0.78 },
  { domain: "poewiki.net", score: 0.8 }
];

export const GAMING_LOW_QUALITY_DOMAINS = [
  "tiktok.com",
  "youtube.com",
  "youtu.be",
  "facebook.com",
  "instagram.com",
  "pinterest.com",
  "x.com",
  "twitter.com"
];

/** Existing discovery seeds remain untrusted until normal acquisition and validation. */
export const GAMING_BUILTIN_SOURCE_CATALOG: GamingBuiltinSourceCatalogEntry[] = [
  {
    game: "Elden Ring",
    sources: [
      {
        title: "Elden Ring official news and patch notes",
        url: "https://en.bandainamcoent.eu/elden-ring/news/elden-ring-patch-notes-version-1161",
        sourceType: "patch_notes",
        topics: ["patch", "latest", "news", "meta", "balance"],
        modes: ["build", "meta"],
        stable: false
      },
      {
        title: "Elden Ring wiki walkthrough",
        url: "https://eldenring.wiki.fextralife.com/Game+Progress+Route",
        sourceType: "wiki",
        topics: ["guide", "walkthrough", "route", "progress", "limgrave", "tutorial"],
        modes: ["guide"],
        stable: true
      },
      {
        title: "Elden Ring wiki builds",
        url: "https://eldenring.wiki.fextralife.com/Builds",
        sourceType: "wiki",
        topics: ["build", "bleed", "stats", "weapons", "talismans"],
        modes: ["build"],
        stable: true
      },
      {
        title: "Elden Ring wiki status effects",
        url: "https://eldenring.wiki.fextralife.com/Status+Effects",
        sourceType: "wiki",
        topics: ["bleed", "frost", "poison", "status", "build"],
        modes: ["build", "guide"],
        stable: true
      },
      {
        title: "Elden Ring wiki hemorrhage guide",
        url: "https://eldenring.wiki.fextralife.com/Hemorrhage",
        sourceType: "wiki",
        topics: ["bleed", "blood loss", "hemorrhage", "arcane", "build"],
        modes: ["build"],
        stable: true
      }
    ]
  },
  {
    game: "World of Warcraft",
    sources: [
      {
        title: "World of Warcraft official news",
        url: "https://worldofwarcraft.blizzard.com/en-us/news",
        sourceType: "patch_notes",
        topics: ["patch", "hotfix", "latest", "meta", "balance"],
        modes: ["build", "meta"],
        stable: false
      },
      {
        title: "Wowhead Frost Mage guide",
        url: "https://www.wowhead.com/guide/classes/mage/frost/overview",
        sourceType: "curated",
        topics: ["frost", "mage", "build", "talents", "rotation", "viable"],
        modes: ["build", "meta", "guide"],
        stable: false
      },
      {
        title: "Icy Veins Frost Mage guide",
        url: "https://www.icy-veins.com/wow/frost-mage-pve-dps-guide",
        sourceType: "curated",
        topics: ["frost", "mage", "build", "talents", "rotation", "viable"],
        modes: ["build", "meta", "guide"],
        stable: false
      }
    ]
  },
  {
    game: "Star Wars: The Old Republic",
    sources: [
      {
        title: "SWTOR official patch notes",
        url: "https://www.swtor.com/patchnotes",
        sourceType: "patch_notes",
        topics: ["patch", "latest", "balance", "meta"],
        modes: ["build", "meta"],
        stable: false
      },
      {
        title: "SWTOR community guide index",
        url: "https://swtorista.com/articles/",
        sourceType: "curated",
        topics: ["guide", "build", "class", "gearing", "walkthrough"],
        modes: ["guide", "build"],
        stable: true
      }
    ]
  },
  {
    game: "Destiny 2",
    sources: [
      {
        title: "Destiny 2 official news",
        url: "https://www.bungie.net/7/en/News",
        sourceType: "patch_notes",
        topics: ["patch", "twid", "latest", "balance", "meta"],
        modes: ["build", "meta"],
        stable: false
      }
    ]
  },
  {
    game: "Diablo 4",
    sources: [
      {
        title: "Diablo 4 official news",
        url: "https://news.blizzard.com/en-us/diablo4",
        sourceType: "patch_notes",
        topics: ["patch", "season", "build", "meta", "balance"],
        modes: ["build", "meta", "guide"],
        stable: false
      }
    ]
  },
  {
    game: "Baldur's Gate 3",
    sources: [
      {
        title: "Baldur's Gate 3 community wiki",
        url: "https://bg3.wiki/",
        sourceType: "wiki",
        topics: ["guide", "build", "class", "walkthrough"],
        modes: ["guide", "build"],
        stable: true
      }
    ]
  },
  {
    game: "Path of Exile",
    sources: [
      {
        title: "Path of Exile official news",
        url: "https://www.pathofexile.com/news",
        sourceType: "patch_notes",
        topics: ["patch", "league", "build", "meta", "balance"],
        modes: ["build", "meta"],
        stable: false
      },
      {
        title: "Path of Exile wiki",
        url: "https://www.poewiki.net/wiki/Path_of_Exile_Wiki",
        sourceType: "wiki",
        topics: ["guide", "build", "item", "skill"],
        modes: ["guide", "build"],
        stable: true
      }
    ]
  }
];

/** Request-only ranking phrases; these never supply acquired game identity. */
export const GAMING_REQUEST_TOPIC_PHRASES = [
  { pattern: '\\bfrost\\s+mage\\b', flags: 'i', phrase: 'frost mage' },
  { pattern: '\\bbleed\\b', flags: 'i', phrase: 'bleed' }
] as const;

export const GAMING_BUILD_RANKING_TERMS = [
  'build', 'gear', 'talent', 'weapon', 'stat', 'stats', 'rotation', 'bleed', 'frost'
] as const;
