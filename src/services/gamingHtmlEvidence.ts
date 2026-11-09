import { createHash } from 'node:crypto';
import { load } from 'cheerio';
import { preservePrimaryContentSidebarLayouts } from '@shared/gaming/gamingDocumentTextNormalization.js';
import { normalizeGamingComparableIdentity } from '@shared/gaming/gamingGameRegistry.js';
import { gamingAttributableClaimText } from '@shared/gaming/gamingRetrievalPolicy.js';
import { countGamingHtmlElements, filterGamingDocumentInstructions, hasGamingActionableProse, GAMING_DOCUMENT_FURNITURE_SELECTOR,
  gamingDocumentExtractionProfile, gamingDocumentFetchOptions } from '@services/gamingDocumentExtraction.js';
import {
  GAMING_EVIDENCE_UNIT_POLICY_VERSION,
  type GamingEvidenceExtractionInput,
  type GamingEvidenceExtractionResult,
  type GamingEvidenceUnit
} from '@shared/gaming/gamingEvidenceUnits.js';

/** Separate from transport limits: no caller can enlarge structural parsing work. */
export const GAMING_HTML_EVIDENCE_LIMITS = Object.freeze({
  htmlChars: 5_000_000, elements: 30_000, tables: 128, rowsPerTable: 1_024,
  columns: 32, span: 64, expandedCells: 32_768, lists: 256, units: 2_048,
  fields: 32, fieldChars: 1_024, contextChars: 512, unitChars: 4_096, outputChars: 1_000_000
});
export const GAMING_SOURCE_USE_RESTRICTION = /\b(?:no (?:automated|machine) (?:access|use)|automated (?:access|use) (?:is )?prohibited|do not (?:store|redistribute) (?:this|our) content)\b/iu;
type Element = cheerio.Element;
type CheerioAPI = ReturnType<typeof load>;
type Fields = GamingEvidenceUnit['fields'];
interface SourceLocation { startOffset: number; endOffset: number; endTag?: { endOffset: number } }
type LocatedElement = Element & { sourceCodeLocation?: SourceLocation };
export interface GamingHtmlLocalTopicReference {
  text: string; paragraphText: string; gameHash: string;
  paragraphOccurrence: number; paragraphCount: number; frameStart: number;
}
export interface GamingHtmlEvidenceExtractionResult extends GamingEvidenceExtractionResult {
  /** Original accepted HTML with structural candidates removed from the prose fallback. */
  proseBody?: string;
  /** Parser-owned local article references; the resolver retains only bound spans. */
  localTopicReferences?: GamingHtmlLocalTopicReference[];
  /** Layout search exhaustion cannot establish unrestricted source scope. */
  applicabilityUnverified?: true;
  sourceUseRestricted?: true;
}
const EXCLUDED = `aside,[role="menu"],${GAMING_DOCUMENT_FURNITURE_SELECTOR}`;
const DISCUSSION = '[itemtype="https://schema.org/DiscussionForumPosting"],[itemtype="http://schema.org/DiscussionForumPosting"]';
const UNRELATED_DISCUSSION = '.comments,#comments,[class*="comment-list"],[itemtype="https://schema.org/Comment"],[itemtype="http://schema.org/Comment"]';
const QUALIFIER = /\b(?:not|no longer|deplet\w*|unconfirmed|old patch|example only|correction|corrected|outdated|unavailable|obsolete|previously|before|after|patch|version)\b/i;
const COMPARISON_PROSE = /^(?:unlike|compare(?:d)?|(?:for\s+)?comparison|contrast|rather\s+than|instead\s+of)\b/iu;
// A comparison lead-in cannot erase an explicit qualification of the primary
// record. Compared equipment alone remains unrelated context.
const PRIMARY_RECORD_QUALIFICATION = /\b(?:this|these|the)\s+(?:records?|equipment|builds?|sources?|entry|entries|sites?|statistics?|resources?|weapons?|items?|stats?|routes?)\s+(?:(?:(?:is|are|was|were|remains?|may|might|can|could|would|should|must|will|be|been|being|has|have|had|now|still|also|already|yet|perhaps|requires?|needs?|a)|[\p{L}-]+ly)\s+)*(?:not|no longer|deplet\w*|unconfirmed|old patch|example only|outdated|unavailable|obsolete|correction|corrected)\b/iu;
const LABELLED_FIELD = /^([^:;|\n]{1,80}):\s*(.*)$/;
// These labels explicitly assert record fields. A complete sentence in a field
// value cannot turn a partial tuple back into unrestricted prose.
const RECORD_FIELD_LABEL = /^(?:game|edition|scope|applicability|patch|version|system|star system|body|planet|moon|site(?: number| identifier|[ _-]?id)?|pml(?:\/site)?|resource|material|mineral|item|equipment|weapon|armou?r|stat(?:istic)?|attribute|value|units?|mechanic|change|before|after|skill|build|notes?|requirements?|compatibility|description)$/iu;
const PARAGRAPH_IDENTITY_FIELD = /^(Game|Edition)\s*:\s*([^;.!?\n]*?)(?=\s+(?:Game|Edition)\s*:|[;.!?]|$)/iu;
const APPLICABILITY_LIST_LABEL = /^(Platforms?|Regions?|Editions?|Patch(?:es)?|Versions?|Source use|Usage restrictions)\s*:?$/iu;
interface ApplicabilityListLabel { label: string; complete: boolean; preserveOnly: boolean; exhausted?: true }
const APPLICABILITY_LAYOUT_LIMITS = Object.freeze({ ancestors: 16, siblings: 32 });

// One reviewed React transport form, interpreted as static DOM relationships,
// never JavaScript. Other renderers/helper revisions remain unsupported.
const STATIC_STREAM_HELPER_SHA256 = '7a3c441a297b4368e7168f53d44323873b11a160d3567f2d4695187785c22646';
const STATIC_STREAM_SEGMENTS = 32;

function restoreStaticStream($: CheerioAPI, deadlineExpired: () => boolean): 'absent' | 'restored' | 'unsupported' {
  const slots = $('template[id^="B:"]').toArray();
  const buckets = $('div[hidden][id^="S:"]').toArray();
  if (!slots.length && !buckets.length) return 'absent';
  if (!slots.length || slots.length !== buckets.length || slots.length > STATIC_STREAM_SEGMENTS) return 'unsupported';
  let scanSteps = 0;
  const inertAncestor = (element: Element): boolean => {
    // Template contents have a parser-owned document-fragment parent, which
    // Cheerio's element-only parents() traversal does not cross.
    for (let ancestor: Element | null = element.parent; ancestor; ancestor = ancestor.parent) {
      if (++scanSteps > GAMING_HTML_EVIDENCE_LIMITS.elements || deadlineExpired()
        || $(ancestor).is('template,noscript')) return true;
    }
    return false;
  };
  const ids = new Map<string, Element[]>();
  for (const element of $('[id]').toArray()) {
    if (deadlineExpired()) return 'unsupported';
    const id = $(element).attr('id')!;
    const matches = ids.get(id);
    if (!matches) ids.set(id, [element]);
    else if (matches.length < 2) matches.push(element);
  }
  const calls: { slot: Element; bucket: Element }[] = [];
  let initialized = false;
  for (const script of $('script').toArray()) {
    if (deadlineExpired()) return 'unsupported';
    const source = $(script).html() ?? '';
    if (!/\$(?:RC|RV|RB)\b/u.test(source)) continue;
    if (!closed(script) || inertAncestor(script) || $(script).attr('nomodule') !== undefined
      || $(script).attr('src') !== undefined
      || !['', 'text/javascript', 'application/javascript'].includes($(script).attr('type') ?? '')) return 'unsupported';
    const call = /\$RC\("(B:[0-9a-f]{1,8})","(S:[0-9a-f]{1,8})"\);?$/u.exec(source);
    if (!call || calls.length >= STATIC_STREAM_SEGMENTS) return 'unsupported';
    const prefix = source.slice(0, call.index);
    if (!initialized) {
      if (createHash('sha256').update(prefix).digest('hex') !== STATIC_STREAM_HELPER_SHA256) return 'unsupported';
      initialized = true;
    } else if (prefix) return 'unsupported';
    const [slot] = ids.get(call[1]) ?? [];
    const [bucket] = ids.get(call[2]) ?? [];
    const callStart = (script as LocatedElement).sourceCodeLocation?.startOffset;
    if (ids.get(call[1])?.length !== 1 || ids.get(call[2])?.length !== 1
      || !slots.includes(slot) || !buckets.includes(bucket)
      || calls.some(previous => previous.slot === slot || previous.bucket === bucket)) return 'unsupported';
    // The reviewed helper cannot resolve IDs supplied later in the response.
    if (callStart === undefined || [(slot as LocatedElement), (bucket as LocatedElement)]
      .some(element => !element.sourceCodeLocation || element.sourceCodeLocation.endOffset > callStart)) return 'unsupported';
    calls.push({ slot, bucket });
  }
  if (!initialized || calls.length !== slots.length) return 'unsupported';
  const plans: { start: Element; removed: Element[]; bucket: Element }[] = [];
  const availableBuckets = new Set<Element>();
  const removed = new Set<Element>();
  for (const { slot, bucket } of calls) {
    if (deadlineExpired()) return 'unsupported';
    if (!closed(slot) || $(slot).html() !== '' || inertAncestor(slot) || !closed(bucket)
      || !$(bucket).parent().is('body') || Object.keys($(bucket).attr() ?? {}).some(key => !['hidden', 'id'].includes(key))) return 'unsupported';
    // A later slot may be supplied by an already planned bucket, but never by
    // itself, an unavailable bucket, or fallback content removed by another slot.
    for (let ancestor: Element | null = slot.parent; ancestor; ancestor = ancestor.parent) {
      if (++scanSteps > GAMING_HTML_EVIDENCE_LIMITS.elements || deadlineExpired()) return 'unsupported';
      if (removed.has(ancestor) || buckets.includes(ancestor) && !availableBuckets.has(ancestor)) return 'unsupported';
    }
    const start = slot.prev;
    if (!start || start.type !== 'comment' || start.data !== '$?' || removed.has(slot)) return 'unsupported';
    const discarded: Element[] = [];
    const nested: string[] = [];
    let end: Element | null = slot;
    for (; end; end = end.next) {
      if (++scanSteps > GAMING_HTML_EVIDENCE_LIMITS.elements || deadlineExpired()) return 'unsupported';
      if (end.type === 'comment') {
        const marker = end.data ?? '';
        if (marker === '/$' || marker === '/&') {
          if (!nested.length) { if (marker !== '/$') return 'unsupported'; break; }
          if (nested.pop() !== marker) return 'unsupported';
        } else if (['$', '$?', '$~', '$!', '&'].includes(marker)) nested.push(marker === '&' ? '/&' : '/$');
      }
      discarded.push(end);
      if (discarded.length > GAMING_HTML_EVIDENCE_LIMITS.elements) return 'unsupported';
    }
    if (!end) return 'unsupported';
    // Validate the complete plan before moving any nodes. A nested slot inside
    // a fallback is not interchangeable with a slot supplied in its bucket.
    const discardedSet = new Set(discarded);
    for (const candidate of slots) {
      if (candidate === slot) continue;
      for (let ancestor: Element | null = candidate; ancestor; ancestor = ancestor.parent) {
        if (++scanSteps > GAMING_HTML_EVIDENCE_LIMITS.elements || deadlineExpired()) return 'unsupported';
        if (discardedSet.has(ancestor)) return 'unsupported';
      }
    }
    for (const element of discarded) removed.add(element);
    plans.push({ start, removed: discarded, bucket });
    availableBuckets.add(bucket);
  }
  if (deadlineExpired()) return 'unsupported';
  for (const plan of plans) {
    // Consume only the protocol's hidden transport wrapper. Destination
    // ancestry and hidden/restricted descendants remain under normal policy.
    $(plan.removed[0]).before($(plan.bucket).contents());
    $(plan.removed).remove();
    $(plan.bucket).remove();
    plan.start.data = '$';
  }
  return 'restored';
}

function text(value: string): string {
  return value.normalize('NFKC').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060\u2066-\u2069\ufeff]/g, ' ').replace(/\s+/g, ' ').trim();
}
function closed(element: Element): boolean {
  return Boolean((element as LocatedElement).sourceCodeLocation?.endTag);
}
function cleanElementText($: CheerioAPI, element: Element): string {
  const copy = $(element).clone();
  copy.find('script,style,template,table,ul,ol,dl').remove();
  copy.find('blockquote').prepend(' ').append(' ');
  copy.find('br').replaceWith('\n');
  return text(copy.text());
}
function listElementText($: CheerioAPI, element: Element): string {
  const copy = $(element).clone();
  copy.find('script,style,template,table,ul,ol,dl').remove();
  copy.find('blockquote').prepend('\n').append('\n');
  copy.find('br').replaceWith('\n');
  copy.find('p,div').append('\n');
  return copy.text().split('\n').map(text).filter(Boolean).join('\n');
}
function eligible($: CheerioAPI, element: Element): boolean {
  const node = $(element);
  if (node.closest(EXCLUDED).length || node.closest('blockquote').length) return false;
  const discussion = node.closest(DISCUSSION);
  // Schema is only a bounded selection hint. It never establishes authority or freshness.
  const unrelated = node.closest(UNRELATED_DISCUSSION);
  if (unrelated.length && (!discussion.length || (!discussion.is('article') && !discussion.closest('main,[role="main"]').length)
    || !discussion.parents().toArray().includes(unrelated.get(0)!))) return false;
  return true;
}
function unique(values: string[]): string[] { return [...new Set(values.filter(Boolean))]; }

/** A closed source label owns its following list, including bounded layout
 * wrappers. Independent sections and intervening headings are scope boundaries. */
function applicabilityListLabel($: CheerioAPI, list: Element): ApplicabilityListLabel | undefined {
  let current = $(list);
  let complete = true;
  const exhausted = (): ApplicabilityListLabel => ({ label: '', complete: false, preserveOnly: true, exhausted: true });
  for (let depth = 0; depth < APPLICABILITY_LAYOUT_LIMITS.ancestors && current.length; depth++, current = current.parent()) {
    if (depth > 0 && current.is('article,main,figure,body,html')) return undefined;
    const previous = current.prevAll().toArray();
    for (const sibling of previous.slice(0, APPLICABILITY_LAYOUT_LIMITS.siblings)) {
      // A heading can own the following section, but a separate sibling section
      // cannot lend its internal label to another independent section/list.
      if ($(sibling).is('section,article,main,figure,ul,ol,dl,table')) return undefined;
      const value = cleanElementText($, sibling);
      if (!value) continue;
      const match = APPLICABILITY_LIST_LABEL.exec(value);
      if (match) {
        const sourceLabel = match[1].toLowerCase();
        return { label: /^platforms?$/u.test(sourceLabel) ? 'Platforms'
          : /^regions?$/u.test(sourceLabel) ? 'Regions' : /^editions?$/u.test(sourceLabel) ? 'Edition'
            // The structural evidence vocabulary already maps Version to Patch.
            : /^(?:versions?|patch(?:es)?)$/u.test(sourceLabel) ? 'Patch' : 'Source use',
          complete: complete && closed(sibling), preserveOnly: /^(?:source use|usage restrictions)$/u.test(sourceLabel) };
      }
      if ($(sibling).is('h1,h2,h3,h4,h5,h6,section,article,main,figure,ul,ol,dl,table')) return undefined;
      complete = false;
    }
    if (previous.length > APPLICABILITY_LAYOUT_LIMITS.siblings) return exhausted();
    if (depth > 0 && current.is('section')) return undefined;
  }
  return current.length ? exhausted() : undefined;
}

/** Parse only the already acquired HTML. There is no fetch, script evaluation, or question input. */
export function extractGamingHtmlEvidence(input: GamingEvidenceExtractionInput): GamingHtmlEvidenceExtractionResult {
  const result: GamingHtmlEvidenceExtractionResult = {
    units: [], attempts: [], subreasons: [], truncated: Boolean(input.transportTruncated),
    inputBytes: Buffer.byteLength(input.body, 'utf8'), outputChars: 0
  };
  const htmlContent = ['text/html', 'application/xhtml+xml'].includes(input.contentType);
  // The downstream prose extractor parses accepted plaintext and responses
  // without a media type as HTML too. Inspect that same DOM interpretation
  // before selectors can omit a tainted block; retain their prose-only contract.
  if (!htmlContent && !['text/plain', ''].includes(input.contentType)) return result;
  const limit = GAMING_HTML_EVIDENCE_LIMITS;
  const fail = (reason: string) => { if (!result.subreasons.includes(reason)) result.subreasons.push(reason); };
  const deadlineExpired = () => {
    if (input.deadlineAt === undefined || Date.now() < input.deadlineAt) return false;
    result.truncated = true; result.proseBody = '';
    fail('extraction_budget_exhausted');
    return true;
  };
  if (deadlineExpired()) return result;
  if (input.body.length > limit.htmlChars || countGamingHtmlElements(input.body, limit.elements) > limit.elements) {
    result.truncated = true; result.proseBody = ''; fail('extraction_budget_exhausted'); return result;
  }
  if (deadlineExpired()) return result;
  // Plain text without tag/entity openers has no DOM-only interpretation to
  // inspect. Scan the complete accepted body while avoiding a second large OCR
  // parse; any possible markup or entity still takes the parser-owned path.
  if (!htmlContent && !/[<&]/u.test(input.body)) {
    const visibleText = text(input.body);
    if (GAMING_SOURCE_USE_RESTRICTION.test(visibleText)) result.sourceUseRestricted = true;
    if (filterGamingDocumentInstructions(input.body) !== visibleText) fail('source_instruction_filtered');
    deadlineExpired();
    return result;
  }
  // Runtime Cheerio uses parse5; the repository's legacy ambient types omit its location option.
  const parseOptions = { sourceCodeLocationInfo: true };
  const $ = load(input.body, parseOptions as Parameters<typeof load>[1]);
  preservePrimaryContentSidebarLayouts($, gamingDocumentFetchOptions(input.sourceUrl).primaryContentSelectors);
  if (deadlineExpired()) return result;
  const visibleBody = $('body').clone();
  visibleBody.find('script,style,template,noscript').remove();
  // Match visible block separation before normalization: adjacent paragraphs
  // cannot join "previous" and "instructions" into a different word and evade
  // the full-response security scan after the context ceiling.
  visibleBody.find('br').replaceWith('\n');
  visibleBody.find('p,div,section,article,main,header,footer,nav,aside,li,dt,dd,table,tr,td,th,h1,h2,h3,h4,h5,h6')
    .prepend('\n').append('\n');
  const rawVisibleText = visibleBody.text();
  const visibleText = text(rawVisibleText);
  // The context projection can omit a long article's tail or its title. Scan the
  // entire bounded visible response before selection so omitted instructions
  // cannot make a partially sanitized document eligible for grounding.
  const rawTitle = $('title').first().text();
  // Cheerio preserves adjacent inline text and decodes entities. Inspect the
  // full visible response before source furniture or navigation can disappear.
  if (GAMING_SOURCE_USE_RESTRICTION.test(visibleText) || GAMING_SOURCE_USE_RESTRICTION.test(text(rawTitle)))
    result.sourceUseRestricted = true;
  if ([[rawVisibleText, visibleText], [rawTitle, text(rawTitle)]].some(([raw, normalized]) =>
    filterGamingDocumentInstructions(raw) !== normalized)) fail('source_instruction_filtered');
  if (deadlineExpired()) return result;
  if (!htmlContent) return result;
  const stream = restoreStaticStream($, deadlineExpired);
  if (deadlineExpired()) return result;
  if (stream === 'unsupported' || stream === 'restored' && input.transportTruncated) {
    result.proseBody = ''; fail('unsupported_streamed_html'); return result;
  }
  const applicabilityLists = new Map<Element, ApplicabilityListLabel | undefined>();
  for (const list of $('ul,ol').toArray().slice(0, limit.lists)) {
    if (deadlineExpired()) return result;
    const applicability = eligible($, list) ? applicabilityListLabel($, list) : undefined;
    applicabilityLists.set(list, applicability);
    if (applicability?.exhausted) { result.applicabilityUnverified = true; fail('applicability_scope_unverified'); }
  }
  // A label-only linked article is catalog navigation, not a source-wide game
  // declaration or a structured gameplay record. Inspect the complete response
  // above first; omission cannot erase source instructions or use restrictions.
  for (const item of $('li').toArray()) {
    if (deadlineExpired()) return result;
    const node = $(item);
    const parentList = node.closest('ul,ol').get(0);
    // Unknown/exhausted list layouts remain visible; a labelled applicability
    // value cannot become disposable navigation merely because it is linked.
    if (!parentList || !applicabilityLists.has(parentList) || applicabilityLists.get(parentList)) continue;
    if (!closed(item) || node.children('ul,ol,dl,table').length || node.find('ul,ol,dl,table').length) continue;
    const anchors = node.find('a[href]');
    if (!anchors.length || anchors.length > 16 || anchors.toArray().some(anchor => !closed(anchor))) continue;
    const structuredLabel = listElementText($, item);
    const label = text(structuredLabel);
    if (!label || label.length > GAMING_HTML_EVIDENCE_LIMITS.unitChars
      || [...structuredLabel.matchAll(/(?:^|[;|\n])\s*([^:;|\n]{1,80}):/gu)].some(match => RECORD_FIELD_LABEL.test(match[1])
        || /^(?:platforms?|regions?|effective(?: from| until)?|published(?: at)?|source updated(?: at)?|last updated|season|current (?:patch|build|season)|valid (?:from|until))$/iu.test(match[1]))
      // Linked facts, short steps and version/date-bearing release entries are
      // authored evidence even if their entire visible text is a single link.
      || /[.!?](?:\s|$)|\p{N}/u.test(label)
      || /\b(?:patch(?:es)?|builds?|updates?|releases?|versions?|seasons?|platforms?|effective|published|updated|baseline|supersedes)\b/iu.test(label)
      || /^(?:(?:first|next|then)[,:]?\s+)?(?:to\s+|attack\b|avoid\b|block\b|collect\b|defeat\b|dodge\b|equip\b|explore\b|follow\b|gather\b|heal\b|jump\b|move\b|open\b|press\b|restore\b|save\b|select\b|spend\b|upgrade\b|use\b|wait\b|this\s+(?:guide|article|page|document|source)\b)/iu.test(label)
      || /\b(?:is|are|was|were|has|have|only|not|no|without|except|requires?|costs?|grants?|unlocks?|available|must|should)\b/iu.test(label)
      || hasGamingActionableProse(label) || gamingAttributableClaimText(label)) continue;
    const remainder = node.clone();
    remainder.find('a[href]').remove();
    if (/^[\s|/,:;.!?()[\]{}•–—-]*$/u.test(remainder.text())) node.remove();
  }
  if (deadlineExpired()) return result;
  // Inspect the complete visible response above before omitting existing
  // publisher furniture from either structured records or the prose fallback.
  for (const selector of gamingDocumentExtractionProfile(input.sourceUrl)?.removeSelectors ?? []) $(selector).remove();
  if (deadlineExpired()) return result;
  // A named article topic linked after a spaced editorial separator is a local
  // reference, rather than a new source-wide game title. Preserve the paragraph
  // here; request projection can exclude only that frame after matching game
  // identity. Never annotate declarations, requirements, edition or record fields.
  const localTopicReferences: NonNullable<GamingHtmlEvidenceExtractionResult['localTopicReferences']> = [];
  const referenceAnchors = $('p > a[href]').toArray().slice(0, 256);
  const paragraphTexts = new Map<Element, string>();
  const paragraphTextFor = (paragraph: Element): string => {
    let value = paragraphTexts.get(paragraph);
    if (value === undefined) { value = text($(paragraph).text()); paragraphTexts.set(paragraph, value); }
    return value;
  };
  const matchingParagraphs = new Map<string, Element[]>();
  for (const anchor of referenceAnchors) {
    const value = paragraphTextFor($(anchor).parent().get(0)!);
    if (value.length <= 512) matchingParagraphs.set(value, []);
  }
  // Count plain as well as linked equal paragraphs. A textual copy cannot move
  // a parser annotation onto an unlinked scope at an earlier occurrence.
  for (const paragraph of matchingParagraphs.size ? $('p').toArray() : []) {
    if (deadlineExpired()) return result;
    const matches = matchingParagraphs.get(paragraphTextFor(paragraph));
    if (matches && eligible($, paragraph)) matches.push(paragraph);
  }
  const paragraphOccurrences = new Map<Element, { occurrence: number; count: number }>();
  for (const matches of matchingParagraphs.values()) for (const [occurrence, paragraph] of matches.entries())
    paragraphOccurrences.set(paragraph, { occurrence, count: matches.length });
  for (const anchor of referenceAnchors) {
    if (deadlineExpired()) return result;
    const paragraph = $(anchor).parent().get(0)!;
    const paragraphText = paragraphTextFor(paragraph);
    const topic = text($(anchor).text());
    const preceding = anchor.prev?.type === 'text' ? text($(anchor.prev).text()) : '';
    if (!closed(anchor) || !closed(paragraph) || !eligible($, paragraph)
      || paragraphText.length > 512 || !topic || topic.length > 120
      || /\bthis\s+(?:guide|build|walkthrough|article|source|page|document)\s+(?:covers|is\s+(?:for|about)|requires?|needs?|only\s+works)\b/iu.test(paragraphText)
      || /\b(?:game|edition|scope|applicability|patch|platforms?)\s*:/iu.test(paragraphText)
      || /\b(?:only|requires?|needs?|exclusiv\w*|not|never|without|except|edition|dlc|expansion|remake|remaster(?:ed)?)\b/iu.test(paragraphText)
      || hasGamingActionableProse(paragraphText)
      || /\b(?:attack|avoid|block|collect|defeat|dodge|equip|explore|follow|gather|heal|jump|move|open|press|restore|save|select|spend|upgrade|use|wait|costs?|grants?|unlocks?|deals?|inflicts?)\b/iu.test(paragraphText)
      || /^(?:ii|iii|iv|\d+|classic)\b/iu.test(topic)) continue;
    const scopes = [...preceding.matchAll(/\bin\s+/giu)];
    const scope = scopes.at(-1);
    const match = scope && /^in\s+(?!the\s+game\b)([^.!?;,\n]{1,120}?)\s+[-–—]$/iu.exec(preceding.slice(scope.index));
    if (!match || `${match[1]} - ${topic}`.length > 160) continue;
    // Only the linked nominal frame is projected. Other sentences, named-game
    // scopes and contradictory assertions in the paragraph remain inspectable.
    const framePrefix = preceding.slice(scope!.index);
    const frame = `${framePrefix} ${topic}`;
    const occurrence = paragraphOccurrences.get(paragraph);
    const children = $(paragraph).contents().toArray();
    const prefix = text(children.slice(0, children.indexOf(anchor)).map(child => $(child).text()).join(''));
    const frameStart = prefix.length - framePrefix.length;
    if (!occurrence || frameStart < 0 || paragraphText.slice(frameStart, frameStart + frame.length) !== frame) continue;
    const reference = { text: frame, paragraphText, paragraphOccurrence: occurrence.occurrence,
      paragraphCount: occurrence.count, frameStart, gameHash: createHash('sha256')
      .update(normalizeGamingComparableIdentity(match[1].trim())).digest('hex') };
    localTopicReferences.push(reference);
    if (localTopicReferences.length >= 64) break;
  }
  if (localTopicReferences.length) result.localTopicReferences = localTopicReferences;
  if (visibleText.length <= 300 && /\b(?:verify (?:that )?you are human|checking your browser|enable javascript and cookies to continue|sign in to continue|log in to continue)\b/iu.test(visibleText)) {
    result.proseBody = ''; fail('access_challenge'); return result;
  }
  if (!visibleText && $('noscript').text().match(/\b(?:enable|requires?|needs?)\b.{0,40}\bjavascript\b/iu)) {
    result.proseBody = ''; fail('script_rendering_required'); return result;
  }
  if (!visibleText && $('body img,body canvas').length && !$('script[type="application/json"],script[type="application/ld+json"]').length) {
    result.proseBody = ''; fail('image_only_content'); return result;
  }
  const elementIndex = new Map<Element, number>();
  const idElements = new Map<string, Element[]>();
  $('*').each((index, node) => {
    elementIndex.set(node, index);
    const id = $(node).attr('id');
    if (id) idElements.set(id, [...(idElements.get(id) ?? []), node]);
  });
  const contextReasons = new Map<string, string[]>();
  const markContext = (scope: string, reason: string) => contextReasons.set(scope, unique([...(contextReasons.get(scope) ?? []), reason]));
  const removedProseElements = new Set<Element>();
  const intactTransportScope = (element: Element) => !input.transportTruncated
    || $(element).parents('section,article,figure').toArray().some(closed);
  const exhausted = () => {
    const stopped = result.units.length >= limit.units || result.outputChars >= limit.outputChars
      || (input.deadlineAt !== undefined && Date.now() >= input.deadlineAt);
    if (stopped) { result.truncated = true; fail('extraction_budget_exhausted'); }
    return stopped;
  };
  const identities = new Set<string>();
  const qualifierValues = new Map<Element, string>();
  const qualifierSelector = 'p,figcaption,small,[role="note"],div,span';
  const standaloneSpans = new Map<Element, Set<Element>>();
  function standaloneSpan(element: Element): boolean {
    const parent = $(element).parent();
    if (!parent.is('body,main,article,section,div')) return false;
    const parentElement = parent.get(0)!;
    let spans = standaloneSpans.get(parentElement);
    if (!spans) {
      spans = new Set<Element>();
      const siblings = parent.contents().toArray().filter(sibling => sibling.type !== 'comment'
        && (sibling.type !== 'text' || text($(sibling).text())));
      const boundary = (sibling: Element | undefined) => !sibling
        || $(sibling).is('p,div,main,article,section,figure,table,ul,ol,dl,h1,h2,h3,h4,h5,h6,script');
      for (const [index, sibling] of siblings.entries()) {
        if ($(sibling).is('span') && boundary(siblings[index - 1]) && boundary(siblings[index + 1])) spans.add(sibling);
      }
      standaloneSpans.set(parentElement, spans);
    }
    return spans.has(element);
  }
  const qualifierBlockEligibility = new Map<Element, boolean>();
  const formattedQualifierBlocks = new Map<Element, boolean>();
  const inlineQualifierSelector = 'span,b,strong,em,i,small,br';
  function formattedQualifierBlock(element: Element): boolean {
    const cached = formattedQualifierBlocks.get(element);
    if (cached !== undefined) return cached;
    const node = $(element);
    const inlineOnly = node.is('div,span') && !node.closest('aside').length && node.children().length > 0
      && (!node.is('span') || standaloneSpan(element))
      && node.children().toArray().every(child => $(child).is(inlineQualifierSelector))
      && node.find('*').toArray().every(child => $(child).is(inlineQualifierSelector));
    const value = inlineOnly ? text(node.text()) : '';
    const formatted = inlineOnly && (QUALIFIER.exec(value)?.index === 0
      || COMPARISON_PROSE.test(value) && PRIMARY_RECORD_QUALIFICATION.test(value));
    formattedQualifierBlocks.set(element, formatted);
    return formatted;
  }
  const qualifierBlock = (_: number, element: Element) => {
    const cached = qualifierBlockEligibility.get(element);
    if (cached !== undefined) return cached;
    const eligible = !$(element).parents('div,span').toArray().some(formattedQualifierBlock)
      && (!$(element).is('div,span') || $(element).is('[role="note"]') || formattedQualifierBlock(element)
        || !$(element).closest('aside').length && !$(element).children().length && (!$(element).is('span') || standaloneSpan(element)));
    qualifierBlockEligibility.set(element, eligible);
    return eligible;
  };
  function nearbyQualifiers(node: cheerio.Cheerio): cheerio.Cheerio {
    const nearby = node.prevAll('p,aside,div,span,small').slice(0, 2).add(node.nextAll('p,aside,div,span,small').slice(0, 2));
    return nearby.add(nearby.find(qualifierSelector).filter(qualifierBlock));
  }
  function context(element: Element, scope: string, caption?: string, ancestorLimit = 6): GamingEvidenceUnit['context'] {
    const node = $(element);
    let heading: string | undefined;
    let current = node;
    for (let level = 0; level < ancestorLimit && current.length && !heading; level++, current = current.parent()) {
      const candidate = current.prevAll('h1,h2,h3,h4,h5,h6').first();
      if (candidate.length) heading = text(candidate.text());
      if (!heading && current.is('section,article,main')) heading = text(current.children('h1,h2,h3,h4,h5,h6').add(current.children('header').find('h1,h2,h3,h4,h5,h6')).first().text()) || undefined;
    }
    const qualifiers: string[] = [];
    const post = node.closest(DISCUSSION).first();
    const container = node.closest('section,article,main,figure').first();
    const ancestors = node.parents().toArray();
    // The nearest whole-article scope already supplies its bounded notes below.
    // Plain publisher wrappers do not imply that an unseen semantic scope exists.
    const wholeArticleContext = container.is('article,main') && !node.parents('section,figure').length;
    if (!heading && wholeArticleContext) heading = text(container.children('h1,h2,h3,h4,h5,h6')
      .add(container.children('header').find('h1,h2,h3,h4,h5,h6')).first().text()) || undefined;
    let relevant = nearbyQualifiers(node);
    let ancestor = node.parent();
    for (let depth = 0; depth < ancestorLimit && ancestor.length && !ancestor.is('html'); depth++, ancestor = ancestor.parent()) {
      relevant = relevant.add(ancestor.children(qualifierSelector).filter(qualifierBlock)).add(nearbyQualifiers(ancestor));
    }
    if (ancestor.length && !ancestor.is('html') && wholeArticleContext) {
      const enclosingScopes = container.parents('article,main');
      if (enclosingScopes.length > ancestorLimit) markContext(scope, 'required_context_missing');
      // Plain wrappers must not hide notes in an enclosing article/main scope.
      // The candidate-scope check below still excludes independent sibling scopes.
      relevant = relevant.add(enclosingScopes.slice(0, ancestorLimit).find(qualifierSelector).filter(qualifierBlock));
    }
    if (ancestor.length && !ancestor.is('html') && !wholeArticleContext) markContext(scope, 'required_context_missing');
    if (container.length) relevant = relevant.add(container.find(qualifierSelector).filter(qualifierBlock));
    let qualifierElements = 0;
    relevant.each((_, sibling) => {
      if (deadlineExpired()) { markContext(scope, 'required_context_missing'); return false; }
      const selected = $(sibling);
      if (selected.is('span') && !qualifierBlock(0, sibling)) return;
      if (selected.closest(`${GAMING_DOCUMENT_FURNITURE_SELECTOR},blockquote,table:not([role="presentation"]),ul,ol,dl`).length) return;
      const candidateScope = selected.closest('section,article,main,figure').get(0);
      if (candidateScope && candidateScope !== container.get(0) && !ancestors.includes(candidateScope)) return;
      if (selected.closest(UNRELATED_DISCUSSION).length && (!post.length || selected.closest(DISCUSSION).get(0) !== post.get(0))) return;
      // Container wrappers must not import a sibling record or a quoted correction.
      let value = qualifierValues.get(sibling);
      if (value === undefined) {
        const copy = selected.clone();
        // Nested blocks are discovered separately; plain wrappers must not count them again.
        copy.find(qualifierSelector).filter(qualifierBlock).remove();
        copy.find(`script,style,template,table,ul,ol,dl,blockquote,section,article,main,figure,${GAMING_DOCUMENT_FURNITURE_SELECTOR},${UNRELATED_DISCUSSION}`).remove();
        value = text(copy.text());
        qualifierValues.set(sibling, value);
      }
      // Nearby wrappers must obey the same comparison boundary as discovered blocks.
      if (selected.is('div,span') && COMPARISON_PROSE.test(value) && !PRIMARY_RECORD_QUALIFICATION.test(value)) return;
      if (QUALIFIER.test(value)) {
        if (++qualifierElements > 64) { markContext(scope, 'required_context_missing'); return false; }
        qualifiers.push(value);
        if (!closed(sibling) || formattedQualifierBlock(sibling)
          && selected.find('*').toArray().some(child => !$(child).is('br') && !closed(child))) markContext(scope, 'content_truncated');
      }
    });
    const attribution = post.length
      ? text(post.find('[itemprop="author"]').first().text()).slice(0, 160) : undefined;
    if ([heading, caption, ...qualifiers].some((value) => value && value.length > limit.contextChars)) markContext(scope, 'content_truncated');
    return { scope, ...(heading ? { heading: heading.slice(0, limit.contextChars) } : {}), ...(caption ? { caption: caption.slice(0, limit.contextChars) } : {}),
      ...(qualifiers.length ? { qualifiers: unique(qualifiers).map((value) => value.slice(0, limit.contextChars)) } : {}), ...(attribution ? { attribution } : {}) };
  }
  function addUnit(kind: GamingEvidenceUnit['kind'], fields: Fields, node: Element,
    strategy: GamingEvidenceUnit['provenance']['strategy'], unitContext: GamingEvidenceUnit['context'], reasons: string[] = []) {
    if (exhausted() || !fields.length) return;
    const integrityReasons = [...reasons, ...(contextReasons.get(unitContext.scope.split('/')[0]) ?? [])];
    if ($(node).find('blockquote').length) integrityReasons.push('ambiguous_field_mapping', 'quoted_content_ambiguous');
    if ((unitContext.qualifiers?.length ?? 0) > 16) {
      integrityReasons.push('content_truncated');
      unitContext = { ...unitContext, qualifiers: unitContext.qualifiers!.slice(0, 16) };
    }
    if (fields.length > limit.fields || fields.some((field) => field.value.length > limit.fieldChars || field.label.length > 160)) integrityReasons.push('content_truncated');
    fields = fields.slice(0, limit.fields).map((field) => ({ label: field.label.slice(0, 160), value: field.value.slice(0, limit.fieldChars) }));
    if (fields.some((field) => !field.label || !field.value)) integrityReasons.push('incomplete_record');
    const labels = fields.map((field) => field.label.toLowerCase());
    if (new Set(labels).size !== labels.length) integrityReasons.push('ambiguous_field_mapping');
    const parts = [unitContext.heading, unitContext.caption, unitContext.attribution ? `Reported by ${unitContext.attribution}` : undefined,
      fields.map((field) => `${field.label}: ${field.value}`).join('; '), ...(unitContext.qualifiers ?? [])].filter(Boolean);
    const fullText = parts.join('; ');
    // Do not filter a malicious clause and then advertise the remaining record as intact.
    if (filterGamingDocumentInstructions(fullText) !== text(fullText)) { fail('source_instruction_filtered'); return; }
    if (fullText.length > limit.unitChars) integrityReasons.push('content_truncated');
    if (result.outputChars + Math.min(fullText.length, limit.unitChars) > limit.outputChars) { result.truncated = true; fail('extraction_budget_exhausted'); return; }
    const serialized = fullText.slice(0, limit.unitChars);
    const status = integrityReasons.includes('ambiguous_field_mapping') ? 'ambiguous' : integrityReasons.length ? 'partial' : 'complete';
    const identity = JSON.stringify({ kind, fields, heading: unitContext.heading, caption: unitContext.caption,
      qualifiers: unitContext.qualifiers, attribution: unitContext.attribution });
    if (identities.has(identity)) return;
    identities.add(identity);
    const locator = `${strategy}:element:${elementIndex.get(node) ?? 0}`;
    const id = createHash('sha256').update(`${GAMING_EVIDENCE_UNIT_POLICY_VERSION}\n${input.sourceUrl}\n${unitContext.scope}\n${identity}`).digest('hex').slice(0, 24);
    result.units.push({ id, kind, text: serialized, fields, context: unitContext,
      provenance: { sourceUrl: input.sourceUrl, strategy, policyVersion: GAMING_EVIDENCE_UNIT_POLICY_VERSION, locator, representation: 'html_dom' },
      integrity: { status, reasons: unique(integrityReasons) } });
    result.outputChars += serialized.length;
    for (const reason of integrityReasons) fail(reason);
  }

  // DOM block boundaries survive text flattening through parser-owned metadata.
  // These paragraph units never establish gameplay facts or structural support.
  for (const [index, paragraph] of $('p,div,span').toArray().entries()) {
    if (exhausted()) break;
    if (!eligible($, paragraph) || $(paragraph).closest('table:not([role="presentation"]),ul,ol,dl').length) continue;
    const metadataBlock = !$(paragraph).is('p');
    const inlineSelector = 'span,b,strong,em,i,small,br';
    if (metadataBlock && ($(paragraph).children().toArray().some(element => !$(element).is(inlineSelector))
      || $(paragraph).is('span') && !standaloneSpan(paragraph))) continue;
    const inlineMetadata = metadataBlock ? $(paragraph).find('*').toArray() : [];
    // Only harmless inline formatting can extend a metadata block; records and wrappers cannot.
    if (metadataBlock && (inlineMetadata.some(element => !$(element).is(inlineSelector))
      || $(paragraph).find(GAMING_DOCUMENT_FURNITURE_SELECTOR).length)) continue;
    const paragraphText = cleanElementText($, paragraph);
    if (!PARAGRAPH_IDENTITY_FIELD.test(paragraphText)) continue;
    if (filterGamingDocumentInstructions(paragraphText) !== paragraphText) { fail('source_instruction_filtered'); continue; }
    const fields: Fields = [];
    let remaining = paragraphText;
    while (fields.length <= limit.fields) {
      const declaration = remaining.match(PARAGRAPH_IDENTITY_FIELD);
      if (!declaration) break;
      fields.push({ label: declaration[1], value: declaration[2].trim() });
      remaining = remaining.slice(declaration[0].length).replace(/^\s*;\s*/u, '').trimStart();
    }
    const reasons = !closed(paragraph) || !intactTransportScope(paragraph) ? ['content_truncated'] : [];
    if (inlineMetadata.some(element => !$(element).is('br') && !closed(element))) reasons.push('content_truncated');
    if ($(paragraph).find('table,ul,ol,dl,blockquote').length) reasons.push('required_context_missing');
    addUnit('paragraph', fields, paragraph, 'prose',
      { scope: `paragraph:${index}` }, reasons);
  }

  result.attempts.push('html_table');
  const tables = $('table').toArray();
  for (const table of tables) {
    // Explicit layout tables may wrap primary prose. Their nested data tables
    // still follow the normal record-removal and integrity policy.
    if ($(table).attr('role') !== 'presentation' || !closed(table) || !intactTransportScope(table)) removedProseElements.add(table);
  }
  if (tables.length > limit.tables) { result.truncated = true; fail('extraction_budget_exhausted'); }
  let expandedCells = 0;
  for (const [tableIndex, table] of tables.slice(0, limit.tables).entries()) {
    if (exhausted()) break;
    if (!eligible($, table) || $(table).attr('role') === 'presentation' || $(table).closest('tfoot').length) continue;
    const scope = `table:${tableIndex}`;
    const caption = text($(table).children('caption').first().text());
    const unitContext = context(table, scope, caption);
    const footerText = text($(table).children('tfoot').text());
    if (footerText) {
      unitContext.qualifiers = unique([...(unitContext.qualifiers ?? []), footerText.slice(0, limit.contextChars)]);
      if (footerText.length > limit.contextChars || !closed($(table).children('tfoot').first().get(0)!)) markContext(scope, 'content_truncated');
    }
    // Footer content qualifies body records; it cannot supply record fields or headers.
    const rows = $(table).find('tr').toArray().filter((row) => $(row).closest('table').get(0) === table && !$(row).closest('tfoot').length);
    const grid: Array<Array<{ element: Element; row: number; column: number; colSpan: number } | undefined>> = [];
    const rowReasons: string[][] = [];
    const headers = new Map<string, Element[]>();
    $(table).find('th[id]').each((_, th) => {
      if ($(th).closest('table').get(0) !== table || $(th).closest('tfoot').length) return;
      const id = $(th).attr('id')!;
      headers.set(id, [...(headers.get(id) ?? []), th]);
    });
    if (rows.length > limit.rowsPerTable) { result.truncated = true; fail('extraction_budget_exhausted'); }
    let invalidSpan = false;
    for (const [rowIndex, row] of rows.slice(0, limit.rowsPerTable).entries()) {
      grid[rowIndex] ??= [];
      rowReasons[rowIndex] = [];
      if (!closed(row) || !closed(table) || !intactTransportScope(table)) rowReasons[rowIndex].push('content_truncated');
      let column = 0;
      for (const cell of $(row).children('td,th').toArray()) {
        while (grid[rowIndex][column]) column++;
        const span = (attribute: string) => {
          const raw = $(cell).attr(attribute);
          return raw === undefined ? 1 : /^\d{1,3}$/.test(raw) ? Number(raw) : 0;
        };
        const rowSpan = span('rowspan'); const colSpan = span('colspan');
        if (rowSpan < 1 || colSpan < 1 || rowSpan > limit.span || colSpan > limit.span || column + colSpan > limit.columns
          || rowIndex + rowSpan > Math.min(rows.length, limit.rowsPerTable) || expandedCells + rowSpan * colSpan > limit.expandedCells) {
          invalidSpan = true; break;
        }
        if (!closed(cell)) rowReasons[rowIndex].push('content_truncated');
        if ($(cell).find('table').length || ($(cell).is('td') && colSpan > 1)) rowReasons[rowIndex].push('ambiguous_field_mapping');
        for (let down = 0; down < rowSpan; down++) {
          grid[rowIndex + down] ??= [];
          for (let across = 0; across < colSpan; across++) {
            if (grid[rowIndex + down][column + across]) invalidSpan = true;
            grid[rowIndex + down][column + across] = { element: cell, row: rowIndex, column, colSpan };
            expandedCells++;
          }
        }
        column += colSpan;
      }
      if (invalidSpan) break;
    }
    if (invalidSpan) { fail('ambiguous_field_mapping'); continue; }
    let headerRows = 0;
    while (headerRows < grid.length && grid[headerRows]?.length && grid[headerRows].every((cell) => cell && $(cell.element).is('th') && $(cell.element).attr('scope') !== 'row')) headerRows++;
    // Without column-record boundaries, an omitted property row can qualify
    // the entire table. Explicit headers cannot make its inspected prefix whole.
    if (!headerRows && rows.length > limit.rowsPerTable) markContext(scope, 'required_context_missing');
    // A property table, like a definition list, explicitly binds labels and
    // values inside one record container. Never combine independent row groups,
    // mixed column tables or spanning cells into an inferred tuple.
    const propertyTable = !headerRows && grid.length > 0 && rows.length === grid.length
      && new Set(rows.map(row => $(row).parent().get(0))).size === 1
      && grid.every((cells, rowIndex) => cells.length === 2 && cells.every(cell => cell && cell.row === rowIndex
        && cell.colSpan === 1 && Number($(cell.element).attr('rowspan') ?? 1) === 1)
        && $(cells[0]!.element).is('th[scope="row"]') && $(cells[1]!.element).is('td'));
    const propertyFields: Fields = [];
    const propertyReasons: string[] = [];
    const propertyQualifiers: string[] = [];
    for (let rowIndex = headerRows; rowIndex < grid.length && !exhausted(); rowIndex++) {
      const cells = grid[rowIndex];
      if (!cells?.length) continue;
      const fields: Fields = [];
      const reasons = [...(rowReasons[rowIndex] ?? [])];
      if (headerRows && cells.length < Math.max(...grid.slice(0, headerRows).map((headerRow) => headerRow.length))) reasons.push('incomplete_record');
      const qualifiers = [...(unitContext.qualifiers ?? [])];
      const visited = new Set<Element>();
      const rowHeader = propertyTable ? cells[0]!.element : undefined;
      for (const [column, cell] of cells.entries()) {
        if (!cell) { reasons.push('incomplete_record'); continue; }
        if (cell.element === rowHeader) continue;
        if (visited.has(cell.element)) continue;
        visited.add(cell.element);
        if (!closed(cell.element)) reasons.push('content_truncated');
        const explicit = ($(cell.element).attr('headers') ?? '').split(/\s+/).filter(Boolean);
        const columnHeaders = explicit.length ? explicit.map((id) => headers.get(id)?.length === 1 ? headers.get(id)![0] : undefined)
          : rowHeader ? [rowHeader] : grid.slice(0, headerRows).map((headerRow) => headerRow[column]?.element);
        if (explicit.length && columnHeaders.some((header) => !header)) reasons.push('ambiguous_field_mapping');
        if ($(cell.element).find('table,ul,ol,dl').length || columnHeaders.some((header) => header && $(header).find('table,ul,ol,dl').length)) reasons.push('required_context_missing');
        if (columnHeaders.some((header) => header && $(header).find('blockquote').length)) reasons.push('ambiguous_field_mapping', 'quoted_content_ambiguous');
        const label = unique(columnHeaders.filter((header): header is Element => Boolean(header)).map((header) => cleanElementText($, header))).join(' / ');
        if (!label) reasons.push('ambiguous_field_mapping');
        fields.push({ label, value: cleanElementText($, cell.element) });
        const footnoteLinks = (rowHeader ? $(cell.element).add(rowHeader) : $(cell.element)).find('a[href^="#"]');
        if (footnoteLinks.length > 8) reasons.push('required_context_missing');
        footnoteLinks.slice(0, 8).each((_, link) => {
          const targetId = $(link).attr('href')!.slice(1);
          const targets = idElements.get(targetId) ?? [];
          if (targets.length !== 1 || !closed(targets[0])) { reasons.push('required_context_missing'); return; }
          const qualifier = text($(targets[0]).text());
          if (qualifier.length > limit.contextChars) reasons.push('content_truncated');
          qualifiers.push(qualifier.slice(0, limit.contextChars));
        });
      }
      if (propertyTable) {
        propertyFields.push(...fields); propertyReasons.push(...reasons); propertyQualifiers.push(...qualifiers);
      } else addUnit('table_row', fields, rows[rowIndex], 'html_table', { ...unitContext, scope: `${scope}/row:${rowIndex}`, ...(qualifiers.length ? { qualifiers: unique(qualifiers) } : {}) }, reasons);
    }
    if (propertyTable) addUnit('table_row', propertyFields, table, 'html_table',
      { ...unitContext, scope: `${scope}/properties`, ...(propertyQualifiers.length ? { qualifiers: unique(propertyQualifiers) } : {}) }, unique(propertyReasons));
  }

  result.attempts.push('html_list', 'html_definition');
  const lists = $('ul,ol,dl').toArray();
  const consumedNestedLists = new Set<Element>();
  if (lists.length > limit.lists) {
    result.truncated = true; result.applicabilityUnverified = true;
    fail('extraction_budget_exhausted'); fail('applicability_scope_unverified');
  }
  function parseFields(value: string): Fields {
    const fields: Fields = [];
    for (const part of value.split(/[;|\n]+/).map((part) => part.trim()).filter(Boolean)) {
      const match = part.match(LABELLED_FIELD);
      if (match) fields.push({ label: text(match[1]), value: text(match[2]) });
      else if (fields.length) fields[fields.length - 1].value += `; ${text(part)}`;
      else fields.push({ label: '', value: text(part) });
    }
    return fields;
  }
  for (const [listIndex, list] of lists.slice(0, limit.lists).entries()) {
    if (exhausted()) break;
    if (!eligible($, list) || $(list).closest('table:not([role="presentation"])').length || consumedNestedLists.has(list)) continue;
    const scope = `list:${listIndex}`;
    const applicability = applicabilityLists.get(list);
    // Metadata association and its qualifier inspection share one bound. Other
    // structural records retain their established context limit.
    const unitContext = context(list, scope, undefined,
      applicability && !applicability.exhausted ? APPLICABILITY_LAYOUT_LIMITS.ancestors : 6);
    if (applicability && !applicability.preserveOnly) {
      const items = $(list).find('li').toArray().filter(item => !$(item).find('ul,ol,dl,table').length);
      const repeatedLabel = new RegExp(`^(?:${applicability.label === 'Platforms' ? 'Platforms?' : applicability.label === 'Regions' ? 'Regions?'
        : applicability.label === 'Patch' ? 'Patch|Version' : applicability.label}):\\s*`, 'iu');
      const values = items.slice(0, limit.fields).map(item => listElementText($, item).replace(repeatedLabel, ''));
      const reasons = !applicability.complete || !closed(list) || !intactTransportScope(list)
        || items.some(item => !closed(item) || $(item).find('*').toArray().some(child => !$(child).is('br,img') && !closed(child)))
        ? ['content_truncated'] : [];
      if (!values.length || values.some(value => !value)) reasons.push('incomplete_record');
      if (items.length > limit.fields) reasons.push('content_truncated');
      if ($(list).find('ul,ol,dl,table').length
        || !['Platforms', 'Regions'].includes(applicability.label) && values.length !== 1) reasons.push('ambiguous_field_mapping');
      const explicitFields = values.some(value => value.split(/[;|\n]+/u).some(part => LABELLED_FIELD.test(part.trim())));
      // Other explicit fields retain the ordinary record parser and its Game/
      // Edition vetoes. Their surrounding applicability cannot become absent.
      addUnit('paragraph', [{ label: applicability.label, value: explicitFields ? '' : values.join(', ') }], list, 'html_list',
        { ...unitContext, scope: `${scope}/applicability` }, [...reasons, ...(explicitFields ? ['incomplete_record'] : [])]);
      if (!explicitFields) {
        removedProseElements.add(list);
        for (const nestedList of $(list).find('ul,ol,dl').toArray()) consumedNestedLists.add(nestedList);
        continue;
      }
    }
    if ($(list).is('dl')) {
      removedProseElements.add(list);
      let fields: Fields = []; let reasons: string[] = []; let first: Element = list;
      let recordParent: Element | undefined;
      const flush = () => {
        addUnit('definition', fields, first, 'html_definition', { ...unitContext, scope: `${scope}/record:${elementIndex.get(first)}` }, reasons);
        fields = []; reasons = [];
      };
      const entries = $(list).find('dt,dd').toArray().filter((entry) => $(entry).closest('dl').get(0) === list);
      for (let index = 0; index < entries.length && index < limit.units * 2; index++) {
        const entry = entries[index];
        if (!$(entry).is('dt')) continue;
        const parent = $(entry).parent().get(0)!;
        // Explicit wrapper boundaries define separate records, even when their labels would form a tuple.
        if (recordParent && parent !== recordParent) flush();
        recordParent = parent;
        const label = cleanElementText($, entry);
        if (fields.some((field) => field.label.toLowerCase() === label.toLowerCase())) flush();
        if (!fields.length) first = entry;
        const next = entries[index + 1];
        if (!next || !$(next).is('dd') || $(next).parent().get(0) !== parent) { fields.push({ label, value: '' }); reasons.push('ambiguous_field_mapping'); continue; }
        if (!closed(list) || !closed(parent) || !closed(entry) || !closed(next) || !intactTransportScope(list)) reasons.push('content_truncated');
        if ($(entry).find('table,ul,ol,dl').length || $(next).find('table,ul,ol,dl').length) reasons.push('required_context_missing');
        if ($(entry).find('blockquote').length || $(next).find('blockquote').length) reasons.push('ambiguous_field_mapping', 'quoted_content_ambiguous');
        const values = [cleanElementText($, next)];
        index++;
        while (entries[index + 1] && $(entries[index + 1]).is('dd') && $(entries[index + 1]).parent().get(0) === parent) {
          index++;
          if (!closed(entries[index])) reasons.push('content_truncated');
          if ($(entries[index]).find('table,ul,ol,dl').length) reasons.push('required_context_missing');
          if ($(entries[index]).find('blockquote').length) reasons.push('ambiguous_field_mapping', 'quoted_content_ambiguous');
          values.push(cleanElementText($, entries[index]));
        }
        fields.push({ label, value: values.join('; ') });
      }
      flush();
      continue;
    }
    // Each list item is its own record. Only an explicit nested field list inherits its parent item's fields.
    for (const [itemIndex, item] of $(list).children('li').toArray().slice(0, limit.units).entries()) {
      const ownText = listElementText($, item);
      let fields = parseFields(ownText);
      const nested = $(item).children('ul,ol').first();
      if (nested.length) {
        fields = fields.concat(nested.children('li').toArray().flatMap((child) => parseFields(listElementText($, child))));
        consumedNestedLists.add(nested.get(0)!);
        for (const descendant of nested.find('ul,ol,dl').toArray()) consumedNestedLists.add(descendant);
      }
      if (!fields.some((field) => field.label)) continue;
      // A topic-prefixed walkthrough step is still prose, not a one-column
      // record. Retain only independently complete authored sentences; nested,
      // incomplete and explicitly labelled record fields keep structural checks.
      if (fields.length === 1 && !RECORD_FIELD_LABEL.test(fields[0].label)
        && !nested.length && !$(item).find('table,ul,ol,dl,blockquote').length
        && closed(item) && closed(list) && intactTransportScope(list)
        && $(item).find('*').toArray().every(child => $(child).is('br') || closed(child))
        && hasGamingActionableProse(fields[0].value)) {
        fail('narrative_list_prose_retained');
        continue;
      }
      removedProseElements.add(item);
      const reasons = !closed(item) || !closed(list) || !intactTransportScope(list) ? ['content_truncated'] : [];
      // A leading unlabelled line cannot invalidate and erase later explicit
      // scope fields. Preserve it under a non-semantic parser label while the
      // incomplete integrity flag prevents any promotion to gameplay evidence.
      if (fields.some(field => !field.label)) {
        reasons.push('incomplete_record');
        if (fields.some(field => /^(?:game|edition|scope|applicability|patch|version|platforms?|regions?)$/iu.test(field.label))) {
          result.applicabilityUnverified = true;
          fail('applicability_scope_unverified');
        }
        fields = fields.map(field => field.label ? field : { label: 'Unlabelled content', value: field.value });
      }
      if ($(item).find('table,ul,ol,dl').length > (nested.length ? 1 : 0)) reasons.push('ambiguous_field_mapping', 'required_context_missing');
      if (nested.children('li').toArray().some((child) => !closed(child))) reasons.push('content_truncated');
      addUnit('list_item', fields, item, 'html_list', { ...unitContext, scope: `${scope}/item:${itemIndex}` }, reasons);
    }
  }
  for (const element of removedProseElements) $(element).remove();
  // Layout cells themselves cannot be laundered into unstructured assertions.
  // Retain authored prose blocks, not bare tabular values or column headings.
  if (deadlineExpired()) return result;
  const visitedLayoutNodes = new Set<unknown>();
  $('table[role="presentation"] td,table[role="presentation"] th').each((_, cell) => {
    if (deadlineExpired()) return false;
    if (visitedLayoutNodes.has(cell)) return;
    visitedLayoutNodes.add(cell);
    $(cell).find('*').addBack().contents().each((__, child) => {
      if (deadlineExpired()) return false;
      if (visitedLayoutNodes.has(child)) return;
      visitedLayoutNodes.add(child);
      if (child.type === 'text' && !$(child).parent().closest('p,h1,h2,h3,h4,h5,h6,li,dt,dd,blockquote').length) $(child).remove();
    });
  });
  if (deadlineExpired()) return result;
  $(EXCLUDED).remove();
  $(UNRELATED_DISCUSSION).each((_, node) => {
    if (deadlineExpired()) return false;
    if ($(node).is(DISCUSSION)) return;
    const primaryPosts = $(node).find(DISCUSSION).filter((__, post) => eligible($, post));
    if (!primaryPosts.length) { $(node).remove(); return; }
    // A recognized primary post does not grant its surrounding comments trust.
    // Keep outermost eligible posts once, excluding every unrelated sibling.
    const selected = new Set(primaryPosts.toArray());
    $(node).replaceWith(primaryPosts.filter((__, post) => !$(post).parents().toArray().some(parent => selected.has(parent))));
  });
  result.proseBody = $.html();
  if (deadlineExpired()) return result;
  if (!result.units.length) fail('no_supported_structured_records');
  return result;
}
