/** Closed publisher aliases already supported by currentness scope intersection. */
const PLATFORM_ALIASES: Readonly<Record<string, string>> = {
  steam: 'pc', 'playstation 4': 'ps4', 'playstation 5': 'ps5'
};

/** Unknown labels stay opaque; console generations and platform families stay distinct. */
export function normalizeGamingPlatformIdentity(value?: string): string {
  const key = value?.normalize('NFKC').replace(/\s+/gu, ' ').trim().toLowerCase() ?? '';
  return Object.hasOwn(PLATFORM_ALIASES, key) ? PLATFORM_ALIASES[key] : key;
}

/** Explicit acquired applicability; absence never establishes a scoped match. */
export function gamingPlatformEvidenceMatchesRequest(values: readonly string[] | undefined, requested?: string): boolean {
  const wanted = normalizeGamingPlatformIdentity(requested);
  return Boolean(values?.some(value => {
    const identity = normalizeGamingPlatformIdentity(value);
    return identity === 'all' || Boolean(wanted && identity === wanted);
  }));
}
