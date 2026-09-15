import { createHash } from 'node:crypto';
import { load } from 'cheerio';
import { assessGamingSourcePolicy, REVIEWED_GAMING_SOURCE_RULES } from '@shared/gaming/gamingFreshnessCore.js';
import type { GamingCurrentnessDocumentIndex, GamingCurrentnessDocumentMetadata } from '@shared/gaming/gamingCurrentnessAdapters.js';
import { filterGamingDocumentInstructions } from './gamingDocumentExtraction.js';

/** Parse only the safely acquired raw document. Links remain candidates; there is no follow-on fetch. */
export function extractGamingCurrentnessDocument(sourceUrl: string, raw: { body: string; contentType: string; truncated: boolean } | undefined): GamingCurrentnessDocumentMetadata | undefined {
  const rule = REVIEWED_GAMING_SOURCE_RULES.find(candidate => ['bandai-news-index-v1', 'bandai-patch-article-v1'].includes(candidate.metadataAdapter ?? '')
    && assessGamingSourcePolicy(sourceUrl, candidate.game).ruleId === candidate.id);
  if (!rule || !raw || !['text/html', 'application/xhtml+xml'].includes(raw.contentType)) return undefined;
  const result: GamingCurrentnessDocumentIndex = { ruleId: rule.id, adapterId: 'bandai-news-index-v1', categoryCount: 0,
    cards: [], rawContentHash: createHash('sha256').update(raw.body).digest('hex'), status: 'incomplete' };
  if (raw.truncated || raw.body.length > 1_500_000 || (raw.body.match(/<[a-zA-Z][^>]*>/gu)?.length ?? 0) > 30_000) return result;
  const $ = load(raw.body);
  $('script,style,noscript,template,nav,footer,aside,form,[hidden],[aria-hidden="true"]').remove();
  if (rule.metadataAdapter === 'bandai-patch-article-v1') {
    const meaningfulContents = (paragraph: ReturnType<typeof $>) => paragraph.contents().toArray()
      .filter(child => child.type !== 'text' || $(child).text().trim().length > 0);
    const labels = $('main p, article p, [role="main"] p').filter((_position, node) => {
      const first = meaningfulContents($(node))[0];
      return $(node).text().trim() === 'Targeted Platforms'
        || first?.type === 'tag' && first.name === 'u' && $(first).text().trim() === 'Targeted Platforms';
    });
    let fieldText = '';
    if (labels.length === 1) {
      if (labels.text().trim() === 'Targeted Platforms') fieldText = labels.next('p').text();
      else {
        // The publisher also puts the underlined label and its complete value
        // in one paragraph. Extra nodes or qualifications must not be dropped.
        const contents = meaningfulContents(labels);
        if (contents.length === 3 && contents[1].type === 'tag' && contents[1].name === 'br'
          && contents[2].type === 'text') fieldText = $(contents[2]).text();
      }
    }
    const platformText = fieldText.normalize('NFKC').replace(/\s+/gu, ' ').trim();
    return { ruleId: rule.id, adapterId: 'bandai-patch-article-v1', rawContentHash: result.rawContentHash, platformText,
      status: platformText.length > 0 && platformText.length <= 256
        && filterGamingDocumentInstructions(platformText) === platformText ? 'complete' : 'incomplete' };
  }
  const heading = $('main h2#patch-notes, [role="main"] h2#patch-notes');
  if (heading.length !== 1) return result;
  const label = /^Patch Notes\s*\((\d{1,5})\)$/iu.exec(heading.text().trim());
  const section = heading.closest('.search__section');
  if (!label || section.length !== 1 || section.find('h2').length !== 1) return result;
  result.categoryCount = Number(label[1]);
  const cards = section.find('ul.cards-list > li');
  if (!result.categoryCount || cards.length !== Math.min(3, result.categoryCount)) return result;
  for (const element of cards.toArray()) {
    const card = $(element);
    const anchor = card.children('a[href]');
    const titleNode = anchor.find('h3');
    const timeNode = anchor.find('time');
    if (anchor.length !== 1 || titleNode.length !== 1 || timeNode.length !== 1) return result;
    const title = titleNode.text().normalize('NFKC').replace(/\s+/gu, ' ').trim();
    const publishedDate = timeNode.text().trim();
    const href = anchor.attr('href');
    if (!href || href.length > 2_048 || !title || title.length > 240 || title !== filterGamingDocumentInstructions(title)
      || !/^\d{1,2}\/\d{1,2}\/\d{4}$/u.test(publishedDate)) return result;
    let url: URL;
    try { url = new URL(href, sourceUrl); } catch { return result; }
    if (url.search || url.hash) return result;
    const policy = assessGamingSourcePolicy(url.toString(), rule.game);
    if (policy.authority !== 'official' || policy.currentness !== 'article' || !rule.currentnessArticleRuleIds?.includes(policy.ruleId ?? '')) return result;
    result.cards.push({ title, publishedDate, url: url.toString() });
  }
  result.status = 'complete';
  return result;
}
