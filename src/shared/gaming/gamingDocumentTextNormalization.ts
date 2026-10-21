/** Normalize scanner characters while preserving real whitespace in either inspection view. */
export function normalizeGamingDocumentInstructionCharacters(text: string, replacement: ' ' | '' = ' '): string {
  return text.normalize('NFKC')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060\u2066-\u2069\ufeff]/g,
      character => replacement === '' && (character === '\v' || character === '\f') ? character : replacement);
}
