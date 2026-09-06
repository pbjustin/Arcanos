/** Shared sentence-bounded chunks for live and stored Gaming document evidence. */
export function splitGamingDocumentIntoChunks(text: string, maxChunkChars: number): string[] {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (!normalized) {
    return [];
  }

  const chunkSize = Math.max(1, maxChunkChars);
  const sentences = normalized.split(/(?<=[.!?])\s+/);
  const chunks: string[] = [];
  let current = '';
  for (const sentence of sentences) {
    const nextLength = current ? current.length + sentence.length + 1 : sentence.length;
    if (nextLength <= chunkSize) {
      current = current ? `${current} ${sentence}` : sentence;
      continue;
    }

    if (current) {
      chunks.push(current);
      current = '';
    }

    if (sentence.length > chunkSize) {
      for (let index = 0; index < sentence.length; index += chunkSize) {
        chunks.push(sentence.slice(index, index + chunkSize));
      }
      continue;
    }

    current = sentence;
  }

  if (current) {
    chunks.push(current);
  }

  return chunks;
}

const QUESTION_STOP_WORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'can', 'do', 'does', 'for', 'from',
  'how', 'i', 'in', 'is', 'it', 'me', 'my', 'of', 'on', 'or', 'should', 'that', 'the',
  'this', 'to', 'was', 'what', 'when', 'where', 'which', 'who', 'why', 'with', 'you'
]);

/** Keep one persisted record while returning evidence from its matching passage. */
export function selectGamingDocumentExcerpt(text: string, query: string, maxChars: number): string {
  const queryTokens = new Set(
    (query.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [])
      .filter((token) => !QUESTION_STOP_WORDS.has(token))
  );
  const chunks = splitGamingDocumentIntoChunks(text, maxChars);
  let selected = chunks[0] ?? '';
  let selectedScore = 0;
  for (const chunk of chunks) {
    const tokens = new Set(chunk.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []);
    let score = 0;
    for (const token of queryTokens) {
      if (tokens.has(token)) score += 1;
    }
    // Strict comparison preserves document order for deterministic score ties.
    if (score > selectedScore) {
      selected = chunk;
      selectedScore = score;
    }
  }
  return selected;
}
