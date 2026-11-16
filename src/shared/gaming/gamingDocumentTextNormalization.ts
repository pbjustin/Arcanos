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
  continuation?: { heading: string; text: string };
}

export const GAMING_ARTICLE_REGION_SELECTOR = 'article,main,[role="main"]';
const ARTICLE_METADATA_HIDDEN = '[hidden],[aria-hidden="true"],[style],.d-none,.visually-hidden,.sr-only';
const ARTICLE_METADATA_INLINE = 'b,em,i,small,span,strong';
const ARTICLE_LEAD_MAX_CHARS = 768;
const ARTICLE_LEAD_BOUNDARY = 'h1,h2,h3,h4,h5,h6,div,p,section,ul,ol,figure';
const ARTICLE_ROUTE_DESTINATION = String.raw`(?:(?:the|his|her|their|your)\s+)?["‘'“]?([\p{L}\p{N}][\p{L}\p{N}-]*(?:\s+[\p{L}\p{N}][\p{L}\p{N}-]*){0,3})["’'”]?`;
const ARTICLE_ROUTE_HEADING = new RegExp('^to\\s+' + ARTICLE_ROUTE_DESTINATION + '$', 'iu');
const ARTICLE_ROUTE_APPROACH = new RegExp(String.raw`^(?:(?:then|next)[,:]?\s+|(?:once|when|after)\s+you\b[^,.!?]{1,60},\s*)?`
  + String.raw`(?:you(?:\s+(?:must|should|need\s+to|will\s+need\s+to)|['’]ll\s+need\s+to)\s+)?`
  + String.raw`(?:drive|walk|head|travel|ride|go|return)\b[^.!?]{0,100}\bto\s+`
  + ARTICLE_ROUTE_DESTINATION + '\\.$', 'iu');
const ARTICLE_ROUTE_NON_AFFIRMING = /[?"“”]|\b(?:not|never|unless|if|might|could|would|maybe|perhaps|whether|plan|planned|planning|supposed|speculative|reported|alleged|unlike|instead|guide|walkthrough|wiki|article|page|links?)\b|n['’]t\b/iu;
const ARTICLE_ROUTE_ACTION = /^(?:follow|head\s+(?:to|towards?)|go\s+to)\s+(?:(?:the|this|that|your)\s+)?(?:[\p{L}\p{N}-]+\s+){0,3}(?:marker|beacon|waypoint|route|path)\b[^.!?]{0,100}\.$/iu;
const ARTICLE_ROUTE_DETAIL = /^(?:this|it)\s+is\s+(?:your|the)\s+(?:gps|marker|beacon|waypoint|route|radar)\b[^.!?]{0,120}\.$/iu;
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

/** Retain only literal contiguous text from the authored opening and its route section. */
export function gamingArticleContinuationIsRetained(scope: GamingArticleScope, text: string): boolean {
  const { lead, continuation } = scope;
  if (!lead || !continuation) return false;
  const flattened = text.replace(/\s+/gu, ' ');
  const route = continuation.heading + ' ' + continuation.text;
  // Bare lead prose can touch its structurally distinct next heading after flattening.
  return flattened.includes(lead + ' ' + route) || flattened.includes(lead + route);
}

type GamingArticleOpening = Pick<GamingArticleScope, 'lead' | 'continuation'> & {
  leadAnchor?: cheerio.Element;
  continuationAnchor?: cheerio.Element;
};

/** The authored lead can be a paragraph or the bare prose in a first Introduction section. */
function readArticleLead($: ReturnType<typeof load>, article: cheerio.Element, header: cheerio.Element, heading: string,
  denied: (element: cheerio.Element) => boolean): GamingArticleOpening | undefined {
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

  const insignificant = (node: cheerio.Element): boolean => node.type === 'comment'
    || node.type === 'text' && !$(node).text().trim() || $(node).is('br') && inline(node);
  const readContinuation = (nodes: cheerio.Element[], start: number, introHeading: cheerio.Element | undefined,
    lead: string): GamingArticleScope['continuation'] => {
    if (!introHeading) return undefined;
    const lastSentence = /(?:^|[.!?]\s+)([^.!?]{1,220}\.)$/u.exec(lead)?.[1];
    if (!lastSentence || ARTICLE_ROUTE_NON_AFFIRMING.test(lastSentence)) return undefined;
    const destination = ARTICLE_ROUTE_APPROACH.exec(lastSentence)?.[1];
    if (!destination) return undefined;
    let next = start;
    while (next < nodes.length && ++visited <= 96 && insignificant(nodes[next])) next++;
    const sectionHeading = nodes[next++];
    if (visited > 96 || !sectionHeading || sectionHeading.parent !== introHeading.parent
      || !$(sectionHeading).is($(introHeading).is('h2') ? 'h2' : 'h3')) return undefined;
    const routeHeading = normalizeArticleLead(proseElementText(sectionHeading) ?? '');
    if (routeHeading.length > 120 || ARTICLE_ROUTE_HEADING.exec(routeHeading)?.[1]?.toLowerCase() !== destination.toLowerCase())
      return undefined;
    let prose = '';
    for (; next < nodes.length && ++visited <= 96; next++) {
      const part = nodes[next];
      if (insignificant(part)) { prose += ' '; continue; }
      if ($(part).is('p') && !prose.trim()) { prose = proseElementText(part) ?? ''; break; }
      if ($(part).is(ARTICLE_LEAD_BOUNDARY)) break;
      if (part.type === 'text') prose += $(part).text();
      else if (inline(part)) {
        const value = proseElementText(part);
        if (value === undefined) return undefined;
        prose += value;
      } else return undefined;
      if (prose.length > ARTICLE_LEAD_MAX_CHARS * 2) return undefined;
    }
    if (visited > 96 || prose.length > ARTICLE_LEAD_MAX_CHARS * 2) return undefined;
    const normalized = normalizeArticleLead(prose);
    const first = /^[^.!?]{1,160}\.(?=\s|$)/u.exec(normalized)?.[0];
    if (!first || !ARTICLE_ROUTE_ACTION.test(first) || ARTICLE_ROUTE_NON_AFFIRMING.test(first)) return undefined;
    const detail = /^[^.!?]{1,160}\.(?=\s|$)/u.exec(normalized.slice(first.length).trimStart())?.[0];
    const route = detail && ARTICLE_ROUTE_DETAIL.test(detail) && !ARTICLE_ROUTE_NON_AFFIRMING.test(detail)
      ? first + ' ' + detail : first;
    return { heading: routeHeading, text: route };
  };
  const withContinuation = (lead: string, leadAnchor: cheerio.Element, nodes: cheerio.Element[], start: number,
    introHeading?: cheerio.Element): GamingArticleOpening => {
    const continuation = readContinuation(nodes, start, introHeading, lead);
    return { lead, leadAnchor, ...(continuation ? { continuation, continuationAnchor: introHeading } : {}) };
  };

  // Undefined permits moving past an empty wrapper. Null means a visible boundary
  // was encountered and later material cannot act as the primary introduction.
  const opening = (nodes: cheerio.Element[], depth: number, introHeading?: cheerio.Element):
    GamingArticleOpening | null | undefined => {
    if (depth > 8) return null;
    for (const [index, node] of nodes.entries()) {
      if (++visited > 96) return null;
      if (node.type === 'comment' || node.type === 'text' && !$(node).text().trim()) continue;
      if (introHeading && (node.type === 'text' || inline(node))) {
        let prose = '';
        for (let position = index; position < nodes.length && ++visited <= 96; position++) {
          const part = nodes[position];
          if ($(part).is(ARTICLE_LEAD_BOUNDARY)) {
            const lead = boundedLead(prose);
            return lead ? withContinuation(lead, node.parent, nodes, position, introHeading) : null;
          }
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
        const lead = visited <= 96 ? boundedLead(prose) : undefined;
        return lead ? { lead, leadAnchor: node.parent } : null;
      }
      if (node.type === 'text' || denied(node)) return null;
      const element = $(node);
      if (!introHeading && (isArticleShareBlock($, node) || isArticlePublicationByline($, node, denied))) continue;
      if (element.is('p')) {
        const value = proseElementText(node);
        if (value === undefined) return null;
        const normalized = normalizeArticleLead(value);
        if (!normalized || normalized === normalizeArticleLead(heading)) continue;
        const lead = boundedLead(value);
        return lead ? withContinuation(lead, node, nodes, index + 1, introHeading) : null;
      }
      if (element.is('h2,h3') && !introHeading && /^(?:intro|introduction)$/iu.test(normalizeArticleLead(proseElementText(node) ?? '')))
        return opening(nodes.slice(index + 1), depth, node) ?? null;
      if (element.is('figure,img,figcaption')) continue;
      if (!element.is('div,section') || !articleElementClosed(node)) return null;
      const nested = opening(element.contents().toArray(), depth + 1, introHeading);
      if (nested !== undefined) return nested;
    }
    return undefined;
  };

  const siblings = $(article).contents().toArray();
  return opening(siblings.slice(siblings.indexOf(header) + 1), 0) ?? undefined;
}

export interface GamingArticleOwner {
  article: cheerio.Element;
  heading: string;
}

function gamingArticleNodeExcluded($: ReturnType<typeof load>, element: cheerio.Element,
  denied: (element: cheerio.Element) => boolean): boolean {
  return denied(element) || $(element).closest(ARTICLE_METADATA_HIDDEN).length > 0;
}

/** Bind negative source-wide facts to one intact article independently of positive game identity. */
export function readGamingArticleOwner($: ReturnType<typeof load>, denied: (element: cheerio.Element) => boolean):
  GamingArticleOwner | undefined {
  const isExcluded = (element: cheerio.Element) => gamingArticleNodeExcluded($, element, denied);
  const candidates = $(GAMING_ARTICLE_REGION_SELECTOR);
  if (candidates.length > 48) return undefined;
  const regions = candidates.toArray().filter(element => !isExcluded(element));
  const articles = regions.filter(element => $(element).is('article'));
  if (articles.length !== 1) return undefined;
  const [article] = articles;
  const enclosing = new Set($(article).parents().toArray());
  if (regions.some(region => region !== article && !enclosing.has(region)) || !articleElementClosed(article)) return undefined;
  const headings = $(article).find('h1');
  const heading = headings.get(0);
  if (headings.length !== 1 || !heading || !articleElementClosed(heading) || isExcluded(heading)) return undefined;
  const value = headings.text().replace(/\s+/gu, ' ').trim();
  return value && value.length <= 160 ? { article, heading: value } : undefined;
}

/** Read the visible label attached to an intact heading in one directly owned article header. */
export function readGamingArticleScope($: ReturnType<typeof load>, denied: (element: cheerio.Element) => boolean,
  owner: GamingArticleOwner): { article: cheerio.Element; metadata: GamingArticleScope;
    leadAnchor?: cheerio.Element; continuationAnchor?: cheerio.Element } | undefined {
  const { article } = owner;
  const isExcluded = (element: cheerio.Element) => gamingArticleNodeExcluded($, element, denied);
  const headers = $(article).children('header');
  if (headers.length !== 1) return undefined;
  const header = headers.get(0)!;
  const headerChildren = headers.children();
  const wrapped = headerChildren.length === 1 && headerChildren.is('div,hgroup') ? headerChildren.get(0) : undefined;
  if (wrapped && headers.contents().toArray().some(node => node !== wrapped
    && !(node.type === 'text' && !$(node).text().trim()))) return undefined;
  const headingGroup = $(wrapped ?? header);
  const headings = headingGroup.children('h1');
  if (headings.length !== 1) return undefined;
  const heading = headings.get(0)!;
  const label = headings.prev('div,p,span').get(0);
  if (!label || headingGroup.children().length !== 2 || headingGroup.children().get(0) !== label
    || headingGroup.contents().toArray().some(node => node !== label && node !== heading
      && !(node.type === 'text' && !$(node).text().trim()))
    || [article, header, heading, label, ...(wrapped ? [wrapped] : [])]
      .some(element => !articleElementClosed(element) || isExcluded(element))) return undefined;

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
  const { leadAnchor, continuationAnchor, ...opening } = readArticleLead($, article, header, headingText, isExcluded) ?? {};
  return { article, metadata: { label: labelText, heading: headingText, ...opening }, leadAnchor, continuationAnchor };
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
