import { describe, expect, it, jest } from '@jest/globals';

import {
  assertBackstageBookerFinalCompactOutputValid,
  buildBackstageBookerStructuredOutputRetryInstruction,
  hasBackstageCompleteBookingContainerComponentCountRequest,
  hasBackstageExplicitCompactOutputRequest,
  hasBackstageExplicitTopLevelCompactItemCount,
  parseBackstageDirectAnswerOutputContract,
  resolveBackstageCompactOutputContract,
  runBackstageBookerCompactOutputAttempts,
  shouldUseBackstageBookerCompactOutputMode,
  type BackstageCompactOutputAttemptEvent,
} from '../src/shared/backstage/backstageCompactOutputContract.js';

function lengthExhaustion(privatePartial: string): Error {
  return Object.assign(new Error(privatePartial), {
    code: 'OPENAI_COMPLETION_INCOMPLETE',
    finishReason: 'length',
    incompleteReason: 'max_output_tokens',
    outputText: privatePartial,
  });
}

describe('Backstage compact output count semantics', () => {
  it('keeps nested alternative cards structured while compact lists stay compact', () => {
    const nestedPrompt =
      'Answer directly. Give me three short alternative cards with eight matches each.';
    const nestedContract = resolveBackstageCompactOutputContract(
      nestedPrompt,
      2_400
    );
    expect(shouldUseBackstageBookerCompactOutputMode(
      nestedPrompt,
      nestedContract,
      true
    )).toBe(false);

    const compactPrompt = 'Give me three short alternative cards.';
    const compactContract = resolveBackstageCompactOutputContract(
      compactPrompt,
      2_400
    );
    expect(shouldUseBackstageBookerCompactOutputMode(
      compactPrompt,
      compactContract,
      false
    )).toBe(true);
  });

  it('enforces malformed compact output on a successful first attempt', () => {
    const contract = resolveBackstageCompactOutputContract(
      'Give me at most four finish options for Raw.',
      2_400
    );

    expect(() => assertBackstageBookerFinalCompactOutputValid(
      'Rivalry matrix output',
      contract,
      {
        compactDirectResponse: true,
        enforceParsedItemContract: true,
        usedCompactOutputRetry: false,
      }
    )).toThrow(expect.objectContaining({
      code: 'BACKSTAGE_BOOKER_OUTPUT_INCOMPLETE',
      retryable: false,
    }));
  });

  it.each([
    'Answer directly. Give me one complete Raw card.',
    'Answer directly. Give me two complete Raw cards as independent alternatives.',
  ])('does not treat a wrestling card as one compact output item: %s', prompt => {
    expect(parseBackstageDirectAnswerOutputContract(prompt)).toEqual({
      requiresShortBullets: false,
    });
    expect(resolveBackstageCompactOutputContract(prompt, 6_000).itemPolicy)
      .toEqual({ mode: 'default', count: 8, budgetItemCount: 8 });
  });

  it('honors an explicit compact bullet contract attached to a complete card', () => {
    const prompt = 'Give me one complete Raw card in three short bullets.';

    expect(parseBackstageDirectAnswerOutputContract(prompt)).toEqual({
      requestedBulletCount: 3,
      requestedBulletCountMode: 'exact',
      requiresShortBullets: true,
    });
    expect(hasBackstageCompleteBookingContainerComponentCountRequest(prompt))
      .toBe(false);
    expect(hasBackstageExplicitCompactOutputRequest(prompt)).toBe(true);
  });

  it.each([
    'Give me one complete Raw card with six matches and two segments.',
    'Give me one complete Raw card with no more than six matches.',
    'Book a complete six-match Raw card with two segments.',
    'Book a six-match complete Raw card with two segments.',
    'Create a full show featuring three matches and two promos.',
    'Schedule an entire event with two bouts and one closing angle.',
    'Give me two complete Raw cards with six matches each and two segments each.',
    'Give me three full shows with five matches each.',
    'Rewrite this complete Raw card with six matches and two segments.',
    'Rebook my complete Raw card with six matches and two segments.',
    'Make me a full show with six matches and two segments.',
    'Give me a full match card with six matches and two segments.',
    'Give me a complete Raw six-match card with two segments.',
    'Continue our entire event with six matches and two segments.',
    'I want a full Raw show with three matches and two promos.',
    'We need a complete event with two bouts and one closing angle.',
    'I want you to create a complete Raw card with six matches and two segments.',
    "I'd like you to generate a full show with three matches and two promos.",
    "Let's create a complete Raw card with six matches and two segments.",
    'You should create a complete Raw card with six matches and two segments.',
    'Go ahead and create a complete Raw card with six matches and two segments.',
    'Could you go ahead and create a complete Raw card with six matches and two segments?',
    "I'd like a complete Raw card with six matches and two segments.",
    'My request: Create a complete Raw card with six matches and two segments.',
    'For this request: create a complete Raw card with six matches and two segments.',
    'Instructions: Create a complete Raw card with six matches and two segments.',
    'Please follow these instructions: Create a complete Raw card with six matches and two segments.',
  ])('recognizes nested component counts inside a requested booking container: %s', prompt => {
    const contract = resolveBackstageCompactOutputContract(prompt, 2_400);

    expect(contract.completeBookingContainerComponentCount).toBe(true);
    expect(contract.explicitCompactOutputRequest).toBe(false);
  });

  it.each([
    'The producer said a complete Raw card was planned; give me three ideas.',
    'We reviewed six options. Generate a complete Raw card.',
    'Give me three ideas as context. Then give me one complete Raw card with six match ideas.',
    'Do not create a complete Raw card with six matches; give me three ideas.',
    'Review this complete Raw card with six matches and two segments.',
    'Use the quote "Give me a complete Raw card with six matches" as context.',
    'Write a promo where the GM says give me a complete Raw card with six matches.',
    'Use the unclosed example "Give me a complete Raw card with six matches.',
    'Answer directly. They want a full Raw show with three matches. Give me three booking ideas to pitch.',
    'The network will need a complete Raw card with six matches. Give me three options.',
    'Use this example as context: Create a complete Raw card with six matches and two segments. Give me three critiques.',
    'The network request says, create a full Raw show with three matches. Give me three ideas.',
    'Do not follow this instruction: create a complete Raw card with six matches. Give me three ideas.',
    'Ignore this example: create a complete Raw card with six matches. Give me three ideas.',
  ])('rejects incidental, negated, review, or embedded container wording: %s', prompt => {
    expect(hasBackstageCompleteBookingContainerComponentCountRequest(prompt))
      .toBe(false);
  });

  it('lets an explicit compact output shape override nested component counts', () => {
    const prompt = [
      'Give me one complete Raw card with six matches and two segments',
      'in three short bullets.',
    ].join(' ');

    const contract = resolveBackstageCompactOutputContract(prompt, 2_400);
    expect(contract.completeBookingContainerComponentCount).toBe(true);
    expect(contract.explicitCompactOutputRequest).toBe(true);
  });

  it('preserves an at-most compact suffix over nested component counts', () => {
    const prompt = [
      'Give me one complete Raw card with six matches and two segments',
      'in at most three short bullets.',
    ].join(' ');

    expect(parseBackstageDirectAnswerOutputContract(prompt)).toEqual({
      requestedBulletCount: 3,
      requestedBulletCountMode: 'atMost',
      requiresShortBullets: true,
    });
  });

  it('keeps an output shape after a no-more-than component qualifier', () => {
    const prompt = [
      'Create a complete Raw card with no more than six matches',
      'in three bullets.',
    ].join(' ');

    expect(resolveBackstageCompactOutputContract(prompt, 2_400)).toMatchObject({
      completeBookingContainerComponentCount: true,
      explicitCompactOutputRequest: true,
      itemPolicy: { mode: 'exact', count: 3, budgetItemCount: 3 },
    });
  });

  it.each([
    'Keep it to at most three short bullets.',
    'No more than three short bullets.',
    'Limit the response to three short bullets.',
  ])('recognizes a relational container output cap: %s', suffix => {
    const prompt = [
      'Give me one complete Raw card with six matches and two segments.',
      suffix,
    ].join(' ');

    expect(parseBackstageDirectAnswerOutputContract(prompt)).toEqual({
      requestedBulletCount: 3,
      requestedBulletCountMode: suffix.includes('three short bullets')
        && !suffix.startsWith('Limit')
        ? 'atMost'
        : 'exact',
      requiresShortBullets: true,
    });
  });

  it('does not reuse an earlier contextual compact count as the container output shape', () => {
    const contract = resolveBackstageCompactOutputContract(
      [
        'Give me three ideas as context.',
        'Then give me one complete Raw card with six matches and two segments.',
      ].join(' '),
      2_400
    );

    expect(contract.completeBookingContainerComponentCount).toBe(true);
    expect(contract.explicitCompactOutputRequest).toBe(false);
  });

  it('does not reuse a later independent compact request as the container presentation', () => {
    const contract = resolveBackstageCompactOutputContract(
      [
        'Give me one complete Raw card with six matches and two segments.',
        'Then give me three booking ideas.',
      ].join(' '),
      2_400
    );

    expect(contract.completeBookingContainerComponentCount).toBe(true);
    expect(contract.explicitCompactOutputRequest).toBe(false);
    expect(contract.itemPolicy.mode).toBe('preserve');
  });

  it.each([
    [
      'Give me a complete Raw card with six matches and two segments. Book the main-event finish in three scenarios based on the winner.',
      'three scenarios',
    ],
    [
      'Give me a complete Raw card with six matches and two segments. Work the closing promo using three bullets in the script.',
      'three bullets',
    ],
    [
      'Give me a complete Raw card with six matches and two segments; the main-event finish branches in three scenarios based on the winner.',
      'three scenarios',
    ],
    [
      'Give me a complete Raw card with six matches and two segments, with the closing promo using three bullets in its script.',
      'three bullets',
    ],
    [
      'Give me a complete Raw card with six matches and two segments, where the finish plays out in three scenarios.',
      'three scenarios',
    ],
    [
      'Give me a complete Raw card with six matches and two segments. No more than three scenarios should be used for the main-event finish.',
      'three scenarios',
    ],
    [
      'Give me a complete Raw card with six matches and two segments. At most three bullets should appear in the closing promo script.',
      'three bullets',
    ],
    [
      'Give me a complete Raw card with six matches and two segments, ending in three scenarios.',
      'three scenarios',
    ],
    [
      'Give me a complete Raw card with six matches and two segments, which can unfold in three scenarios.',
      'three scenarios',
    ],
  ])('does not attach an unrelated later presentation count: %s', prompt => {
    const contract = resolveBackstageCompactOutputContract(prompt, 2_400);

    expect(contract.completeBookingContainerComponentCount).toBe(true);
    expect(contract.explicitCompactOutputRequest).toBe(false);
    expect(contract.itemPolicy.mode).toBe('preserve');
  });

  it.each([
    'Give me a complete Raw card with six matches in six bullets—actually make that three.',
    'Give me a complete Raw card with six matches in three bullets and four options.',
  ])('keeps a conflicting container presentation conservative: %s', prompt => {
    const contract = resolveBackstageCompactOutputContract(prompt, 2_400);

    expect(contract.completeBookingContainerComponentCount).toBe(true);
    expect(contract.explicitCompactOutputRequest).toBe(false);
    expect(contract.itemPolicy.mode).toBe('preserve');
  });

  it('recognizes an explicit response anaphora in the immediately following clause', () => {
    const prompt = [
      'Give me a complete Raw card with six matches and two segments.',
      'Return it in at most three short bullets.',
    ].join(' ');

    expect(parseBackstageDirectAnswerOutputContract(prompt)).toEqual({
      requestedBulletCount: 3,
      requestedBulletCountMode: 'atMost',
      requiresShortBullets: true,
    });
  });

  it.each([
    'in three short bullets, each covering two matches.',
    'in three short bullets, each covering two matches and one segment.',
    'in three short bullets, each with two matches.',
    'in three short bullets, one per section.',
    'in three short bullets total.',
    'in three short bullets and no table.',
    'in three short bullets and be concise.',
  ])('keeps a bounded output-only modifier attached to the compact shape: %s', suffix => {
    const prompt = [
      'Give me a complete Raw card with six matches and two segments',
      suffix,
    ].join(' ');

    expect(parseBackstageDirectAnswerOutputContract(prompt)).toMatchObject({
      requestedBulletCount: 3,
      requestedBulletCountMode: 'exact',
    });
    expect(hasBackstageExplicitCompactOutputRequest(prompt)).toBe(true);
  });

  it('treats a trailing max as an explicit maximum compact shape', () => {
    const prompt = [
      'Give me a complete Raw card with six matches and two segments',
      'in three short bullets max.',
    ].join(' ');

    expect(parseBackstageDirectAnswerOutputContract(prompt)).toMatchObject({
      requestedBulletCount: 3,
      requestedBulletCountMode: 'atMost',
    });
    expect(hasBackstageExplicitCompactOutputRequest(prompt)).toBe(true);
  });

  it('keeps a following relational output modifier attached to the compact shape', () => {
    const prompt = [
      'Give me a complete Raw card with six matches and two segments.',
      'Keep it to three bullets and be concise.',
    ].join(' ');

    expect(parseBackstageDirectAnswerOutputContract(prompt)).toMatchObject({
      requestedBulletCount: 3,
      requestedBulletCountMode: 'exact',
    });
  });

  it.each([
    'Give me six options, actually make that three.',
    'Do not give me six options; give me three instead.',
    'Give me three options for Raw and four options for SmackDown.',
  ])('retains standalone ambiguous compact-count handling: %s', prompt => {
    expect(resolveBackstageCompactOutputContract(prompt, 2_400).itemPolicy.mode)
      .toBe('preserve');
  });

  it('builds structured recovery without converting component counts to top-level items', () => {
    const instruction = buildBackstageBookerStructuredOutputRetryInstruction();

    expect(instruction).toContain('Preserve every requested card, show, or event component');
    expect(instruction).toContain('counts as component requirements');
    expect(instruction).not.toContain('one compact paragraph per item');
    expect(instruction).not.toContain('Stop after item');
  });

  it.each([
    ['Give me 1 short bullet.', 1, true],
    ['Give me 3 booking ideas.', 3, false],
    ['Give me 5 possible matches.', 5, false],
    ['Give me 4 finish options.', 4, false],
    ['Give me three short alternative cards.', 3, false],
    ['Give me 6 options.', 6, false],
  ] as const)('preserves genuine compact request %s', (prompt, count, short) => {
    expect(parseBackstageDirectAnswerOutputContract(prompt)).toEqual({
      requestedBulletCount: count,
      requestedBulletCountMode: 'exact',
      requiresShortBullets: short,
    });
  });

  it.each([
    'Answer directly. Give me three detailed alternative cards.',
    'Answer directly. Give me three full alternative cards.',
    'Answer directly. Give me thirteen detailed alternative cards.',
    'Answer directly. Describe three detailed alternative cards.',
    'Answer directly. Outline three full alternative cards.',
    'Answer directly. What is the best way to book three detailed alternative cards?',
    'What are three detailed alternative cards I could book for Raw?',
    'What are the three full alternative cards you recommend?',
    'What does booking three detailed alternative cards require?',
    'Recommend three alternative cards.',
    'Pitch a detailed alternative card.',
    'Sketch a full alternative card.',
    'Map an alternative card with eight matches.',
    'Explain an alternative card with eight matches.',
    'Answer directly. Come up with three alternative cards.',
    'Brainstorm three alternative cards.',
    'Craft three alternative cards.',
    'Prepare three alternative cards.',
    'Devise three alternative cards.',
    'Put together three alternative cards.',
    'Invent three alternative cards.',
    'Can you come up with three alternative cards?',
    'Answer directly. Can I get three alternative cards?',
    'Could I have three alternative cards?',
    'Could you get me three alternative cards?',
    'Could we see three alternative cards?',
    "I'd like three alternative cards.",
    "I'd love to see three alternative cards.",
    'I would love to see three alternative cards.',
    'Let me see three alternative cards.',
    'How about three alternative cards?',
    'What about three alternative cards?',
    'How about an alternative card?',
    'What about an alternative card?',
    'Could you get me an alternative card?',
    "I'd love to see an alternative card.",
    'Could we see an alternative card?',
    'Let me see an alternative card.',
    'Could we try an alternative card?',
    "Let's do an alternative card.",
    'Maybe an alternative card?',
    'Send me an alternative card.',
    'Show me three alternative cards.',
    'List three alternative cards.',
    'My request is three alternative cards.',
    'Three alternative cards were mentioned by John, but fully book them.',
    'An alternative card was mentioned by John; instead build it fully.',
    'Three alternative cards, please.',
    'Three alternative cards for Raw, please.',
    'Three alternative cards—build them fully.',
    'Three alternative cards would be great.',
    'Three alternative cards would help.',
    'Three alternative cards are needed.',
    'Three alternative cards should be generated.',
    'Three alternative cards should be booked.',
    'Three alternative cards should be fully booked.',
    'Three alternative cards should all be fully booked.',
    'Three alternative cards should be professionally booked.',
    'Three alternative cards must be completely developed.',
    'Three alternative cards should be carefully drafted.',
    'Three alternative cards must actually be booked.',
    'Three alternative cards ought to be booked.',
    'Three alternative cards have to be booked.',
    'Three alternative cards shall be booked.',
    'Three alternative cards are to be fully booked.',
    'Three alternative cards will need to be booked.',
    'Three alternative cards would need full lineups.',
    'Three alternative cards ought each to contain eight matches.',
    'Three alternative cards must each include a full lineup.',
    'Three alternative cards should consist of eight matches.',
    'Three alternative cards need booking.',
    'Three alternative cards need to be booked.',
    'Three alternative cards require full booking.',
    'Three alternative cards require complete lineups.',
    'Three alternative cards deserve a full booking.',
    'An alternative card deserves a full booking.',
    'Three alternative cards are exactly what I need.',
    'Three alternative cards are precisely what I want.',
    'Three alternative cards are all I want.',
    "Three alternative cards are what I’d like.",
    "Three alternative cards are all that I'd like.",
    'Three alternative cards are the cards I need.',
    'Three alternative cards are exactly the output I need.',
    'Three alternative cards are my requested output.',
    'Three alternative cards are the exact cards I want.',
    "Three alternative cards are the output we’d like.",
    'Three alternative cards—can you book them?',
    'Three alternative cards—could you fully book each one?',
    'Three alternative cards—could you turn them into complete bookings?',
    'Three alternative cards—would you flesh them out?',
    "Three alternative cards—I’d like you to book them.",
    'Three alternative cards—can you book all three?',
    'Three alternative cards—book every one.',
    'Three alternative cards—develop all three.',
    'Three alternative cards—would you mind booking them?',
    'Three alternative cards—book the whole set.',
    'Three alternative cards—flesh out the trio.',
    'Three alternative cards, if possible.',
    'Three alternative cards, if you can.',
    'Three alternative cards, ideally.',
    'Three alternative cards, preferably.',
    'Three alternative cards, one per brand.',
    'Three alternative cards, one to a brand.',
    'Three alternative cards, one apiece.',
    'Three alternative cards, a different one for each brand.',
    'Three alternative cards, one themed for each brand.',
    'Three alternative cards, one for Raw, one for SmackDown, and one for NXT.',
    'Three alternative cards: Raw power struggle, SmackDown title chase, NXT breakout.',
    'Three alternative cards: Raw power struggle; SmackDown title chase; NXT breakout.',
    'Three alternative cards: Raw power struggle / SmackDown title chase / NXT breakout.',
    'Three alternative cards—Raw power struggle, SmackDown title chase, NXT breakout.',
    'Three alternative cards (one per brand).',
    'Three alternative cards for Raw.',
    'If possible, three alternative cards for Raw.',
    'If you can, three alternative cards with full lineups.',
    'As a starting point, three alternative cards for Raw.',
    'For Raw, three alternative cards with different champions.',
    'To begin, three alternative cards featuring Cody Rhodes.',
    'Three alternative cards for SmackDown, NXT, and Raw.',
    'Three alternative cards across all three brands.',
    'Three alternative cards split across Raw, SmackDown, and NXT.',
    'Three alternative cards divided among the brands.',
    'Three alternative cards with different champions.',
    'Three alternative cards with different winners.',
    'Three alternative cards with escalating stakes.',
    'Three alternative cards with fresh opponents.',
    'Three alternative cards with no repeated wrestlers.',
    'Three alternative cards featuring Cody Rhodes, Gunther, and CM Punk.',
    'Three alternative cards featuring champions who need wins.',
    'Three alternative cards built around Cody Rhodes.',
    'Three alternative cards built around wrestlers who have history.',
    'Three alternative cards based on the current champions.',
    'Three alternative cards containing unique concepts.',
    'Three alternative cards where every match matters.',
    'Three alternative cards in which each match advances a storyline.',
    'Three alternative cards with a different creative direction.',
    'Three alternative cards containing storylines would be great.',
    'Three alternative cards consisting of eight matches would help.',
    'An alternative card would help.',
    'An alternative card is needed.',
    'An alternative card needs to be booked.',
    'An alternative card is exactly what I need.',
    'An alternative card—could you build it?',
    'It would help to have three alternative cards.',
    'It would help to have an alternative card.',
    'It would be great to have three alternative cards.',
    'Have John create three alternative cards.',
    'Ask John to draft three alternative cards.',
    'Please have the team create three alternative cards.',
    'Let John draft three alternative cards.',
    'Get John to generate three alternative cards.',
    'Tell John to build three alternative cards.',
    'Deliver three alternative cards.',
    'Assemble three alternative cards.',
    'Formulate three alternative cards.',
    'Frame three alternative cards.',
    'Give me three numbered alternative cards.',
    'Give me three numbered full alternative cards.',
    'Give me three alternative cards, each with a full match lineup, storyline beats, finishes, and consequences.',
    'Give me three short alternative cards, each with eight matches.',
    'Give me three concise alternative cards, each containing eight matches.',
    'Answer directly. Give me three concise alternative cards with eight fights each.',
    'Answer directly. Give me three short alternative cards with an undercard and main event each.',
    'Give me three short alternative cards. Each has eight matches.',
    'Give me three short alternative cards. Each card includes a full match lineup and storyline beats.',
    'Give me three short alternative cards. For each, include eight matches.',
    'Give me three short alternative cards. Then include eight matches in each card.',
    'Give me three short alternative cards. Include eight matches per card.',
    'Give me three short alternative cards. Put eight matches on every card.',
    'Give me three short alternative cards. Eight matches should go on each card.',
    'Give me three short alternative cards. They should each include eight matches.',
    'Give me three short alternative cards. Make sure every one includes eight matches.',
    'Give me three short alternative cards. Make them distinct. Each card should include eight matches.',
    'Give me three short alternative cards, but do not make them compact.',
    'Give me three short alternative cards with matches, angles, finishes, and consequences.',
    'Give me three concise alternative cards containing matches, storylines, and finishes.',
    'Give me three short alternative cards comprising matches, stories, and finishes.',
    'Give me three short alternative cards consisting of matches, stories, and finishes.',
    'Give me three short alternative cards made up of matches, stories, and finishes.',
    'Give me three short alternative cards built around matches, stories, and finishes.',
    'Give me three short alternative cards: matches, storylines, and finishes in each.',
    'Give me three short alternative cards. All three should include eight matches.',
    'Give me three short alternative cards. Each of them should include matches, stories, and finishes.',
    'Give me three short alternative cards. Make them distinct. Use a different theme for each. Each should include eight matches.',
    'Answer directly. Give me three short alternative cards, plus matches, storylines, finishes, and consequences for each.',
    'Answer directly. Give me three short alternative cards—matches, finishes, and consequences for each.',
    'Give me three short alternative cards. Matches, angles, and finishes for each.',
    'Give me three short alternative cards. Eight matches apiece.',
    'Give me three short alternative cards. They should include a match lineup, angles, and finishes.',
    'Give me three short alternative cards. Every one needs a lineup.',
    'Give me three short alternative cards. All of them need a lineup.',
    'Give me three short alternative cards. Each one consists of a lineup.',
    'Give me three short alternative cards. Do not summarize; fully book each one.',
    "Don't just explain three alternative cards; book them with matches, stories, and finishes.",
    'Do not merely list three alternative cards; build them with lineups and finishes.',
    'I do not want summaries of three alternative cards; write the actual bookings.',
    'Do not only summarize three alternative cards; flesh them out into actual bookings.',
    'Do not summarize three alternative cards; instead fully develop them.',
    'Do not just list three alternative cards; instead actually build them into complete bookings.',
    'Do not merely explain three alternative cards; instead really flesh them out.',
    'Do not summarize an alternative card; instead fully develop it.',
    'Do not merely explain three alternative cards; instead give the cards a full booking.',
    'Do not summarize an alternative card; instead give it a full booking.',
    'Give me a short alternative card. It should include eight matches.',
    'Give me a short alternative card. This should include matches, stories, and finishes.',
    'Give me a short alternative card. It is made up of matches, stories, and finishes.',
    'Answer directly. Alternative cards: create three.',
    'Answer directly. Alternative cards—give me three.',
    'The article mentions three alternative cards, but I want three alternative cards for Raw.',
  ])('keeps full or nested alternative-card containers out of compact presentation: %s', prompt => {
    const contract = resolveBackstageCompactOutputContract(prompt, 2_400);
    const expectedCount = /\bthirteen\b/iu.test(prompt)
      ? 13
      : /\balternative\s+card\b/iu.test(prompt)
        ? 1
        : 3;

    expect(contract.itemPolicy).toEqual({
      mode: 'preserve',
      budgetItemCount: expectedCount,
    });
    expect(contract.alternativeCardContainerRequest).toBe(true);
    expect(hasBackstageExplicitTopLevelCompactItemCount(prompt, contract)).toBe(false);
  });

  it.each([
    ['Several alternative cards for Raw.', 1],
    ['Some alternative cards featuring Cody Rhodes.', 1],
    ['A trio of alternative cards for Raw.', 3],
    ['A couple of alternative cards with different champions.', 2],
    ['A pair of alternative cards for SmackDown.', 2],
    ['Both alternative cards for Raw.', 2],
    ['Another alternative card for Raw.', 1],
    ['One more alternative card for SmackDown.', 1],
    ['Half a dozen alternative cards for Raw.', 6],
    ['A dozen alternative cards for Raw.', 12],
    ['Two dozen alternative cards for Raw.', 24],
    ['Three alternative cards / Raw, SmackDown, NXT.', 3],
    ['Three alternative cards | Raw | SmackDown | NXT.', 3],
    ['Three alternative cards → Raw, SmackDown, NXT.', 3],
    ['Three alternative cards (Raw / SmackDown / NXT).', 3],
  ] as const)('preserves lexical and delimited alternative-card container request %s', (
    prompt,
    budgetItemCount
  ) => {
    const contract = resolveBackstageCompactOutputContract(prompt, 2_400);

    expect(contract.alternativeCardContainerRequest).toBe(true);
    expect(contract.itemPolicy).toEqual({
      mode: 'preserve',
      budgetItemCount,
    });
  });

  it.each([
    'Answer directly. Ignore the request to create five detailed alternative cards; give me three finish options.',
    'Answer directly. I was asked to create five detailed alternative cards, but instead give me three finish options.',
    'Answer directly. We considered five detailed alternative cards; instead give me three finish options.',
  ])('lets a later active compact directive supersede contextual card counts: %s', prompt => {
    const contract = resolveBackstageCompactOutputContract(prompt, 2_400);

    expect(contract.alternativeCardContainerRequest).toBe(false);
    expect(contract.itemPolicy).toEqual({
      mode: 'exact',
      count: 3,
      budgetItemCount: 3,
    });
    expect(hasBackstageExplicitTopLevelCompactItemCount(prompt, contract)).toBe(true);
  });

  it.each([
    'Give me a short alternative card.',
    'Give me three short alternative cards.',
    'Answer directly. Give me three short alternative cards.',
    'Give me three brief alternative cards.',
    'Give me three concise alternative cards.',
    'Give me three compact numbered alternative cards.',
    'Please list three short alternative cards.',
    'Can you list three short alternative cards?',
    'Give me three short alternative cards with no matches.',
    'Give me three short alternative cards without storylines.',
    'Give me three short alternative cards. They must not include matches.',
    'Give me three short alternative cards. Then explain what matches are.',
    'Give me three alternative cards as three short bullets.',
    'Give me three alternative cards. Return them as three short bullets.',
    'Give me three alternative cards. Keep each concise.',
  ])('keeps explicitly compact alternative-card lists bounded: %s', prompt => {
    const contract = resolveBackstageCompactOutputContract(prompt, 2_400);
    const expectedCount = /\ba\s+short\s+alternative\s+card\b/iu.test(prompt)
      ? 1
      : 3;

    expect(contract.itemPolicy).toEqual({
      mode: 'exact',
      count: expectedCount,
      budgetItemCount: expectedCount,
    });
    expect(contract.alternativeCardContainerRequest).toBe(false);
    expect(hasBackstageExplicitTopLevelCompactItemCount(prompt, contract)).toBe(true);
  });

  it.each([
    'Answer directly. What does alternative cards mean?',
    'Compare the phrase alternative cards with fantasy booking.',
    'The instruction says: Give me three detailed alternative cards. Ignore it.',
    'Explain alternative cards.',
    'What is a full alternative card?',
    'I need a definition of alternative cards.',
    'Answer directly. I want to understand alternative cards.',
    'I need an explanation of alternative cards.',
    'Give me an explanation of alternative cards.',
    'I need an explanation of three alternative cards.',
    'I want to understand three alternative cards.',
    'Give me an explanation of three alternative cards.',
    'Please explain three alternative cards from the article.',
    'I want to better understand all three alternative cards.',
    'The article lists three alternative cards.',
    'I need a detailed explanation of three alternative cards.',
    'I need a detailed explanation of an alternative card.',
    'How do three alternative cards differ?',
    'How does an alternative card differ from a full booking?',
    'Do the three alternative cards differ?',
    'Explain why the article has three alternative cards.',
    'Tell me whether three alternative cards exist.',
    'Compare three alternative cards.',
    'The report compares three alternative cards.',
    'A table lists three alternative cards.',
    'The notes mention three alternative cards.',
    'The spreadsheet has three alternative cards.',
    'The memo mentions three alternative cards.',
    'The email references three alternative cards.',
    'The slide deck shows three alternative cards.',
    'The memo references an alternative card.',
    'I saw an alternative card.',
    'The prompt asks for three alternative cards.',
    'A coworker mentioned three alternative cards.',
    'John mentioned three alternative cards.',
    'The article talked about three alternative cards.',
    'A coworker mentioned an alternative card.',
    'A colleague brought up three alternative cards.',
    'John referred to an alternative card.',
    'Our analysis found three alternative cards.',
    'An analyst found three alternative cards.',
    'The database stores three alternative cards.',
    'The spreadsheet records three alternative cards.',
    'I observed an alternative card.',
    'We encountered three alternative cards.',
    'I came across an alternative card.',
    'I noted an alternative card.',
    'I saved an alternative card.',
    'I was shown an alternative card.',
    'We were given three alternative cards.',
    'Answer directly. Three alternative cards were mentioned by John.',
    'Three alternative cards were discussed by the team.',
    'Three alternative cards were described in the report.',
    'Three alternative cards were found in the archive.',
    'Three alternative cards have been listed.',
    'Three alternative cards are shown below.',
    'An alternative card was mentioned by John.',
    'Three alternative cards were suggested by the article.',
    'Three alternative cards were proposed in the meeting.',
    'Three alternative cards were generated earlier.',
    'Three alternative cards were attached to the email.',
    'Three alternative cards were reviewed yesterday.',
    'Three alternative cards caught my attention.',
    'Three alternative cards came up in the meeting.',
    'Three alternative cards seem promising.',
    'Three alternative cards resulted from the exercise.',
    'Three alternative cards await review.',
    'Three alternative cards already exist.',
    'Three alternative cards surfaced in our search.',
    'Three alternative cards emerged from the workshop.',
    'Three alternative cards belong to the old plan.',
    'Three alternative cards need to be compared.',
    'Three alternative cards warrant discussion.',
    'Three alternative cards look similar.',
    'Three alternative cards sound familiar.',
    'Three alternative cards caught our eye.',
    'An alternative card caught my attention.',
    'Three alternative cards should be compared.',
    'Three alternative cards should be reviewed.',
    'Three alternative cards should be analyzed.',
    'Three alternative cards should be discussed.',
    'Three alternative cards should be evaluated.',
    'Three alternative cards should be ranked.',
    'Three alternative cards should be considered.',
    'Three alternative cards should be summarized.',
    'Three alternative cards must be reviewed.',
    'Three alternative cards must be compared.',
    'Three alternative cards must have been mentioned.',
    'Three alternative cards should already have been compared.',
    'Three alternative cards must still be analyzed.',
    'Three alternative cards with eight matches each were attached.',
    'Three alternative cards with eight matches each were circulated.',
    'Three alternative cards with eight matches each circulated yesterday.',
    'Three alternative cards containing storylines were discussed.',
    'Three alternative cards containing storylines drew criticism.',
    'Three alternative cards consisting of eight matches were reviewed.',
    'Three alternative cards consisting of eight matches prompted discussion.',
    'An alternative card with eight matches was attached.',
    'Three alternative cards built around rivalries became obsolete.',
    'Three alternative cards featuring rivalries appeared yesterday.',
    'Three alternative cards containing storylines arrived yesterday.',
    'Three alternative cards containing storylines proved divisive.',
    'Three alternative cards with eight matches each won praise.',
    'Three alternative cards with eight matches each continued unchanged.',
    'Three alternative cards with eight matches each disappeared.',
    'Three alternative cards consisting of eight matches originated elsewhere.',
    'Three alternative cards consisting of eight matches originated in the workshop.',
    'Three alternative cards featuring title matches sat in the inbox.',
    'Three alternative cards with lineups eventually produced storylines.',
    'Three alternative cards built around rivalries circulated yesterday.',
    'Three alternative cards with eight matches inspired new storylines.',
    'Three alternative cards with full lineups reshaped the roster.',
    'Three alternative cards featuring title matches changed the universe.',
    'Three alternative cards containing angles influenced the rivalries.',
    'Three alternative cards built around veterans headlined the shows.',
    'Three alternative cards with chaotic finishes caused consequences.',
    'An alternative card with eight matches inspired a new storyline.',
    'Three alternative cards that featured title matches changed the universe.',
    'Three alternative cards which contained angles influenced the rivalries.',
    'She can create three alternative cards.',
    'They could provide three alternative cards.',
    'John can book three alternative cards.',
    'The team will create three alternative cards tomorrow.',
    'They may draft three alternative cards later.',
    'Our system can generate three alternative cards.',
    'John did recommend three alternative cards.',
    'A producer did propose three alternative cards.',
    'Her assistant could assemble three alternative cards.',
    'The prior worker would generate three alternative cards.',
    'Their script will return three alternative cards.',
    'Avoid creating alternative cards.',
    'Answer directly. There are three alternative cards in the article.',
    'Why are three alternative cards listed?',
    'How were three alternative cards with full lineups received?',
    'Which of the three alternative cards is best?',
    'Several alternative cards appeared in the report.',
    'Some alternative cards were reviewed yesterday.',
    'A trio of alternative cards was discussed.',
    'A pair of alternative cards was attached.',
    'Both alternative cards were compared.',
    'Another alternative card was mentioned.',
    'Half a dozen alternative cards were listed in the memo.',
    'Two dozen alternative cards existed in the archive.',
    'Alternative cards | Raw | SmackDown | NXT appeared in the notes.',
    'Three alternative cards for Raw | all previously reviewed.',
  ])('does not treat a contextual alternative-card mention as a container request: %s', prompt => {
    expect(resolveBackstageCompactOutputContract(prompt, 2_400))
      .toMatchObject({ alternativeCardContainerRequest: false });
  });

  it('keeps a negated alternative-card phrase from masking a real compact request', () => {
    const contract = resolveBackstageCompactOutputContract(
      'Without creating alternative cards, list three finish options.',
      2_400
    );

    expect(contract.alternativeCardContainerRequest).toBe(false);
    expect(contract.itemPolicy).toEqual({
      mode: 'exact',
      count: 3,
      budgetItemCount: 3,
    });
  });
});

describe('Backstage compact output attempt state machine', () => {
  it('runs exactly one eligible compact retry and reports bounded state transitions', async () => {
    const events: BackstageCompactOutputAttemptEvent[] = [];
    const runAttempt = jest
      .fn<(compactOutputRetry: boolean) => Promise<string>>()
      .mockRejectedValueOnce(lengthExhaustion('PRIVATE-FIRST-PARTIAL'))
      .mockResolvedValueOnce('1. Complete compact result.');

    await expect(runBackstageBookerCompactOutputAttempts(
      runAttempt,
      () => true,
      event => events.push(event)
    )).resolves.toEqual({
      result: '1. Complete compact result.',
      usedCompactOutputRetry: true,
    });

    expect(runAttempt.mock.calls).toEqual([[false], [true]]);
    expect(events).toEqual([
      'initial_length_exhaustion',
      'compact_retry_started',
      'compact_retry_provider_completed',
    ]);
  });

  it('does not let a throwing telemetry observer alter retry semantics', async () => {
    const runAttempt = jest
      .fn<(compactOutputRetry: boolean) => Promise<string>>()
      .mockRejectedValueOnce(lengthExhaustion('PRIVATE-FIRST-PARTIAL'))
      .mockResolvedValueOnce('1. Complete compact result.');

    await expect(runBackstageBookerCompactOutputAttempts(
      runAttempt,
      () => true,
      () => {
        throw new Error('telemetry unavailable');
      }
    )).resolves.toEqual({
      result: '1. Complete compact result.',
      usedCompactOutputRetry: true,
    });
    expect(runAttempt.mock.calls).toEqual([[false], [true]]);
  });

  it('does not retry content filtering or arbitrary provider errors', async () => {
    const contentFilter = Object.assign(new Error('filtered'), {
      code: 'OPENAI_COMPLETION_INCOMPLETE',
      finishReason: 'content_filter',
      incompleteReason: 'content_filter',
      contentFiltered: true,
    });

    for (const failure of [contentFilter, new Error('provider unavailable')]) {
      const runAttempt = jest
        .fn<(compactOutputRetry: boolean) => Promise<string>>()
        .mockRejectedValueOnce(failure);
      const events: BackstageCompactOutputAttemptEvent[] = [];

      await expect(runBackstageBookerCompactOutputAttempts(
        runAttempt,
        () => true,
        event => events.push(event)
      )).rejects.toBe(failure);
      expect(runAttempt).toHaveBeenCalledTimes(1);
      expect(events).toEqual([]);
    }
  });

  it('skips retry when the finite recovery gate is unavailable', async () => {
    const events: BackstageCompactOutputAttemptEvent[] = [];
    const runAttempt = jest
      .fn<(compactOutputRetry: boolean) => Promise<string>>()
      .mockRejectedValueOnce(lengthExhaustion('PRIVATE-SKIPPED-PARTIAL'));

    await expect(runBackstageBookerCompactOutputAttempts(
      runAttempt,
      () => false,
      event => events.push(event)
    )).rejects.toMatchObject({
      code: 'BACKSTAGE_BOOKER_OUTPUT_INCOMPLETE',
      retryable: false,
    });
    expect(runAttempt).toHaveBeenCalledTimes(1);
    expect(events).toEqual([
      'initial_length_exhaustion',
      'compact_retry_skipped_insufficient_budget',
    ]);
  });

  it('fails closed after a second length exhaustion without a third attempt or partial leak', async () => {
    const events: BackstageCompactOutputAttemptEvent[] = [];
    const runAttempt = jest
      .fn<(compactOutputRetry: boolean) => Promise<string>>()
      .mockRejectedValueOnce(lengthExhaustion('PRIVATE-FIRST-PARTIAL'))
      .mockRejectedValueOnce(lengthExhaustion('PRIVATE-RETRY-PARTIAL'));

    let failure: unknown;
    try {
      await runBackstageBookerCompactOutputAttempts(
        runAttempt,
        () => true,
        event => events.push(event)
      );
    } catch (error) {
      failure = error;
    }

    expect(runAttempt.mock.calls).toEqual([[false], [true]]);
    expect(events).toEqual([
      'initial_length_exhaustion',
      'compact_retry_started',
      'compact_retry_length_exhausted',
    ]);
    expect(failure).toMatchObject({
      code: 'BACKSTAGE_BOOKER_OUTPUT_INCOMPLETE',
      message:
        'Backstage Booker could not produce a complete response within the output limit. Narrow the request and try again.',
      retryable: false,
    });
    expect((failure as Error & { cause?: unknown }).cause).toBeUndefined();
    expect(JSON.stringify(failure)).not.toContain('PRIVATE-FIRST-PARTIAL');
    expect(JSON.stringify(failure)).not.toContain('PRIVATE-RETRY-PARTIAL');
  });
});
