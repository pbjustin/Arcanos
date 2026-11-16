/**
 * Acquired Game labels start a metadata field, not a substring of gameplay
 * phrases such as "early game:". Whitespace normalization preserves sentence
 * and metadata separators; parser-owned structural fields are inspected separately.
 */
export function gamingAcquiredGameDeclarationPattern(): RegExp {
  return /(?:^|[\r\n;|]|[.!?](?=\s|$))\s*game\s*:\s*([^\r\n]*?)(?=\.(?:\s|$)|;|\||\r?\n|\s+(?:Edition|Platforms?|Regions?|Patch|Build|Published at|Effective from)\s*:|$)/giu;
}

/** Remove only recognized declaration spans, retaining ordinary source prose. */
export function withoutGamingAcquiredGameDeclarations(text: string): string {
  return text.replace(gamingAcquiredGameDeclarationPattern(), ' ');
}

/** A retained copy can replace an acquired declaration only at its own statement boundary. */
export function hasStandaloneGamingArticleAssertion(text: string, assertion: string): boolean {
  const literal = assertion.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  const end = /[.!?;|]$/u.test(assertion) ? '(?=\\s|$)' : '(?=[ \\t]*(?:[.!?;|\\r\\n]|$))';
  return new RegExp('(?:^\\s*|[.!?;|]\\s+|[\\r\\n][ \\t]*)' + literal + end, 'u').test(text);
}
