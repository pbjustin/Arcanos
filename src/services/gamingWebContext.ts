import { resolveErrorMessage } from "@core/lib/errors/index.js";
import { logger } from "@platform/logging/structuredLogging.js";
import { fetchAndClean } from "@shared/webFetcher.js";
import {
  getGamingWebContextFetchTimeoutMs,
  getGamingWebContextMaxChars,
  getGamingWebContextMaxUrls
} from "@services/gamingConfig.js";
import type { GamingMode, GamingSuccessEnvelope, ValidatedGamingRequest } from "@services/gamingModes.js";

export type GamingWebSource = GamingSuccessEnvelope["data"]["sources"][number];

export type GamingWebContext = {
  context: string;
  sources: GamingWebSource[];
};

export type GamingGuideUrlInput = Pick<ValidatedGamingRequest, "guideUrl" | "guideUrls">;

export type GamingWebContextLogContext = {
  module: "ARCANOS:GAMING";
  route: "gaming";
  mode: GamingMode;
  sourceEndpoint: string;
  requestId?: string;
  traceId?: string;
};

export function collectGamingGuideUrls(params: GamingGuideUrlInput): string[] {
  return [
    ...(params.guideUrl ? [params.guideUrl] : []),
    ...params.guideUrls
  ];
}

function isFetchableGuideUrl(url: string): boolean {
  const trimmedUrl = url.trim();
  if (trimmedUrl.length === 0) {
    return false;
  }

  try {
    const parsedUrl = new URL(trimmedUrl);
    return parsedUrl.protocol === "http:" || parsedUrl.protocol === "https:";
  } catch {
    return false;
  }
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

function readErrorString(error: unknown, key: string): string | undefined {
  if (!error || typeof error !== "object") {
    return undefined;
  }

  const value = (error as Record<string, unknown>)[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function createGamingRetrievalTimeoutError(timeoutMs: number): Error {
  const error = new Error(`Gaming guide source fetch timed out after ${timeoutMs}ms.`);
  Object.assign(error, {
    code: "INTAKE_RETRIEVAL_TIMEOUT",
    timeoutMs,
    timeoutPhase: "retrieval"
  });
  return error;
}

function runWithLocalTimeout<T>(operation: (signal: AbortSignal) => Promise<T>, timeoutMs: number): Promise<T> {
  const controller = new AbortController();
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    operation(controller.signal),
    new Promise<T>((_resolve, reject) => {
      timeoutHandle = setTimeout(() => {
        controller.abort();
        reject(createGamingRetrievalTimeoutError(timeoutMs));
      }, timeoutMs);
    })
  ]).finally(() => {
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
    }
  });
}

function buildSafeSourceLogTarget(url: string): { sourceHost: string; sourcePathLength: number } {
  try {
    const parsedUrl = new URL(url);
    return {
      sourceHost: parsedUrl.host,
      sourcePathLength: parsedUrl.pathname.length
    };
  } catch {
    return {
      sourceHost: "invalid-url",
      sourcePathLength: 0
    };
  }
}

export async function buildGamingWebContext(
  urls: string[],
  logContext?: GamingWebContextLogContext
): Promise<GamingWebContext> {
  if (urls.length === 0) {
    return { context: "", sources: [] };
  }

  const maxContextChars = getGamingWebContextMaxChars();
  const maxUrls = getGamingWebContextMaxUrls();
  const fetchTimeoutMs = getGamingWebContextFetchTimeoutMs();
  const uniqueUrls = Array.from(new Set(urls.map((url) => url.trim()).filter(isFetchableGuideUrl))).slice(0, maxUrls);
  const retrievalStartedAt = Date.now();
  if (logContext) {
    logger.info("gaming.retrieval.start", {
      ...logContext,
      sourceCount: uniqueUrls.length,
      requestedSourceCount: urls.length,
      maxUrls,
      maxContextChars,
      fetchTimeoutMs
    });
  }

  const sources: GamingWebSource[] = await Promise.all(
    uniqueUrls.map(async (url, index): Promise<GamingWebSource> => {
      const sourceUrl = redactUrlCredentials(url);
      const sourceStartedAt = Date.now();
      const sourceLogTarget = buildSafeSourceLogTarget(sourceUrl);
      if (logContext) {
        logger.info("gaming.retrieval.source.start", {
          ...logContext,
          ...sourceLogTarget,
          sourceIndex: index + 1,
          sourceCount: uniqueUrls.length,
          fetchTimeoutMs,
          maxContextChars
        });
      }

      try {
        const snippet = await runWithLocalTimeout(
          (signal) => fetchAndClean(sourceUrl, maxContextChars, { signal, timeoutMs: fetchTimeoutMs }),
          fetchTimeoutMs
        );
        if (logContext) {
          logger.info("gaming.retrieval.source.end", {
            ...logContext,
            ...sourceLogTarget,
            sourceIndex: index + 1,
            sourceCount: uniqueUrls.length,
            ok: true,
            elapsedMs: Date.now() - sourceStartedAt,
            fetchParseMs: Date.now() - sourceStartedAt,
            snippetChars: snippet.length,
            maxContextChars,
            fetchTimeoutMs
          });
        }
        return { url: sourceUrl, snippet };
      } catch (error) {
        const errorCode = readErrorString(error, "code") ?? "INTAKE_RETRIEVAL_FAILED";
        const timeoutPhase = readErrorString(error, "timeoutPhase");
        if (logContext) {
          logger.warn("gaming.retrieval.source.end", {
            ...logContext,
            ...sourceLogTarget,
            sourceIndex: index + 1,
            sourceCount: uniqueUrls.length,
            ok: false,
            elapsedMs: Date.now() - sourceStartedAt,
            fetchParseMs: Date.now() - sourceStartedAt,
            errorCode,
            ...(timeoutPhase ? { timeoutPhase } : {}),
            fallbackReason: errorCode,
            fetchTimeoutMs
          });
        }
        return { url: sourceUrl, error: resolveErrorMessage(error, "Unknown fetch error") };
      }
    })
  );

  const contextStartedAt = Date.now();
  const context = sources
    .filter((source) => Boolean(source.snippet))
    .map((source, index) => `[Source ${index + 1}] ${source.url}\n${source.snippet}`)
    .join("\n\n");

  if (logContext) {
    logger.info("gaming.retrieval.end", {
      ...logContext,
      sourceCount: sources.length,
      usableSourceCount: sources.filter((source) => Boolean(source.snippet)).length,
      failedSourceCount: sources.filter((source) => Boolean(source.error)).length,
      contextChars: context.length,
      parseMs: Date.now() - contextStartedAt,
      retrievalLatencyMs: Date.now() - retrievalStartedAt,
      maxContextChars,
      fetchTimeoutMs
    });
  }

  return { context, sources };
}
