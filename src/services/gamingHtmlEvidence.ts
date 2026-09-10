import { createHash } from 'node:crypto';
import { load } from 'cheerio';
import { filterGamingDocumentInstructions } from '@services/gamingDocumentExtraction.js';
import {
  GAMING_EVIDENCE_UNIT_POLICY_VERSION,
  type GamingEvidenceExtractionInput,
  type GamingEvidenceExtractionResult,
  type GamingEvidenceUnit
} from '@shared/gaming/gamingEvidenceUnits.js';

/** Separate from transport limits: no caller can enlarge structural parsing work. */
export const GAMING_HTML_EVIDENCE_LIMITS = Object.freeze({
  htmlChars: 1_500_000, elements: 30_000, tables: 128, rowsPerTable: 1_024,
  columns: 32, span: 64, expandedCells: 32_768, lists: 256, units: 2_048,
  fields: 32, fieldChars: 1_024, contextChars: 512, unitChars: 4_096, outputChars: 1_000_000
});
type Element = cheerio.Element;
type CheerioAPI = ReturnType<typeof load>;
type Fields = GamingEvidenceUnit['fields'];
interface SourceLocation { startOffset: number; endOffset: number; endTag?: { endOffset: number } }
type LocatedElement = Element & { sourceCodeLocation?: SourceLocation };
export interface GamingHtmlEvidenceExtractionResult extends GamingEvidenceExtractionResult {
  /** Original accepted HTML with structural candidates removed from the prose fallback. */
  proseBody?: string;
}
const EXCLUDED = 'nav,footer,aside,form,template,[hidden],[aria-hidden="true"],[role="navigation"],[role="menu"],[role="dialog"],.sidebar,#sidebar';
const DISCUSSION = '[itemtype="https://schema.org/DiscussionForumPosting"],[itemtype="http://schema.org/DiscussionForumPosting"]';
const UNRELATED_DISCUSSION = '.comments,#comments,[class*="comment-list"],[itemtype="https://schema.org/Comment"],[itemtype="http://schema.org/Comment"]';
const QUALIFIER = /\b(?:not|no longer|deplet\w*|unconfirmed|old patch|example only|correction|corrected|outdated|unavailable|obsolete|previously|before|after|patch|version)\b/i;
const LABELLED_FIELD = /^([^:;|\n]{1,80}):\s*(.+)$/;

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

/** Parse only the already acquired HTML. There is no fetch, script evaluation, or question input. */
export function extractGamingHtmlEvidence(input: GamingEvidenceExtractionInput): GamingHtmlEvidenceExtractionResult {
  const result: GamingHtmlEvidenceExtractionResult = {
    units: [], attempts: [], subreasons: [], truncated: Boolean(input.transportTruncated),
    inputBytes: Buffer.byteLength(input.body, 'utf8'), outputChars: 0
  };
  if (!['text/html', 'application/xhtml+xml'].includes(input.contentType)) return result;
  const limit = GAMING_HTML_EVIDENCE_LIMITS;
  const fail = (reason: string) => { if (!result.subreasons.includes(reason)) result.subreasons.push(reason); };
  if (input.body.length > limit.htmlChars || (input.body.match(/<[a-zA-Z][^>]*>/g)?.length ?? 0) > limit.elements) {
    result.truncated = true; result.proseBody = ''; fail('extraction_budget_exhausted'); return result;
  }
  // Runtime Cheerio uses parse5; the repository's legacy ambient types omit its location option.
  const parseOptions = { sourceCodeLocationInfo: true };
  const $ = load(input.body, parseOptions as Parameters<typeof load>[1]);
  const visibleBody = $('body').clone();
  visibleBody.find('script,style,template,noscript').remove();
  const visibleText = text(visibleBody.text());
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
  function context(element: Element, scope: string, caption?: string): GamingEvidenceUnit['context'] {
    const node = $(element);
    let heading: string | undefined;
    let current = node;
    for (let level = 0; level < 6 && current.length && !heading; level++, current = current.parent()) {
      const candidate = current.prevAll('h1,h2,h3,h4,h5,h6').first();
      if (candidate.length) heading = text(candidate.text());
      if (!heading && current.is('section,article,main')) heading = text(current.children('h1,h2,h3,h4,h5,h6').add(current.children('header').find('h1,h2,h3,h4,h5,h6')).first().text()) || undefined;
    }
    const qualifiers: string[] = [];
    node.prevAll('p,aside,div').slice(0, 2).add(node.nextAll('p,aside,div').slice(0, 2)).each((_, sibling) => {
      const value = text($(sibling).text());
      if (QUALIFIER.test(value)) {
        qualifiers.push(value);
        if (!closed(sibling)) contextReasons.set(scope, ['content_truncated']);
      }
    });
    const post = node.closest(DISCUSSION).first();
    const attribution = post.length
      ? text(post.find('[itemprop="author"]').first().text()).slice(0, 160) : undefined;
    if ([heading, caption, ...qualifiers].some((value) => value && value.length > limit.contextChars)) contextReasons.set(scope, ['content_truncated']);
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

  result.attempts.push('html_table');
  const tables = $('table').toArray();
  for (const table of tables) removedProseElements.add(table);
  if (tables.length > limit.tables) { result.truncated = true; fail('extraction_budget_exhausted'); }
  let expandedCells = 0;
  for (const [tableIndex, table] of tables.slice(0, limit.tables).entries()) {
    if (exhausted()) break;
    if (!eligible($, table) || $(table).attr('role') === 'presentation') continue;
    const scope = `table:${tableIndex}`;
    const caption = text($(table).children('caption').first().text());
    const unitContext = context(table, scope, caption);
    const footerText = text($(table).children('tfoot').text());
    if (footerText) {
      unitContext.qualifiers = unique([...(unitContext.qualifiers ?? []), footerText.slice(0, limit.contextChars)]);
      if (footerText.length > limit.contextChars || !closed($(table).children('tfoot').first().get(0)!)) contextReasons.set(scope, ['content_truncated']);
    }
    const rows = $(table).find('tr').toArray().filter((row) => $(row).closest('table').get(0) === table);
    const grid: Array<Array<{ element: Element; row: number; column: number; colSpan: number } | undefined>> = [];
    const rowReasons: string[][] = [];
    const headers = new Map<string, Element[]>();
    $(table).find('th[id]').each((_, th) => {
      if ($(th).closest('table').get(0) !== table) return;
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
    for (let rowIndex = headerRows; rowIndex < grid.length && !exhausted(); rowIndex++) {
      const cells = grid[rowIndex];
      if (!cells?.length) continue;
      const fields: Fields = [];
      const reasons = [...(rowReasons[rowIndex] ?? [])];
      if (headerRows && cells.length < Math.max(...grid.slice(0, headerRows).map((headerRow) => headerRow.length))) reasons.push('incomplete_record');
      const qualifiers = [...(unitContext.qualifiers ?? [])];
      const visited = new Set<Element>();
      for (const [column, cell] of cells.entries()) {
        if (!cell) { reasons.push('incomplete_record'); continue; }
        if (visited.has(cell.element)) continue;
        visited.add(cell.element);
        if (!closed(cell.element)) reasons.push('content_truncated');
        const explicit = ($(cell.element).attr('headers') ?? '').split(/\s+/).filter(Boolean);
        const columnHeaders = explicit.length ? explicit.map((id) => headers.get(id)?.length === 1 ? headers.get(id)![0] : undefined)
          : grid.slice(0, headerRows).map((headerRow) => headerRow[column]?.element);
        if (explicit.length && columnHeaders.some((header) => !header)) reasons.push('ambiguous_field_mapping');
        if (columnHeaders.some((header) => header && $(header).find('blockquote').length)) reasons.push('ambiguous_field_mapping', 'quoted_content_ambiguous');
        const label = unique(columnHeaders.filter((header): header is Element => Boolean(header)).map((header) => cleanElementText($, header))).join(' / ');
        if (!label) reasons.push('ambiguous_field_mapping');
        fields.push({ label, value: cleanElementText($, cell.element) });
        const footnoteLinks = $(cell.element).find('a[href^="#"]');
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
      addUnit('table_row', fields, rows[rowIndex], 'html_table', { ...unitContext, scope: `${scope}/row:${rowIndex}`, ...(qualifiers.length ? { qualifiers: unique(qualifiers) } : {}) }, reasons);
    }
  }

  result.attempts.push('html_list', 'html_definition');
  const lists = $('ul,ol,dl').toArray();
  const consumedNestedLists = new Set<Element>();
  if (lists.length > limit.lists) { result.truncated = true; fail('extraction_budget_exhausted'); }
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
    if (!eligible($, list) || $(list).closest('table').length || consumedNestedLists.has(list)) continue;
    const scope = `list:${listIndex}`;
    const unitContext = context(list, scope);
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
        if ($(entry).find('blockquote').length || $(next).find('blockquote').length) reasons.push('ambiguous_field_mapping', 'quoted_content_ambiguous');
        const values = [cleanElementText($, next)];
        index++;
        while (entries[index + 1] && $(entries[index + 1]).is('dd') && $(entries[index + 1]).parent().get(0) === parent) {
          index++;
          if (!closed(entries[index])) reasons.push('content_truncated');
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
      removedProseElements.add(item);
      const reasons = !closed(item) || !closed(list) || !intactTransportScope(list) ? ['content_truncated'] : [];
      if ($(item).children('ul,ol').length > 1 || nested.find('ul,ol,dl').length) reasons.push('ambiguous_field_mapping');
      if (nested.children('li').toArray().some((child) => !closed(child))) reasons.push('content_truncated');
      addUnit('list_item', fields, item, 'html_list', { ...unitContext, scope: `${scope}/item:${itemIndex}` }, reasons);
    }
  }
  for (const element of removedProseElements) $(element).remove();
  result.proseBody = $.html();
  if (!result.units.length) fail('no_supported_structured_records');
  return result;
}
