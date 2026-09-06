import type { FetchAndCleanOptions } from "@shared/webFetcher.js";

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

const SOURCE_EXTRACTION_PROFILES: Array<{
  domains: string[];
  contentSelectors: readonly string[];
  removeSelectors: readonly string[];
}> = [
  {
    domains: ["wiki.fextralife.com", "fextralife.com"],
    contentSelectors: ["#wiki-content-block", ".wiki-content-block", "#main-content", ".page-content"],
    removeSelectors: [
      ".wiki-header-container",
      ".wiki-menu-2-left",
      ".wikiMenuMobile",
      ".left-side-menu-container",
      ".side-bar-right",
      "#featured-wikis",
      "#related-games-content",
      "#disqus_thread"
    ]
  },
  {
    domains: ["bandainamcoent.com", "bandainamcoent.eu"],
    contentSelectors: [".article__edito-content", ".article__content", ".article", "article"],
    removeSelectors: [
      ".article__sidebar",
      ".article__share-social",
      "[class*='read-next']",
      ".age-gate"
    ]
  },
  {
    domains: ["worldofwarcraft.blizzard.com", "news.blizzard.com", "blizzard.com"],
    contentSelectors: [".NewsBlog-content", ".Article-content", ".article-content", "#main", "article"],
    removeSelectors: [".SiteNav", ".SocialLinks", ".CommentTotal"]
  },
  {
    domains: ["icy-veins.com"],
    contentSelectors: [".left-column-content", ".left-column-main", ".guide-page-content", "article"],
    removeSelectors: [
      ".guide-header__breadcrumbs",
      ".content-toc",
      ".table-of-contents",
      ".left-column-sidebar"
    ]
  }
];

const SOURCE_INSTRUCTION_PATTERN = /\b(?:(?:ignore|disregard|override)\s+(?:all\s+)?(?:previous|prior|system|developer|assistant|user)\s+(?:instructions?|messages?|prompts?)|forget\s+(?:everything|all)\s+(?:above|before)|you\s+are\s+now|new\s+(?:system|developer|assistant)\s+(?:message|prompt|instructions?)|follow\s+(?:these|the\s+following)\s+instructions?|(?:system|developer|assistant)\s+(?:message|prompt|instructions?)|(?:reveal|print|show|expose|exfiltrate)\s+(?:the\s+)?(?:system|developer|secret|credential|token|api\s+key)\s*(?:prompt|message|instructions?|value)?|(?:call|invoke)\s+(?:the\s+)?(?:tool|function)|(?:execute|run)\s+(?:this\s+)?(?:command|shell|powershell|bash))\b/i;

/** Shared acquisition profiles: downstream query ranking does not select a different document transport. */
export function gamingDocumentFetchOptions(url: string, options: FetchAndCleanOptions = {}): FetchAndCleanOptions {
  const domain = new URL(url).hostname.toLowerCase();
  const profile = SOURCE_EXTRACTION_PROFILES.find((entry) =>
    entry.domains.some((candidate) => domain === candidate || domain.endsWith(`.${candidate}`))
  );
  return {
    ...options,
    includeLinks: false,
    preferredContentSelectors: options.preferredContentSelectors ?? [
      ...(profile?.contentSelectors ?? []), ...GENERIC_CONTENT_SELECTORS
    ],
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
    .filter((sentence) => sentence.length > 0 && !SOURCE_INSTRUCTION_PATTERN.test(sentence))
    .join(" ")
    .trim();
}

export const GAMEPLAY_CONTENT_PATTERN = /\b(?:boss|route|walkthrough|build|patch|weapon|stat|skill|class|quest|location|level|damage|talent|gear|rotation|viable|craft|resource|upgrade|exploration|progress|economy|unit|mission|encounter|ability|loadout|mechanic)\b/i;

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
