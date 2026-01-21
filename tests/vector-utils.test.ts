import { cosineSimilarity } from '../src/utils/vectorUtils.js';

describe('cosineSimilarity', () => {
  it('returns 0 when vectors are empty', () => {
    expect(cosineSimilarity([], [])).toBe(0);
  });

  it('returns 0 when either vector has zero magnitude', () => {
    expect(cosineSimilarity([0, 0, 0], [1, 2, 3])).toBe(0);
    expect(cosineSimilarity([1, 2, 3], [0, 0, 0])).toBe(0);
  });

  it('throws when vectors have different lengths', () => {
    expect(() => cosineSimilarity([1, 2], [1])).toThrow(
      'Vectors must be the same length to compute cosine similarity'
    );
  });

  it('computes cosine similarity for valid vectors', () => {
    const result = cosineSimilarity([1, 0], [0, 1]);
    expect(result).toBeCloseTo(0);
  });
});
