/**
 * Calculates cosine similarity between two vectors while guarding against
 * numerical edge-cases such as zero-length or zero-magnitude vectors.
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (!Array.isArray(a) || !Array.isArray(b)) {
    throw new TypeError('cosineSimilarity expects array inputs');
  }

  if (a.length !== b.length) {
    throw new Error('Vectors must be the same length to compute cosine similarity');
  }

  if (a.length === 0) {
    return 0;
  }

  let dot = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i++) {
    const aVal = a[i];
    const bVal = b[i];

    dot += aVal * bVal;
    normA += aVal * aVal;
    normB += bVal * bVal;
  }

  if (normA === 0 || normB === 0) {
    return 0;
  }

  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}
