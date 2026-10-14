/**
 * Original synthetic source documents, not captured publisher pages or verified
 * gameplay advice. Every factual sentence below is labeled fixture evidence.
 * No registry entry, publisher authority, player class, or stored source is
 * supplied to the production validators by these fixtures.
 */
export interface GamingUniversalIdentityFixture {
  id: string;
  game: string;
  genre: string;
  topic: string;
  question: string;
  mode: 'guide' | 'build';
  sentences: readonly string[];
  unrelatedGame: string;
}

export const gamingUniversalIdentityFixtures: readonly GamingUniversalIdentityFixture[] = [
  { id: 'samurai', game: 'Elden Ring', genre: 'action RPG', topic: 'Unsheathe Timing', mode: 'guide',
    question: 'How do I practice Unsheathe timing?', unrelatedGame: 'Elden Ring Nightreign',
    sentences: ['Practice Unsheathe timing by observing a safe opening before committing to one strike.',
      'Return to a neutral stance after the strike and preserve enough stamina to retreat.',
      'Repeat one controlled timing attempt rather than chaining attacks into an uncertain opening.'] },
  { id: 'heavy-gunner', game: 'Fallout 76', genre: 'online RPG', topic: 'Ammunition Conservation', mode: 'guide',
    question: 'How do I practice ammunition conservation?', unrelatedGame: 'Fallout 4',
    sentences: ['Practice ammunition conservation by checking the weapon condition before a short encounter.',
      'Use controlled bursts and stop firing when the target moves behind cover.',
      'Inspect the ammunition supply between encounters instead of assuming a later Heavy Gunner loadout is available.'] },
  { id: 'tactical-positioning', game: "Baldur's Gate 3", genre: 'turn based RPG', topic: 'Tactical Spacing', mode: 'guide',
    question: 'How do I practice tactical spacing?', unrelatedGame: 'Divinity: Original Sin 2',
    sentences: ['Practice tactical spacing by checking the available movement before committing an action.',
      'Place allies so that one blocked path does not prevent every character from moving.',
      'Review the next turn from the visible terrain rather than assuming an unseen route is safe.'] },
  { id: 'farm-layout', game: 'Stardew Valley', genre: 'farming', topic: 'Irrigation Layout', mode: 'build',
    question: 'Recommend an irrigation layout for reachable crop rows.', unrelatedGame: 'Harvest Moon',
    sentences: ['Arrange reachable crop rows around a clear irrigation path and leave a walking lane beside the planted area.',
      'Keep the irrigation layout compact so that crop access does not depend on crossing a planted tile.',
      'Expand the layout only after checking that every crop row remains reachable from the walking lane.'] },
  { id: 'wound-observation', game: 'Monster Hunter Wilds', genre: 'hunting action', topic: 'Wound Observation', mode: 'guide',
    question: 'How do I practice wound observation?', unrelatedGame: 'Monster Hunter World',
    sentences: ['Practice wound observation by inspecting the visible target before committing to a follow-up action.',
      'Check the target position and leave room to disengage when its movement changes.',
      'Repeat the observation exercise with a single deliberate follow-up instead of assuming every opening is safe.'] },
  { id: 'orb-routing', game: 'Destiny 2', genre: 'shooter', topic: 'Orb Routing', mode: 'guide',
    question: 'How do I practice orb routing?', unrelatedGame: 'Warframe',
    sentences: ['Practice orb routing by checking the visible pickup path before leaving cover.',
      'Collect an orb only when the return path has a clear retreat option.',
      'Recheck the route after each pickup rather than assuming a previous opening remains available.'] },
  { id: 'district-layout', game: 'Civilization VI', genre: 'strategy', topic: 'District Adjacency', mode: 'build',
    question: 'Recommend a district adjacency layout around a mountain cluster.', unrelatedGame: 'Civilization V',
    sentences: ['Plan a district adjacency layout around the visible mountain cluster before placing the first district.',
      'Reserve the intended district tiles and compare the displayed adjacency yields before confirming construction.',
      'Keep the layout flexible when a required tile is unavailable instead of assuming the surrounding terrain can be changed.'] },
  { id: 'soul-recovery', game: 'Hollow Knight', genre: 'metroidvania', topic: 'Soul Recovery', mode: 'guide',
    question: 'How do I practice soul recovery?', unrelatedGame: 'Hollow Knight Silksong',
    sentences: ['Practice soul recovery by observing a safe pause before spending the available resource.',
      'Leave room to disengage when an approaching hazard interrupts the recovery window.',
      'Repeat one deliberate recovery attempt before attempting a longer sequence.'] },
  { id: 'unknown-resonance', game: 'Copperwind Loom', genre: 'synthetic unknown', topic: 'Resonance Braiding', mode: 'build',
    question: 'Recommend a resonance braiding layout for a chime lattice.', unrelatedGame: 'Glasswake Almanac',
    sentences: ['Arrange the chime lattice around a quiet lumen spindle before beginning resonance braiding.',
      'Leave one unlinked braid between the spindle and the outer chimes so that a ravel pulse can dissipate.',
      'Inspect the resonance braiding layout after each pulse and reconnect the outer chime only after the lattice becomes quiet.'] }
];

const htmlText = (value: string) => value.replace(/&/gu, '&amp;').replace(/</gu, '&lt;').replace(/>/gu, '&gt;');

export function gamingUniversalIdentityHtml(fixture: GamingUniversalIdentityFixture, options: {
  scope?: 'affirmative' | 'missing' | 'comparison' | 'wrong' | 'bare_wrong';
  title?: string;
  furniture?: boolean;
  extra?: string;
  metadata?: string;
} = {}): string {
  const title = options.title ?? fixture.topic;
  const scope = options.scope ?? 'affirmative';
  const game = scope === 'wrong' || scope === 'bare_wrong' ? fixture.unrelatedGame : fixture.game;
  const declaration = scope === 'missing' ? '' : `${scope === 'comparison' ? 'Unlike in' : scope === 'wrong' ? 'In the game' : 'In'} ${game}, `;
  const paragraphs = fixture.sentences.map((sentence, index) => `<p>${htmlText(index === 0 ? declaration + sentence : sentence)}</p>`).join('');
  const furniture = `<h2>${htmlText(fixture.unrelatedGame)} guide</h2><p>FURNITURE_ONLY: In ${htmlText(fixture.unrelatedGame)}, collect unrelated equipment.</p>`;
  return `<html><head><title>${htmlText(title)}</title></head><body>`
    + (options.furniture ? `<nav>${furniture}</nav>` : '')
    + `<article><h1>${htmlText(title)}</h1>${options.metadata ?? ''}${paragraphs}`
    + '<section><h2>Publisher stationery</h2><p>UNRELATED_ARTICLE_SECTION: The desk ledger lists stationery deliveries and archive shelf labels.</p></section>'
    + `${options.extra ?? ''}`
    + (options.furniture ? `<aside>${furniture}</aside><div class="related-content">${furniture}</div>` : '')
    + '</article></body></html>';
}
