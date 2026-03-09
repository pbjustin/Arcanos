export interface ExactLiteralPromptShortcut {
  literal: string;
  matchedPattern: 'exact_literal_colon' | 'reply_with_only';
}

interface ExactLiteralPromptPattern {
  matchedPattern: ExactLiteralPromptShortcut['matchedPattern'];
  expression: RegExp;
  preserveWrappingDelimiters: boolean;
}

const EXACT_LITERAL_PROMPT_PATTERNS: ExactLiteralPromptPattern[] = [
  {
    matchedPattern: 'exact_literal_colon',
    expression: /^\s*(?:write|return|reply|respond|output)\s+exactly\s+(?:this\s+)?(?:token|text|string|value|phrase)\s+and\s+nothing\s+else\s*:\s*(?<literal>.+?)\s*$/i,
    preserveWrappingDelimiters: true
  },
  {
    matchedPattern: 'exact_literal_colon',
    expression: /^\s*(?:write|return|reply|respond|output)\s+exactly\s+(?:this\s+)?(?:token|text|string|value|phrase)\s*:\s*(?<literal>.+?)\s*$/i,
    preserveWrappingDelimiters: true
  },
  {
    matchedPattern: 'reply_with_only',
    expression: /^\s*(?:reply|respond|return|write|output)\s+with\s+(?<literal>"[^"\r\n]+"|'[^'\r\n]+'|`[^`\r\n]+`|[A-Za-z0-9][A-Za-z0-9._:@/+\\=-]{0,159})\s+only[.!?]?\s*$/i,
    preserveWrappingDelimiters: false
  }
];

const MAX_EXACT_LITERAL_LENGTH = 160;

function unwrapOneLayerOfDelimiters(rawLiteral: string): string {
  const trimmedLiteral = rawLiteral.trim();
  const wrappedByMatchingQuotes =
    (trimmedLiteral.startsWith('"') && trimmedLiteral.endsWith('"')) ||
    (trimmedLiteral.startsWith("'") && trimmedLiteral.endsWith("'")) ||
    (trimmedLiteral.startsWith('`') && trimmedLiteral.endsWith('`'));

  //audit Assumption: quoted `reply with ... only` prompts use delimiters for instruction readability, not as literal content; failure risk: responses accidentally include wrapper quotes; expected invariant: one matching delimiter pair is removed when present; handling strategy: unwrap exactly one layer and keep all inner characters untouched.
  if (wrappedByMatchingQuotes && trimmedLiteral.length >= 2) {
    return trimmedLiteral.slice(1, -1);
  }

  return trimmedLiteral;
}

function normalizeMatchedLiteral(
  rawLiteral: string,
  preserveWrappingDelimiters: boolean
): string | null {
  const normalizedLiteral = preserveWrappingDelimiters
    ? rawLiteral.trim()
    : unwrapOneLayerOfDelimiters(rawLiteral);

  //audit Assumption: deterministic literal shortcuts must stay small and single-line to avoid hijacking normal generative prompts; failure risk: large multiline payloads bypass Trinity reasoning unexpectedly; expected invariant: literal is non-empty, bounded, and line-safe; handling strategy: reject unsupported matches by returning null.
  if (
    normalizedLiteral.length === 0 ||
    normalizedLiteral.length > MAX_EXACT_LITERAL_LENGTH ||
    /[\r\n]/.test(normalizedLiteral) ||
    normalizedLiteral.includes('```')
  ) {
    return null;
  }

  return normalizedLiteral;
}

/**
 * Detect prompts that explicitly require an exact literal response.
 *
 * Purpose:
 * - Identify narrow, deterministic prompts that should bypass full Trinity generation and echo a literal value exactly.
 *
 * Inputs/outputs:
 * - Input: raw user prompt text.
 * - Output: extracted literal plus match metadata, or `null` when the prompt should continue through normal AI routing.
 *
 * Edge case behavior:
 * - Rejects multiline or oversized literals so normal generative prompts are not accidentally short-circuited.
 */
export function tryExtractExactLiteralPromptShortcut(
  prompt: string
): ExactLiteralPromptShortcut | null {
  for (const promptPattern of EXACT_LITERAL_PROMPT_PATTERNS) {
    const matchedPrompt = prompt.match(promptPattern.expression);
    //audit Assumption: prompt patterns are checked in fixed priority order to keep shortcut behavior stable; failure risk: overlapping regexes produce inconsistent literal extraction; expected invariant: first valid match wins; handling strategy: continue scanning until a supported literal is found.
    if (!matchedPrompt?.groups?.literal) {
      continue;
    }

    const normalizedLiteral = normalizeMatchedLiteral(
      matchedPrompt.groups.literal,
      promptPattern.preserveWrappingDelimiters
    );
    if (!normalizedLiteral) {
      continue;
    }

    return {
      literal: normalizedLiteral,
      matchedPattern: promptPattern.matchedPattern
    };
  }

  return null;
}
