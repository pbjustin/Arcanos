/** Entirely synthetic guide prose. No source text from the named game or Archive item. */
export function buildGamingLargeGuideFixture() {
  const markers = {
    early: 'Traverse Town synthetic objective A: ring the copper practice bell beside the training gate.',
    middle: 'Wonderland synthetic objective B: arrange the painted practice tiles into a silver spiral.',
    late: 'Synthetic objective C: activate the violet lantern at the imaginary Clockwork Observatory.',
    nearEnd: 'The fictional Zephyrglass Compass is hidden in the imaginary Moonlit Repository beyond the cobalt arch.'
  } as const;
  const paragraphs: string[] = [
    '# Kingdom Hearts HD 1.5 Remix — Synthetic Strategy Guide Fixture',
    'This invented guide models Archive.org DjVu OCR ingestion only. Every objective and instruction below is synthetic test material.',
    '## Traverse Town training route',
    markers.early
  ];
  let length = paragraphs.join('\n\n').length;
  const append = (paragraph: string) => {
    paragraphs.push(paragraph);
    length += paragraph.length + 2;
  };
  const fillUntil = (minimumChars: number, phase: string) => {
    let ordinal = 0;
    while (length < minimumChars) {
      append(`Synthetic ${phase} training note ${ordinal}: inspect the wooden practice sign before entering the next exercise room. `
        + 'A patient explorer follows the marked path, checks the harmless practice switches, and records the result in an imaginary notebook. '
        + 'The invented corridor contains a blue bench and a brass practice door. These repeated details establish document volume without asserting real gameplay facts.');
      ordinal += 1;
    }
  };
  fillUntil(260_000, 'early');
  append('## Wonderland practice route');
  append(markers.middle);
  fillUntil(410_000, 'middle');
  append('## Clockwork Observatory invented late route');
  append(markers.late);
  fillUntil(590_000, 'late');
  append('## Moonlit Repository invented final chamber');
  append(markers.nearEnd);
  append('End of the wholly synthetic strategy guide fixture.');
  const text = paragraphs.join('\n\n');
  const positions = {
    early: text.indexOf(markers.early),
    middle: text.indexOf(markers.middle),
    late: text.indexOf(markers.late),
    nearEnd: text.indexOf(markers.nearEnd)
  };
  return { text, markers, positions };
}
