export type GamingGameDetectionSource = "explicit" | "alias" | "prompt" | "url" | "page_metadata" | "none";

export type GamingGameDetection = {
  game?: string;
  confidence: number;
  source: GamingGameDetectionSource;
};

type DetectionInput = {
  explicitGame?: string;
  prompt?: string;
  urls?: readonly string[];
  pageTitle?: string;
  pageHeadings?: string;
};

const MAX_GAME_TITLE_CHARS = 120;

const OPTIONAL_GAME_ALIASES: Array<{ pattern: RegExp; name: string }> = [
  { pattern: /\b(?:star\s+wars:\s*)?the\s+old\s+republic\b|\bswtor\b/i, name: "Star Wars: The Old Republic" },
  { pattern: /\bworld\s+of\s+warcraft\b/i, name: "World of Warcraft" },
  { pattern: /\b(?:WoW|WOW)\b/, name: "World of Warcraft" },
  { pattern: /\belden\s+ring\s+nightreign\b/i, name: "Elden Ring Nightreign" },
  { pattern: /\belden\s+ring\b/i, name: "Elden Ring" },
  { pattern: /\bdestiny\s+2\b/i, name: "Destiny 2" },
  { pattern: /\bdiablo\s+(?:4|iv)\b/i, name: "Diablo 4" },
  { pattern: /\bpath\s+of\s+exile\s+2\b/i, name: "Path of Exile 2" },
  { pattern: /\bpath\s+of\s+exile\b/i, name: "Path of Exile" },
  { pattern: /\bbaldur'?s\s+gate\s+3\b/i, name: "Baldur's Gate 3" },
  { pattern: /\bminecraft\b/i, name: "Minecraft" },
  { pattern: /\bleague\s+of\s+legends\b/i, name: "League of Legends" },
  { pattern: /\b(?:LoL|LOL)\b/, name: "League of Legends" },
  { pattern: /\boverwatch\s+2\b/i, name: "Overwatch 2" },
  { pattern: /\bfortnite\b/i, name: "Fortnite" }
];

const GAME_TRAILING_TERMS = new Set([
  "action", "beginner", "beginners", "boss", "class", "combat", "community", "current", "early", "first",
  "build", "builds", "endgame", "exploration", "gear", "guide", "guides", "late", "legacy", "leveling", "loadout", "main",
  "mechanic", "mechanics", "meta", "midgame", "mining", "patch", "progression", "pve", "pvp", "quest",
  "currently", "now", "raid", "raids", "request", "right", "route", "season", "simulator", "starter", "starters", "strategy", "survival", "night", "tip", "tips", "today", "update", "walkthrough", "wiki"
]);

const INVALID_GAME_WORDS = new Set([
  "a", "an", "best", "build", "compare", "create", "current", "explain", "find", "for", "from", "give", "guide", "help", "how", "in", "is",
  "latest", "loadout", "look", "make", "me", "meta", "my", "need", "numbering", "on", "patch", "please", "raid", "raids",
  "recommend", "search", "season", "show", "source", "sources", "starter", "starters", "that", "this", "summarize", "tell", "tips", "use",
  "lol", "using", "want", "what", "where", "which", "with", "wow"
]);

const NON_GAME_ENTITY_WORDS = new Set([
  "advanced", "barbarian", "budget", "cannon", "carry", "casual", "class", "complete", "crafting", "damage", "deck",
  "direct", "duo", "dps", "druid", "early", "endgame", "free", "frost", "game", "general", "generic", "glass",
  "hardcore", "healer", "hunter", "late", "mage", "melee", "monk", "necromancer", "new", "optimal", "paladin",
  "pc", "player", "priest", "ps4", "ps5", "ranged", "recommended", "rogue", "solo", "sorc", "sorcerer", "speedrun",
  "steam", "support", "switch", "tank", "ultimate", "veteran", "warlock", "warrior", "xbox"
]);

const GENERIC_HOST_LABELS = new Set([
  "app", "community", "forum", "forums", "game", "games", "gaming", "guide", "guides", "help", "news", "official",
  "site", "support", "wiki", "www"
]);

const GENERIC_PATH_SEGMENTS = new Set([
  "article", "articles", "blog", "build", "builds", "content", "game", "games", "guide", "guides", "help", "index",
  "meta", "news", "post", "posts", "strategy", "tips", "walkthrough", "walkthroughs", "wiki"
]);

function canonicalAlias(value: string): string | undefined {
  return OPTIONAL_GAME_ALIASES.find((entry) => entry.pattern.test(value))?.name;
}

export function canonicalizeGamingGameName(value: string): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (/^wow$/i.test(normalized)) {
    return "World of Warcraft";
  }
  if (/^lol$/i.test(normalized)) {
    return "League of Legends";
  }
  return canonicalAlias(normalized) ?? normalized;
}

function displayCase(value: string): string {
  const minorWords = new Set(["a", "an", "and", "for", "of", "the", "to"]);
  return value.split(/\s+/).map((word, index) => {
    if (/^[ivxlcdm]+$/i.test(word) || /\d/.test(word)) {
      return /^[ivxlcdm]+$/i.test(word) ? word.toUpperCase() : word;
    }
    if (index > 0 && minorWords.has(word.toLowerCase())) {
      return word.toLowerCase();
    }
    return `${word.charAt(0).toUpperCase()}${word.slice(1).toLowerCase()}`;
  }).join(" ");
}

function normalizeCandidate(rawValue: string): string | undefined {
  const alias = canonicalAlias(rawValue);
  if (alias) {
    return alias;
  }

  const normalized = rawValue
    .replace(/https?:\/\/\S+/gi, " ")
    .replace(/[|–—].*$/g, " ")
    .replace(/[_/]+/g, " ")
    .replace(/[-]+/g, " ")
    .replace(/^[\s'"“”‘’([{]+|[\s'"“”‘’\])}.!?,;:]+$/g, "")
    .replace(/\b(?:guide|build|meta|walkthrough|wiki|tips?)\s+(?:for|in|on)\s+$/i, "")
    .replace(/\s+(?:season|patch|version)\s+[a-z0-9._-]+$/i, "")
    .replace(/\s+(?:right\s+now|currently|today|this\s+(?:patch|season|version))$/i, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!normalized) {
    return undefined;
  }
  if (/^(?:the\s+)?(?:game|title|one)(?:\s+(?:i|you|we))?\s+(?:mentioned|named|provided|linked|shown|above|earlier|before)\b/i.test(normalized)) {
    return undefined;
  }

  const words = normalized.split(/\s+/);
  while (
    words.length > 0
    && GAME_TRAILING_TERMS.has(words[words.length - 1].toLowerCase().replace(/[’']s$/u, "s"))
  ) {
    words.pop();
  }
  while (words.length > 0 && /^(?:early|mid|late)[- ]?game$/i.test(words[words.length - 1])) {
    words.pop();
  }
  if (words.length === 0 || words.length > 7) {
    return undefined;
  }

  const lowerWords = words.map((word) => word.toLowerCase().replace(/[^a-z0-9+']/g, ""));
  if (
    lowerWords.some((word) => !word)
    || (lowerWords.length === 1 && lowerWords[0] === "the")
    || INVALID_GAME_WORDS.has(lowerWords[0])
    || lowerWords.every((word) => NON_GAME_ENTITY_WORDS.has(word) || INVALID_GAME_WORDS.has(word))
    || lowerWords.every((word) => word === "the" || INVALID_GAME_WORDS.has(word) || GAME_TRAILING_TERMS.has(word))
    || !words.some((word) => /[a-z]/i.test(word))
  ) {
    return undefined;
  }

  return displayCase(words.join(" "));
}

function stripConversationalRequestPrefix(value: string): string {
  return value
    .replace(/^(?:hey|hello|hi)[,!?.]\s*/i, "")
    .replace(/^(?:wow|Wow)[,!?.]\s*/, "")
    .replace(/^(?:please\s+)?(?:find(?:\s+me)?|look\s+up|search\s+for)(?:\s+me)?\s+(?:an|a|the)?\s*/i, "")
    .replace(/^(?:(?:could|can|would|will)\s+you\s+)?(?:please\s+)?(?:give|make|show|create|recommend)\s+(?:me\s+)?(?:a|an|the)?\s*/i, "")
    .replace(/^(?:i\s+(?:need|want|would\s+like)|(?:please\s+)?help\s+me(?:\s+(?:with|find|make))?|looking\s+for)\s+(?:a|an|the)?\s*/i, "")
    .replace(/^please\s+/i, "")
    .trim();
}

function detectFromAnchoredText(value: string, source: "prompt" | "page_metadata"): GamingGameDetection {
  const normalizedText = stripConversationalRequestPrefix(value.replace(/\s+/g, " ").trim());
  const text = source === "prompt"
    ? normalizedText.replace(/^(?:please\s+)?(?:use|using|read|check|summarize)\s+(?:the\s+)?(?:supplied|linked|provided)\s+(?:article|guide|source|page)\s+(?:for|about)\s+/i, "")
    : normalizedText;
  if (!text) {
    return { confidence: 0, source: "none" };
  }

  const patterns = [
    /["“]([^"”]{2,80})["”]\s+(?:guide|build|loadout|meta|walkthrough|wiki|tips?)\b/i,
    /[|｜]\s*([a-z0-9][a-z0-9'’:.+ -]{1,80}?)\s*[|｜]\s*[a-z0-9][a-z0-9'’:.+ -]{1,80}\s*$/i,
    /\b(?:guide|build|loadout|meta|walkthrough|wiki|tips?)\s+(?:for\s+)?(?:the\s+)?(?:current|latest)\s+(?:patch|season|version)(?:\s+[a-z0-9._-]+)?\s+(?:in|for|on)\s+(?:the\s+game\s+)?([a-z0-9][a-z0-9'’:.+ -]{1,80}?)(?=[?!,;]|\.(?!\d)|$)/i,
    /^([a-z0-9][a-z0-9'’:.+ -]{1,80}?)\s+(?:(?:beginner|boss|class|combat|community|current|early(?:\s+game)?|endgame|exploration|first[-\s]+night|late(?:\s+game)?|legacy|leveling|main|mechanics?|mining|patch|progression|pve|pvp|quest|raids?|route|season|strategy|survival)\s+){0,4}(?:guide|build|loadout|meta|walkthrough|wiki|tips?|tier(?:\s+list)?|patch\s+notes)\b/i,
    /\b(?:guide|build|loadout|meta|walkthrough|wiki|tips?)\s+(?:for|in|on)\s+(?:the\s+game\s+)?([a-z0-9][a-z0-9'’:.+ -]{1,80}?)(?=[?!,;]|\.(?!\d)|$)/i,
    /\b(?:for|in|on)\s+(?:the\s+game\s+)?([a-z0-9][a-z0-9'’:.+ -]{1,80}?)(?=\s+(?:guide|build|loadout|meta|walkthrough|wiki|tips?|patch|season)\b|[?!,;]|\.(?!\d)|$)/i,
    /^([a-z0-9][a-z0-9'’:.+ -]{1,80}?)\s+(?:(?:beginner|boss|class|combat|community|current|early(?:\s+game)?|endgame|exploration|first[-\s]+night|late(?:\s+game)?|legacy|leveling|main|mechanics?|mining|patch|progression|pve|pvp|quest|raids?|route|season|strategy|survival)\s+){0,4}(?:guide|build|loadout|meta|walkthrough|wiki|tips?|tier(?:\s+list)?|patch\s+notes)(?:\s+request)?[?.!]*$/i
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    const candidate = match?.[1] ? normalizeCandidate(match[1]) : undefined;
    if (candidate) {
      const aliasMatched = Boolean(match?.[1] && canonicalAlias(match[1]));
      return {
        game: candidate,
        confidence: aliasMatched ? (source === "prompt" ? 0.98 : 0.9) : (source === "prompt" ? 0.84 : 0.8),
        source: aliasMatched ? "alias" : source
      };
    }
  }

  const alias = canonicalAlias(text);
  if (alias) {
    return { game: alias, confidence: source === "prompt" ? 0.96 : 0.88, source: "alias" };
  }

  return { confidence: 0, source: "none" };
}

function detectFromUrl(rawUrl: string): GamingGameDetection {
  try {
    const parsedUrl = new URL(rawUrl);
    const decodedSegments = parsedUrl.pathname
      .split("/")
      .map((segment) => decodeURIComponent(segment).replace(/\.[a-z0-9]{1,6}$/i, ""))
      .filter(Boolean);
    const alias = canonicalAlias(`${parsedUrl.hostname} ${decodedSegments.join(" ")}`);
    if (alias) {
      return { game: alias, confidence: 0.88, source: "alias" };
    }

    for (let index = 0; index < decodedSegments.length; index += 1) {
      const segment = decodedSegments[index];
      const nextSegment = decodedSegments[index + 1] ?? "";
      const hasTopicAnchor = /(?:guide|build|meta|wiki|walkthrough|beginner|boss|class|progress|explor|patch|route)/i.test(`${segment} ${nextSegment}`);
      if (!hasTopicAnchor) {
        continue;
      }
      const candidate = GENERIC_PATH_SEGMENTS.has(segment.toLowerCase()) ? undefined : normalizeCandidate(segment);
      if (candidate) {
        const previousSegment = decodedSegments[index - 1]?.toLowerCase();
        const structuredGamePath = previousSegment === "game" || previousSegment === "games" || previousSegment === "wiki";
        return { game: candidate, confidence: structuredGamePath ? 0.74 : 0.66, source: "url" };
      }
      if (index > 0) {
        const previousSegment = decodedSegments[index - 1];
        const previousCandidate = GENERIC_PATH_SEGMENTS.has(previousSegment.toLowerCase())
          ? undefined
          : normalizeCandidate(previousSegment);
        if (previousCandidate) {
          return { game: previousCandidate, confidence: 0.66, source: "url" };
        }
      }
    }

    const hostLabel = parsedUrl.hostname.toLowerCase().replace(/^www\./, "").split(".")[0];
    const rawHostWords = hostLabel.split(/[-_]+/);
    const hostHasWikiAnchor = rawHostWords.includes("wiki") || parsedUrl.hostname.toLowerCase().endsWith(".wiki");
    const hostWords = rawHostWords.filter((word) => !GENERIC_HOST_LABELS.has(word));
    if (hostWords.length > 0 && hostWords.length < 6 && hostWords.join("").length >= 4) {
      const candidate = normalizeCandidate(hostWords.join(" "));
      if (candidate) {
        return { game: candidate, confidence: hostHasWikiAnchor ? 0.74 : 0.64, source: "url" };
      }
    }
  } catch {
    return { confidence: 0, source: "none" };
  }

  return { confidence: 0, source: "none" };
}

export function detectGamingGame(input: DetectionInput): GamingGameDetection {
  const explicit = input.explicitGame?.replace(/\s+/g, " ").trim().slice(0, MAX_GAME_TITLE_CHARS);
  if (explicit) {
    return {
      game: explicit,
      confidence: 1,
      source: "explicit"
    };
  }

  const promptDetection = detectFromAnchoredText(input.prompt ?? "", "prompt");
  if (promptDetection.game) {
    return promptDetection;
  }

  for (const url of input.urls ?? []) {
    const urlDetection = detectFromUrl(url);
    if (urlDetection.game) {
      return urlDetection;
    }
  }

  const metadataDetection = detectFromAnchoredText(
    [input.pageTitle, input.pageHeadings].filter(Boolean).join(" | "),
    "page_metadata"
  );
  if (metadataDetection.game) {
    return metadataDetection;
  }

  return { confidence: 0, source: "none" };
}
