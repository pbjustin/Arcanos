import type { load } from 'cheerio';

/** Normalize scanner characters while preserving real whitespace in either inspection view. */
export function normalizeGamingDocumentInstructionCharacters(text: string, replacement: ' ' | '' = ' '): string {
  return text.normalize('NFKC')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060\u2066-\u2069\ufeff]/g,
      character => replacement === '' && (character === '\v' || character === '\f') ? character : replacement);
}

/** Layout modifiers are not sidebar furniture. Normalize parser-owned class hints
 * on semantic primary regions and their containers; source text is unchanged. */
export function preservePrimaryContentSidebarLayouts($: ReturnType<typeof load>): void {
  const primaryAncestors = new Set<unknown>();
  $('article,main,[role="main"]').each((_, element) => {
    primaryAncestors.add(element);
    // Share ancestry work across nested layouts and primary regions. Looking
    // through every candidate's descendants would repeat a quadratic DOM walk.
    for (let parent = element.parent; parent && !primaryAncestors.has(parent); parent = parent.parent) {
      primaryAncestors.add(parent);
    }
  });
  $("[class$='-sidebar'],[class$='__sidebar']").each((_, element) => {
    const node = $(element);
    const classes = (node.attr('class') ?? '').split(/\s+/u).filter(Boolean);
    const sidebarClasses = classes.filter(value => /(?:-|__)sidebar$/u.test(value));
    const layoutModifier = (value: string) => /^(?:has|with)-[^\s]*sidebar$/u.test(value);
    if (!sidebarClasses.length || sidebarClasses.some(value => !layoutModifier(value))
      || classes.includes('sidebar') || !primaryAncestors.has(element)) return;
    node.attr('class', classes.filter(value => !layoutModifier(value)).join(' '));
  });
}
