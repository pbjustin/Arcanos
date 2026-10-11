import { createHash } from 'node:crypto';
import { load } from 'cheerio';
import { countGamingHtmlElements, filterGamingDocumentInstructions, GAMING_DOCUMENT_FURNITURE_SELECTOR } from '@services/gamingDocumentExtraction.js';
import {
  GAMING_EVIDENCE_UNIT_POLICY_VERSION,
  type GamingEvidenceExtractionInput,
  type GamingEvidenceExtractionResult,
  type GamingEvidenceUnit
} from '@shared/gaming/gamingEvidenceUnits.js';

export const GAMING_JSON_EVIDENCE_LIMITS = Object.freeze({
  inputChars: 5_000_000, htmlChars: 5_000_000, htmlElements: 30_000,
  jsonBytes: 262_144, totalJsonBytes: 524_288, scripts: 16,
  depth: 12, objectKeys: 64, totalKeys: 4_096, arrayItems: 256, stringChars: 4_096,
  records: 256, fields: 32, fieldChars: 1_000, labelChars: 160, qualifiers: 16, qualifierChars: 400,
  unitChars: 4_096, outputChars: 200_000, elapsedMs: 1_000
});
const LIMITS = GAMING_JSON_EVIDENCE_LIMITS;
const DANGEROUS_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
const SENSITIVE_VALUE = /(?:\b(?:password|secret|token|api[_ -]?key|authorization|cookie)\s*[:=]|\bBearer\s+|\bsk-(?:proj-)?[a-z0-9_-]{8,}|\bgh[opusr]_[a-z0-9]{12,}|\beyJ[a-z0-9_-]+\.[a-z0-9_-]+\.[a-z0-9_-]+)/iu;
const SENSITIVE_KEY = /(?:password|secret|token|apikey|authorization|cookie|session|analytics|tracking)/iu;
const VISIBLE_QUALIFIER = /\b(?:not|no longer|deplet\w*|unconfirmed|old patch|example only|correction|corrected|outdated|unavailable|obsolete|previously|before|after|patch|version)\b/iu;
const COMPARISON_PROSE = /^(?:unlike|compare(?:d)?|(?:for\s+)?comparison|contrast|rather\s+than|instead\s+of)\b/iu;
// A comparison lead-in cannot erase an explicit qualification of the primary
// record. Compared equipment alone remains unrelated context.
const PRIMARY_RECORD_QUALIFICATION = /\b(?:this|these|the)\s+(?:records?|equipment|builds?|sources?|entry|entries|sites?|statistics?|resources?|weapons?|items?|stats?|routes?)\s+(?:(?:(?:is|are|was|were|remains?|may|might|can|could|would|should|must|will|be|been|being|has|have|had|now|still|also|already|yet|perhaps|requires?|needs?|a)|[\p{L}-]+ly)\s+)*(?:not|no longer|deplet\w*|unconfirmed|old patch|example only|outdated|unavailable|obsolete|correction|corrected)\b/iu;
const DISCUSSION = '[itemtype="https://schema.org/DiscussionForumPosting"],[itemtype="http://schema.org/DiscussionForumPosting"]';
const UNRELATED_DISCUSSION = '.comments,#comments,[class*="comment-list"],[itemtype="https://schema.org/Comment"],[itemtype="http://schema.org/Comment"]';
const QUALIFIER_KEYS = new Set(['qualifier', 'qualifiers', 'note', 'notes', 'status', 'correction', 'availability']);
const CONTEXT_KEYS = new Set(['game', 'edition', 'patch', 'version', 'scope', 'applicability']);
const METADATA_KEYS = new Set(['@context', '@id', '@type']);
const FIELD_KEYS = new Map([
  ['system', 'system'], ['body', 'body'], ['site', 'site'], ['siteid', 'site'],
  ['resource', 'resource'], ['item', 'item'], ['equipment', 'item'], ['stat', 'stat'],
  ['value', 'value'], ['unit', 'unit'], ['mechanic', 'mechanic'], ['change', 'change'],
  ['before', 'before'], ['after', 'after'], ['skill', 'skill'], ['slot', 'slot'],
  ['rank', 'rank'], ['latitude', 'latitude'], ['longitude', 'longitude'],
  ['game', 'game'], ['edition', 'edition'], ['patch', 'patch'], ['version', 'version'], ['scope', 'scope'], ['applicability', 'applicability']
]);
const keyForm = (value: string): string => value.toLowerCase().replace(/[\s_-]/gu, '');
const pointerPart = (value: string): string => value.replace(/~/gu, '~0').replace(/\//gu, '~1');

/** Numeric source tokens retain signs, decimals, exponent spelling, and precision. */
class JsonNumber { constructor(readonly text: string) {} }
type JsonValue = string | boolean | null | JsonNumber | JsonValue[] | { [key: string]: JsonValue };
type JsonRecord = { [key: string]: JsonValue };
class JsonFailure extends Error { constructor(readonly reason: string) { super(reason); } }

/** Strict bounded JSON grammar; duplicate decoded keys are rejected before object construction. */
function parseJson(text: string, deadline: number): JsonValue {
  let cursor = 0;
  let keys = 0;
  const fail = (reason = 'invalid_json'): never => { throw new JsonFailure(reason); };
  const budget = (): void => { if (Date.now() >= deadline) fail('extraction_budget_exhausted'); };
  const space = (): void => { while (cursor < text.length && /[\x20\x09\x0a\x0d]/u.test(text[cursor])) cursor++; };
  const string = (): string => {
    const start = cursor++;
    let escaped = false;
    while (cursor < text.length) {
      if (cursor - start > LIMITS.stringChars * 6 + 2) fail('extraction_budget_exhausted');
      const character = text[cursor++];
      if (escaped) { escaped = false; continue; }
      if (character === '\\') { escaped = true; continue; }
      if (character === '"') {
        let value: string;
        try { value = JSON.parse(text.slice(start, cursor)) as string; } catch { return fail(); }
        if (value.length > LIMITS.stringChars) fail('extraction_budget_exhausted');
        return value;
      }
      if (character.charCodeAt(0) < 0x20) fail();
    }
    return fail('content_truncated');
  };
  const value = (depth: number): JsonValue => {
    budget();
    if (depth > LIMITS.depth) fail('extraction_budget_exhausted');
    space();
    const current = text[cursor];
    if (current === '"') return string();
    if (current === '{') {
      cursor++;
      const object: JsonRecord = Object.create(null) as JsonRecord;
      const seen = new Set<string>();
      space();
      if (text[cursor] === '}') { cursor++; return object; }
      while (cursor < text.length) {
        space();
        if (text[cursor] !== '"') fail();
        const key = string();
        if (seen.has(key)) fail('ambiguous_field_mapping');
        if (DANGEROUS_KEYS.has(key.toLowerCase())) fail('unsafe_json_key');
        seen.add(key);
        if (seen.size > LIMITS.objectKeys || ++keys > LIMITS.totalKeys) fail('extraction_budget_exhausted');
        space();
        if (text[cursor++] !== ':') fail();
        object[key] = value(depth + 1);
        space();
        const end = text[cursor++];
        if (end === '}') return object;
        if (end !== ',') fail();
      }
      return fail('content_truncated');
    }
    if (current === '[') {
      cursor++;
      const array: JsonValue[] = [];
      space();
      if (text[cursor] === ']') { cursor++; return array; }
      while (cursor < text.length) {
        if (array.length >= LIMITS.arrayItems) fail('extraction_budget_exhausted');
        array.push(value(depth + 1));
        space();
        const end = text[cursor++];
        if (end === ']') return array;
        if (end !== ',') fail();
      }
      return fail('content_truncated');
    }
    for (const [literal, result] of [['true', true], ['false', false], ['null', null]] as const) {
      if (text.startsWith(literal, cursor)) { cursor += literal.length; return result; }
    }
    const number = text.slice(cursor).match(/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/u)?.[0];
    if (number) {
      if (number.length > 128 || !Number.isFinite(Number(number))) fail('invalid_json_number');
      cursor += number.length;
      return new JsonNumber(number);
    }
    return fail(cursor >= text.length ? 'content_truncated' : 'invalid_json');
  };
  const result = value(0);
  space();
  if (cursor !== text.length) fail();
  return result;
}

function record(value: JsonValue | undefined): JsonRecord | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) && !(value instanceof JsonNumber)
    ? value : undefined;
}
function scalar(value: JsonValue | undefined): string | undefined {
  return typeof value === 'string' ? value.trim() : value instanceof JsonNumber ? value.text : undefined;
}
function safeText(value: string): boolean {
  return !SENSITIVE_VALUE.test(value) && filterGamingDocumentInstructions(value) === value.normalize('NFKC').replace(/\s+/gu, ' ').trim();
}
function typeIs(value: JsonRecord, name: string): boolean {
  const raw = value['@type'];
  return raw === name || (Array.isArray(raw) && raw.includes(name));
}
interface ScopeContext {
  fields: Array<{ label: string; value: string }>;
  qualifiers: string[];
  heading?: string;
  attribution?: string;
  integrityReasons?: string[];
}

/** Only explicitly named record groups and schema.org PropertyValue/ItemList envelopes are traversed. */
function extractRecords(
  root: JsonValue, strategy: 'json_ld' | 'application_json', scope: string, sourceUrl: string,
  deadline: number, result: GamingEvidenceExtractionResult, visibleContext?: ScopeContext
): void {
  const addReason = (reason: string): void => { if (!result.subreasons.includes(reason)) result.subreasons.push(reason); };
  const completeContext = (input: JsonRecord, inherited: ScopeContext): ScopeContext | undefined => {
    const next = { ...inherited, fields: [...inherited.fields], qualifiers: [...inherited.qualifiers] };
    const supplied = new Set<string>();
    for (const [label, raw] of Object.entries(input)) {
      const key = keyForm(label);
      if (CONTEXT_KEYS.has(key)) {
        if (supplied.has(key)) { addReason('ambiguous_field_mapping'); return undefined; }
        supplied.add(key);
        const text = scalar(raw);
        if (!text || !safeText(text)) {
          addReason(text && !safeText(text) ? 'instruction_or_sensitive_content_filtered' : 'required_context_missing'); return undefined;
        }
        const prior = next.fields.find(field => keyForm(field.label) === key);
        if (prior && prior.value !== text) { addReason('ambiguous_field_mapping'); return undefined; }
        if (!prior) next.fields.push({ label, value: text });
      }
      if (QUALIFIER_KEYS.has(key)) {
        const entries = Array.isArray(raw) ? raw : [raw];
        for (const entry of entries) {
          const text = scalar(entry);
          if (!text || !safeText(text)) {
            addReason(text && !safeText(text) ? 'instruction_or_sensitive_content_filtered' : 'required_context_missing'); return undefined;
          }
          next.qualifiers.push(`${label}: ${text}`);
        }
      }
    }
    return next;
  };
  const emit = (input: JsonRecord, pointer: string, inherited: ScopeContext): void => {
    if (Date.now() >= deadline || result.units.length >= LIMITS.records) {
      result.truncated = true; addReason('extraction_budget_exhausted'); return;
    }
    const context = completeContext(input, inherited);
    if (!context) return;
    const fields = [...context.fields];
    const seen = new Set(fields.map(field => FIELD_KEYS.get(keyForm(field.label))));
    for (const [label, raw] of Object.entries(input)) {
      const key = keyForm(label);
      if (METADATA_KEYS.has(label) || CONTEXT_KEYS.has(key) || QUALIFIER_KEYS.has(key)) continue;
      const mapping = FIELD_KEYS.get(key);
      if (!mapping || SENSITIVE_KEY.test(key)) { addReason('no_supported_structured_records'); return; }
      if (seen.has(mapping)) { addReason('ambiguous_field_mapping'); return; }
      const text = scalar(raw);
      if (!text || !safeText(text)) {
        addReason(text && !safeText(text) ? 'instruction_or_sensitive_content_filtered' : 'incomplete_record'); return;
      }
      seen.add(mapping);
      fields.push({ label, value: text });
    }
    const gameplayCount = fields.filter(field => !CONTEXT_KEYS.has(keyForm(field.label))).length;
    if (gameplayCount < 2 || !fields.some(field => /^(?:system|body|site|resource|item|equipment|stat|mechanic|change|skill|slot)$/u.test(keyForm(field.label)))) {
      addReason('no_supported_structured_records'); return;
    }
    // Sorting establishes stable source serialization without query-derived labels or padding.
    fields.sort((left, right) => left.label < right.label ? -1 : left.label > right.label ? 1 : 0);
    const qualifiers = [...new Set(context.qualifiers)].sort();
    const text = [context.heading, context.attribution ? `Reported by ${context.attribution}` : undefined,
      ...fields.map(field => `${field.label}: ${field.value}`), ...qualifiers].filter(Boolean).join(' | ');
    if (text.length > LIMITS.unitChars || result.outputChars + text.length > LIMITS.outputChars
      || fields.length > LIMITS.fields || fields.some(field => field.label.length > LIMITS.labelChars || field.value.length > LIMITS.fieldChars)
      || qualifiers.length > LIMITS.qualifiers || qualifiers.some(qualifier => qualifier.length > LIMITS.qualifierChars)
      || (context.heading?.length ?? 0) > LIMITS.qualifierChars || (context.attribution?.length ?? 0) > LIMITS.labelChars) {
      result.truncated = true; addReason('content_truncated'); return;
    }
    const locator = `${scope}#${pointer}`;
    const id = createHash('sha256').update(JSON.stringify({ sourceUrl, locator, text, policy: GAMING_EVIDENCE_UNIT_POLICY_VERSION })).digest('hex').slice(0, 24);
    const unit: GamingEvidenceUnit = {
      id, kind: 'structured_record', text, fields,
      context: { scope: locator, ...(context.heading ? { heading: context.heading } : {}),
        ...(context.attribution ? { attribution: context.attribution } : {}), ...(qualifiers.length ? { qualifiers } : {}) },
      provenance: { sourceUrl, strategy, policyVersion: GAMING_EVIDENCE_UNIT_POLICY_VERSION,
        locator, representation: 'json_pointer', jsonOnly: true },
      integrity: { status: context.integrityReasons?.length ? 'partial' : 'complete', reasons: context.integrityReasons ?? [] }
    };
    result.units.push(unit);
    result.outputChars += text.length;
  };
  const visit = (value: JsonValue, pointer: string, inherited: ScopeContext, envelopeDepth = 0): void => {
    if (Date.now() >= deadline || result.units.length >= LIMITS.records) {
      result.truncated = true; addReason('extraction_budget_exhausted'); return;
    }
    if (envelopeDepth > 3) { addReason('no_supported_structured_records'); return; }
    if (Array.isArray(value)) {
      value.forEach((entry, index) => visit(entry, `${pointer}/${index}`, inherited, envelopeDepth + 1));
      return;
    }
    const input = record(value);
    if (!input) { addReason('no_supported_structured_records'); return; }
    const keys = Object.keys(input);
    const context = completeContext(input, inherited);
    if (!context) return;
    const allowedEnvelopeKeys = (extra: string[]): boolean => keys.every(key =>
      METADATA_KEYS.has(key) || CONTEXT_KEYS.has(keyForm(key)) || QUALIFIER_KEYS.has(keyForm(key)) || extra.includes(key));
    const preserveEnvelopeText = (): boolean => {
      for (const label of ['name', 'description']) {
        if (input[label] === undefined) continue;
        const text = scalar(input[label]);
        if (!text || !safeText(text)) { addReason('required_context_missing'); return false; }
        context.qualifiers.push(`${label}: ${text}`);
      }
      return true;
    };
    // Dataset.variableMeasured preserves one explicitly associated PropertyValue set.
    if (strategy === 'json_ld' && typeIs(input, 'Dataset') && Array.isArray(input.variableMeasured)) {
      if (!allowedEnvelopeKeys(['variableMeasured', 'name', 'description'])) { addReason('no_supported_structured_records'); return; }
      const converted: JsonRecord = Object.create(null) as JsonRecord;
      for (const [index, raw] of input.variableMeasured.entries()) {
        const property = record(raw);
        const label = property && scalar(property.name);
        if (!property || !typeIs(property, 'PropertyValue') || !label || property.value === undefined
          || Object.keys(property).some(key => !['@type', 'name', 'value', 'unitText'].includes(key))) {
          addReason('ambiguous_field_mapping'); return;
        }
        if (Object.keys(converted).some(key => keyForm(key) === keyForm(label))) { addReason('ambiguous_field_mapping'); return; }
        if (property.unitText !== undefined) {
          // Unit associations are supported only for the explicit statistic value field.
          if (keyForm(label) !== 'value' || converted.unit !== undefined) { addReason('ambiguous_field_mapping'); return; }
          converted.unit = property.unitText;
        }
        converted[label] = property.value;
        if (index >= LIMITS.objectKeys) { addReason('extraction_budget_exhausted'); return; }
      }
      if (!preserveEnvelopeText()) return;
      emit(converted, `${pointer}/variableMeasured`, context);
      return;
    }
    if (strategy === 'json_ld' && typeIs(input, 'ItemList') && Array.isArray(input.itemListElement)) {
      if (!allowedEnvelopeKeys(['itemListElement', 'name', 'description'])) { addReason('no_supported_structured_records'); return; }
      if (!preserveEnvelopeText()) return;
      input.itemListElement.forEach((entry, index) => {
        const element = record(entry);
        if (element && typeIs(element, 'ListItem')) {
          if (Object.keys(element).some(key => !['@type', 'position', 'item'].includes(key)) || !record(element.item)) {
            addReason('ambiguous_field_mapping'); return;
          }
          visit(element.item, `${pointer}/itemListElement/${index}/item`, context, envelopeDepth + 1);
        } else visit(entry, `${pointer}/itemListElement/${index}`, context, envelopeDepth + 1);
      });
      return;
    }
    for (const group of ['records', 'locations', 'equipmentStats', 'patchChanges']) {
      if (Array.isArray(input[group])) {
        if (!allowedEnvelopeKeys([group])) { addReason('no_supported_structured_records'); return; }
        input[group].forEach((entry, index) => visit(entry, `${pointer}/${pointerPart(group)}/${index}`, context, envelopeDepth + 1));
        return;
      }
    }
    emit(input, pointer, inherited);
  };
  visit(root, '', visibleContext ?? { fields: [], qualifiers: [] });
}

/** Inert, document-oriented extraction from the existing accepted response. Never fetches or executes. */
export function extractGamingJsonEvidence(input: GamingEvidenceExtractionInput): GamingEvidenceExtractionResult {
  const result: GamingEvidenceExtractionResult = {
    units: [], attempts: [], subreasons: [], truncated: false,
    inputBytes: Buffer.byteLength(input.body, 'utf8'), outputChars: 0
  };
  const reason = (value: string): void => { if (!result.subreasons.includes(value)) result.subreasons.push(value); };
  const deadline = Math.min(Date.now() + LIMITS.elapsedMs, input.deadlineAt ?? Infinity);
  const deadlineExpired = () => {
    if (Date.now() < deadline) return false;
    result.truncated = true;
    reason('extraction_budget_exhausted');
    return true;
  };
  if (deadlineExpired()) return result;
  let bytes = 0;
  const parse = (text: string, strategy: 'json_ld' | 'application_json', scope: string, context?: ScopeContext): void => {
    result.attempts.push(strategy);
    const size = Buffer.byteLength(text, 'utf8');
    bytes += size;
    if (size > LIMITS.jsonBytes || bytes > LIMITS.totalJsonBytes || Date.now() >= deadline) {
      result.truncated = true; reason('extraction_budget_exhausted'); return;
    }
    try { extractRecords(parseJson(text, deadline), strategy, scope, input.sourceUrl, deadline, result, context); }
    catch (error) {
      const subreason = error instanceof JsonFailure ? error.reason : 'invalid_json';
      reason(subreason);
      if (subreason === 'extraction_budget_exhausted' || subreason === 'content_truncated') result.truncated = true;
    }
  };
  if (input.body.length > LIMITS.inputChars) {
    result.truncated = true; reason('extraction_budget_exhausted'); return result;
  }
  const mediaType = input.contentType.split(';', 1)[0].trim().toLowerCase();
  if (mediaType === 'application/json' || mediaType === 'application/ld+json') {
    if (input.transportTruncated) { result.truncated = true; reason('content_truncated'); return result; }
    parse(input.body, mediaType === 'application/ld+json' ? 'json_ld' : 'application_json', 'response');
  } else if (mediaType === 'text/html' || mediaType === 'application/xhtml+xml') {
    if (input.body.length > LIMITS.htmlChars) {
      result.truncated = true; reason('extraction_budget_exhausted'); return result;
    }
    if (countGamingHtmlElements(input.body, LIMITS.htmlElements) > LIMITS.htmlElements) {
      result.truncated = true; reason('extraction_budget_exhausted'); return result;
    }
    if (deadlineExpired()) return result;
    // Without a script opener the DOM cannot contain embedded JSON. Retain
    // the independent admission bounds above, and parse every possible opener
    // below so comments, templates, casing and malformed markup stay DOM-owned.
    if (!/<script/iu.test(input.body)) {
      if (input.transportTruncated) { result.truncated = true; reason('content_truncated'); }
      if (deadlineExpired()) return result;
      if (!result.subreasons.length) reason('no_supported_structured_records');
      return result;
    }
    // Parse actual DOM scripts, never script-looking text inside comments, templates, or assignment strings.
    // The installed parser supports source locations; the repository also includes older ambient Cheerio types.
    const parserOptions = { xmlMode: false, sourceCodeLocationInfo: true };
    const $ = load(input.body, parserOptions);
    if (deadlineExpired()) return result;
    $('template, noscript').remove();
    const scripts = $('script');
    const qualifierValues = new Map<cheerio.Element, string>();
    const qualifierSelector = 'p,figcaption,small,[role="note"],div,span';
    const standaloneSpans = new Map<cheerio.Element, Set<cheerio.Element>>();
    function standaloneSpan(element: cheerio.Element): boolean {
      const parent = $(element).parent();
      if (!parent.is('body,main,article,section,div')) return false;
      const parentElement = parent.get(0)!;
      let spans = standaloneSpans.get(parentElement);
      if (!spans) {
        spans = new Set<cheerio.Element>();
        const siblings = parent.contents().toArray().filter(sibling => sibling.type !== 'comment'
          && (sibling.type !== 'text' || $(sibling).text().trim()));
        const boundary = (sibling: cheerio.Element | undefined) => !sibling
          || $(sibling).is('p,div,main,article,section,figure,table,ul,ol,dl,h1,h2,h3,h4,h5,h6,script');
        for (const [index, sibling] of siblings.entries()) {
          if ($(sibling).is('span') && boundary(siblings[index - 1]) && boundary(siblings[index + 1])) spans.add(sibling);
        }
        standaloneSpans.set(parentElement, spans);
      }
      return spans.has(element);
    }
    const qualifierBlockEligibility = new Map<cheerio.Element, boolean>();
    const formattedQualifierBlocks = new Map<cheerio.Element, boolean>();
    const inlineQualifierSelector = 'span,b,strong,em,i,small,br';
    function formattedQualifierBlock(element: cheerio.Element): boolean {
      const cached = formattedQualifierBlocks.get(element);
      if (cached !== undefined) return cached;
      const node = $(element);
      const inlineOnly = node.is('div,span') && !node.closest('aside').length && node.children().length > 0
        && (!node.is('span') || standaloneSpan(element))
        && node.children().toArray().every(child => $(child).is(inlineQualifierSelector))
        && node.find('*').toArray().every(child => $(child).is(inlineQualifierSelector));
      const value = inlineOnly ? node.text().normalize('NFKC').replace(/\s+/gu, ' ').trim() : '';
      const formatted = inlineOnly && (VISIBLE_QUALIFIER.exec(value)?.index === 0
        || COMPARISON_PROSE.test(value) && PRIMARY_RECORD_QUALIFICATION.test(value));
      formattedQualifierBlocks.set(element, formatted);
      return formatted;
    }
    const qualifierBlock = (_: number, element: cheerio.Element) => {
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
    let inertScripts = 0;
    for (const [index, element] of scripts.toArray().entries()) {
      if (Date.now() >= deadline) { result.truncated = true; reason('extraction_budget_exhausted'); break; }
      if ($(element).parents('template, noscript').length) continue;
      const location = (element as typeof element & { sourceCodeLocation?: {
        startTag?: { startOffset: number; endOffset: number };
        endTag?: { startOffset: number; endOffset: number };
      } }).sourceCodeLocation;
      if (!location?.startTag || !location.endTag) { reason('content_truncated'); continue; }
      const startTag = input.body.slice(location.startTag.startOffset, location.startTag.endOffset);
      const typeMatches = [...startTag.matchAll(/(?:^|\s)type\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/giu)];
      if (typeMatches.length !== 1) continue;
      const type = ($(element).attr('type') ?? '').toLowerCase().trim();
      if (type !== 'application/json' && type !== 'application/ld+json') continue;
      if (++inertScripts > LIMITS.scripts) { result.truncated = true; reason('extraction_budget_exhausted'); break; }
      const node = $(element);
      if (node.closest(`aside,blockquote,[role="menu"],${GAMING_DOCUMENT_FURNITURE_SELECTOR}`).length) continue;
      const post = node.closest(DISCUSSION).first();
      const unrelated = node.closest(UNRELATED_DISCUSSION).first();
      if (unrelated.length && (!post.length || !post.is('article') && !post.closest('main,[role="main"]').length
        || !post.parents().toArray().includes(unrelated.get(0)!))) continue;
      const container = node.closest('section,article,main,figure').first();
      const visibleContext: ScopeContext = { fields: [], qualifiers: [], integrityReasons: [] };
      const attribution = post.length ? post.find('[itemprop="author"]').first().text().normalize('NFKC').replace(/\s+/gu, ' ').trim() : '';
      if (attribution) visibleContext.attribution = attribution;
      // Nearby visible qualifications belong to this source assertion even though its fields are JSON-only.
      let relevant = nearbyQualifiers(node);
      // A containing section can inherit an article-level qualification without importing sibling sections.
      let ancestor = node.parent();
      for (let depth = 0; depth < 6 && ancestor.length && !ancestor.is('html'); depth++, ancestor = ancestor.parent()) {
        relevant = relevant.add(ancestor.children(qualifierSelector).filter(qualifierBlock)).add(nearbyQualifiers(ancestor));
      }
      const wholeArticleContext = container.is('article,main') && !node.parents('section,figure').length;
      if (ancestor.length && !ancestor.is('html') && wholeArticleContext) {
        const enclosingScopes = container.parents('article,main');
        if (enclosingScopes.length > 6) visibleContext.integrityReasons!.push('required_context_missing');
        // Plain wrappers must not hide an enclosing article/main qualification.
        relevant = relevant.add(enclosingScopes.slice(0, 6).find(qualifierSelector).filter(qualifierBlock));
      }
      if (container.length) relevant = relevant.add(container.find(qualifierSelector).filter(qualifierBlock));
      const ancestors = node.parents().toArray();
      let qualifierElements = 0;
      relevant.each((_, candidate) => {
        if (deadlineExpired()) return false;
        const selected = $(candidate);
        if (selected.is('span') && !qualifierBlock(0, candidate)) return;
        if (selected.closest(`${GAMING_DOCUMENT_FURNITURE_SELECTOR},blockquote,table:not([role="presentation"]),ul,ol,dl`).length) return;
        if (selected.closest(UNRELATED_DISCUSSION).length && (!post.length || selected.closest(DISCUSSION).get(0) !== post.get(0))) return;
        const candidateScope = selected.closest('section,article,main,figure').get(0);
        if (candidateScope && candidateScope !== container.get(0) && !ancestors.includes(candidateScope)) return;
        let text = qualifierValues.get(candidate);
        if (text === undefined) {
          const copy = selected.clone();
          // Nested blocks are discovered separately; plain wrappers must not count them again.
          copy.find(qualifierSelector).filter(qualifierBlock).remove();
          copy.find(`script,style,table,ul,ol,dl,blockquote,section,article,main,figure,${GAMING_DOCUMENT_FURNITURE_SELECTOR},${UNRELATED_DISCUSSION}`).remove();
          text = copy.text().normalize('NFKC').replace(/\s+/gu, ' ').trim();
          qualifierValues.set(candidate, text);
        }
        // Nearby wrappers must obey the same comparison boundary as discovered blocks.
        if (selected.is('div,span') && COMPARISON_PROSE.test(text) && !PRIMARY_RECORD_QUALIFICATION.test(text)) return;
        if (VISIBLE_QUALIFIER.test(text)) {
          if (++qualifierElements > 64) {
            visibleContext.integrityReasons!.push('required_context_missing'); reason('required_context_missing'); return false;
          }
          visibleContext.qualifiers.push(text);
          const closureNodes = formattedQualifierBlock(candidate) ? selected.find('*').add(selected).toArray() : [candidate];
          if (closureNodes.some(child => !$(child).is('br')
            && !(child as typeof child & { sourceCodeLocation?: { endTag?: unknown } }).sourceCodeLocation?.endTag)) {
            visibleContext.integrityReasons!.push('content_truncated'); reason('content_truncated');
          }
        }
      });
      if (deadlineExpired()) return result;
      let headingNode = node.prevAll('h1,h2,h3,h4,h5,h6').first();
      if (!headingNode.length && container.length) headingNode = container.children('h1,h2,h3,h4,h5,h6').first();
      const heading = headingNode.text().normalize('NFKC').replace(/\s+/gu, ' ').trim();
      if (heading) visibleContext.heading = heading;
      if ([heading, attribution, ...visibleContext.qualifiers].some(text => text && !safeText(text))) {
        reason('instruction_or_sensitive_content_filtered'); continue;
      }
      const scopeLocation = (container.get(0) as { sourceCodeLocation?: { endTag?: unknown } } | undefined)?.sourceCodeLocation;
      if (input.transportTruncated && !scopeLocation?.endTag) {
        visibleContext.integrityReasons!.push('required_context_missing'); reason('required_context_missing');
      }
      parse(input.body.slice(location.startTag.endOffset, location.endTag.startOffset),
        type === 'application/ld+json' ? 'json_ld' : 'application_json', `script[${index + 1}]`, visibleContext);
      if (bytes >= LIMITS.totalJsonBytes) break;
    }
    if (input.transportTruncated) { result.truncated = true; reason('content_truncated'); }
  }
  if (deadlineExpired()) return result;
  if (!result.units.length && !result.subreasons.length) reason('no_supported_structured_records');
  return result;
}
