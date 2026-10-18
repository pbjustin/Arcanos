import type { FetchAndCleanOptions } from "@shared/webFetcher.js";
import { GAMING_PUBLISHER_EXTRACTION_PROFILES } from '@shared/gaming/gamingPublisherExtractionProfileData.js';

/** Preserve the existing tag-budget scan, advancing past each complete span without backtracking. */
export function countGamingHtmlElements(body: string, maxElements: number): number {
  const starts = /<[A-Za-z]/g;
  let count = 0;
  for (let match = starts.exec(body); match; match = starts.exec(body)) {
    const end = body.indexOf('>', starts.lastIndex);
    if (end < 0) break;
    if (++count > maxElements) return maxElements + 1;
    starts.lastIndex = end + 1;
  }
  return count;
}

/** Preserve each old <...> replacement, including malformed spans and unclosed trailing text. */
export function stripGamingHtmlTags(body: string): string {
  const batches: string[] = [];
  let parts: string[] = [];
  let cursor = 0;
  for (;;) {
    const start = body.indexOf('<', cursor);
    if (start < 0) break;
    const end = body.indexOf('>', start + 1);
    if (end < 0) break;
    parts.push(body.slice(cursor, start), ' ');
    if (parts.length >= 4_096) {
      batches.push(parts.join(''));
      parts = [];
    }
    cursor = end + 1;
  }
  parts.push(body.slice(cursor));
  batches.push(parts.join(''));
  return batches.join('');
}

const GENERIC_CONTENT_SELECTORS = [
  "main",
  "article",
  "[role='main']",
  ".mw-parser-output",
  ".entry-content",
  ".article-content",
  ".article-body",
  "[class*='article-content']",
  "[class*='article-body']",
  ".main-content",
  "#main-content",
  ".page-content",
  ".post-content",
  "#content",
  ".content"
] as const;

const PRIMARY_CONTENT_SELECTORS = [
  '#article-body', '.article-content', '.article-body', "[class*='article-content']", "[class*='article-body']",
  '.entry-content', '.post-content', '.mw-parser-output', '.main-content', '#main-content', '.page-content',
  'article', 'main', "[role='main']"
] as const;

const COMMON_JUNK_SELECTORS = [
  "nav",
  "header",
  "footer",
  "aside",
  "form",
  "template",
  "[hidden]",
  "[aria-hidden='true']",
  "[aria-modal='true']",
  "[role='dialog']",
  "[role='navigation']",
  "[role='banner']",
  "[role='complementary']",
  ".sidebar",
  "#sidebar",
  "[class$='-sidebar']",
  "[class$='__sidebar']",
  "[id$='-sidebar']",
  "[id$='__sidebar']",
  "[class*='cookie']",
  "[id*='cookie']",
  "[class*='newsletter']",
  "[class*='sign-in']",
  "[class*='signin']",
  "[class*='login']",
  "[id*='sign-in']",
  "[id*='signin']",
  "[id*='login']",
  "[class*='modal']",
  "[class*='popup']",
  "[class*='popin']",
  ".comments",
  "#comments",
  "[class*='comment-list']",
  "[class*='breadcrumb']",
  "[class*='social-share']",
  "[class*='share-social']",
  "[class*='related-links']",
  "[class*='related-content']",
  "[class*='recommended-links']",
  "[class*='advertisement']",
  "[class*='ad-container']"
] as const;

/** Shared furniture denial for structural candidates and surrounding notes.
 * Article headers, ordinary adjacent aside notes and primary community posts
 * retain their separately scoped extraction rules. */
export const GAMING_DOCUMENT_FURNITURE_SELECTOR = COMMON_JUNK_SELECTORS
  .filter(selector => !['header', 'aside', '.comments', '#comments', "[class*='comment-list']"].includes(selector))
  .join(',');

// Player instructions and progress narration are normal guide content. Require a
// control-plane target for role reassignment; the remaining explicit override,
// secret-disclosure and execution patterns keep their document rejection boundary.
const SOURCE_INSTRUCTION_PATTERN = /\b(?:(?:ignore|disregard|override)\s+(?:(?:all|the)\s+)?(?:previous|prior|system|developer|assistant|user)(?:\s+(?:and|or)\s+(?:system|developer|assistant|user))*\s+(?:instructions?|messages?|prompts?)|forget\s+(?:everything|all)\s+(?:above|before)|new\s+(?:system|developer|assistant)\s+(?:message|prompt|instructions?)|(?:system|developer|assistant)\s+(?:message|prompt|instructions?)|(?:reveal|print|show|expose|exfiltrate|disclose|leak)\s+(?:(?:the|your|our|my|all|any|private)\s+)*(?:system|developer|secrets|secret(?=\s*(?:[.!?;,:]|$)|\s+(?:from|in|of|to|with)\b)|credentials?|passwords?|tokens?|api\s+keys?|secret\s+(?:keys?|tokens?|values?))\b|(?:call|invoke)\s+(?:the\s+)?(?:tools?|functions?|[a-z_]\w*(?:\.\w+|__\w+)+)\b|(?:execute|run)\s+(?:this\s+)?(?:command|shell|powershell|bash))\b/i;
// Bounded modifiers describe a role without an adjective allowlist. An article
// permits coordinated adjectives inside that noun phrase. Otherwise conjunction
// and preposition boundaries keep later gameplay subjects out of the role.
const SOURCE_ROLE_ASSIGNMENT_PATTERN = /\byou\s+are\s+now\s+(?:(?:(?:an?|the)\s+(?:(?!(?:but|to|of|in|on|at|near|with|without|from|for|as|by|that|which|who)\b)[a-z][a-z-]{0,31}\s+){0,4}|(?:(?!(?:and|or|but|to|of|in|on|at|near|with|without|from|for|as|by|that|which|who)\b)[a-z][a-z-]{0,31}\s+){0,4})(?:assistant|ai|chatgpt|(?:language\s+)?model|system|developer)\b|in\s+(?:system|developer|assistant)\s+mode\b)/i;

/** Shared acquisition profiles: downstream query ranking does not select a different document transport. */
export function gamingDocumentFetchOptions(url: string, options: FetchAndCleanOptions = {}): FetchAndCleanOptions {
  const domain = new URL(url).hostname.toLowerCase();
  const profile = GAMING_PUBLISHER_EXTRACTION_PROFILES.find((entry) =>
    entry.domains.some((candidate) => domain === candidate || domain.endsWith(`.${candidate}`))
  );
  return {
    ...options,
    includeLinks: false,
    preservePrimaryContentHeading: options.preservePrimaryContentHeading ?? true,
    preferredContentSelectors: options.preferredContentSelectors ?? [
      ...(profile?.contentSelectors ?? []), ...GENERIC_CONTENT_SELECTORS
    ],
    primaryContentSelectors: options.primaryContentSelectors ?? [...(profile?.contentSelectors ?? []), ...PRIMARY_CONTENT_SELECTORS],
    removeSelectors: options.removeSelectors ?? [...COMMON_JUNK_SELECTORS, ...(profile?.removeSelectors ?? [])]
  };
}

/** Source prose is data: remove instruction-like sentences before it can be stored or grounded. */
export function filterGamingDocumentInstructions(text: string): string {
  return text
    .normalize("NFKC")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060\u2066-\u2069\ufeff]/g, " ")
    .replace(/\s*\[LINKS\][\s\S]*$/i, "")
    .replace(/^\s*(?:\[(?:system|developer|assistant|instructions?|mode|request|output)\]|<(?:system|developer|assistant)>|#{1,6}\s*(?:system|developer|assistant|instructions?)\b).*$/gim, "")
    .replace(/\s+/g, " ")
    .trim()
    .split(/(?<=[.!?])\s+/)
    .filter((sentence) => sentence.length > 0 && !SOURCE_INSTRUCTION_PATTERN.test(sentence)
      && !SOURCE_ROLE_ASSIGNMENT_PATTERN.test(sentence))
    .join(" ")
    .trim();
}

export const GAMEPLAY_CONTENT_PATTERN = /\b(?:boss|route|walkthrough|build|patch|weapon|stat|skill|class|quest|location|level|damage|talent|gear|rotation|viable|craft|resource|upgrade|exploration|progress|economy|unit|mission|encounter|ability|loadout|mechanic)\b/i;

/** Complete player actions distinguish authored gameplay prose from link labels.
 * This establishes text quality only; identity and claim support remain separate. */
export function hasGamingActionableProse(text: string): boolean {
  return text.split(/(?<=[.!?])\s+/).some((sentence) =>
    /[.!?]$/u.test(sentence.trim())
    && GAMEPLAY_CONTENT_PATTERN.test(sentence)
    && new Set(sentence.toLowerCase().split(/[^a-z0-9+]+/i).filter((part) => part.length >= 3)).size >= 8
    && /(?:^(?:(?:first|next|then)[,:]?\s+)?(?:to\s+)?|\b(?:should|must|can|then)\s+)(?:attack|avoid|block|collect|defeat|dodge|equip|explore|follow|gather|heal|jump|move|open|press|restore|save|select|spend|upgrade|use|wait)\b/i.test(sentence.trim())
  );
}

export function isGamingCatalogMetadataOnly(text: string): boolean {
  const catalogLabels = text.match(/\b(?:identifier|addeddate|download options|scanner|isbn|publication date|publisher)\b/gi) ?? [];
  if (catalogLabels.length < 2) {
    return false;
  }
  // A title or catalog label can overlap the requested game without describing
  // gameplay. Preserve catalog pages only when they also contain gameplay prose.
  return !text.split(/(?<=[.!?])\s+/).some((sentence) =>
    GAMEPLAY_CONTENT_PATTERN.test(sentence)
    && new Set(sentence.toLowerCase().split(/[^a-z0-9+]+/i).filter((part) => part.length >= 3)).size >= 8
    && /(?:^(?:(?:first|next|then)[,:]?\s+)?(?:to\s+)?|\b(?:should|must|can|then)\s+)(?:attack|avoid|block|collect|defeat|dodge|equip|explore|follow|gather|heal|jump|move|open|press|restore|save|select|spend|upgrade|use|wait)\b/i.test(sentence.trim())
  );
}
