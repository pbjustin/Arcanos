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

export interface GamingArticleScope {
  label: string;
  heading: string;
  lead?: string;
}

export const GAMING_ARTICLE_REGION_SELECTOR = 'article,main,[role="main"]';
const ARTICLE_METADATA_HIDDEN = '[hidden],[aria-hidden="true"],[style],.d-none,.visually-hidden,.sr-only';
const ARTICLE_METADATA_INLINE = 'b,em,i,small,span,strong';
const ARTICLE_LEAD_MAX_CHARS = 768;
const ARTICLE_LEAD_BOUNDARY = 'h1,h2,h3,h4,h5,h6,div,p,section,ul,ol,figure';
type ArticleLocatedElement = cheerio.Element & { sourceCodeLocation?: { endTag?: unknown } };
const articleElementClosed = (element: cheerio.Element) => Boolean((element as ArticleLocatedElement).sourceCodeLocation?.endTag);
const normalizeArticleLead = (text: string) => normalizeGamingDocumentInstructionCharacters(text).replace(/\s+/gu, ' ').trim();

const PUBLISHED_BYLINE = /^Published(?: on)? ((?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?) \d{1,2},? \d{4}(?:(?: at|,)? \d{1,2}:\d{2}(?: [AP]M)?)?)(?: by ([\p{L}][\p{L}\p{N}_.\u2019'-]{0,31}))?$/iu;

/** Compact publisher metadata can precede the opening without supplying gameplay or identity. */
function isArticlePublicationByline($: ReturnType<typeof load>, node: cheerio.Element,
  denied: (element: cheerio.Element) => boolean): boolean {
  const element = $(node);
  const allowedTags = ARTICLE_METADATA_INLINE + ',time,a';
  if (!element.is('div,p') || !articleElementClosed(node) || element.children().toArray().some(child => !$(child).is(allowedTags)))
    return false;
  const children = element.find('*').toArray();
  if (children.length > 16 || children.some(child => !$(child).is(allowedTags) || !articleElementClosed(child))) return false;
  const time = element.find('time');
  const author = element.find('a');
  const timeElement = time.get(0);
  const authorElement = author.get(0);
  if (time.length !== 1 || !timeElement || denied(timeElement) || author.length > 1 || authorElement && denied(authorElement)) return false;
  const value = normalizeArticleLead(element.text());
  const match = value.length <= 100 && PUBLISHED_BYLINE.exec(value);
  if (!match || /^(?:only|pc|xbox\d*|playstation\d*|ps[345]|nintendo)$/iu.test(match[2] ?? '')) return false;
  return normalizeArticleLead(time.text()) === match[1] && (!authorElement || normalizeArticleLead(author.text()) === match[2]);
}

function isArticleShareBlock($: ReturnType<typeof load>, node: cheerio.Element): boolean {
  const element = $(node);
  if (!element.is('div.share-block') || !articleElementClosed(node)) return false;
  const children = element.children().toArray();
  return children.length <= 12 && children.some(child => $(child).is('a[href]') && normalizeArticleLead($(child).text()) === 'Share')
    && children.every(child => articleElementClosed(child)
      && ($(child).is('a[href]') || $(child).is('div.share-message') && !normalizeArticleLead($(child).text())))
    && normalizeArticleLead(element.text()) === 'Share';
}

/** The authored lead can be a paragraph or the bare prose in a first Introduction section. */
function readArticleLead($: ReturnType<typeof load>, article: cheerio.Element, header: cheerio.Element, heading: string,
  denied: (element: cheerio.Element) => boolean): string | undefined {
  let visited = 0;
  const boundedLead = (value: string): string | undefined => {
    const normalized = normalizeArticleLead(value);
    return normalized.length <= ARTICLE_LEAD_MAX_CHARS && /^[\p{L}\p{N}]/u.test(normalized)
      && /[.!?][")'\u2019\u201d]*$/u.test(normalized) ? normalized : undefined;
  };
  const inline = (element: cheerio.Element) => $(element).is('br')
    ? !denied(element) : $(element).is(ARTICLE_METADATA_INLINE) && articleElementClosed(element) && !denied(element);
  const proseElementText = (element: cheerio.Element): string | undefined => {
    if (!articleElementClosed(element) || denied(element)) return undefined;
    const descendants = $(element).find('*').toArray();
    if (descendants.length > 24 || descendants.some(child => !inline(child))) return undefined;
    const copy = $(element).clone();
    copy.find('br').replaceWith(' ');
    return copy.text();
  };

  // Undefined permits moving past an empty wrapper. Null means a visible boundary
  // was encountered and later material cannot act as the primary introduction.
  const opening = (nodes: cheerio.Element[], depth: number, direct = false): string | null | undefined => {
    if (depth > 8) return null;
    for (const [index, node] of nodes.entries()) {
      if (++visited > 96) return null;
      if (node.type === 'comment' || node.type === 'text' && !$(node).text().trim()) continue;
      if (direct && (node.type === 'text' || inline(node))) {
        let prose = '';
        for (let position = index; position < nodes.length && ++visited <= 96; position++) {
          const part = nodes[position];
          if ($(part).is(ARTICLE_LEAD_BOUNDARY)) return boundedLead(prose) ?? null;
          if (part.type === 'comment') continue;
          if (part.type === 'text') prose += $(part).text();
          else if ($(part).is('br') && inline(part)) prose += ' ';
          else if (inline(part)) {
            const content = proseElementText(part);
            if (content === undefined) return null;
            prose += content;
          } else return null;
          if (prose.length > ARTICLE_LEAD_MAX_CHARS * 2) return null;
        }
        return visited <= 96 ? boundedLead(prose) ?? null : null;
      }
      if (node.type === 'text' || denied(node)) return null;
      const element = $(node);
      if (!direct && (isArticleShareBlock($, node) || isArticlePublicationByline($, node, denied))) continue;
      if (element.is('p')) {
        const value = proseElementText(node);
        if (value === undefined) return null;
        const normalized = normalizeArticleLead(value);
        if (!normalized || normalized === normalizeArticleLead(heading)) continue;
        return boundedLead(value) ?? null;
      }
      if (element.is('h2,h3') && !direct && /^(?:intro|introduction)$/iu.test(normalizeArticleLead(proseElementText(node) ?? '')))
        return opening(nodes.slice(index + 1), depth, true) ?? null;
      if (element.is('figure,img,figcaption')) continue;
      if (!element.is('div,section') || !articleElementClosed(node)) return null;
      const nested = opening(element.contents().toArray(), depth + 1, direct);
      if (nested !== undefined) return nested;
    }
    return undefined;
  };

  const siblings = $(article).contents().toArray();
  return opening(siblings.slice(siblings.indexOf(header) + 1), 0) ?? undefined;
}

/** Read the visible label attached to an intact heading in one directly owned article header. */
export function readGamingArticleScope($: ReturnType<typeof load>, denied: (element: cheerio.Element) => boolean):
  { article: cheerio.Element; metadata: GamingArticleScope } | undefined {
  const isExcluded = (element: cheerio.Element) => denied(element)
    || $(element).closest(ARTICLE_METADATA_HIDDEN).length > 0;
  const candidates = $(GAMING_ARTICLE_REGION_SELECTOR);
  if (candidates.length > 48) return undefined;
  const regions = candidates.toArray().filter(element => !isExcluded(element));
  const articles = regions.filter(element => $(element).is('article'));
  if (articles.length !== 1) return undefined;
  const [article] = articles;
  const enclosing = new Set($(article).parents().toArray());
  if (regions.some(region => region !== article && !enclosing.has(region))) return undefined;

  const headers = $(article).children('header');
  const headings = headers.children('h1');
  if (headers.length !== 1 || headings.length !== 1 || $(article).find('h1').length !== 1) return undefined;
  const heading = headings.get(0)!;
  const label = headings.prev('div,p,span').get(0);
  const header = headers.get(0)!;
  const headerNodes = headers.contents().toArray();
  if (!label || headers.children().length !== 2 || headers.children().get(0) !== label
    || headerNodes.some(node => node !== label && node !== heading
      && !(node.type === 'text' && !$(node).text().trim()))
    || [article, header, heading, label].some(element => !articleElementClosed(element) || isExcluded(element))) return undefined;

  const readText = (element: cheerio.Element, ceiling: number) => {
    const children = $(element).find('*').toArray();
    if (children.length > 16 || children.some(child => !$(child).is('img')
      && (!$(child).is(ARTICLE_METADATA_INLINE) || !articleElementClosed(child) || isExcluded(child)))) return '';
    // Text nodes only. Accessible image descriptions and link metadata do not name the article's game.
    const value = $(element).text().replace(/\s+/gu, ' ').trim();
    return value.length <= ceiling ? value : '';
  };
  const labelText = readText(label, 120);
  const headingText = readText(heading, 160);
  if (!labelText || !headingText
    || /^(?:related|see\s+also|read\s+(?:also|next)|compare|comparison|references?|browse)\b/iu.test(labelText)) return undefined;
  const lead = readArticleLead($, article, header, headingText, isExcluded);
  return { article, metadata: { label: labelText, heading: headingText, ...(lead ? { lead } : {}) } };
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
  const optionalSelectors = primaryContentSelectors.slice(0, GAMING_PRIMARY_CONTENT_SELECTOR_LIMIT)
    .map(selector => selector.trim()).filter(Boolean);
  const boundedSelectors = optionalSelectors.length ? optionalSelectors : GAMING_PRIMARY_CONTENT_SELECTORS;
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
