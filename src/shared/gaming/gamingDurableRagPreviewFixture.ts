import {
  chunkGamingDocument,
  hashGamingDocumentRevision,
  type GamingDocumentChunk
} from '@services/gamingDurableDocumentChunks.js';
import { buildGamingDocumentSearchText } from './gamingDocumentIngestionCore.js';
import {
  GamingArchiveResolutionError,
  resolveGamingArchiveResourceCore
} from './gamingArchiveResourceCore.js';
import {
  buildStoredGamingLexicalQuery,
  formatStoredGamingEvidence,
  selectStoredGamingEvidence,
  type GamingStoredEvidenceRecord,
  type GamingStoredKnowledgeInput
} from './gamingStoredEvidenceCore.js';
import { extractGamingDocumentEvidence } from '@services/gamingDocumentEvidence.js';
import { extractGamingHtmlEvidence, GAMING_HTML_EVIDENCE_LIMITS } from '@services/gamingHtmlEvidence.js';
import { projectGamingDocumentText } from './gamingDocumentProjectionCore.js';
import { assessGamingRequestCoverage } from './gamingClearEvidence.js';
import { assessGamingClearSourceIdentity } from './gamingClearSource.js';
import { assessGamingSourcePolicy, evaluateGamingFreshness, extractGamingFreshnessMetadata } from './gamingFreshnessCore.js';
import { buildGamingRequestRequirements } from './gamingRetrievalPolicy.js';
import { classifyGamingEditionRequirements } from './gamingStructuralEvidence.js';
import { isGamingApprovedArtifactCurrent, projectGamingHybridSuppliedGuides } from './gamingHybridPolicyCore.js';
import { GAMING_HYBRID_V2_CONTRACT_VERSION, gamingHybridQuerySchema } from './gamingHybridContract.js';
import { getProtectedDocumentByteBudgetFailure } from '../protectedDocumentByteBudget.js';
import { GAMING_DOCUMENT_ACQUISITION_LIMITS } from './gamingSourceAcquisitionCore.js';

const FAILURE = 'PREVIEW_GAMING_DURABLE_RAG_CONTRACT_INVALID';
const GAME = 'Synthetic Lantern Quest';
const ITEM = 'native_preview_durable_manual';
const SOURCE_URL = `https://archive.org/details/${ITEM}`;
const METADATA_URL = `https://archive.org/metadata/${ITEM}`;
const DOCUMENT_URL = `https://ia123.us.archive.org/1/items/${ITEM}/manual_djvu.txt`;
const FETCHED_AT = new Date('2026-09-01T00:00:00.000Z');
const LATE_FACT = 'At the imaginary Clockwork Observatory, activate the violet lantern before crossing the copper bridge.';
const FINAL_FACT = 'The fictional Zephyrglass Compass is hidden beyond the cobalt arch in the Moonlit Repository.';
const LIMITS = Object.freeze({
  chunkChars: 1_200, maxChunks: 8, maxSources: 3, maxContextChars: 12_000, structuredEvidenceChars: 8_000
});
const BROKEN_UNICODE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u;

export const GAMING_LARGE_SOURCE_PREVIEW_VERSION = 'gaming-large-source/v1';
export const GAMING_LARGE_SOURCE_PREVIEW_CASES = Object.freeze([
  'large-html-structural-extraction', 'independent-text-index-context-bounds',
  'protected-transfer-decoded-byte-admission', 'oversized-structural-input-rejection', 'archive-decoded-byte-rejection',
  'late-complete-passage-pool', 'samurai-multi-topic-early', 'samurai-multi-topic-late',
  'insufficient-coverage-budget', 'wrong-game-edition-dlc', 'partial-conflicting-structural-records',
  'unsupported-currentness', 'transient-artifact-scope-expiry-content-binding'
]);

function requireProof(condition: unknown): asserts condition {
  if (!condition) throw new Error(FAILURE);
}

function guideText(): string {
  const paragraphs = [`# ${GAME} invented strategy guide`, 'Every location and objective in this server-owned fixture is invented.'];
  let length = paragraphs.join('\n\n').length;
  const append = (paragraph: string): void => { paragraphs.push(paragraph); length += paragraph.length + 2; };
  const fillUntil = (minimum: number, phase: string): void => {
    for (let ordinal = 0; length < minimum; ordinal += 1) {
      append(`Synthetic ${phase} training note ${ordinal}: inspect the wooden practice sign before entering the next exercise room. `
        + 'A patient explorer follows the marked path, checks the harmless practice switches, and records the result in an imaginary notebook. '
        + 'The invented corridor contains a blue bench and a brass practice door. These details establish volume without asserting real gameplay facts.');
    }
  };
  fillUntil(410_000, 'opening');
  append('## Clockwork Observatory practice route');
  append(LATE_FACT);
  fillUntil(590_000, 'later');
  append('## Moonlit Repository final chamber');
  append(FINAL_FACT);
  return paragraphs.join('\n\n');
}

function requireChunkCoverage(result: Awaited<ReturnType<typeof chunkGamingDocument>>): void {
  requireProof(result.chunks.length > 0 && result.chunks.length <= 500);
  let end = 0;
  const keys = new Set<string>();
  for (const [ordinal, chunk] of result.chunks.entries()) {
    requireProof(chunk.ordinal === ordinal && chunk.totalChunks === result.chunks.length);
    requireProof(chunk.startChar >= 0 && chunk.startChar <= end && end - chunk.startChar <= 240);
    requireProof(chunk.endChar > end && chunk.endChar <= result.text.length);
    requireProof(chunk.text === result.text.slice(chunk.startChar, chunk.endChar));
    requireProof(chunk.text.length > 0 && chunk.text.length <= 2_000 && !BROKEN_UNICODE.test(chunk.text));
    requireProof(chunk.overlapFromPrevious === (chunk.startChar < end));
    requireProof(/^[a-f0-9]{64}$/u.test(chunk.contentHash) && /^[a-f0-9]{64}$/u.test(chunk.semanticKey));
    requireProof(!keys.has(chunk.semanticKey));
    keys.add(chunk.semanticKey);
    end = chunk.endChar;
  }
  requireProof(result.indexedChars === end && result.documentChars === result.text.length);
}

function row(chunk: GamingDocumentChunk, overrides: Partial<GamingStoredEvidenceRecord> = {}): GamingStoredEvidenceRecord {
  const { text, semanticKey: _semanticKey, ...metadata } = chunk;
  return {
    recordId: `synthetic-record-${chunk.ordinal}`, recordType: 'guide', title: 'Synthetic durable guide',
    searchText: text, normalized: { text, chunk: metadata }, sourceId: 'synthetic-source', publicUrl: SOURCE_URL,
    sourceType: 'supplied', revisionId: 'synthetic-revision', fetchedAt: FETCHED_AT, publishedAt: null,
    provenance: { resolverId: 'archive-org', resolverVersion: 'archive-text-v1', resolutionStrategy: 'archive_djvu_text' },
    relevance: 0.8, ...overrides
  };
}

function shortRow(id: string, text: string, startChar = 0, ordinal = 0): GamingStoredEvidenceRecord {
  return row({
    ordinal, totalChunks: 3, startChar, endChar: startChar + text.length, text,
    contentHash: 'a'.repeat(64), semanticKey: id, overlapFromPrevious: false
  }, { recordId: id });
}

function requireDeepRetrieval(chunks: GamingDocumentChunk[]): void {
  for (const [prompt, fact, minimum] of [
    ['Clockwork Observatory', LATE_FACT, 400_000],
    ['Zephyrglass Compass', FINAL_FACT, 580_000]
  ] as const) {
    // Fixed fixture lookup only: these rows do not emulate PostgreSQL candidate acquisition or rank.
    const chunk = chunks.find(candidate => candidate.text.includes(fact));
    requireProof(chunk && chunk.startChar > minimum);
    const input = { game: GAME, prompt, mode: 'guide' as const };
    const selected = selectStoredGamingEvidence([row(chunk)], input, LIMITS);
    const result = formatStoredGamingEvidence(selected, { sourceIndexOffset: 2, maxContextChars: 2_000 }, LIMITS);
    requireProof(selected.length === 1 && result.evidence?.length === 1 && result.sources.length === 1);
    requireProof(result.context.includes(fact) && result.context.includes('[Source 3]') && result.context.length <= 2_000);
    const evidence = result.evidence[0];
    requireProof(evidence.sourceId === 'synthetic-source' && evidence.revisionId === 'synthetic-revision');
    requireProof(evidence.recordId === `synthetic-record-${chunk.ordinal}` && evidence.ordinal === chunk.ordinal);
    requireProof(evidence.startChar === chunk.startChar && evidence.endChar === chunk.endChar && evidence.publicUrl === SOURCE_URL);
    requireProof(evidence.provenance.fetchedAt === FETCHED_AT.toISOString());
    requireProof(evidence.provenance.resolverId === 'archive-org' && evidence.provenance.resolverVersion === 'archive-text-v1');
    requireProof(evidence.provenance.resolutionStrategy === 'archive_djvu_text');
    requireProof(result.sources[0].url === SOURCE_URL && result.sources[0].snippet.includes(fact));
  }
}

function requireSelectionAndBudgets(): void {
  const input = { game: GAME, prompt: 'Where is the Zephyrglass Compass?', mode: 'guide' as const };
  const query = buildStoredGamingLexicalQuery(`Where is the Ｚｅｐｈｙｒｇｌａｓｓ Ｃｏｍｐａｓｓ in ${GAME}?`, GAME);
  requireProof(query.query === '"zephyrglass" OR "compass"' && query.terms.join(' ') === 'zephyrglass compass');
  const shared = 'The Zephyrglass Compass opens the hidden route beyond the cobalt arch. Follow the blue markings toward the entrance.';
  const distinct = 'A second use of the Zephyrglass Compass reveals a violet staircase beneath the old library. Climb to reach the observatory.';
  const first = shortRow('overlap-a', shared);
  const duplicate = shortRow('overlap-b', shared);
  const alternate = shortRow('overlap-c', distinct, 400, 2);
  const selected = selectStoredGamingEvidence([first, first, duplicate, alternate], input, LIMITS);
  requireProof(selected.length === 2 && selected[0].evidence.recordId === 'overlap-a' && selected[1].evidence.recordId === 'overlap-c');
  const liveContext = '[Source 1] Synthetic supplied source.\n[Source 2] Synthetic supplied source.';
  const budget = 1_000 - liveContext.length - 2;
  const result = formatStoredGamingEvidence(selected, { sourceIndexOffset: 2, maxContextChars: budget }, LIMITS);
  requireProof(result.evidence?.length === 2 && result.sources.length === 1);
  requireProof(`${liveContext}\n\n${result.context}`.length <= 1_000);
  requireProof(result.context.match(/\[Source 3\]/gu)?.length === 2 && !result.context.includes('[Source 4]'));
  requireProof(result.context.includes(shared) && result.context.includes(distinct));
  const empty = formatStoredGamingEvidence(selected, { maxContextChars: 10 }, LIMITS);
  requireProof(empty.context === '' && empty.sources.length === 0 && !empty.evidence?.length);

  const unrelated = shortRow('metadata-only', 'The training route leads to the wooden practice gate.');
  unrelated.title = 'Zephyrglass Compass';
  unrelated.searchText = `Zephyrglass Compass\n${unrelated.searchText}`;
  requireProof(selectStoredGamingEvidence([unrelated], input, LIMITS).length === 0);
  requireProof(selectStoredGamingEvidence([{ ...first, relevance: 0 }], input, LIMITS).length === 0);
  requireProof(selectStoredGamingEvidence([first], { ...input, excludePublicUrls: [SOURCE_URL] }, LIMITS).length === 0);
  requireProof(selectStoredGamingEvidence([first], { ...input, prompt: 'What should I do?' }, LIMITS).length === 0);
  const corrupt = { ...first, normalized: { text: shared, chunk: { ordinal: -1, totalChunks: 3, startChar: 0, endChar: shared.length } } };
  requireProof(selectStoredGamingEvidence([corrupt], input, LIMITS).length === 0);
}

function requireStructuredTail(): void {
  const fact = 'Rotation: activate the Zephyrglass Compass before opening the cobalt arch.';
  const structuredEvidence = `${'Equipment: synthetic training armor. '.repeat(240).slice(0, 8_000 - fact.length)}${fact}`;
  const text = `${'Synthetic build planner prose. '.repeat(80).slice(0, 1_999)}X`;
  const title = 'Synthetic build '.padEnd(500, 't');
  const game = 'Synthetic Game '.padEnd(120, 'g');
  const patch = '1.'.padEnd(64, '2');
  requireProof(structuredEvidence.length === 8_000 && text.length === 2_000);
  const searchText = buildGamingDocumentSearchText({
    cleanedText: text, title, game, patchVersion: patch, normalizedEvidence: structuredEvidence, maxChars: 10_692
  });
  requireProof(searchText === [text, title, game, patch, structuredEvidence].join('\n\n') && searchText.endsWith(fact));
  const candidate = shortRow('structured-tail', text);
  candidate.recordType = 'build';
  candidate.title = title;
  candidate.searchText = searchText;
  candidate.normalized = { ...candidate.normalized, structuredEvidence };
  const selected = selectStoredGamingEvidence([candidate], { game, prompt: 'Zephyrglass Compass', mode: 'build' }, LIMITS);
  const result = formatStoredGamingEvidence(selected, { maxContextChars: 2_000 }, LIMITS);
  requireProof(result.evidence?.length === 1 && result.sources.length === 1 && result.context.includes(fact));
  requireProof(result.sources[0].snippet.includes(fact) && result.context.length <= 2_000);
}

async function requirePartialCoverageAndUnicode(): Promise<void> {
  const bounded = await chunkGamingDocument('Synthetic checkpoint. '.repeat(44_000));
  requireChunkCoverage(bounded);
  requireProof(bounded.documentChars < 1_000_000 && bounded.chunks.length === 500);
  requireProof(bounded.indexedChars < bounded.documentChars && bounded.documentTruncated && bounded.coverageStatus === 'partial');
  const capped = await chunkGamingDocument(`${'🗝'.repeat(499_999)}x🗝tail`);
  requireChunkCoverage(capped);
  requireProof(capped.documentChars === 999_999 && capped.text.endsWith('x') && capped.documentTruncated && capped.coverageStatus === 'partial');
  const unicode = await chunkGamingDocument(`\uD800\u0000${'🗝'.repeat(3_000)}\uDC00`);
  requireChunkCoverage(unicode);
  requireProof(unicode.text.startsWith('\uFFFD ') && unicode.text.endsWith('\uFFFD'));
  requireProof(!unicode.text.includes('\u0000') && unicode.indexedChars === unicode.documentChars);
  requireProof(!unicode.documentTruncated && unicode.coverageStatus === 'complete');
}

async function acquireArchive(body: string, selectedChars: number | undefined, expectedReadChars: number,
  reads: string[], declaredBytes = Buffer.byteLength(body, 'utf8')) {
  const metadata = JSON.stringify({
    metadata: { identifier: ITEM, mediatype: 'texts' }, d1: 'ia123.us.archive.org', dir: `/1/items/${ITEM}`,
    files: [
      { name: 'manual.pdf', format: 'PDF', source: 'original', size: '1000' },
      { name: 'manual_djvu.txt', format: 'DjVuTXT', source: 'derivative', original: 'manual.pdf', size: String(declaredBytes) }
    ]
  });
  return resolveGamingArchiveResourceCore(SOURCE_URL, 2_000_000, { maxSelectedTextChars: selectedChars }, {
    prepareResourceUrl: (url) => [SOURCE_URL, DOCUMENT_URL].includes(url) ? { privateFetchUrl: url } : null,
    fetchAndClean: async (url, maxChars, options) => {
      reads.push(url);
      requireProof(url === METADATA_URL || url === DOCUMENT_URL);
      const isMetadata = url === METADATA_URL;
      requireProof(options.includeLinks === false && maxChars === (isMetadata ? 0 : expectedReadChars));
      requireProof(options.rawDocumentMaxChars === (isMetadata ? 128_000 : 1_000_000));
      const raw = isMetadata ? metadata : body;
      options.onRawDocument({ body: raw, contentType: isMetadata ? 'application/json' : 'text/plain', truncated: false });
      return raw.slice(0, maxChars);
    }
  });
}

async function requireArchiveBounds(guide: string): Promise<void> {
  const reads: string[] = [];
  const durable = await acquireArchive(guide, 2_000_000, 1_000_000, reads);
  requireProof(durable?.text === guide && durable.text.includes(FINAL_FACT));
  const live = await acquireArchive(guide, undefined, 100_000, reads);
  requireProof(live?.text === guide.slice(0, 100_000) && !live.text.includes(LATE_FACT));
  const multibyte = '道'.repeat(210_000);
  const selected = await acquireArchive(multibyte, 200_000, 200_000, reads);
  requireProof(selected?.text.length === 200_000 && selected.resolution.archiveDerivativeBytes === 630_000);
  requireProof(reads.length === 6 && reads.every((url, index) => url === (index % 2 ? DOCUMENT_URL : METADATA_URL)));
  const rejectedReads: string[] = [];
  let rejected = false;
  try {
    await acquireArchive('道'.repeat(340_000), 1_000_000, 1_000_000, rejectedReads, 1000);
  } catch (error) {
    rejected = error instanceof GamingArchiveResolutionError && error.reason === 'DOCUMENT_TOO_LARGE';
  }
  requireProof(rejected && rejectedReads.length === 2);
}

/** Fixed pure-component proof; no ingestion writer, SQL, pool, provider, HTTP extractor, or configured logger. */
export async function runGamingDurableRagPreview(): Promise<void> {
  try {
    const guide = guideText();
    requireProof(guide.length >= 590_000 && guide.length < 600_000 && guide.indexOf(FINAL_FACT) > 590_000);
    const chunked = await chunkGamingDocument(guide);
    requireChunkCoverage(chunked);
    requireProof(chunked.text === guide && chunked.indexedChars === guide.length && !chunked.documentTruncated);
    requireProof(chunked.coverageStatus === 'complete' && chunked.chunks.length > 200);
    const unchanged = await chunkGamingDocument(guide);
    requireProof(JSON.stringify(unchanged) === JSON.stringify(chunked));
    const originalHash = hashGamingDocumentRevision(guide, '{}');
    const changed = guide.replace('violet lantern', 'copper lantern');
    requireProof(changed !== guide && changed.length === guide.length && changed.slice(0, 100_000) === guide.slice(0, 100_000));
    requireProof(originalHash === hashGamingDocumentRevision(guide, '{}'));
    requireProof(originalHash !== hashGamingDocumentRevision(changed, '{}'));
    requireProof(originalHash !== hashGamingDocumentRevision(guide, '{}', 'gaming-document-chunks-v2'));
    requireDeepRetrieval(chunked.chunks);
    requireSelectionAndBudgets();
    requireStructuredTail();
    await requirePartialCoverageAndUnicode();
    await requireArchiveBounds(guide);
  } catch {
    throw new Error(FAILURE);
  }
}

const SAMURAI_URL = 'https://large-source-preview.example/guides/samurai';
const SAMURAI_INPUT: GamingStoredKnowledgeInput = {
  game: 'Elden Ring', mode: 'build', class: 'Samurai', platform: 'PC/Steam', edition: 'Base game',
  role: 'solo PvE', progressPoint: 'after the tutorial through level 50',
  constraints: ['base game only', 'keep Uchigatana'], requireRequestCoverage: true, limit: 6,
  prompt: 'Recommend an early-game Samurai bleed build covering stats through level 50; Uchigatana upgrades; '
    + 'bleed affinity; Ashes of War; combat rotation; medium equipment load; healing flasks; talisman selection.'
};
const SAMURAI_TOPICS = [
  'Stats through level 50 prioritize Vigor for survival before Dexterity investment.',
  'Uchigatana upgrades use ordinary Smithing Stones found along the early route.',
  'Bleed affinity is a weapon choice and this synthetic example makes no current-patch damage claim.',
  'Ashes of War guidance retains Unsheathe while learning enemy recovery windows.',
  'Combat rotation waits for an enemy miss, strikes once, then recovers stamina.',
  'Medium equipment load leaves room for a dodge after each controlled attack.',
  'Healing flasks should be replenished at a checkpoint before practising combat.',
  'Talisman selection uses base-game equipment available along the opening route.'
];
const SAMURAI_COMBINED = 'In Elden Ring, this synthetic early Samurai bleed build for solo PvE on PC/Steam uses the base-game Uchigatana. '
  + SAMURAI_TOPICS.slice(0, 3).join(' ');

function largeSourceRow(id: string, text: string, ordinal: number, game = SAMURAI_INPUT.game): GamingStoredEvidenceRecord {
  const startChar = ordinal * 2_000;
  return { recordId: id, recordType: 'guide', title: `${game} synthetic guide`, searchText: text,
    normalized: { text, chunk: { ordinal, totalChunks: 100, startChar, endChar: startChar + text.length } },
    gameName: game, sourceId: 'synthetic-samurai-source', publicUrl: SAMURAI_URL, sourceType: 'supplied',
    revisionId: 'synthetic-samurai-revision', fetchedAt: FETCHED_AT, publishedAt: null,
    provenance: { resolverId: 'generic-web', resolverVersion: 'gaming-document-v3', resolutionStrategy: 'article', edition: 'base-game' },
    relevance: 1 };
}

function requireLargeHtmlExtraction(): ReturnType<typeof extractGamingDocumentEvidence>['units'][number] {
  const columns = '<tr><th>Game</th><th>Build</th><th>Item</th><th>Skill</th><th>Scope</th><th>Description</th></tr>';
  const record = `<tr><td>Elden Ring</td><td>Samurai</td><td>Uchigatana</td><td>Unsheathe</td><td>Base game</td><td>${SAMURAI_COMBINED}</td></tr>`;
  const irrelevant = columns + '<tr><td>Navigation Sentinel</td><td>Menu</td><td>Irrelevant</td><td>None</td><td>All</td><td>Unrelated page material.</td></tr>';
  // The multi-megabyte inert page shell models a legitimate HTML response without executing scripts.
  const html = '<html><head><title>Elden Ring synthetic Samurai guide</title></head><body>'
    + `<nav><table>${irrelevant}</table></nav><main><article><h1>Elden Ring Samurai guide</h1>`
    + `<section><h2>Base-game Samurai build</h2><table>${columns}${record}</table></section>`
    + '</article></main><aside>Unrelated Sidebar Sentinel</aside><script type="application/javascript">'
    + JSON.stringify({ inertPageShell: '道'.repeat(700_000) }) + '</script></body></html>';
  const bytes = Buffer.byteLength(html, 'utf8');
  requireProof(bytes > 2_000_000 && html.length < GAMING_HTML_EVIDENCE_LIMITS.htmlChars);
  const acceptedBudget = { ...GAMING_DOCUMENT_ACQUISITION_LIMITS, declaredBytes: bytes, transferredBytes: bytes, decodedBytes: bytes };
  requireProof(getProtectedDocumentByteBudgetFailure('transferred_bytes', acceptedBudget) === undefined
    && getProtectedDocumentByteBudgetFailure('decoded_bytes', acceptedBudget) === undefined);
  // This proves the HTML structural component independently of the optional JSON extractor's real-time budget.
  const extracted = extractGamingHtmlEvidence({ body: html, sourceUrl: SAMURAI_URL, contentType: 'text/html', transportTruncated: false });
  requireProof(extracted.inputBytes === bytes && !extracted.truncated && extracted.subreasons.length === 0);
  requireProof(extracted.units.length === 1 && extracted.outputChars === extracted.units[0].text.length);
  const unit = extracted.units[0];
  requireProof(unit.integrity.status === 'complete' && unit.integrity.reasons.length === 0);
  requireProof(unit.text.includes(SAMURAI_COMBINED) && !unit.text.includes('Sentinel') && !unit.text.includes('inertPageShell'));
  requireProof(unit.fields.some(field => field.label === 'Item' && field.value === 'Uchigatana'));
  requireProof(unit.provenance.sourceUrl === SAMURAI_URL && unit.provenance.strategy === 'html_table'
    && unit.provenance.representation === 'html_dom' && unit.provenance.locator.startsWith('html_table:element:'));
  const projection = projectGamingDocumentText({ acquiredText: '', selectedTextLength: 0, maxChars: 1_000_000, evidenceUnits: [unit] });
  requireProof(projection.text === unit.text && !projection.truncated && projection.cleanedTextLength < 1_000);
  const search = buildGamingDocumentSearchText({ cleanedText: projection.text, game: SAMURAI_INPUT.game,
    normalizedEvidence: 'Synthetic index metadata. '.repeat(100), maxChars: 1_000 });
  requireProof(search.length === 1_000 && search.startsWith(unit.text));
  const context = formatStoredGamingEvidence([{ evidence: { sourceId: 'synthetic-html-source', revisionId: 'synthetic-html-revision',
    recordId: `synthetic-html-record-${unit.id}`, recordType: 'guide', publicUrl: SAMURAI_URL, text: unit.text,
    evidenceUnits: [unit], lexicalScore: 1, combinedScore: 1, provenance: { fetchedAt: FETCHED_AT.toISOString() } },
  source: { sourceId: 'synthetic-html-source', url: SAMURAI_URL, sourceType: 'supplied', fetchedAt: FETCHED_AT.toISOString(), snippet: unit.text } }],
  { maxContextChars: 1_200, sourceIndexOffset: 2 }, LIMITS);
  requireProof(context.context.length <= 1_200 && context.context.includes(unit.text) && context.context.includes('[Source 3]'));
  const bounded = projectGamingDocumentText({ acquiredText: 'Synthetic guide prose. '.repeat(50_000),
    selectedTextLength: 1_100_000, maxChars: 1_000_000 });
  requireProof(bounded.text.length <= 1_000_000 && bounded.truncated);
  return unit;
}

async function requireOversizedPureBoundaries(): Promise<void> {
  // Production-owned allowances and admission policy; this seam never starts a transport.
  const { maxTransferredBytes, maxDecodedBytes } = GAMING_DOCUMENT_ACQUISITION_LIMITS;
  for (const stage of ['declared_length', 'transferred_bytes', 'decoded_bytes'] as const) {
    const exact = { maxTransferredBytes, maxDecodedBytes,
      transferredBytes: stage === 'declared_length' ? 0 : maxTransferredBytes,
      decodedBytes: maxDecodedBytes, ...(stage === 'declared_length' ? { declaredBytes: maxTransferredBytes } : {}) };
    requireProof(getProtectedDocumentByteBudgetFailure(stage, exact) === undefined);
    const excess = { ...exact,
      ...(stage === 'declared_length' ? { declaredBytes: maxTransferredBytes + 1 }
        : stage === 'transferred_bytes' ? { transferredBytes: maxTransferredBytes + 1 } : { decodedBytes: maxDecodedBytes + 1 }) };
    const failure = getProtectedDocumentByteBudgetFailure(stage, excess);
    requireProof(failure?.code === (stage === 'decoded_bytes' ? 'DECODED_LIMIT' : 'TRANSFER_LIMIT'));
    requireProof(failure.byteDiagnostics.limitStage === stage && failure.byteDiagnostics.maxTransferredBytes === maxTransferredBytes
      && failure.byteDiagnostics.maxDecodedBytes === maxDecodedBytes);
    requireProof(failure.byteDiagnostics.transferredBytes === excess.transferredBytes
      && failure.byteDiagnostics.decodedBytes === excess.decodedBytes);
  }
  const aggregate = getProtectedDocumentByteBudgetFailure('declared_length', {
    maxTransferredBytes, maxDecodedBytes, transferredBytes: 10, decodedBytes: 10, declaredBytes: maxTransferredBytes - 9
  });
  requireProof(aggregate?.code === 'TRANSFER_LIMIT' && aggregate.byteDiagnostics.limitStage === 'declared_length');
  const extracted = extractGamingDocumentEvidence({ body: 'x'.repeat(GAMING_HTML_EVIDENCE_LIMITS.htmlChars + 1),
    sourceUrl: SAMURAI_URL, contentType: 'text/html', transportTruncated: false });
  requireProof(extracted.units.length === 0 && extracted.proseBody === '' && extracted.diagnostics.budgetOutcome === 'exhausted');
  requireProof(extracted.diagnostics.subreasons.includes('extraction_budget_exhausted')
    && extracted.diagnostics.truncationStages.includes('extraction'));
  const reads: string[] = [];
  let rejected = false;
  try { await acquireArchive('道'.repeat(340_000), 1_000_000, 1_000_000, reads, 1_000); }
  catch (error) { rejected = error instanceof GamingArchiveResolutionError && error.reason === 'DOCUMENT_TOO_LARGE'; }
  requireProof(rejected && reads.length === 2);
}

function requireCompleteCandidatePool(): void {
  const input: GamingStoredKnowledgeInput = { game: 'Synthetic Lantern Quest', mode: 'guide', requireRequestCoverage: true,
    prompt: 'How do I activate amber gate and cross crystal bridge?' };
  const incomplete = Array.from({ length: 24 }, (_unused, index) => largeSourceRow(`pool-record-${index}`,
    `Activate amber gate using the copper switch beside lantern ${index}.`, index, input.game));
  const supporting = largeSourceRow('pool-record-24',
    'Activate amber gate using the copper switch. Cross crystal bridge following the blue lanterns.', 24, input.game);
  const selected = selectStoredGamingEvidence([...incomplete, supporting], input, LIMITS, undefined, assessGamingRequestCoverage);
  const knowledge = formatStoredGamingEvidence(selected, input, LIMITS);
  requireProof(selected.length === 1 && selected[0].evidence.recordId === supporting.recordId);
  requireProof(assessGamingRequestCoverage(input, knowledge).coverageSatisfied && knowledge.context.includes(supporting.searchText));
  requireProof(knowledge.evidence?.[0].sourceId === supporting.sourceId && knowledge.evidence[0].revisionId === supporting.revisionId
    && knowledge.evidence[0].publicUrl === supporting.publicUrl && knowledge.evidence[0].ordinal === 24);
  requireProof(knowledge.context.includes('[Source 1]') && knowledge.sources[0].url === SAMURAI_URL);
  const partial = formatStoredGamingEvidence(selectStoredGamingEvidence(incomplete, input, LIMITS, undefined,
    assessGamingRequestCoverage), input, LIMITS);
  requireProof(!assessGamingRequestCoverage(input, partial).coverageSatisfied);
}

function requireSamuraiMultiTopic(late: boolean): void {
  requireProof(buildGamingRequestRequirements(SAMURAI_INPUT).length === 8);
  const singletons = [...SAMURAI_TOPICS.slice(3),
    ...Array.from({ length: 36 }, (_unused, index) => SAMURAI_TOPICS[index % 3])];
  const texts = late ? [...singletons, SAMURAI_COMBINED] : [SAMURAI_COMBINED, ...singletons];
  const rows = texts.map((text, index) => largeSourceRow(`samurai-record-${index}`, text, index));
  const combinedIndex = late ? singletons.length : 0;
  rows[combinedIndex].relevance = 0.1;
  const selected = selectStoredGamingEvidence(rows, SAMURAI_INPUT, LIMITS, undefined, assessGamingRequestCoverage);
  const knowledge = formatStoredGamingEvidence(selected, SAMURAI_INPUT, LIMITS);
  requireProof(selected.length === 6 && knowledge.evidence?.length === 6 && knowledge.context.length <= LIMITS.maxContextChars);
  requireProof(selected.some(candidate => candidate.evidence.recordId === rows[combinedIndex].recordId));
  requireProof(knowledge.context.includes(SAMURAI_COMBINED) && knowledge.sources.length === 1);
  const coverage = assessGamingRequestCoverage(SAMURAI_INPUT, knowledge);
  requireProof(coverage.coverageSatisfied && coverage.missingCoverage.length === 0 && coverage.requirementSupport.length === 8);
  requireProof(coverage.requirementSupport.slice(0, 3).every(support => support.evidenceIds.includes(rows[combinedIndex].recordId)));
  requireProof(knowledge.evidence.every(chunk => chunk.sourceId === 'synthetic-samurai-source'
    && chunk.revisionId === 'synthetic-samurai-revision' && chunk.publicUrl === SAMURAI_URL));
  const missing = formatStoredGamingEvidence(selectStoredGamingEvidence(rows.filter(row => !row.searchText.includes('Healing flasks')),
    SAMURAI_INPUT, LIMITS, undefined, assessGamingRequestCoverage), SAMURAI_INPUT, LIMITS);
  requireProof(!assessGamingRequestCoverage(SAMURAI_INPUT, missing).coverageSatisfied);
  const tooSmall = { ...SAMURAI_INPUT, maxContextChars: 100 };
  const bounded = formatStoredGamingEvidence(selectStoredGamingEvidence(rows, tooSmall, LIMITS, undefined,
    assessGamingRequestCoverage), tooSmall, LIMITS);
  requireProof(bounded.context.length <= 100 && !assessGamingRequestCoverage(tooSmall, bounded).coverageSatisfied);
}

function requireNegativeEvidence(unit: ReturnType<typeof requireLargeHtmlExtraction>): void {
  const narrow = { ...SAMURAI_INPUT, prompt: 'Explain Samurai Uchigatana Unsheathe', requireRequestCoverage: false };
  requireProof(selectStoredGamingEvidence([largeSourceRow('wrong-game', SAMURAI_COMBINED, 0, 'Dark Souls III')], narrow, LIMITS).length === 0);
  const policy = assessGamingSourcePolicy(SAMURAI_URL, SAMURAI_INPUT.game);
  const document = { publicUrl: SAMURAI_URL, metadata: { title: 'Elden Ring Samurai guide' }, text: SAMURAI_COMBINED };
  const wrongEdition = { ...document, metadata: { title: 'Elden Ring Shadow of the Erdtree Samurai guide' },
    text: `Edition: Shadow of the Erdtree. ${SAMURAI_COMBINED}` };
  requireProof(assessGamingClearSourceIdentity(wrongEdition, SAMURAI_INPUT, policy).status === 'conflict');
  const dlc = 'This weapon is only available in Shadow of the Erdtree.';
  requireProof(classifyGamingEditionRequirements(dlc) === 'conflict');
  requireProof(assessGamingClearSourceIdentity({ ...document, text: `${SAMURAI_COMBINED} ${dlc}` }, SAMURAI_INPUT, policy).status === 'conflict');
  const partial = { ...unit, integrity: { status: 'partial' as const, reasons: ['incomplete_record'] } };
  const row = largeSourceRow('partial-structural', partial.text, 0);
  row.normalized = { ...row.normalized, evidenceUnits: [partial] };
  requireProof(selectStoredGamingEvidence([row], narrow, LIMITS).length === 0);
  const conflictHtml = '<html><body><article><h1>Elden Ring Samurai guide</h1><table>'
    + '<tr><th>Item</th><th>Stat</th><th>Value</th><th>Unit</th><th>Scope</th></tr>'
    + '<tr><td>Uchigatana</td><td>bleed buildup</td><td>45</td><td>points</td><td>Base game</td></tr>'
    + '<tr><td>Uchigatana</td><td>bleed buildup</td><td>99</td><td>points</td><td>Base game</td></tr></table></article></body></html>';
  const conflicting = extractGamingDocumentEvidence({ body: conflictHtml, sourceUrl: SAMURAI_URL, contentType: 'text/html' });
  requireProof(conflicting.units.length === 2 && conflicting.units.every(entry => entry.integrity.status !== 'complete'));
  const conflictingRows = conflicting.units.map((entry, index) => {
    const candidate = largeSourceRow(`conflicting-stat-${index}`, entry.text, index);
    candidate.normalized = { ...candidate.normalized, evidenceUnits: [entry] };
    return candidate;
  });
  requireProof(selectStoredGamingEvidence(conflictingRows, { ...narrow, prompt: 'What is Uchigatana bleed buildup value?' }, LIMITS).length === 0);
  const freshness = extractGamingFreshnessMetadata({ ...document, text: `${SAMURAI_COMBINED} This is the latest current-patch build.` },
    SAMURAI_INPUT, FETCHED_AT);
  const evaluated = evaluateGamingFreshness({ game: SAMURAI_INPUT.game, question: 'What is the current best Samurai bleed build?',
    mode: 'build', evidence: [freshness], now: FETCHED_AT });
  requireProof(!evaluated.usable && evaluated.status === 'unverified');
}

function requireTransientArtifactBindings(): void {
  const workflowId = '10000000-0000-4000-8000-000000000001';
  const actorScopeHash = 'a'.repeat(64);
  const now = FETCHED_AT.getTime();
  const candidate = { candidateId: 'synthetic-samurai-source', publicUrl: SAMURAI_URL, actorScopeHash, workflowId,
    expiresAt: now + 1, document: { requestedUrl: SAMURAI_URL } };
  const knowledge = formatStoredGamingEvidence(selectStoredGamingEvidence([largeSourceRow('artifact-record', SAMURAI_COMBINED, 0)],
    { ...SAMURAI_INPUT, requireRequestCoverage: false }, LIMITS), {}, LIMITS);
  requireProof(knowledge.evidence?.length === 1 && knowledge.evidence[0].revisionId === 'synthetic-samurai-revision');
  const input = { requiredUrls: [SAMURAI_URL], accepted: [candidate], actorScopeHash, workflowId, now, knowledge };
  requireProof(projectGamingHybridSuppliedGuides(input).length === 1);
  for (const denied of [{ ...candidate, actorScopeHash: 'b'.repeat(64) },
    { ...candidate, workflowId: '10000000-0000-4000-8000-000000000002' }, { ...candidate, expiresAt: now },
    { ...candidate, candidateId: 'another-workflow-source' }, { ...candidate, publicUrl: `${SAMURAI_URL}/other` }])
    requireProof(projectGamingHybridSuppliedGuides({ ...input, accepted: [denied] }).length === 0);
  const contentHash = hashGamingDocumentRevision(SAMURAI_COMBINED, '{}');
  const approved = { approvedContentHash: contentHash, documentContentHash: contentHash, truncated: false, instructionFiltered: false };
  requireProof(isGamingApprovedArtifactCurrent(approved));
  requireProof(!isGamingApprovedArtifactCurrent({ ...approved,
    documentContentHash: hashGamingDocumentRevision(`${SAMURAI_COMBINED} Changed acquired revision.`, '{}') }));
  requireProof(!isGamingApprovedArtifactCurrent({ ...approved, truncated: true }));
  requireProof(!isGamingApprovedArtifactCurrent({ ...approved, instructionFiltered: true }));
  const query = { contractVersion: GAMING_HYBRID_V2_CONTRACT_VERSION, idempotencyKey: 'large-source-transient-fixture',
    game: SAMURAI_INPUT.game, question: SAMURAI_INPUT.prompt };
  requireProof(gamingHybridQuerySchema.parse(query).storagePolicy === 'transient_only');
  requireProof(!gamingHybridQuerySchema.safeParse({ ...query, canStore: true }).success);
}

/** Additional fixed component proof; transport cancellation, durable writes and provider invocation are separate gates. */
export async function runGamingLargeSourcePreview(): Promise<void> {
  try {
    const unit = requireLargeHtmlExtraction();
    await requireOversizedPureBoundaries();
    requireCompleteCandidatePool();
    requireSamuraiMultiTopic(false);
    requireSamuraiMultiTopic(true);
    requireNegativeEvidence(unit);
    requireTransientArtifactBindings();
  } catch {
    throw new Error('PREVIEW_GAMING_LARGE_SOURCE_CONTRACT_INVALID');
  }
}
