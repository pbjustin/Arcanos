export function parseFacts(html: string): string[] {
  const text = html.replace(/<[^>]+>/g, ' ');
  return text
    .split(/(?<=[\.?!])\s+/)
    .map(s => s.trim())
    .filter(Boolean);
}

const RAG = {
  match(facts: string[]): string[] {
    // Placeholder: deduplicate facts to simulate retrieval of corroborated info
    return Array.from(new Set(facts));
  }
};

const HRC = {
  verify(facts: string[]): string[] {
    const flagged = [/rm\s+-rf/i, /drop\s+table/i, /shutdown/i];
    return facts.filter(f => !flagged.some(p => p.test(f)));
  }
};

const CLEAR = {
  format(facts: string[]): string {
    const score = facts.length;
    return JSON.stringify({ facts, score });
  }
};

export function handleInternetResult(rawHTML: string): string {
  const facts = parseFacts(rawHTML);
  const verified = RAG.match(facts);
  const final = HRC.verify(verified);
  return CLEAR.format(final);
}
