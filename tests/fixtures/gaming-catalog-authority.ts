/** Original synthetic documents for PR 1592 P1-B. No publisher captures,
 * real Portal mechanics, paid providers, durable source storage or live access. */
export const gamingCatalogAuthorityFixture = {
  game: 'Portal 2',
  question: 'How do I obtain the copper shield?',
  title: 'Portal 2 copper shield wiki',
  url: 'https://guides.example.org/synthetic-copper-shield-catalog',
  cases: [
    { id: 'long-catalog', text: 'In the game Portal 2, this wiki catalog lists copper shield acquisition topics, '
      + 'copper shield weapon names, copper shield locations, copper shield upgrades, copper shield skill headings, '
      + 'and copper shield equipment categories. Article titles, glossary labels, sidebar topics, equipment headings, '
      + 'map indexes, and linked page names.' },
    { id: 'keyword-only', text: 'In the game Portal 2, copper shield; copper shield acquisition; copper shield locations; '
      + 'copper shield upgrades; copper shield skills; copper shield equipment; copper shield route; copper shield strategy; '
      + 'copper shield statistics; copper shield topics; copper shield index; copper shield glossary.' },
    { id: 'catalog-discusses', text: 'In the game Portal 2, this wiki catalog discusses copper shield acquisition topics, '
      + 'copper shield weapon names, copper shield locations, copper shield upgrades, copper shield skill headings, and copper shield equipment categories.' },
    { id: 'catalog-directory', text: 'In the game Portal 2, this wiki catalog is a directory of copper shield acquisition topics, '
      + 'copper shield weapon names, copper shield locations, copper shield upgrades, copper shield skill headings, and copper shield equipment categories.' },
    { id: 'browse-index', text: 'In the game Portal 2, follow the copper shield acquisition index for copper shield locations, '
      + 'copper shield upgrades, copper shield skills and copper shield equipment categories.' },
    { id: 'encyclopedia', text: 'In the game Portal 2, this encyclopedia contains copper shield acquisition topics, '
      + 'copper shield locations, copper shield upgrades and copper shield equipment categories.' },
    { id: 'keyword-titlecase', text: 'In the game Portal 2, Copper shield locations and Copper shield upgrades '
      + 'and Copper shield skills and Copper shield equipment categories.' },
    { id: 'keyword-lowercase', text: 'In the game Portal 2, copper shield locations and copper shield upgrades '
      + 'and copper shield skills and copper shield equipment categories.' },
    { id: 'vague-offer', text: 'In the game Portal 2, Portal 2 offers a good copper shield build. '
      + 'Copper shield locations and copper shield upgrades and copper shield skills and copper shield equipment categories.' }
  ] as const,
  html(text: string) {
    return `<html><title>${this.title}</title><article><h1>${this.title}</h1><p>${text}</p></article></html>`;
  }
};

export const gamingCompiledHttpCatalogFixture = {
  game: 'Amber Pilgrim', question: 'How do I cross the observatory bridge?',
  html: '<h1>Amber Pilgrim</h1><p>In Amber Pilgrim, the following acquired gameplay applies.</p><p>Edition: base game.</p>'
    + '<p>Welcome to the community wiki catalog. Browse the index of locations, items and walkthrough chapters. '
    + 'The observatory entry lists the telescope, eastern beacon, bridge and amber gate article titles. '
    + 'These topics are part of the encyclopedia directory and related article collection.</p>'
};
