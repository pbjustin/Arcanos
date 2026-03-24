/**
 * Count whitespace-delimited words in a text fragment.
 * Input: any user-visible or internal text string.
 * Output: the number of non-empty whitespace-delimited tokens.
 * Edge cases: returns 0 for empty or whitespace-only strings.
 */
export function countWords(text: string): number {
  const words = text.match(/\S+/g);
  return words ? words.length : 0;
}
