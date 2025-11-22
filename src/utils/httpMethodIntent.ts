export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export interface HttpMethodIntent {
  method: HttpMethod;
  signals: string[];
  confidence: 'high' | 'medium' | 'low';
}

const METHOD_KEYWORDS: Record<HttpMethod, string[]> = {
  GET: ['get', 'fetch', 'retrieve', 'list', 'pull', 'read', 'show'],
  POST: ['post', 'create', 'submit', 'send', 'add', 'register', 'make'],
  PUT: ['put', 'replace', 'update completely', 'overwrite'],
  PATCH: ['patch', 'update', 'modify', 'tweak', 'adjust'],
  DELETE: ['delete', 'remove', 'erase', 'destroy', 'drop']
};

function collectSignals(text: string, phrases: string[]): string[] {
  const lower = text.toLowerCase();
  return phrases.filter(phrase => lower.includes(phrase)).map(phrase => phrase.trim());
}

export function inferHttpMethodIntent(text: string | undefined | null): HttpMethodIntent | null {
  if (!text) return null;
  const signals: { method: HttpMethod; matches: string[] }[] = [];

  for (const [method, phrases] of Object.entries(METHOD_KEYWORDS) as [HttpMethod, string[]][]) {
    const matches = collectSignals(text, phrases);
    if (matches.length) {
      signals.push({ method, matches });
    }
  }

  if (!signals.length) {
    return null;
  }

  signals.sort((a, b) => b.matches.length - a.matches.length);
  const best = signals[0];
  const confidence: HttpMethodIntent['confidence'] = best.matches.length >= 2 ? 'high' : 'medium';

  return {
    method: best.method,
    signals: best.matches,
    confidence
  };
}
