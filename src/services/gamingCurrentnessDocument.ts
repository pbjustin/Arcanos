import { createHash } from 'node:crypto';
import { load } from 'cheerio';
import { assessGamingSourcePolicy, REVIEWED_GAMING_SOURCE_RULES, type GamingReviewedSourceRule } from '@shared/gaming/gamingFreshnessCore.js';
import { parseGamingCurrentnessDate, type GamingCurrentnessDocumentIndex, type GamingCurrentnessDocumentMetadata } from '@shared/gaming/gamingCurrentnessAdapters.js';
import { countGamingHtmlElements, filterGamingDocumentInstructions } from './gamingDocumentExtraction.js';

const escape = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
/** Parse only safely acquired raw HTML with a reviewed extraction contract. Links are candidates; there is no follow-on fetch. */
export function extractGamingCurrentnessDocument(sourceUrl: string, raw: { body: string; contentType: string; truncated: boolean } | undefined,
  rules: readonly GamingReviewedSourceRule[] = REVIEWED_GAMING_SOURCE_RULES): GamingCurrentnessDocumentMetadata | undefined {
  const rule = rules.find(candidate => ['article-index-v1', 'patch-article-v1'].includes(candidate.metadataAdapter ?? '')
    && assessGamingSourcePolicy(sourceUrl, candidate.game, rules).ruleId === candidate.id);
  const config = rule?.metadataAdapterConfig;
  if (!rule || !config || !raw || !['text/html', 'application/xhtml+xml'].includes(raw.contentType)
    || !['article-index', 'patch-article'].includes(config.kind)) return undefined;
  const rawContentHash = createHash('sha256').update(raw.body).digest('hex');
  const incomplete: GamingCurrentnessDocumentMetadata = config.kind === 'patch-article'
    ? { ruleId: rule.id, adapterId: 'patch-article-v1', platformText: '', rawContentHash, status: 'incomplete' }
    : { ruleId: rule.id, adapterId: 'article-index-v1', categoryCount: 0, cards: [], rawContentHash, status: 'incomplete' };
  // These fixed parser bounds cannot be changed by registry data.
  if (raw.truncated || raw.body.length > 1_500_000 || countGamingHtmlElements(raw.body, 30_000) > 30_000) return incomplete;
  const $ = load(raw.body);
  $('script,style,noscript,template,nav,footer,aside,form,[hidden],[aria-hidden="true"]').remove();
  if (config.kind === 'patch-article') {
    const meaningfulContents = (paragraph: ReturnType<typeof $>) => paragraph.contents().toArray()
      .filter(child => child.type !== 'text' || $(child).text().trim().length > 0);
    const labels = $(config.platformSelector).filter((_position, node) => {
      const first = meaningfulContents($(node))[0];
      return $(node).text().trim() === config.platformLabel
        || first?.type === 'tag' && first.name === 'u' && $(first).text().trim() === config.platformLabel;
    });
    let fieldText = '';
    if (labels.length === 1) {
      if (labels.text().trim() === config.platformLabel) fieldText = labels.next('p').text();
      else {
        // A label and its complete value may share one paragraph. Do not discard extra qualifications.
        const contents = meaningfulContents(labels);
        if (contents.length === 3 && contents[1].type === 'tag' && contents[1].name === 'br'
          && contents[2].type === 'text') fieldText = $(contents[2]).text();
      }
    }
    const platformText = fieldText.normalize('NFKC').replace(/\s+/gu, ' ').trim();
    return { ruleId: rule.id, adapterId: 'patch-article-v1', rawContentHash, platformText,
      status: platformText.length > 0 && platformText.length <= 256
        && filterGamingDocumentInstructions(platformText) === platformText ? 'complete' : 'incomplete' };
  }
  if (config.kind !== 'article-index') return incomplete;
  const result = incomplete as GamingCurrentnessDocumentIndex;
  const heading = $(config.headingSelector);
  if (heading.length !== 1) return result;
  const label = new RegExp(`^${escape(config.headingLabel)}\\s*\\((\\d{1,5})\\)$`, 'iu').exec(heading.text().trim());
  const section = heading.closest(config.sectionSelector);
  if (!label || section.length !== 1 || section.find('h2').length !== 1) return result;
  result.categoryCount = Number(label[1]);
  const cards = section.find(config.cardsSelector);
  if (!result.categoryCount || cards.length !== Math.min(config.pageSize, result.categoryCount)) return result;
  for (const element of cards.toArray()) {
    const card = $(element);
    const anchor = card.children(config.anchorSelector);
    const titleNode = anchor.find(config.titleSelector);
    const timeNode = anchor.find(config.dateSelector);
    if (anchor.length !== 1 || titleNode.length !== 1 || timeNode.length !== 1) return result;
    const title = titleNode.text().normalize('NFKC').replace(/\s+/gu, ' ').trim();
    const publishedDate = timeNode.text().trim();
    const href = anchor.attr('href');
    if (!href || href.length > 2_048 || !title || title.length > 240 || title !== filterGamingDocumentInstructions(title)
      || !parseGamingCurrentnessDate(publishedDate, config.dateFormat)) return result;
    let url: URL;
    try { url = new URL(href, sourceUrl); } catch { return result; }
    if (url.search || url.hash) return result;
    const policy = assessGamingSourcePolicy(url.toString(), rule.game, rules);
    if (policy.authority !== 'official' || policy.currentness !== 'article' || !rule.currentnessArticleRuleIds?.includes(policy.ruleId ?? '')) return result;
    result.cards.push({ title, publishedDate, url: url.toString() });
  }
  result.status = 'complete';
  return result;
}
