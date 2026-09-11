import { fetchAndClean, type FetchAndCleanOptions } from "@shared/webFetcher.js";
import { prepareGamingResourceUrl } from "@services/gamingBuildResources.js";
import {
  recognizeGamingArchiveItemCore,
  resolveGamingArchiveResourceCore,
  type GamingArchiveResolutionTelemetry
} from "@shared/gaming/gamingArchiveResourceCore.js";

export {
  GAMING_ARCHIVE_RESOLVER_VERSION,
  GAMING_ARCHIVE_RESOURCE_LIMITS,
  GamingArchiveResolutionError
} from "@shared/gaming/gamingArchiveResourceCore.js";
export type { GamingArchiveResolutionTelemetry } from "@shared/gaming/gamingArchiveResourceCore.js";

/** Recognition preserves case-sensitive item identity; query and reader position are not evidence. */
export function recognizeGamingArchiveItem(url: string): string | null {
  return recognizeGamingArchiveItemCore(url, prepareGamingResourceUrl);
}

/** Resolve only metadata-attested Archive text files; every network read uses the existing pinned fetcher. */
export async function resolveGamingArchiveResource(
  url: string,
  maxDocumentChars: number,
  options: FetchAndCleanOptions = {}
): Promise<{ text: string; resolution: GamingArchiveResolutionTelemetry } | null> {
  return resolveGamingArchiveResourceCore(url, maxDocumentChars, options, {
    prepareResourceUrl: prepareGamingResourceUrl,
    fetchAndClean: (resourceUrl, boundedMaxChars, overrides) => fetchAndClean(
      resourceUrl,
      boundedMaxChars,
      { ...options, ...overrides }
    )
  });
}
