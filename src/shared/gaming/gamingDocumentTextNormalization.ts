/** Normalize instruction-scanner characters without erasing line boundaries. */
export function normalizeGamingDocumentInstructionCharacters(text: string): string {
  return text.normalize('NFKC')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060\u2066-\u2069\ufeff]/g, ' ');
}
