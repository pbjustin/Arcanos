import type { load } from 'cheerio';

/** Reviewed primary-content hints shared by layout normalization and prose selection. */
export const GAMING_PRIMARY_CONTENT_SELECTORS = Object.freeze([
  '#article-body', '.article-content', '.article-body', "[class*='article-content']", "[class*='article-body']",
  '.entry-content', '.post-content', '.mw-parser-output', '.main-content', '#main-content', '.page-content',
  'article', 'main', "[role='main']"
] as const);
export const GAMING_PRIMARY_CONTENT_SELECTOR = GAMING_PRIMARY_CONTENT_SELECTORS.join(',');
/** Existing shared-fetcher selector ceiling; layout normalization uses the same bound. */
export const GAMING_PRIMARY_CONTENT_SELECTOR_LIMIT = 24;

/** Normalize scanner characters while preserving real whitespace in either inspection view. */
export function normalizeGamingDocumentInstructionCharacters(text: string, replacement: ' ' | '' = ' '): string {
  return text.normalize('NFKC')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060\u2066-\u2069\ufeff]/g,
      character => replacement === '' && (character === '\v' || character === '\f') ? character : replacement);
}

/** Layout modifiers are not sidebar furniture. Normalize parser-owned class hints
 * on reviewed semantic/class primary regions and their containers; source text is unchanged. */
export function preservePrimaryContentSidebarLayouts($: ReturnType<typeof load>,
  primaryContentSelectors: readonly string[] = GAMING_PRIMARY_CONTENT_SELECTORS): void {
  const primaryAncestors = new Set<unknown>();
  const rememberPrimary = (_: number, element: cheerio.Element) => {
    primaryAncestors.add(element);
    // Share ancestry work across nested layouts and primary regions. Looking
    // through every candidate's descendants would repeat a quadratic DOM walk.
    for (let parent = element.parent; parent && !primaryAncestors.has(parent); parent = parent.parent) {
      primaryAncestors.add(parent);
    }
  };
  const activeSelectors = primaryContentSelectors.length ? primaryContentSelectors : GAMING_PRIMARY_CONTENT_SELECTORS;
  const boundedSelectors = activeSelectors.slice(0, GAMING_PRIMARY_CONTENT_SELECTOR_LIMIT);
  try { $(boundedSelectors.join(',')).each(rememberPrimary); } catch {
    // Reviewed profiles use one combined selection. Isolate malformed optional
    // hints only on the exceptional path so valid siblings remain usable.
    for (const selector of boundedSelectors) {
      try { $(selector).each(rememberPrimary); } catch { /* Invalid optional hints do not disable valid siblings. */ }
    }
  }
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
