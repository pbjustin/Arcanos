/**
 * Original synthetic HTML, authored for the November 7, 2026 modernization.
 * Not an IGN capture, not a reconstruction of request req_1794038305638_2bg3na,
 * and not evidence of publisher accessibility or real game mechanics.
 */
export const gamingWikiIdentityFixture = {
  provenance: 'synthetic' as const,
  capturedPublisherResponse: false,
  game: 'Xenoblade Chronicles X',
  title: 'Xenoblade Chronicles X Wiki Guide',
  definition: 'Xenoblade Chronicles X is an open-world action role-playing game.',
  catalog: 'This page provides an index of walkthrough entries. Browse the linked walkthrough entries and introductory reference articles for this game.',
  gameplay: 'In the game Xenoblade Chronicles X, unlock the practice route by collecting the practice token at the marked training gate. Return the practice token to the practice terminal before leaving the training area.',
  localReference: 'Related guide: In the game Fallout 4, collect an unrelated comparison reward.',
  url: 'https://synthetic-guides.example.org/wiki-index',
  html(prose: string, title = this.title): string {
    return `<html><head><title>${title}</title></head><body><nav><h1>Fallout 4 Guide</h1><p>Game: Fallout 4.</p></nav>`
      + `<main><article><h1>${title}</h1><p>${prose}</p>`
      + '<nav aria-label="Related games"><a href="https://synthetic-guides.example.org/other-game">Fallout 4 guide</a></nav>'
      + '<aside><h2>Minecraft Bedrock guide</h2><p>Edition: Bedrock.</p></aside>'
      + '<p><a href="https://synthetic-guides.example.org/walkthrough">Individual walkthrough</a></p>'
      + '</article></main></body></html>';
  }
};
