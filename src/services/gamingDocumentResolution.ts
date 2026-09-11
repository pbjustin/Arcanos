import {
  GamingDocumentAcquisitionError, GAMING_DOCUMENT_ACQUISITION_POLICY_VERSION, isGamingDocumentRedirectStatus,
  requireGamingHttpsSourceAdmission, resolveGamingDocumentRedirect, type GamingDocumentAcquisition
} from "@shared/gaming/gamingSourceAcquisitionCore.js";
export { GamingDocumentAcquisitionError, GAMING_DOCUMENT_ACQUISITION_POLICY_VERSION }
  from "@shared/gaming/gamingSourceAcquisitionCore.js";
export type { GamingDocumentAcquisition } from "@shared/gaming/gamingSourceAcquisitionCore.js";
import { createHash } from "node:crypto";
import * as webFetcher from "@shared/webFetcher.js";
import {
  type FetchAndCleanExtractionMetrics,
  type FetchAndCleanOptions,
  type FetchAndCleanRawDocument
} from "@shared/webFetcher.js";
import {
  GAMING_BUILD_RESOURCE_HARD_LIMITS,
  classifyGamingResource,
  prepareGamingResourceUrl
} from "@services/gamingBuildResources.js";
import {
  GAMING_ARCHIVE_RESOLVER_VERSION,
  recognizeGamingArchiveItem,
  resolveGamingArchiveResource,
  type GamingArchiveResolutionTelemetry
} from "@services/gamingArchiveResources.js";
import { filterGamingDocumentInstructions, gamingDocumentFetchOptions } from "@services/gamingDocumentExtraction.js";
import { projectGamingDocumentText } from "@shared/gaming/gamingDocumentProjectionCore.js";
import { sanitizeGamingDiscoveryCandidateUrl, sanitizeGamingStructuredDocumentUrl } from "@services/gamingSourceDiscovery.js";
import type { GamingEvidenceUnit, GamingStructureDiagnostics } from '@shared/gaming/gamingEvidenceUnits.js';
import { extractGamingDocumentEvidence } from './gamingDocumentEvidence.js';

export const GAMING_DOCUMENT_RESOLVER_VERSION = "gaming-document-v2";
const acquisitionAttestations = new WeakMap<GamingDocumentAcquisition, string>();
const documentBinding = (document: ResolvedGamingDocument): string => createHash("sha256")
  .update(JSON.stringify({ requestedUrl: document.requestedUrl, canonicalUrl: document.canonicalUrl,
    publicUrl: document.publicUrl, host: document.host, text: document.text, metadata: document.metadata,
    contentType: document.contentType, resolution: document.resolution, metrics: document.metrics,
    acquisition: document.acquisition, evidenceUnits: document.evidenceUnits,
    sourceUseRestricted: document.sourceUseRestricted }), "utf8").digest("hex");

/** Preserve article selectors; only structured URL payloads need a separate citation projection. */
export function projectGamingDocumentPublicUrl(url: string): string {
  if (classifyGamingResource({ url }).extractionStrategy !== "url_payload") return url;
  const prepared = prepareGamingResourceUrl(url);
  if (!prepared) throw new GamingDocumentAcquisitionError("URL_BLOCKED", "extraction", "INVALID_PUBLIC_IDENTITY");
  return prepared.publicUrl;
}

/** Only this resolver can attest a changed identity; plain records cannot grant redirect permission. */
export function isResolvedGamingDocumentIdentityVerified(document: ResolvedGamingDocument, requestedUrl: string): boolean {
  try {
    const description = describeGamingDocumentSource(requestedUrl);
    if (document.acquisition) return document.acquisition.requestedUrl === description.publicUrl
      && document.requestedUrl === description.publicUrl && document.canonicalUrl === document.acquisition.finalUrl
      && document.publicUrl === projectGamingDocumentPublicUrl(document.canonicalUrl)
      && acquisitionAttestations.get(document.acquisition) === documentBinding(document);
    // Specialized Archive and the unchanged legacy HTTP transport have their own deny-redirect policy.
    const legacyIdentity = new URL(requestedUrl).protocol === "http:"
      || (description.resolverId === "archive-org" && document.resolution.resolverId === "archive-org");
    return legacyIdentity && document.requestedUrl === description.publicUrl && document.publicUrl === description.publicUrl
      && document.canonicalUrl === description.publicUrl && document.host === new URL(description.publicUrl).hostname;
  } catch { return false; }
}
export const GAMING_DOCUMENT_LIMITS = Object.freeze({ textChars: 100_000, timeoutMs: 30_000 });
// Matches the existing revision ceiling and stays within the unchanged 1.5 MB default fetch budget for ASCII prose.
export const GAMING_DURABLE_DOCUMENT_MAX_CHARS = 1_000_000;
export interface GamingDocumentResolutionOptions extends FetchAndCleanOptions {
  documentPurpose?: 'durable';
}

/** Internal acquired document. Requested/canonical URLs retain private payload identity; only publicUrl is a citation. */
export interface ResolvedGamingDocument {
  requestedUrl: string;
  canonicalUrl: string;
  publicUrl: string;
  host: string;
  text: string;
  contentType?: string;
  rawDocument?: FetchAndCleanRawDocument;
  metadata: { title?: string; headings?: string };
  extraction: FetchAndCleanExtractionMetrics;
  resolution: {
    resolverId: string;
    resolverVersion: string;
    strategy: string;
    documentType: "html" | "text" | "json" | "unknown";
    supportsStructuredExtraction: boolean;
  };
  metrics: {
    rawTextLength: number;
    cleanedTextLength: number;
    truncated: boolean;
    instructionFiltered: boolean;
  };
  archiveResolution?: GamingArchiveResolutionTelemetry;
  acquisition?: GamingDocumentAcquisition;
  evidenceUnits?: GamingEvidenceUnit[];
  structureDiagnostics?: GamingStructureDiagnostics;
  sourceUseRestricted?: boolean;
}

interface GamingDocumentResolver {
  id: string;
  version: string;
  canHandle: (url: URL) => boolean;
  supportsUrlPayload: boolean;
  publicUrl: (url: string) => string | undefined;
  acquire: (url: string, maxChars: number, options: FetchAndCleanOptions) => Promise<{
    text: string;
    strategy?: string;
    archiveResolution?: GamingArchiveResolutionTelemetry;
    supportsStructuredExtraction: boolean;
    finalUrl?: string;
    transitions?: GamingDocumentAcquisition["transitions"];
    structure?: ReturnType<typeof extractGamingDocumentEvidence>;
  } | null>;
}

// Ordered and bounded. Future source types add one adapter; every caller uses the same acquisition entry.
const DOCUMENT_RESOLVERS: readonly GamingDocumentResolver[] = [
  {
    id: "archive-org",
    supportsUrlPayload: false,
    version: GAMING_ARCHIVE_RESOLVER_VERSION,
    canHandle: (url) => ["archive.org", "www.archive.org"].includes(url.hostname.toLowerCase()),
    publicUrl: (url) => {
      const identifier = recognizeGamingArchiveItem(url);
      return identifier ? `https://archive.org/details/${identifier}` : undefined;
    },
    acquire: async (url, maxChars, options) => {
      const archive = await resolveGamingArchiveResource(url, maxChars, options);
      return archive ? {
        text: archive.text,
        strategy: archive.resolution.archiveSelectionReason,
        archiveResolution: archive.resolution,
        supportsStructuredExtraction: false
      } : null;
    }
  },
  {
    id: "generic-web",
    supportsUrlPayload: true,
    version: GAMING_DOCUMENT_RESOLVER_VERSION,
    canHandle: () => true,
    publicUrl: () => undefined,
    acquire: acquireGenericGamingDocument
  }
];

/** Safe identity and resolver policy for caller-owned deduplication/caches, without fetching. */
export function describeGamingDocumentSource(url: string): {
  publicUrl: string;
  resolverId: string;
  resolverVersion: string;
  supportsUrlPayload: boolean;
} {
  const parsed = new URL(url);
  if (!["http:", "https:"].includes(parsed.protocol)) throw new Error("Only HTTP/HTTPS URLs are supported");
  // prepareGamingResourceUrl intentionally redacts credentials; acquisition must reject them before that step.
  if (parsed.username || parsed.password) throw new Error("Source URL credentials are not supported");
  const prepared = prepareGamingResourceUrl(url);
  if (!prepared) throw new Error("Invalid source URL");
  const resolver = DOCUMENT_RESOLVERS.find((entry) => entry.canHandle(parsed))!;
  if (resolver.id === "archive-org" && recognizeGamingArchiveItem(url)) {
    const admission = sanitizeGamingDiscoveryCandidateUrl(url);
    // Archive's reviewed metadata/derivative resolver can turn an item PDF view into public OCR.
    // That content-type exception cannot erase credentials or bypass other admission categories.
    if (admission.rejected && admission.rejection?.subreason !== "unsupported_document_type") {
      throw new GamingDocumentAcquisitionError("URL_BLOCKED", "admission", admission.rejection?.subreason ?? "URL_REJECTED");
    }
  }
  return {
    publicUrl: resolver.publicUrl(url) ?? describeGenericGamingUrl(url),
    resolverId: resolver.id,
    resolverVersion: resolver.version,
    supportsUrlPayload: resolver.supportsUrlPayload
  };
}

function describeGenericGamingUrl(rawUrl: string): string {
  const parsed = new URL(rawUrl);
  if (parsed.protocol === "http:") {
    // Legacy local-development fixtures retain the existing server-owned transport opt-in.
    // No redirect session is reachable here, and redaction must not change the requested resource.
    if (["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname)) {
      const prepared = prepareGamingResourceUrl(rawUrl);
      if (parsed.hash) throw new GamingDocumentAcquisitionError("URL_BLOCKED", "admission", "UNSAFE_LEGACY_LOCAL_URL");
      parsed.hash = "";
      if (/[\u0000-\u0020\u007f-\u009f\\]/u.test(rawUrl) || !prepared || prepared.publicUrl !== parsed.toString()) {
        throw new GamingDocumentAcquisitionError("URL_BLOCKED", "admission", "UNSAFE_LEGACY_LOCAL_URL");
      }
      return parsed.toString();
    }
    const admission = sanitizeGamingDiscoveryCandidateUrl(rawUrl);
    if (admission.url && !admission.rejected) return admission.url;
    throw new GamingDocumentAcquisitionError("URL_BLOCKED", "admission", admission.rejection?.subreason ?? "URL_REJECTED");
  }
  return admitGenericGamingUrl(rawUrl, 0, true);
}

function admitGenericGamingUrl(rawUrl: string, redirectCount = 0, initialDocument = false): string {
  // This allowance belongs to existing internal structured acquisition only. Public candidates
  // have already passed their stricter admission, and every redirect destination keeps that bound.
  const structuredInitial = initialDocument && classifyGamingResource({ url: rawUrl }).extractionStrategy === "url_payload";
  const admission = structuredInitial ? sanitizeGamingStructuredDocumentUrl(rawUrl) : sanitizeGamingDiscoveryCandidateUrl(rawUrl);
  return requireGamingHttpsSourceAdmission(admission, redirectCount);
}

async function acquireGenericGamingDocument(url: string, maxChars: number, options: FetchAndCleanOptions) {
  if (new URL(url).protocol === "http:") {
    const legacyUrl = describeGenericGamingUrl(url);
    return { text: await webFetcher.fetchAndClean(legacyUrl, maxChars, options), supportsStructuredExtraction: true };
  }
  let currentUrl = admitGenericGamingUrl(url, 0, true);
  const seen = new Set([currentUrl]);
  const transitions: GamingDocumentAcquisition["transitions"][number][] = [];
  const session = webFetcher.createProtectedDocumentFetchSession(options);
  const startedAt = Date.now();
  try {
    for (;;) {
      session.assertActive();
      const response = await session.fetch(currentUrl);
      session.assertActive();
      if (!isGamingDocumentRedirectStatus(response.status)) {
        if (response.status < 200 || response.status >= 300) throw new GamingDocumentAcquisitionError(
          response.status === 401 || response.status === 403 ? "SOURCE_INACCESSIBLE" : "SOURCE_FETCH_FAILED",
          "transport", response.status === 304 ? "CONDITIONAL_CONTENT_UNAVAILABLE" : "HTTP_RESPONSE_UNUSABLE", transitions.length, response.status);
        if (response.contentType && !["text/html", "text/plain", "application/xhtml+xml", "application/json"].includes(response.contentType)) {
          throw new GamingDocumentAcquisitionError("SOURCE_FETCH_FAILED", "extraction", "UNSUPPORTED_CONTENT_TYPE", transitions.length);
        }
        let extracted: webFetcher.FetchAndCleanDocument;
        let structure: ReturnType<typeof extractGamingDocumentEvidence>;
        try {
          webFetcher.assertSupportedFetchAndCleanBody(response.body, response.contentType);
          structure = extractGamingDocumentEvidence({ body: response.body, contentType: response.contentType,
            sourceUrl: projectGamingDocumentPublicUrl(currentUrl), deadlineAt: options.deadlineAt,
            receivedBytes: response.receivedBytes, acceptedBytes: response.acceptedBytes });
          // Raw diagnostic/build preview describes the original response, not the
          // structural projection. Extraction sees the entire accepted body above.
          const rawLimit = Math.min(options.rawDocumentMaxChars ?? GAMING_BUILD_RESOURCE_HARD_LIMITS.maxHtmlChars,
            GAMING_BUILD_RESOURCE_HARD_LIMITS.maxHtmlChars);
          options.onRawDocument?.({ body: response.body.slice(0, rawLimit), contentType: response.contentType,
            truncated: response.body.length > rawLimit });
          extracted = webFetcher.extractFetchAndCleanDocument(currentUrl, structure.proseBody, response.contentType, maxChars,
            gamingDocumentFetchOptions(currentUrl, { ...options, onRawDocument: undefined }), Date.now() - startedAt);
        } catch {
          session.assertActive();
          throw new GamingDocumentAcquisitionError("SOURCE_FETCH_FAILED", "extraction", "DOCUMENT_EXTRACTION_FAILED", transitions.length);
        }
        session.assertActive();
        return { text: extracted.combined, finalUrl: currentUrl, transitions, supportsStructuredExtraction: true, structure };
      }
      const transition = resolveGamingDocumentRedirect({
        currentUrl, status: response.status, location: response.location, redirectCount: transitions.length, seen
      }, admitGenericGamingUrl);
      transitions.push(transition);
      seen.add(transition.toUrl);
      currentUrl = transition.toUrl;
    }
  } catch (error) {
    options.signal?.throwIfAborted();
    if (error instanceof webFetcher.ProtectedDocumentFetchError) throw new GamingDocumentAcquisitionError(
      error.code === "NETWORK_DESTINATION_BLOCKED" || error.code === "INVALID_TARGET" ? "URL_BLOCKED"
        : error.code === "REDIRECT_LOCATION_INVALID" ? "REDIRECT_NOT_ALLOWED"
          : error.code === "DEADLINE_EXCEEDED" ? "SOURCE_TIMEOUT" : "SOURCE_FETCH_FAILED",
      "transport", error.code, transitions.length, error.status);
    throw error;
  } finally { session.dispose(); }
}

/** Resolve once before live ranking or durable normalization; retain the pinned fetcher's security controls. */
export async function resolveGamingDocument(
  url: string,
  maxDocumentChars: number = GAMING_DOCUMENT_LIMITS.textChars,
  options: GamingDocumentResolutionOptions = {}
): Promise<ResolvedGamingDocument> {
  const description = describeGamingDocumentSource(url);
  const parsed = new URL(url);
  const documentCeiling = options.documentPurpose === 'durable'
    ? GAMING_DURABLE_DOCUMENT_MAX_CHARS : GAMING_DOCUMENT_LIMITS.textChars;
  const maxChars = Math.min(documentCeiling, Math.max(0,
    Number.isFinite(maxDocumentChars) ? Math.trunc(maxDocumentChars) : GAMING_DOCUMENT_LIMITS.textChars));
  const timeoutMs = Math.min(GAMING_DOCUMENT_LIMITS.timeoutMs, Math.max(1,
    Number.isFinite(options.timeoutMs) ? Math.trunc(options.timeoutMs!) : webFetcher.getConfiguredFetchTimeoutMs()));
  const deadlineAt = Math.min(
    Number.isFinite(options.deadlineAt) ? options.deadlineAt! : Number.POSITIVE_INFINITY,
    Date.now() + timeoutMs
  );
  let extraction: FetchAndCleanExtractionMetrics | undefined;
  let rawDocument: FetchAndCleanRawDocument | undefined;
  const fetchOptions = gamingDocumentFetchOptions(url, {
    ...options,
    // Acquisition/extraction identity never depends on a caller's question terms.
    // Relevance selection belongs to the live and stored retrieval consumers.
    preferredContentTerms: [],
    timeoutMs,
    deadlineAt,
    retainFullSelectedText: true,
    maxSelectedTextChars: documentCeiling,
    rawDocumentMaxChars: Math.min(options.rawDocumentMaxChars ?? GAMING_BUILD_RESOURCE_HARD_LIMITS.maxHtmlChars,
      GAMING_BUILD_RESOURCE_HARD_LIMITS.maxHtmlChars),
    onExtraction: (metrics) => { extraction = metrics; },
    onRawDocument: (document) => { rawDocument = document; }
  });
  for (const resolver of DOCUMENT_RESOLVERS) {
    if (!resolver.canHandle(parsed)) continue;
    const acquired = await resolver.acquire(url, maxChars, fetchOptions);
    if (!acquired) continue;
    const effectiveExtraction: FetchAndCleanExtractionMetrics = extraction ?? {
      strategy: "body", rawTextLength: acquired.text.length, cleanedTextLength: acquired.text.length
    };
    const projection = projectGamingDocumentText({
      acquiredText: acquired.text,
      maxChars,
      selectedTextLength: effectiveExtraction.cleanedTextLength,
      evidenceUnits: acquired.structure?.units
    });
    const contentType = rawDocument?.contentType;
    const boundedRaw = rawDocument ? {
      ...rawDocument,
      body: rawDocument.body.slice(0, GAMING_BUILD_RESOURCE_HARD_LIMITS.maxHtmlChars),
      truncated: rawDocument.truncated || rawDocument.body.length > GAMING_BUILD_RESOURCE_HARD_LIMITS.maxHtmlChars
    } : undefined;
    const safeMetadata = {
      ...(effectiveExtraction.documentTitle ? { title: filterGamingDocumentInstructions(effectiveExtraction.documentTitle).slice(0, 240) } : {}),
      ...(effectiveExtraction.headingText ? { headings: filterGamingDocumentInstructions(effectiveExtraction.headingText).slice(0, 240) } : {})
    };
    options.onExtraction?.(effectiveExtraction);
    if (boundedRaw) options.onRawDocument?.(boundedRaw);
    const canonicalUrl = resolver.publicUrl(url) ?? acquired.finalUrl ?? description.publicUrl;
    const publicUrl = acquired.finalUrl ? projectGamingDocumentPublicUrl(canonicalUrl) : canonicalUrl;
    const acquisition: GamingDocumentAcquisition | undefined = acquired.finalUrl ? {
      policyVersion: GAMING_DOCUMENT_ACQUISITION_POLICY_VERSION, requestedUrl: description.publicUrl,
      finalUrl: canonicalUrl, redirectCount: acquired.transitions?.length ?? 0,
      transitions: acquired.transitions ?? [], contentType: contentType ?? "unknown",
      coverage: { selectedTextChars: effectiveExtraction.cleanedTextLength, returnedTextChars: projection.text.length,
        truncated: projection.truncated, instructionFiltered: projection.instructionFiltered }
    } : undefined;
    const evidenceUnits = acquired.structure?.units.filter(unit => projection.text.includes(unit.text));
    const structureDiagnostics = acquired.structure ? { ...acquired.structure.diagnostics,
      extractedChars: projection.text.length,
      selectedUnits: evidenceUnits?.length ?? 0,
      unitKinds: [...new Set(evidenceUnits?.map(unit => unit.kind) ?? [])],
      completeUnits: evidenceUnits?.filter(unit => unit.integrity.status === 'complete').length ?? 0,
      partialUnits: evidenceUnits?.filter(unit => unit.integrity.status === 'partial').length ?? 0,
      ambiguousUnits: evidenceUnits?.filter(unit => unit.integrity.status === 'ambiguous').length ?? 0,
      truncationStages: [...new Set([...acquired.structure.diagnostics.truncationStages,
        ...(boundedRaw?.truncated ? ['raw_preview'] : []), ...(projection.truncated ? ['output'] : [])])]
    } : undefined;
    if (structureDiagnostics && !projection.text.trim() && !structureDiagnostics.subreasons.length) {
      structureDiagnostics.subreasons.push('no_primary_content');
    }
    const document: ResolvedGamingDocument = {
      requestedUrl: description.publicUrl,
      canonicalUrl,
      publicUrl,
      host: new URL(publicUrl).hostname,
      text: projection.text,
      ...(contentType ? { contentType } : {}),
      ...(boundedRaw ? { rawDocument: boundedRaw } : {}),
      metadata: safeMetadata,
      extraction: effectiveExtraction,
      resolution: {
        resolverId: resolver.id,
        resolverVersion: resolver.version,
        strategy: acquired.strategy ?? effectiveExtraction.strategy,
        documentType: contentType === "text/plain" ? "text" : contentType === "application/json" ? "json"
          : ["text/html", "application/xhtml+xml"].includes(contentType ?? "") ? "html" : "unknown",
        supportsStructuredExtraction: acquired.supportsStructuredExtraction
      },
      metrics: {
        rawTextLength: effectiveExtraction.rawTextLength,
        cleanedTextLength: projection.cleanedTextLength,
        truncated: projection.truncated || Boolean(acquired.structure?.diagnostics.truncationStages.includes('extraction')),
        instructionFiltered: projection.instructionFiltered || acquired.structure?.instructionFiltered === true
      },
      ...(acquired.archiveResolution ? { archiveResolution: acquired.archiveResolution } : {}),
      ...(acquisition ? { acquisition } : {}),
      ...(evidenceUnits?.length ? { evidenceUnits } : {}),
      ...(structureDiagnostics ? { structureDiagnostics } : {}),
      ...(acquired.structure?.sourceUseRestricted ? { sourceUseRestricted: true } : {})
    };
    if (acquisition) acquisitionAttestations.set(acquisition, documentBinding(document));
    if (Date.now() >= deadlineAt) throw new GamingDocumentAcquisitionError("SOURCE_TIMEOUT", "extraction", "DEADLINE_EXCEEDED", acquisition?.redirectCount);
    options.signal?.throwIfAborted();
    return document;
  }
  throw new Error("Source document could not be resolved");
}
