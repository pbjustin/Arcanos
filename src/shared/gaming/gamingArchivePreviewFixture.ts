import { GamingSourceEvidenceError } from '@services/gamingModes.js';
import {
  GAMING_ARCHIVE_RESOURCE_LIMITS,
  resolveGamingArchiveResourceCore,
  type GamingArchiveRawDocument
} from './gamingArchiveResourceCore.js';
import {
  buildGamingGroundingSummary,
  createGamingSuppliedGuideEvidenceError,
  isCitableGamingEvidenceSource,
  LIMITED_GAMING_ARTICLE_TEXT_SNIPPET,
  resolveGamingExecutionOutcome
} from './gamingGrounding.js';

const FAILURE = 'PREVIEW_GAMING_ARCHIVE_GROUNDING_CONTRACT_INVALID';
const ITEM_ID = 'native_preview_manual';
const ITEM_URL = `https://archive.org/details/${ITEM_ID}`;
const METADATA_URL = `https://archive.org/metadata/${ITEM_ID}`;
const STORAGE_BASE = `https://ia123.us.archive.org/1/items/${ITEM_ID}`;
const OCR_URL = `${STORAGE_BASE}/manual_djvu.txt`;
const PLAIN_URL = `${STORAGE_BASE}/manual.txt`;
const TEXT = 'Synthetic preview guide: save at the lantern checkpoint before entering the courtyard. '
  + 'Equip a healing item, avoid the opening boss attack, and follow the western path during the recovery window.';
const MAX_CONTEXT_CHARS = 512;
const MAX_DOCUMENT_CHARS = 1_024;

function requireProof(condition: unknown): asserts condition {
  if (!condition) throw new Error(FAILURE);
}

function metadata() {
  return {
    metadata: { identifier: ITEM_ID, mediatype: 'texts' },
    d1: 'ia123.us.archive.org',
    dir: `/1/items/${ITEM_ID}`,
    files: [
      { name: 'manual.pdf', format: 'PDF', source: 'original', size: '1000' },
      { name: 'manual.txt', format: 'Text', source: 'derivative', original: 'manual.pdf', size: String(TEXT.length) },
      { name: 'manual_djvu.txt', format: 'DjVuTXT', source: 'derivative', original: 'manual.pdf', size: String(TEXT.length) }
    ]
  };
}

function rawMetadata(body = JSON.stringify(metadata())): GamingArchiveRawDocument {
  return { body, contentType: 'application/json', truncated: false };
}

async function exerciseArchive(input: {
  metadataDocument: GamingArchiveRawDocument | null;
  textDocument?: GamingArchiveRawDocument | null;
  failRead?: 'metadata' | 'text';
  signal?: AbortSignal;
}) {
  const reads: Array<{ url: string; maxChars: number; rawChars: number; includeLinks: boolean }> = [];
  let returnedRawDocument: GamingArchiveRawDocument | undefined;
  try {
    const result = await resolveGamingArchiveResourceCore(ITEM_URL, MAX_DOCUMENT_CHARS, {
      signal: input.signal,
      onRawDocument: (document) => { returnedRawDocument = document; }
    }, {
      prepareResourceUrl: (url) => [ITEM_URL, OCR_URL, PLAIN_URL].includes(url)
        ? { privateFetchUrl: url } : null,
      fetchAndClean: async (url, maxChars, options) => {
        reads.push({ url, maxChars, rawChars: options.rawDocumentMaxChars, includeLinks: options.includeLinks });
        if ((input.failRead === 'metadata' && url === METADATA_URL)
          || (input.failRead === 'text' && url !== METADATA_URL)) {
          throw new Error('Synthetic preview read unavailable');
        }
        const document = url === METADATA_URL ? input.metadataDocument
          : url === OCR_URL || url === PLAIN_URL ? input.textDocument : null;
        if (document) options.onRawDocument(document);
        // This is an in-memory read seam, not the production HTTP extractor.
        return document?.body.slice(0, maxChars) ?? '';
      }
    });
    return { result, reads, returnedRawDocument, error: undefined };
  } catch (error) {
    return { result: null, reads, returnedRawDocument, error };
  }
}

function requireReads(reads: Awaited<ReturnType<typeof exerciseArchive>>['reads'], count: number): void {
  requireProof(reads.length === count);
  for (const [index, read] of reads.entries()) {
    requireProof(read.url === (index === 0 ? METADATA_URL : OCR_URL));
    requireProof(read.maxChars === (index === 0 ? 0 : MAX_DOCUMENT_CHARS));
    requireProof(read.rawChars === (index === 0 ? 128_000 : 1_000_000));
    requireProof(read.includeLinks === false);
  }
}

function fixtureGrounding(text: string | undefined, contextChars: number, fetchedSourceCount: number) {
  const source = text === undefined ? undefined : { snippet: text };
  const citable = source !== undefined && isCitableGamingEvidenceSource(source);
  // Fixed admission into a small synthetic context does not execute RAG ranking.
  const context = citable ? text!.slice(0, contextChars).trim() : '';
  const sources = source && (context || !citable) ? [source] : [];
  const selectedChunkCount = context ? 1 : 0;
  return {
    context,
    grounding: buildGamingGroundingSummary({
      requestedSourceCount: 1, fetchedSourceCount,
      fetchedSuppliedSourceCount: fetchedSourceCount,
      sources, selectedChunkCount,
      suppliedEvidenceSourceCount: selectedChunkCount
    })
  };
}

function requireEvidenceRejection(
  grounding: ReturnType<typeof buildGamingGroundingSummary>,
  expectedCode: 'GAMING_SOURCE_UNREADABLE' | 'GAMING_SOURCE_UNAVAILABLE'
): void {
  let providerSentinelCalls = 0;
  let rejected: unknown;
  try {
    const error = createGamingSuppliedGuideEvidenceError(grounding);
    if (error) throw error;
    providerSentinelCalls += 1;
  } catch (error) {
    rejected = error;
  }
  requireProof(providerSentinelCalls === 0);
  requireProof(rejected instanceof GamingSourceEvidenceError && rejected.code === expectedCode);
  requireProof(rejected.grounding.groundedInSuppliedEvidence === false);
  requireProof(rejected.grounding.groundingStatus ===
    (expectedCode === 'GAMING_SOURCE_UNREADABLE' ? 'insufficient_evidence' : 'unavailable'));
}

/** Fixed served component proof; no caller data, provider, HTTP, DNS, ranking, or logger execution. */
export async function runGamingArchiveGroundingPreview(): Promise<void> {
  try {
    requireProof(GAMING_ARCHIVE_RESOURCE_LIMITS.metadataBytes === 128_000);
    requireProof(GAMING_ARCHIVE_RESOURCE_LIMITS.documentBytes === 1_000_000);
    const textDocument = { body: TEXT, contentType: 'text/plain', truncated: false };
    const success = await exerciseArchive({ metadataDocument: rawMetadata(), textDocument });
    requireProof(success.error === undefined && success.result !== null);
    requireReads(success.reads, 2);
    requireProof(success.returnedRawDocument === textDocument);
    requireProof(success.result.text === TEXT);
    requireProof(success.result.resolution.archiveResolverVersion === 'archive-text-v1');
    requireProof(success.result.resolution.archiveSelectionReason === 'archive_djvu_text');
    requireProof(success.result.resolution.archiveDerivativeBytes === Buffer.byteLength(TEXT, 'utf8'));
    requireProof(success.result.resolution.archiveMetadataFileCount === 3);
    const accepted = fixtureGrounding(success.result.text, MAX_CONTEXT_CHARS, 1);
    requireProof(accepted.context === TEXT && accepted.context.length <= MAX_CONTEXT_CHARS);
    requireProof(accepted.grounding.groundingStatus === 'grounded');
    requireProof(accepted.grounding.fetchedSourceCount === 1 && accepted.grounding.selectedChunkCount === 1);
    requireProof(accepted.grounding.usableSourceCount === 1 && accepted.grounding.citableSourceCount === 1);
    requireProof(accepted.grounding.groundedInSuppliedEvidence === true);
    requireProof(createGamingSuppliedGuideEvidenceError(accepted.grounding) === null);

    const ambiguous = metadata();
    ambiguous.files.push({ name: 'second.txt', format: 'Text', source: 'original', size: '200' });
    const unsafe = metadata();
    unsafe.d1 = 'unrelated.invalid';
    const failureCases = [
      { input: { metadataDocument: rawMetadata(JSON.stringify(ambiguous)), textDocument }, code: 'GAMING_ARCHIVE_AMBIGUOUS_DOCUMENTS', reads: 1 },
      { input: { metadataDocument: null }, code: 'GAMING_ARCHIVE_INVALID_METADATA', reads: 1 },
      { input: { metadataDocument: rawMetadata(), failRead: 'metadata' as const }, code: 'GAMING_ARCHIVE_METADATA_UNAVAILABLE', reads: 1 },
      { input: { metadataDocument: rawMetadata(JSON.stringify(unsafe)) }, code: 'GAMING_ARCHIVE_UNSAFE_STORAGE_LOCATION', reads: 1 },
      { input: { metadataDocument: rawMetadata('x'.repeat(128_001)) }, code: 'GAMING_ARCHIVE_METADATA_TOO_LARGE', reads: 1 },
      { input: { metadataDocument: rawMetadata(), textDocument: null }, code: 'GAMING_ARCHIVE_DOCUMENT_NOT_TEXT', reads: 2 },
      { input: { metadataDocument: rawMetadata(), failRead: 'text' as const }, code: 'GAMING_ARCHIVE_DOCUMENT_UNAVAILABLE', reads: 2 }
    ];
    for (const scenario of failureCases) {
      const failure = await exerciseArchive(scenario.input);
      requireProof(failure.result === null && failure.error instanceof Error);
      requireProof('code' in failure.error && failure.error.code === scenario.code);
      requireReads(failure.reads, scenario.reads);
      requireProof(failure.returnedRawDocument === undefined);
    }
    const controller = new AbortController();
    const abortReason = new Error('Synthetic preview request aborted');
    controller.abort(abortReason);
    const aborted = await exerciseArchive({ metadataDocument: rawMetadata(), signal: controller.signal });
    requireProof(aborted.result === null && aborted.error === abortReason);
    requireReads(aborted.reads, 0);

    for (const diagnostic of [
      LIMITED_GAMING_ARTICLE_TEXT_SNIPPET,
      'Structured build resource detected, but the loadout data could not be decoded safely.',
      'Structured build resource detected, but only bounded metadata could be recovered.',
      'Resource metadata was inspected, but no structured build data was recovered.'
    ]) {
      const rejected = fixtureGrounding(diagnostic, MAX_CONTEXT_CHARS, 1);
      requireProof(rejected.context === '' && rejected.grounding.usableSourceCount === 0);
      requireProof(rejected.grounding.selectedChunkCount === 0 && rejected.grounding.suppliedEvidenceSourceCount === 0);
      requireEvidenceRejection(rejected.grounding, 'GAMING_SOURCE_UNREADABLE');
    }
    const zeroContext = fixtureGrounding(success.result.text, 0, 1);
    requireProof(zeroContext.context === '' && zeroContext.grounding.selectedChunkCount === 0);
    requireProof(zeroContext.grounding.suppliedEvidenceSourceCount === 0);
    requireEvidenceRejection(zeroContext.grounding, 'GAMING_SOURCE_UNREADABLE');
    const unavailable = fixtureGrounding(undefined, MAX_CONTEXT_CHARS, 0);
    requireProof(unavailable.grounding.fetchedSourceCount === 0);
    requireEvidenceRejection(unavailable.grounding, 'GAMING_SOURCE_UNAVAILABLE');
    requireProof(resolveGamingExecutionOutcome() === 'completed');
    requireProof(resolveGamingExecutionOutcome('GAMING_PROVIDER_UNAVAILABLE') === 'fallback');
  } catch {
    throw new Error(FAILURE);
  }
}
