/** Mask quoted source/example content without treating contractions as quotes. */
function unquotedRequest(prompt: string): string {
  let closingQuote: string | null = null;
  let request = '';
  for (let index = 0; index < prompt.length; index += 1) {
    const character = prompt[index]!;
    const previous = prompt[index - 1] ?? '';
    const next = prompt[index + 1] ?? '';
    const inWordApostrophe = /['’]/u.test(character)
      && /[\p{L}\p{N}]/u.test(previous) && /[\p{L}\p{N}]/u.test(next);
    if (closingQuote) {
      if (character === closingQuote && !inWordApostrophe) closingQuote = null;
      request += character === '\n' ? '\n' : ' ';
    } else if (character === '"' || character === '“'
      || ((character === "'" || character === '‘') && !/[\p{L}\p{N}]/u.test(previous))) {
      closingQuote = character === '“' ? '”' : character === '‘' ? '’' : character;
      request += ' ';
    } else {
      request += character;
    }
  }
  return request;
}

/** Detect a generation instruction, rather than a mention in supplied state. */
export function requiresCreativeDialogue(prompt: string): boolean {
  const request = unquotedRequest(prompt);
  if (/\b(?:(?:no|without|omit|exclude|avoid)\s+(?:(?:any|spoken)\s+)?dialogue|dialogue[- ]free)\b/iu.test(request)
    || /\b(?:do\s+not|don['’]t|never)\s+(?:include|add|provide|write|generate|create|draft|deliver|supply|return)\b[^.!?;\n]{0,80}\bdialogue\b/iu.test(request)) {
    return false;
  }
  return /\b(?:include|add|provide|write|generate|create|draft|deliver|supply|return)\s+(?:(?:some|a|the|meaningful|spoken|character|natural|short|brief|full|complete|original|scripted|in-character|promo|backstage)\s+)*dialogue\b/iu.test(request)
    || /\b(?:include|add|provide|deliver|supply|return)\s+[^.!?;\n]{0,120}\band\s+(?:(?:meaningful|spoken|character|natural|scripted|in-character)\s+)*dialogue\b/iu.test(request)
    || /\b(?:write|generate|create|draft|book)\b[^.!?;\n]{0,200}\bwith\s+(?:(?:some|meaningful|spoken|character|natural|scripted|in-character)\s+)*dialogue\b/iu.test(request);
}

function hasSpokenWords(text: string): boolean {
  return (text.match(/[\p{L}\p{N}]+(?:['’][\p{L}]+)?/gu)?.length ?? 0) >= 1;
}

/**
 * Conservative evidence of speech, independent of participant names and layout.
 * This is an omission guard, not a semantic assessment: the dedicated HRC pass
 * still evaluates whether the speech fulfills the actual creative requirements.
 */
export function hasCreativeDialogue(text: string): boolean {
  if (Array.from(text.matchAll(/["“]([^"”]+)["”]/gu))
    .some(match => hasSpokenWords(match[1] ?? ''))) {
    return true;
  }
  // Single quotation marks may contain contractions, but apostrophes within
  // ordinary words and possessives do not open a speech span.
  if (Array.from(text.matchAll(/(?:^|[^\p{L}\p{N}])[‘']((?:[^'’]|['’](?=[\p{L}\p{N}]))+)[’'](?=$|[\s.,!?;:])/gu))
    .some(match => hasSpokenWords(match[1] ?? ''))) {
    return true;
  }

  const productionLabel = /\b(?:camera|direction|production|sound|lighting|music|stage|segment|creative|heading|scene|title|note|visual|setting|location)\b/iu;
  for (const line of text.split(/\r?\n/gu)) {
    const script = line.match(/^\s*(?:>\s*)?(?:\*\*|__)?([^:\n]{1,80}?)(?:\*\*|__)?\s*:(?:\*\*|__)?\s*(.+)$/u);
    if (script && !productionLabel.test(script[1] ?? '')
      && hasSpokenWords((script[2] ?? '').replace(/\[[^\]]*\]|\([^)]*\)/gu, ''))) {
      return true;
    }
  }

  // Attributed speech also supports prose scenes rather than screenplay labels.
  if (/\b(?:says?|said|asks?|asked|repl(?:y|ies|ied)|shouts?|whispers?|declares?|responds?|tells?)\s+[^\n.!?]*[\p{L}\p{N}]+\s+[\p{L}\p{N}]+/iu.test(text)) {
    return true;
  }

  // A monologue can be plain, unquoted first/second-person prose. Ignore stage
  // directions and production labels when looking for that form of speech.
  return text.split(/\r?\n/gu).some(line => {
    if (/^\s*(?:#{1,6}\s|\[|\()/u.test(line) || productionLabel.test(line.split(':', 1)[0] ?? '')) {
      return false;
    }
    return /(?:^|[.!?]\s+)(?:>\s*)?(?:i|we|you|my|our|your)\b/iu.test(line)
      && hasSpokenWords(line);
  });
}
