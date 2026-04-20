export interface ExactLiteralPromptShortcut {
  literal: string;
  matchedPattern:
    | 'exact_literal_colon'
    | 'reply_with_exactly'
    | 'reply_with_only'
    | 'exact_literal_directive_suffix';
}

interface ExactLiteralPromptPattern {
  matchedPattern: ExactLiteralPromptShortcut['matchedPattern'];
  expression: RegExp;
  preserveWrappingDelimiters: boolean;
  allowDirectiveOnlyPrefix?: boolean;
  trimTerminalSentencePunctuation?: boolean;
}

const EXACT_LITERAL_PROMPT_PATTERNS: ExactLiteralPromptPattern[] = [
  {
    matchedPattern: 'exact_literal_colon',
    expression: /^\s*(?:write|return|reply|respond|output|say)\s+exactly\s+(?:this\s+)?(?:token|text|string|value|phrase)\s+and\s+nothing\s+else\s*:\s*(?<literal>.+?)\s*$/i,
    preserveWrappingDelimiters: true
  },
  {
    matchedPattern: 'exact_literal_colon',
    expression: /^\s*(?:write|return|reply|respond|output|say)\s+exactly\s+(?:this\s+)?(?:token|text|string|value|phrase)\s*:\s*(?<literal>.+?)\s*$/i,
    preserveWrappingDelimiters: true
  },
  {
    matchedPattern: 'exact_literal_directive_suffix',
    expression: /(?:^|[\s.!?])(?<directive>(?:say|write|return|reply|respond|output)\s+exactly\s*:\s*(?<literal>.+?))\s*$/i,
    preserveWrappingDelimiters: true,
    allowDirectiveOnlyPrefix: true,
    trimTerminalSentencePunctuation: true
  },
  {
    matchedPattern: 'reply_with_exactly',
    expression: /^\s*(?:reply|respond|return|write|output|say)\s+with\s+exactly\s+(?<literal>"[^"\r\n]+"|'[^'\r\n]+'|`[^`\r\n]+`|[A-Za-z0-9][A-Za-z0-9._:@/+\\=-]{0,159})[.!?]?\s*$/i,
    preserveWrappingDelimiters: false,
    trimTerminalSentencePunctuation: true
  },
  {
    matchedPattern: 'reply_with_only',
    expression: /^\s*(?:reply|respond|return|write|output)\s+with\s+(?<literal>"[^"\r\n]+"|'[^'\r\n]+'|`[^`\r\n]+`|[A-Za-z0-9][A-Za-z0-9._:@/+\\=-]{0,159})\s+only[.!?]?\s*$/i,
    preserveWrappingDelimiters: false
  },
  {
    matchedPattern: 'reply_with_only',
    expression: /^\s*(?:reply|respond|return|write|output|say)\s+(?:the\s+)?(?:word|token|text|string|value|phrase)\s+(?<literal>"[^"\r\n]+"|'[^'\r\n]+'|`[^`\r\n]+`|[A-Za-z0-9][A-Za-z0-9._:@/+\\=-]{0,159})\s+only[.!?]?\s*$/i,
    preserveWrappingDelimiters: false
  }
];

const MAX_EXACT_LITERAL_LENGTH = 160;
const DIRECTIVE_ONLY_PREFIX_PATTERNS: RegExp[] = [
  /^(?:answer|respond|reply|write|output|say)\s+directly[.!?]?$/i,
  /^(?:do\s+not|don't)\s+simulate(?:[^.!?\r\n]*)[.!?]?$/i,
  /^(?:do\s+not|don't)\s+role-?play(?:[^.!?\r\n]*)[.!?]?$/i,
  /^(?:do\s+not|don't)\s+pretend(?:[^.!?\r\n]*)[.!?]?$/i,
  /^(?:do\s+not|don't)\s+describe(?:[^.!?\r\n]*)\bhypothetical(?:[^.!?\r\n]*)[.!?]?$/i,
  /^(?:give|provide|return)\s+only\s+the\s+final\s+answer[.!?]?$/i
];

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
  preserveWrappingDelimiters: boolean,
  trimTerminalSentencePunctuation = false
): string | null {
  let normalizedLiteral = preserveWrappingDelimiters
    ? rawLiteral.trim()
    : unwrapOneLayerOfDelimiters(rawLiteral);

  if (
    trimTerminalSentencePunctuation &&
    /^[^"'`].*[^"'`]$/.test(normalizedLiteral) &&
    /[.!?]$/.test(normalizedLiteral)
  ) {
    normalizedLiteral = normalizedLiteral.slice(0, -1).trimEnd();
  }

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

function splitPromptIntoDirectiveSegments(prefix: string): string[] {
  return prefix
    .split(/[.!?]+/)
    .map(segment => segment.trim())
    .filter(segment => segment.length > 0);
}

function hasAllowedDirectiveOnlyPrefix(prefix: string): boolean {
  const normalizedPrefix = prefix.trim();
  //audit Assumption: suffix-style exact-literal directives should only short-circuit when earlier text consists solely of direct-answer guardrails; failure risk: normal prompts that merely contain “say exactly:” near the end bypass generative reasoning unexpectedly; expected invariant: only explicit anti-simulation/direct-answer prefixes enable the suffix shortcut; handling strategy: require every leading sentence fragment to match a small allowlist.
  if (!normalizedPrefix) {
    return true;
  }

  const directiveSegments = splitPromptIntoDirectiveSegments(normalizedPrefix);
  if (directiveSegments.length === 0) {
    return true;
  }

  return directiveSegments.every(segment =>
    DIRECTIVE_ONLY_PREFIX_PATTERNS.some(pattern => pattern.test(segment))
  );
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

    if (promptPattern.allowDirectiveOnlyPrefix) {
      const directiveText = matchedPrompt.groups.directive;
      const matchedInput = matchedPrompt.input ?? prompt;
      const matchedIndex = typeof matchedPrompt.index === 'number' ? matchedPrompt.index : 0;
      const directiveStartIndex =
        typeof directiveText === 'string' ? matchedPrompt[0].lastIndexOf(directiveText) : -1;
      const prefix = directiveStartIndex >= 0
        ? matchedInput.slice(0, matchedIndex + directiveStartIndex)
        : matchedInput.slice(0, matchedIndex);

      //audit Assumption: suffix-based exact-literal detection is safe only when the prompt prefix is entirely directive scaffolding; failure risk: broad phrase matches hijack normal requests into literal-only responses; expected invariant: unrelated semantic content in the prefix disables the shortcut; handling strategy: continue scanning when the prefix allowlist check fails.
      if (!hasAllowedDirectiveOnlyPrefix(prefix)) {
        continue;
      }
    }

    const normalizedLiteral = normalizeMatchedLiteral(
      matchedPrompt.groups.literal,
      promptPattern.preserveWrappingDelimiters,
      promptPattern.trimTerminalSentencePunctuation
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
