export interface GamingArchiveRawDocument {
  body: string;
  contentType: string;
  truncated: boolean;
}

export interface GamingArchiveResolutionOptions {
  signal?: AbortSignal;
  /** Caller-selected document projection bound; existing byte validation is unchanged. */
  maxSelectedTextChars?: number;
  onRawDocument?: (document: GamingArchiveRawDocument) => void;
}

export interface GamingArchiveReadOverrides {
  includeLinks: false;
  rawDocumentMaxChars: number;
  onRawDocument: (document: GamingArchiveRawDocument) => void;
  onExtraction?: undefined;
}

export interface GamingArchiveResourceDependencies {
  prepareResourceUrl: (url: string) => { privateFetchUrl: string } | null;
  fetchAndClean: (
    url: string,
    maxChars: number,
    overrides: GamingArchiveReadOverrides
  ) => Promise<string>;
}

export const GAMING_ARCHIVE_RESOLVER_VERSION = "archive-text-v1";
export const GAMING_ARCHIVE_RESOURCE_LIMITS = Object.freeze({
  metadataBytes: 128_000,
  documentBytes: 1_000_000,
  documentChars: 100_000,
  durableDocumentChars: 1_000_000,
  files: 512,
  provenanceDepth: 8
});

export type GamingArchiveResolutionTelemetry = {
  archiveResolverVersion: typeof GAMING_ARCHIVE_RESOLVER_VERSION;
  archiveSelectionReason: "archive_djvu_text" | "archive_plain_text";
  archiveDerivativeBytes: number;
  archiveMetadataFileCount: number;
};

type ArchiveFailureReason = "INVALID_ITEM_URL" | "METADATA_UNAVAILABLE" | "INVALID_METADATA"
  | "METADATA_TOO_LARGE" | "UNSAFE_STORAGE_LOCATION" | "NO_READABLE_DERIVATIVE"
  | "AMBIGUOUS_DOCUMENTS" | "DOCUMENT_UNAVAILABLE" | "DOCUMENT_TOO_LARGE" | "DOCUMENT_NOT_TEXT";

export class GamingArchiveResolutionError extends Error {
  readonly code: string;

  constructor(readonly reason: ArchiveFailureReason) {
    super("Archive guide evidence could not be resolved safely.");
    this.name = "GamingArchiveResolutionError";
    this.code = `GAMING_ARCHIVE_${reason}`;
  }
}

type ArchiveFile = Record<string, unknown> & { name: string };
type TextCandidate = { file: ArchiveFile; root: string; priority: number; bytes: number };

function plainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype);
}

function archiveInput(
  url: string,
  prepareResourceUrl: GamingArchiveResourceDependencies["prepareResourceUrl"]
): { parsed: URL; identifier: string | null } | null {
  try {
    const parsed = new URL(url);
    if (!["archive.org", "www.archive.org"].includes(parsed.hostname.toLowerCase())) return null;
    // Inspect the original path as well: URL parsing must not hide a dot-segment item identifier.
    const originalPath = url.replace(/^[a-z]+:\/\/[^/]+/iu, "").split(/[?#]/u, 1)[0];
    if (!/^\/details(?:\/|$)/u.test(originalPath)) return null;
    const match = /^\/details\/([a-z0-9][a-z0-9._-]{4,99})(?:\/)?(?:\/page\/[a-z0-9._-]+(?:\/mode\/(?:1up|2up|thumb))?)?$/iu.exec(parsed.pathname);
    const prepared = prepareResourceUrl(url);
    const safe = prepared && parsed.protocol === "https:" && !parsed.port
      && !parsed.username && !parsed.password && !originalPath.includes("\\")
      && !/%|(?:^|\/)\.{1,2}(?:\/|$)/u.test(originalPath);
    return { parsed, identifier: safe && match ? match[1] : null };
  } catch {
    return null;
  }
}

/** Recognition preserves case-sensitive item identity; query and reader position are not evidence. */
export function recognizeGamingArchiveItemCore(
  url: string,
  prepareResourceUrl: GamingArchiveResourceDependencies["prepareResourceUrl"]
): string | null {
  return archiveInput(url, prepareResourceUrl)?.identifier ?? null;
}

function safeFilename(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 240
    && Buffer.byteLength(value, "utf8") <= 512 && value.trim() === value
    && !value.startsWith(".") && !/[\\/%?#:\u0000-\u001f\u007f-\u009f]/u.test(value)
    && !/[\u202a-\u202e\u2066-\u2069]/u.test(value);
}

function fileIsPublic(file: ArchiveFile): boolean {
  return file.private === undefined || file.private === false || file.private === "false";
}

function documentRoot(file: ArchiveFile, files: Map<string, ArchiveFile>): string | undefined {
  const seen = new Set<string>();
  let current: ArchiveFile | undefined = file;
  for (let depth = 0; current && depth < GAMING_ARCHIVE_RESOURCE_LIMITS.provenanceDepth; depth += 1) {
    if (seen.has(current.name) || !fileIsPublic(current)) return undefined;
    seen.add(current.name);
    if (current.source === "original") {
      return /\.(?:pdf|txt|epub|djvu)$/iu.test(current.name)
        && ["Text", "Plain Text", "Text PDF", "Image Container PDF", "PDF", "EPUB", "DjVu"].includes(String(current.format))
        ? current.name : undefined;
    }
    if (current.source !== "derivative" || !safeFilename(current.original)) return undefined;
    current = files.get(current.original);
  }
  return undefined;
}

function selectTextCandidate(files: Map<string, ArchiveFile>): TextCandidate {
  const candidates: TextCandidate[] = [];
  for (const file of files.values()) {
    if (!fileIsPublic(file) || !/\.txt$/iu.test(file.name)
      || /(?:^|[ ._-])(?:readme|license|metadata|reviews?|checksums?|logs?)(?:[ ._-]|$)/iu.test(file.name)) continue;
    const priority = file.format === "DjVuTXT" && file.source === "derivative" ? 0
      : ["Text", "Plain Text"].includes(String(file.format)) ? 1 : -1;
    const bytes = typeof file.size === "string" && /^[1-9][0-9]{0,9}$/u.test(file.size)
      ? Number(file.size) : typeof file.size === "number" ? file.size : 0;
    if (priority < 0 || !Number.isSafeInteger(bytes) || bytes <= 0
      || bytes > GAMING_ARCHIVE_RESOURCE_LIMITS.documentBytes) continue;
    const root = documentRoot(file, files);
    if (root) candidates.push({ file, root, priority, bytes });
  }
  candidates.sort((left, right) => left.priority - right.priority
    || (left.file.name < right.file.name ? -1 : left.file.name > right.file.name ? 1 : 0));
  if (candidates.length === 0) throw new GamingArchiveResolutionError("NO_READABLE_DERIVATIVE");
  const best = candidates[0];
  // A collection containing different manuals cannot be disambiguated from an item URL alone.
  if (candidates.some((candidate) => candidate.root !== best.root)) {
    throw new GamingArchiveResolutionError("AMBIGUOUS_DOCUMENTS");
  }
  return best;
}

function assertNotAborted(options: GamingArchiveResolutionOptions): void {
  if (options.signal?.aborted) {
    throw options.signal.reason instanceof Error ? options.signal.reason : new Error("Gaming retrieval aborted");
  }
}

function assertRawDocument(
  document: GamingArchiveRawDocument | undefined,
  kind: "metadata" | "text"
): asserts document is GamingArchiveRawDocument {
  if (!document) throw new GamingArchiveResolutionError(kind === "metadata" ? "INVALID_METADATA" : "DOCUMENT_NOT_TEXT");
  const maxBytes = kind === "metadata" ? GAMING_ARCHIVE_RESOURCE_LIMITS.metadataBytes : GAMING_ARCHIVE_RESOURCE_LIMITS.documentBytes;
  if (document.truncated || Buffer.byteLength(document.body, "utf8") > maxBytes) {
    throw new GamingArchiveResolutionError(kind === "metadata" ? "METADATA_TOO_LARGE" : "DOCUMENT_TOO_LARGE");
  }
  if (document.contentType !== (kind === "metadata" ? "application/json" : "text/plain")) {
    throw new GamingArchiveResolutionError(kind === "metadata" ? "INVALID_METADATA" : "DOCUMENT_NOT_TEXT");
  }
  if (kind === "text" && (/[\u0000-\u0008\u000e-\u001f]/u.test(document.body)
    || /^\s*(?:%PDF-|PK\u0003\u0004|MZ|<!doctype\s+html|<html\b)/iu.test(document.body)
    || document.body.trim().length < 80)) {
    throw new GamingArchiveResolutionError("DOCUMENT_NOT_TEXT");
  }
}

/** Resolve metadata-attested Archive text through caller-owned bounded reads. */
export async function resolveGamingArchiveResourceCore(
  url: string,
  maxDocumentChars: number,
  options: GamingArchiveResolutionOptions,
  dependencies: GamingArchiveResourceDependencies
): Promise<{ text: string; resolution: GamingArchiveResolutionTelemetry } | null> {
  const item = archiveInput(url, dependencies.prepareResourceUrl);
  if (!item) return null;
  if (!item.identifier) throw new GamingArchiveResolutionError("INVALID_ITEM_URL");
  const identifier = item.identifier;
  assertNotAborted(options);
  let metadataDocument: GamingArchiveRawDocument | undefined;
  try {
    await dependencies.fetchAndClean(`https://archive.org/metadata/${identifier}`, 0, {
      includeLinks: false,
      onExtraction: undefined,
      rawDocumentMaxChars: GAMING_ARCHIVE_RESOURCE_LIMITS.metadataBytes,
      onRawDocument: (document) => { metadataDocument = document; }
    });
  } catch {
    assertNotAborted(options);
    throw new GamingArchiveResolutionError("METADATA_UNAVAILABLE");
  }
  assertNotAborted(options);
  assertRawDocument(metadataDocument, "metadata");
  let metadata: unknown;
  try { metadata = JSON.parse(metadataDocument.body); }
  catch { throw new GamingArchiveResolutionError("INVALID_METADATA"); }
  if (!plainRecord(metadata) || !plainRecord(metadata.metadata)
    || metadata.metadata.identifier !== identifier || metadata.metadata.mediatype !== "texts"
    || metadata.is_dark === true || metadata.error !== undefined
    || !Array.isArray(metadata.files) || metadata.files.length === 0
    || metadata.files.length > GAMING_ARCHIVE_RESOURCE_LIMITS.files) {
    throw new GamingArchiveResolutionError("INVALID_METADATA");
  }
  const storageHost = metadata.d1;
  const directory = metadata.dir;
  if (typeof storageHost !== "string" || !/^ia[0-9]{1,12}\.(?:us|eu)\.archive\.org$/u.test(storageHost)
    || typeof directory !== "string" || !/^\/[0-9]{1,4}\/items\//u.test(directory)
    || directory !== `/${directory.split("/")[1]}/items/${identifier}`) {
    throw new GamingArchiveResolutionError("UNSAFE_STORAGE_LOCATION");
  }
  const files = new Map<string, ArchiveFile>();
  for (const file of metadata.files) {
    if (!plainRecord(file) || !safeFilename(file.name) || files.has(file.name)) {
      throw new GamingArchiveResolutionError("INVALID_METADATA");
    }
    files.set(file.name, file as ArchiveFile);
  }
  const selected = selectTextCandidate(files);
  const derivativeUrl = `https://${storageHost}${directory}/${encodeURIComponent(selected.file.name)}`;
  const preparedDerivative = dependencies.prepareResourceUrl(derivativeUrl);
  if (!preparedDerivative || preparedDerivative.privateFetchUrl !== derivativeUrl) {
    throw new GamingArchiveResolutionError("UNSAFE_STORAGE_LOCATION");
  }
  let document: GamingArchiveRawDocument | undefined;
  let text: string;
  const documentTextCeiling = Number.isFinite(options.maxSelectedTextChars)
    ? Math.min(GAMING_ARCHIVE_RESOURCE_LIMITS.durableDocumentChars, Math.max(0, Math.trunc(options.maxSelectedTextChars!)))
    : GAMING_ARCHIVE_RESOURCE_LIMITS.documentChars;
  try {
    text = await dependencies.fetchAndClean(derivativeUrl,
      Math.min(Math.max(0, maxDocumentChars), documentTextCeiling), {
        includeLinks: false,
        rawDocumentMaxChars: GAMING_ARCHIVE_RESOURCE_LIMITS.documentBytes,
        onRawDocument: (raw) => { document = raw; }
      });
  } catch {
    assertNotAborted(options);
    throw new GamingArchiveResolutionError("DOCUMENT_UNAVAILABLE");
  }
  assertNotAborted(options);
  // The shared fetcher's raw callback is advisory; validate after awaiting, never by throwing inside it.
  assertRawDocument(document, "text");
  options.onRawDocument?.(document);
  return {
    text,
    resolution: {
      archiveResolverVersion: GAMING_ARCHIVE_RESOLVER_VERSION,
      archiveSelectionReason: selected.priority === 0 ? "archive_djvu_text" : "archive_plain_text",
      archiveDerivativeBytes: Buffer.byteLength(document.body, "utf8"),
      archiveMetadataFileCount: files.size
    }
  };
}
