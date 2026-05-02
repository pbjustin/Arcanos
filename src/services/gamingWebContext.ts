import { resolveErrorMessage } from "@core/lib/errors/index.js";
import { fetchAndClean } from "@shared/webFetcher.js";
import { getGamingWebContextMaxChars, getGamingWebContextMaxUrls } from "@services/gamingConfig.js";
import type { GamingSuccessEnvelope, ValidatedGamingRequest } from "@services/gamingModes.js";

export type GamingWebSource = GamingSuccessEnvelope["data"]["sources"][number];

export type GamingWebContext = {
  context: string;
  sources: GamingWebSource[];
};

export type GamingGuideUrlInput = Pick<ValidatedGamingRequest, "guideUrl" | "guideUrls">;

export function collectGamingGuideUrls(params: GamingGuideUrlInput): string[] {
  return [
    ...(params.guideUrl ? [params.guideUrl] : []),
    ...params.guideUrls
  ];
}

function redactUrlCredentials(url: string): string {
  try {
    const parsedUrl = new URL(url);
    if (!parsedUrl.username && !parsedUrl.password) {
      return url;
    }
    parsedUrl.username = "";
    parsedUrl.password = "";
    return parsedUrl.toString();
  } catch {
    return url;
  }
}

export async function buildGamingWebContext(urls: string[]): Promise<GamingWebContext> {
  if (urls.length === 0) {
    return { context: "", sources: [] };
  }

  const maxContextChars = getGamingWebContextMaxChars();
  const uniqueUrls = Array.from(new Set(urls)).slice(0, getGamingWebContextMaxUrls());
  const sources: GamingWebSource[] = await Promise.all(
    uniqueUrls.map(async (url): Promise<GamingWebSource> => {
      const sourceUrl = redactUrlCredentials(url);
      try {
        const snippet = await fetchAndClean(url, maxContextChars);
        return { url: sourceUrl, snippet };
      } catch (error) {
        return { url: sourceUrl, error: resolveErrorMessage(error, "Unknown fetch error") };
      }
    })
  );

  const context = sources
    .filter((source) => Boolean(source.snippet))
    .map((source, index) => `[Source ${index + 1}] ${source.url}\n${source.snippet}`)
    .join("\n\n");

  return { context, sources };
}
