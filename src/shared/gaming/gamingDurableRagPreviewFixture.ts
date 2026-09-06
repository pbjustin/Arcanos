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
  type GamingStoredEvidenceRecord
} from './gamingStoredEvidenceCore.js';

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
