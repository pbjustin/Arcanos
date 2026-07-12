export type GamingVersionTextInput = {
  prompt: string;
  game?: string;
};

type IndexedVersion = {
  index: number;
  version: string;
};

const VERSION_TOKEN_SOURCE = String.raw`(\d{1,3}\.\d{1,3}(?:\.\d{1,3})?)`;
const VERSION_END_SOURCE = String.raw`(?!\d|[.\/-]\d)`;
const NON_VERSION_GAME_SUFFIX_SOURCE = String.raw`(?!\s*(?:%|percent\b|milliseconds?\b|ms\b|seconds?\b|secs?\b|minutes?\b|mins?\b|hours?\b|hrs?\b|days?\b|fps\b|hz\b|pixels?\b|resolution\b|kilograms?\b|kgs?\b|grams?\b|pounds?\b|lbs?\b|ounces?\b|oz\b|meters?\b|metres?\b|centimeters?\b|centimetres?\b|miles?\b|dollars?\b|usd\b|euros?\b|gbp\b|items?\b|copies?\b|units?\b|damage\b|health\b|points?\b|stats?\b|multiplier\b|k\s*\/\s*d\b|am\b|pm\b|[$€£¥]|release(?:d)?\b|date\b))`;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function addPatternMatches(
  prompt: string,
  pattern: RegExp,
  matches: IndexedVersion[],
  collectContinuations = false
): void {
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(prompt)) !== null) {
    const version = match[1];
    if (!version) {
      continue;
    }
    const versionOffset = match[0].lastIndexOf(version);
    matches.push({ index: match.index + Math.max(0, versionOffset), version });

    if (!collectContinuations) {
      continue;
    }
    let cursor = match.index + match[0].length;
    while (cursor < prompt.length) {
      const continuation = new RegExp(
        String.raw`^\s*(?:,|and\b|or\b|vs\.?(?=\s)|versus\b|to\b)\s*(?:["'“‘]\s*)?(?:v(?:ersion)?\.?\s*)?${VERSION_TOKEN_SOURCE}${VERSION_END_SOURCE}`,
        "i"
      ).exec(prompt.slice(cursor));
      const continuedVersion = continuation?.[1];
      if (!continuation || !continuedVersion) {
        break;
      }
      matches.push({
        index: cursor + continuation[0].lastIndexOf(continuedVersion),
        version: continuedVersion
      });
      cursor += continuation[0].length;
    }
  }
}

/** Extract explicit semantic game versions in prompt order without treating arbitrary decimals as versions. */
export function extractExplicitGamingVersions(input: GamingVersionTextInput): string[] {
  const prompt = input.prompt;
  const matches: IndexedVersion[] = [];
  addPatternMatches(
    prompt,
    new RegExp(
      String.raw`\b(?:patch|version|update)s?\s*(?:[:#=-]\s*)?(?:["'“‘]\s*)?(?:v(?:ersion)?\.?\s*)?${VERSION_TOKEN_SOURCE}${VERSION_END_SOURCE}`,
      "gi"
    ),
    matches,
    true
  );
  addPatternMatches(
    prompt,
    new RegExp(String.raw`\bv(?:ersion)?\.?\s*${VERSION_TOKEN_SOURCE}${VERSION_END_SOURCE}`, "gi"),
    matches
  );
  addPatternMatches(
    prompt,
    new RegExp(String.raw`\bwhat\s+changed\b[^.!?\n]{0,32}\bin\s+${VERSION_TOKEN_SOURCE}${VERSION_END_SOURCE}`, "gi"),
    matches
  );
  addPatternMatches(
    prompt,
    new RegExp(String.raw`\(\s*(?:v(?:ersion)?\.?\s*)?${VERSION_TOKEN_SOURCE}${VERSION_END_SOURCE}\s*\)`, "gi"),
    matches
  );

  const game = input.game?.replace(/\s+/g, " ").trim();
  if (game) {
    addPatternMatches(
      prompt,
      new RegExp(
        String.raw`\b${escapeRegExp(game)}\s+(?:(?:version|patch)\s+|v(?:ersion)?\.?\s*)?${VERSION_TOKEN_SOURCE}${VERSION_END_SOURCE}${NON_VERSION_GAME_SUFFIX_SOURCE}`,
        "gi"
      ),
      matches,
      true
    );
  }

  matches.sort((left, right) => left.index - right.index);
  return Array.from(new Set(matches.map((match) => match.version)));
}

export function textContainsExactGamingVersion(text: string, version: string): boolean {
  const escapedVersion = escapeRegExp(version);
  return new RegExp(`(?:^|[^0-9.])${escapedVersion}(?![0-9]|\\.[0-9])`, "i").test(text);
}
