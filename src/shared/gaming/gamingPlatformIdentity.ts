/** Closed publisher aliases already supported by currentness scope intersection. */
const PLATFORM_ALIASES: Readonly<Record<string, string>> = {
  steam: 'pc', 'playstation 3': 'ps3', 'playstation 4': 'ps4', 'playstation 5': 'ps5'
};

/** Unknown labels stay opaque; console generations and platform families stay distinct. */
export function normalizeGamingPlatformIdentity(value?: string): string {
  const key = value?.normalize('NFKC').replace(/\s+/gu, ' ').trim().toLowerCase() ?? '';
  return Object.hasOwn(PLATFORM_ALIASES, key) ? PLATFORM_ALIASES[key] : key;
}

/** A complete source-wide sentence can state the same restriction as a Platform field. */
export function gamingProsePlatformDeclarationPattern(): RegExp {
  return /(?:^|(?<=[.!?;]\s)|(?<=\n))[ \t]{0,16}This (?:guide|walkthrough|article) applies only to (PC|Steam|Xbox 360|Xbox One|Xbox Series [XS]|PlayStation [345]|PS[345]|Nintendo Switch)(?:\.(?=\s|$)|$)/giu;
}

/** Explicit acquired applicability; absence never establishes a scoped match. */
export function gamingPlatformEvidenceMatchesRequest(values: readonly string[] | undefined, requested?: string): boolean {
  const wanted = normalizeGamingPlatformIdentity(requested);
  return Boolean(values?.some(value => {
    const identity = normalizeGamingPlatformIdentity(value);
    return identity === 'all' || Boolean(wanted && identity === wanted);
  }));
}
