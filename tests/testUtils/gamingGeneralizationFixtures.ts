/** Authored, deterministic HTML. Reference URLs document fact provenance, never source authority in the test. */
interface BenchmarkSeed {
  id: string;
  game: string;
  topic: string;
  reference: string;
  body: string;
  answer: string;
  support: RegExp[];
  firstAnswer?: { answer: string; support: RegExp[] };
  questions: string[];
  tags: string[];
  title?: string;
  progress?: string;
  afterArticle?: string;
}

const known = ['known', 'unconfigured-mechanic'];
const unfamiliar = ['unconfigured-game', 'unconfigured-mechanic'];
const boatLead = 'Niko climbs off the ship in Liberty City, where Roman meets him at the docks. Niko and Roman reunite after the voyage.';
const boatRoute = 'After disembarking from the ship at the Liberty City docks, get into Roman’s car and drive him home. Follow the yellow GPS route to his apartment in Hove Beach.';
const gtaReference = 'https://www.gta4.tv/gta4/guides/the-cousins-bellic';
const bladeFact = 'Start a Blade Combo with a Blade Special. Use another Special that follows one of the displayed elemental branches before the timer runs out.';
const restFact = 'At a Rest Site, select Smith and choose one card to upgrade. Confirm the card selection to improve that card.';
const extraContext = Array.from({ length: 196 }, (_, index) => '<p>Guide note ' + (index + 1)
  + ' records the camera angle, dialogue presentation, scene framing, and the order of the introductory cutscenes. These notes describe how the mission is presented without discussing the driving route.</p>').join('');
const seeds: BenchmarkSeed[] = [
  {
    id: 'gta-opening-late', game: 'Grand Theft Auto IV', topic: 'The Cousins Bellic', title: 'GTA IV - The Cousins Bellic - Story Mission Guide',
    reference: gtaReference, tags: ['known', 'layout', 'late'], progress: 'Just got off the boat.',
    body: '<header><div>GTA IV - Story Mission Guide</div><h1>The Cousins Bellic</h1></header><p>' + boatLead
      + '</p>' + extraContext + '<h2>The Cousins Bellic</h2><p>In the game Grand Theft Auto IV, after disembarking from the ship at the Liberty City docks, get into Roman’s car and drive him home along the yellow GPS route to Hove Beach.</p>',
    questions: ['What should I do next?', 'What are the next steps after disembarking from the ship?'],
    answer: 'Get into Roman’s car and drive him home to Hove Beach along the yellow GPS route.',
    support: [/ship at the Liberty City docks/iu, /drive him home/iu, /yellow GPS route/iu, /Hove Beach/iu]
  },
  {
    id: 'gta-opening-layout', game: 'Grand Theft Auto IV', topic: 'The Cousins Bellic', title: 'The Cousins Bellic',
    reference: gtaReference, tags: ['known', 'layout'], progress: 'Just got off the boat.',
    body: '<div><p>Game: Grand Theft Auto IV.</p><section><h1>The Cousins Bellic</h1><p>' + boatLead + '</p>'
      + '<h2>After the boat arrives</h2><p>' + boatRoute + '</p></section></div>',
    questions: ['What should I do next?', 'Where do I go after the ship arrives?'],
    answer: 'Get into Roman’s car and follow the yellow GPS route home to Hove Beach.',
    support: [/ship at the Liberty City docks/iu, /Roman’s car/iu, /yellow GPS route/iu, /Hove Beach/iu]
  },
  {
    id: 'elden-gear', game: 'Elden Ring', topic: 'Smithing', reference: 'https://en.bandainamcoent.eu/elden-ring/news/elden-ring-early-game-tips',
    tags: known,
    body: '<p>In the game Elden Ring, the smithing table at the Church of Elleh lets you reinforce your armaments using Smithing Stones. Interact with the smithing table and choose the armament you want to strengthen.</p>',
    questions: ['How do I upgrade my weapons?', 'How can I reinforce my armaments?'],
    answer: 'Use the smithing table at the Church of Elleh and spend Smithing Stones to reinforce an armament.',
    support: [/Church of Elleh/iu, /smithing table/iu, /reinforce your armaments using Smithing Stones/iu]
  },
  {
    id: 'xc2-blade', game: 'Xenoblade Chronicles 2', topic: 'Blade Combo', title: 'Xenoblade Chronicles 2 Blade Combo guide',
    reference: 'https://www.nintendo-insider.com/xenoblade-chronicles-2-combat-guide-breaking-down-the-battle-system/',
    tags: known, body: '<h1>Xenoblade Chronicles 2 Blade Combo guide</h1><p>This guide covers XC2 Blade Combo. Blade Combo is a mechanic in Xenoblade Chronicles 2. '
      + bladeFact + '</p>',
    questions: ['How do I perform a Blade Combo?', 'How do I link Blade Specials in a combo?'],
    answer: 'Start with a Blade Special, then use another Special along a displayed elemental branch before the timer runs out.',
    support: [/Start a Blade Combo with a Blade Special/iu, /displayed elemental branches/iu, /before the timer runs out/iu]
  },
  {
    id: 'elite-assist', game: 'Elite Dangerous', topic: 'Supercruise Assist', title: 'Elite Dangerous Supercruise Assist guide',
    reference: 'https://edfieldmanual.com/wiki/Supercruise_Assist', tags: [...known, 'layout'],
    body: '<h1>Elite Dangerous Supercruise Assist guide</h1><p>This guide covers Elite Dangerous Supercruise Assist. Supercruise Assist is a mechanic in Elite Dangerous. Select a destination in the Navigation panel and enable Supercruise Assist. With manual throttle enabled, set the throttle in the blue zone.</p><table><tr><th>Mechanic</th><th>Value</th></tr><tr><td>Supercruise Assist</td><td>Select it from the destination entry in the Navigation panel.</td></tr></table>',
    questions: ['How do I enable Supercruise Assist?', 'How do I use Supercruise Assist with manual throttle?'],
    firstAnswer: {
      answer: 'Select a destination in the Navigation panel and enable Supercruise Assist.',
      support: [/Select a destination in the Navigation panel/iu, /enable Supercruise Assist/iu]
    },
    answer: 'Select the destination in the Navigation panel, enable Supercruise Assist, and set manual throttle in the blue zone.',
    support: [/Navigation panel/iu, /enable Supercruise Assist/iu, /manual throttle enabled/iu, /blue zone/iu]
  },
  {
    id: 'hollow-stag', game: 'Hollow Knight', topic: 'Forgotten Crossroads Stag Station',
    reference: 'https://hollowknight.wiki/w/Stagways', tags: [...unfamiliar, 'layout'],
    body: '<h1>Forgotten Crossroads Stag Station guide</h1><div class="mw-parser-output"><h2>Forgotten Crossroads Stag Station</h2><p>Forgotten Crossroads Stag Station is a location in Hollow Knight. Pay 50 Geo at the toll machine to unlock the Forgotten Crossroads Stag Station. Ring the bell to call the Stag.</p></div>',
    questions: ['How do I unlock the Forgotten Crossroads Stag Station?', 'How much Geo unlocks the Forgotten Crossroads Stag Station?'],
    answer: 'Pay 50 Geo at the Forgotten Crossroads toll machine, then ring the bell to call the Stag.',
    support: [/Pay 50 Geo at the toll machine/iu, /Ring the bell/iu]
  },
  {
    id: 'spire-smith', game: 'Slay the Spire', topic: 'Rest Site Smith',
    reference: 'https://slay-the-spire.fandom.com/wiki/Rest_Site', tags: unfamiliar,
    body: '<p>In the game Slay the Spire, the Rest Site presents a choice of actions. ' + restFact + '</p>',
    questions: ['How do I upgrade a card at a Rest Site?', 'What does Smith do at a Rest Site?'],
    answer: 'At a Rest Site, choose Smith and confirm the one card you want to upgrade.',
    support: [/select Smith/iu, /one card to upgrade/iu]
  },
  {
    id: 'monster-equipment', game: 'Monster Hunter: World', topic: 'Smithy',
    reference: 'https://game.capcom.com/manual/MHW/en/ps4/page/4/4', tags: unfamiliar,
    body: '<p>In the game Monster Hunter: World, visit the Smithy to strengthen your gear. Choose the weapon or armor piece you want to reinforce and pay the material costs shown by the Smithy.</p>',
    questions: ['How do I upgrade my equipment?', 'How do I strengthen my gear?'],
    answer: 'Visit the Smithy, choose the weapon or armor to reinforce, and pay the listed material costs.',
    support: [/Smithy to strengthen your gear/iu, /weapon or armor piece/iu, /material costs/iu]
  },
  {
    id: 'subnautica-scanner', game: 'Subnautica', topic: 'Scanner',
    reference: 'https://subnautica.fandom.com/wiki/Scanner_(Subnautica)', tags: [...unfamiliar, 'layout'],
    body: '<div><h2>Scanner</h2><section><p>In the game Subnautica, use the Fabricator to craft the Scanner with one Battery and one Titanium. Equip the Scanner to inspect suitable fragments and unlock recipes.</p></section></div>',
    questions: ['What materials do I need to craft the Scanner?', 'How do I make the Scanner in the Fabricator?'],
    answer: 'Use the Fabricator with one Battery and one Titanium to make the Scanner.',
    support: [/Fabricator to craft the Scanner/iu, /one Battery and one Titanium/iu],
    afterArticle: '<nav><a href="/below-zero">Subnautica: Below Zero walkthrough</a></nav>'
  },
  {
    id: 'gta-opening-wrapped-header', game: 'Grand Theft Auto IV', topic: 'The Cousins Bellic', title: 'The Cousins Bellic',
    reference: gtaReference, tags: ['known', 'layout'], progress: 'Just got off the boat.',
    body: '<header><div><span>GTA IV - Story Mission Guide</span><h1>The Cousins Bellic</h1></div></header><p>'
      + boatLead + ' ' + boatRoute + '</p>',
    questions: ['What should I do next?', 'Where do I go after the boat docks?'],
    answer: 'Get into Roman’s car and follow the yellow GPS route home to Hove Beach.',
    support: [/ship at the Liberty City docks/iu, /Roman’s car/iu, /yellow GPS route/iu, /Hove Beach/iu]
  }
];

function scenario(seed: BenchmarkSeed, index: number) {
  const id = seed.id + '-' + (index + 1);
  const url = 'https://synthetic-guide-benchmark.example/' + id;
  const expected = index === 0 && seed.firstAnswer ? seed.firstAnswer : seed;
  return {
    id, game: seed.game, question: seed.questions[index], progressPoint: seed.progress,
    pages: [{ url, title: seed.title ?? seed.game + ' ' + seed.topic + ' guide',
      body: seed.body, includeTitleHeading: !seed.body.includes('<h1>'), afterArticle: seed.afterArticle }],
    claims: [{ url, draft: expected.answer, answerProbe: new RegExp(expected.answer.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'iu'), support: expected.support }]
  };
}

const adversarial = (id: string, index: number, body: string, input: {
  title?: string; question?: string; progress?: string; layout?: string; truncate?: boolean; platform?: string; edition?: string;
} = {}) => {
  const seed = seeds[index];
  const fixture = scenario({ ...seed, body, id: 'negative-' + id,
    ...(input.title ? { title: input.title } : {}), ...(input.question ? { questions: [input.question] } : {}),
    ...(input.progress ? { progress: input.progress } : {}), ...(input.layout ? { afterArticle: input.layout } : {}) }, 0);
  return { tags: ['adversarial', id], expected: false, scenario: fixture, reference: seed.reference,
    truncate: input.truncate, platform: input.platform, edition: input.edition };
};
const foreignOpening = '<header><div>GTA IV - Story Mission Guide</div><h1>The Cousins Bellic</h1></header>';
const negativeGta = (id: string, lead: string) => adversarial(id, 0, foreignOpening + '<p>' + lead + '</p>');
export const gamingGeneralizationCases = [
  ...seeds.flatMap(seed => seed.questions.map((_, index) => ({
    expected: true, tags: [...seed.tags, ...(index === 1 || seed.id === 'elden-gear' ? ['wording-variation'] : [])],
    reference: seed.reference, scenario: scenario(seed, index), truncate: false, platform: undefined, edition: undefined
  }))),
  adversarial('wrong-game', 7, '<p>In the game No Man’s Sky, a Scanner reads terrain and nearby minerals. Use that Scanner to look for the minerals on the current world.</p>'),
  adversarial('wrong-installment', 8, '<p>In the game Subnautica: Below Zero, use the Fabricator to craft the Scanner with one Battery and one Titanium.</p>'),
  adversarial('wrong-mechanic', 5, '<p>In the game Hollow Knight, the Dirtmouth Stag Station uses the bell. No Forgotten Crossroads Stag Station instructions are provided.</p>'),
  adversarial('platform', 0, foreignOpening + '<aside><p>This walkthrough applies only to Xbox 360.</p></aside><p>' + boatLead + '</p><p>' + boatRoute + '</p>', { platform: 'PC' }),
  adversarial('edition', 2, '<p>Edition: Shadow of the Erdtree.</p><p>In the game Elden Ring, reinforce your armaments with Smithing Stones at the smithing table.</p>', { edition: 'base game' }),
  adversarial('dlc', 2, seeds[2].body, { question: 'How do I upgrade gear in the DLC?' }),
  adversarial('contradictory-ownership', 3, '<p>Blade Combo is a mechanic in Xenoblade Chronicles 2. ' + bladeFact + '</p><p>In the game Xenoblade Chronicles 3, all the procedures in this guide apply to that game.</p>'),
  negativeGta('quoted', 'A reader quoted “Niko climbs off the boat in Liberty City with Roman and immediately follows the yellow GPS route.”'),
  negativeGta('negated', 'Niko never gets off the boat in Liberty City with Roman. No opening drive is described.'),
  negativeGta('hypothetical', 'If Niko gets off the boat in Liberty City with Roman, he would follow the yellow GPS route.'),
  negativeGta('planned', 'Niko plans to step off the boat in Liberty City to meet Roman and follow the yellow GPS route later.'),
  negativeGta('different-actor', 'A sailor steps off the boat in Liberty City while Niko waits beside Roman.'),
  negativeGta('locative', 'Niko steps off a platform overlooking the boat in Liberty City with Roman.'),
  adversarial('cross-article', 0, '<h1>The Cousins Bellic</h1><p>Follow the yellow GPS route to the destination.</p>',
    { layout: '<article>' + foreignOpening + '<p>' + boatLead + '</p></article>' }),
  adversarial('search-snippet', 0, '<p>The publisher preview contains no walkthrough or usable instructions.</p>'),
  adversarial('chronology', 0, foreignOpening + '<p>Niko walks beside Roman at the Liberty City docks after arriving on foot. Follow the yellow GPS route to Roman’s apartment.</p>'),
  adversarial('false-progress', 0, foreignOpening + '<p>' + boatLead + '</p>', { progress: 'Suppose I got off the boat, but I have not disembarked.' }),
  adversarial('partial-multipart', 8, '<p>In the game Subnautica, the Scanner requires one Battery and one Titanium at the Fabricator.</p>',
    { question: 'What materials do I need to craft the Scanner, and where can I find the Battery materials?' }),
  adversarial('upgrade-without-method', 7, '<p>In the game Monster Hunter: World, you can upgrade equipment. This article discusses regional editions and menu presentation.</p>'),
  adversarial('upgrade-wrong-object', 7, '<p>In the game Monster Hunter: World, upgrade your house by talking to the housekeeper. This guide does not describe equipment.</p>'),
  adversarial('ambiguous-boss', 5, '<p>In the game Hollow Knight, visit the station after the encounter has ended. The encounter is unnamed in the guide.</p>',
    { question: 'Where should I go after the first boss?' }),
  adversarial('truncated', 0, seeds[0].body, { truncate: true })
];
