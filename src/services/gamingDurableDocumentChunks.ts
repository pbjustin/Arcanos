import { createHash } from 'node:crypto';
import { setImmediate as yieldToEventLoop } from 'node:timers/promises';

export const GAMING_DOCUMENT_CHUNKING_VERSION = 'gaming-document-chunks-v1';
export const GAMING_DURABLE_DOCUMENT_LIMITS = Object.freeze({
  documentChars: 1_000_000,
  revisionPreviewChars: 16_000,
  maxChunks: 500,
  targetChunkChars: 1_800,
  maxChunkChars: 2_000,
  overlapChars: 240
});

export interface GamingDocumentChunk {
  ordinal: number;
  totalChunks: number;
  startChar: number;
  endChar: number;
  text: string;
  contentHash: string;
  semanticKey: string;
  overlapFromPrevious: boolean;
  headingPath?: string[];
}

function hashText(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** Refresh identity includes all accepted prose, even the portion beyond the record-count bound. */
export function hashGamingDocumentRevision(
  text: string,
  normalizedIdentity: string,
  policyVersion = GAMING_DOCUMENT_CHUNKING_VERSION
): string {
  return hashText(JSON.stringify([policyVersion, text, normalizedIdentity]));
}

function unicodeBoundary(text: string, end: number): number {
  return end > 0 && end < text.length
    && /[\uD800-\uDBFF]/u.test(text[end - 1]) && /[\uDC00-\uDFFF]/u.test(text[end])
    ? end - 1 : end;
}

/** Prefer paragraphs, then sentences, then words; only indivisible runs need a code-point split. */
function selectChunkEnd(text: string, start: number): number {
  const { targetChunkChars, maxChunkChars } = GAMING_DURABLE_DOCUMENT_LIMITS;
  if (text.length - start <= maxChunkChars) return text.length;
  const window = text.slice(start, start + maxChunkChars);
  for (const boundary of [/\n[ \t]*\n+/gu, /[.!?]["'”’)\]]*\s+/gu, /\s+/gu]) {
    let preferred = 0;
    let extended = 0;
    for (const match of window.matchAll(boundary)) {
      const offset = match.index + match[0].length;
      if (offset < 1_200) continue;
      if (offset <= targetChunkChars) preferred = offset;
      else if (!extended) extended = offset;
    }
    if (preferred || extended) return start + (preferred || extended);
  }
  return unicodeBoundary(text, start + targetChunkChars);
}

function selectOverlapStart(text: string, start: number, end: number): number {
  const earliest = Math.max(start + 1, end - GAMING_DURABLE_DOCUMENT_LIMITS.overlapChars);
  const tail = text.slice(earliest, end);
  // A complete trailing sentence provides continuity without copying a paragraph.
  const sentence = /[.!?]["'”’)\]]*\s+/u.exec(tail);
  if (sentence) {
    const candidate = earliest + sentence.index + sentence[0].length;
    if (end - candidate >= 40) return candidate;
  }
  const word = /\s+/u.exec(tail);
  return word && end - (earliest + word.index + word[0].length) >= 40
    ? earliest + word.index + word[0].length : end;
}

/**
 * Durable document segmentation. Offsets address the returned accepted text in UTF-16
 * code units, always at code-point boundaries. A 500-record prefix is explicit partial
 * coverage; no scattered or silently discarded sections are represented as complete.
 */
export async function chunkGamingDocument(
  input: string,
  options: { signal?: AbortSignal; policyVersion?: string } = {}
): Promise<{
  text: string;
  chunks: GamingDocumentChunk[];
  documentChars: number;
  indexedChars: number;
  documentTruncated: boolean;
  coverageStatus: 'complete' | 'partial';
  chunkingVersion: string;
}> {
  options.signal?.throwIfAborted();
  const policyVersion = options.policyVersion ?? GAMING_DOCUMENT_CHUNKING_VERSION;
  if (!/^[a-zA-Z0-9._-]{1,80}$/u.test(policyVersion)) throw new TypeError('Invalid Gaming chunk policy version.');
  const bound = unicodeBoundary(input, Math.min(input.length, GAMING_DURABLE_DOCUMENT_LIMITS.documentChars));
  const text = input.slice(0, bound)
    .replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/gu, '\uFFFD')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/gu, ' ')
    .trim();
  const chunks: GamingDocumentChunk[] = [];
  // Only explicit headings have a provable path. Flat OCR/HTML metadata has no offsets.
  const headings = text.matchAll(/^ {0,3}(#{1,6})[ \t]+([^\n]{1,120})[ \t]*$/gmu);
  let nextHeading = headings.next();
  let headingPath: string[] = [];
  let start = 0;
  let indexedChars = 0;
  while (start < text.length && chunks.length < GAMING_DURABLE_DOCUMENT_LIMITS.maxChunks) {
    options.signal?.throwIfAborted();
    if (chunks.length % 32 === 0) {
      await yieldToEventLoop(undefined, { signal: options.signal });
      options.signal?.throwIfAborted();
    }
    while (!nextHeading.done && nextHeading.value.index <= start) {
      const heading = nextHeading.value;
      headingPath = [...headingPath.slice(0, Math.min(heading[1].length - 1, 3)), heading[2].trim()];
      nextHeading = headings.next();
    }
    const end = selectChunkEnd(text, start);
    const chunkText = text.slice(start, end);
    const ordinal = chunks.length;
    const contentHash = hashText(chunkText);
    chunks.push({
      ordinal, totalChunks: 0, startChar: start, endChar: end, text: chunkText,
      contentHash,
      semanticKey: hashText(JSON.stringify([policyVersion, ordinal, headingPath, contentHash])),
      overlapFromPrevious: start < indexedChars,
      ...(headingPath.length ? { headingPath: [...headingPath] } : {})
    });
    indexedChars = end;
    if (end === text.length) break;
    start = selectOverlapStart(text, start, end);
  }
  for (const chunk of chunks) chunk.totalChunks = chunks.length;
  const documentTruncated = input.length > bound || indexedChars < text.length;
  return {
    text, chunks, documentChars: text.length, indexedChars, documentTruncated,
    coverageStatus: documentTruncated ? 'partial' : 'complete', chunkingVersion: policyVersion
  };
}
