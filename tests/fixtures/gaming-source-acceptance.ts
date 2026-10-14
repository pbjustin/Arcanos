/**
 * Reproducible synthetic documents for the 2026-10-13 source-acceptance report.
 * These are not captured publisher bodies or proof of any incident URL's validity.
 * Gameplay claims are fixture evidence only, not a current gameplay recommendation.
 */
export const gamingSourceAcceptanceCases = [
  {
    id: 'elden-ring', game: 'Elden Ring', genericTitle: 'Early Game',
    title: 'Elden Ring Samurai beginner guide',
    question: 'What should an early Samurai using Uchigatana do immediately after the tutorial?',
    prose: 'In Elden Ring, the Samurai starts with Uchigatana. Immediately after the tutorial, practice the starting weapon and preserve stamina for dodging after attacks. Raise Vigor for survival and upgrade Uchigatana as Smithing Stones become available. Keep a medium equipment load and use the starting Unsheathe skill. This early Samurai plan uses starting equipment and does not require late-game weapons.',
    record: '<ul><li>Weapon: Uchigatana; Skill: Unsheathe; Scope: base-game</li></ul>',
    unrelatedGame: 'Elden Ring Nightreign'
  },
  {
    id: 'fallout-76', game: 'Fallout 76', genericTitle: 'Heavy Weapons',
    title: 'Fallout 76 beginner Heavy Gunner guide',
    question: 'What should a beginner Heavy Gunner do immediately after leaving Vault 76?',
    prose: 'In Fallout 76, a beginner Heavy Gunner immediately after leaving Vault 76 should first use available equipment, collect ammunition, and repair the starter weapon. The Heavy Gunner build is a later progression goal: do not assume heavy weapons, Power Armor, or later perks are already available. Use a basic weapon while exploring the starting area, check its level requirement, and save supplies for the later Heavy Gunner transition.',
    record: '<ul><li>Weapon: starter weapon; Progression: after leaving Vault 76; Role: Heavy Gunner transition later</li></ul>',
    unrelatedGame: 'Fallout 4'
  }
] as const;

export type GamingSourceAcceptanceCase = typeof gamingSourceAcceptanceCases[number];

export function gamingSourceAcceptanceHtml(fixture: GamingSourceAcceptanceCase, options: {
  title?: string; heading?: string; prose?: string; records?: string; furniture?: boolean;
} = {}): string {
  const title = options.title ?? fixture.genericTitle;
  const heading = options.heading ?? title;
  const unrelated = `<h2>${fixture.unrelatedGame} guide</h2><p>In ${fixture.unrelatedGame}, use unrelated equipment.</p>`;
  return `<html><head><title>${title}</title></head><body>`
    + (options.furniture ? `<nav>${unrelated}</nav>` : '')
    + `<article><h1>${heading}</h1><p>${options.prose ?? fixture.prose}</p>${options.records ?? fixture.record}`
    + (options.furniture ? `<aside>${unrelated}</aside><div class="related-content">${unrelated}</div>` : '')
    + '</article></body></html>';
}
