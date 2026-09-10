import { isIP } from "node:net";
import { redactString } from "@arcanos/runtime/redaction";

/** Configuration belongs to production wrappers; this shared policy never reads the environment. */
export interface GamingSourceDomainPolicy {
  allowlist?: readonly string[];
  blocklist?: readonly string[];
}

// These names are analytics identifiers. Generic source/campaign/ref selectors can identify a document.
const TRACKING_PARAM_PATTERN = /^(?:utm_.+|fbclid|gclid|dclid|msclkid|mc_[ce]id)$/i;
const SENSITIVE_PARAM_PATTERN = /(?:^|[_-])(?:access|api|auth|authorization|bearer|cookie|credential|key|nonce|password|secret|session|sig|signature|ticket|token)(?:$|[_-])|^(?:accessToken|apiKey|authToken|sessionId|x-amz-.+|x-goog-.+)$/i;
const SENSITIVE_PATH_MARKER_PATTERN = /^(?:access[-_]?token|api[-_]?key|assertion|authorization|bearer|credential|jwt|nonce|oauth|password|saml|secret|session|sig|signature|signed|sso|ticket|token|x-amz-.+)$/i;
const SENSITIVE_VALUE_PATTERN = /^(?:sk-|gh[opusr]_|eyj[a-z0-9_-]*\.|bearer\s+)/i;
const FILE_DOWNLOAD_PATTERN = /\.(?:7z|avi|bin|dmg|docx?|exe|gz|iso|mov|mp3|mp4|msi|pdf|pkg|rar|tar|wav|webm|xlsx?|zip)$/i;
const ACCOUNT_PATH_PATTERN = /\/(?:account|accounts|auth|login|log-in|register|registration|sign-in|signin|signup)(?:\/|$)/i;
const SEARCH_PATH_PATTERN = /\/(?:search|search-results|results)(?:\/|$)/i;
const SEARCH_QUERY_PARAM_PATTERN = /^(?:keyword|q|query|search|search_query)$/i;
const SEARCH_QUERY_ENDPOINT_PATTERN = /^\/(?:index(?:\.(?:php|html?|aspx?))?)?\/?$/i;
const RAW_URL_CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f-\u009f]/u;
const CONTENT_FARM_DOMAIN_PATTERN = /(?:^|[.-])(?:clickbait|content-?farm|scraper|seo-?spam|spam)(?:[.-]|$)/i;
const LOW_SIGNAL_DOMAINS = [
  "facebook.com",
  "instagram.com",
  "pinterest.com",
  "tiktok.com",
  "twitter.com",
  "x.com",
  "youtube.com",
  "youtu.be"
];
const URL_SHORTENER_DOMAINS = [
  "bit.ly",
  "buff.ly",
  "cutt.ly",
  "goo.gl",
  "is.gd",
  "ow.ly",
  "rebrand.ly",
  "shorturl.at",
  "tinyurl.com",
  "t.co"
];
const SEARCH_ENGINE_DOMAINS = [
  "bing.com",
  "duckduckgo.com",
  "google.com",
  "search.brave.com",
  "search.yahoo.com"
];

export function normalizeGamingSourceDomain(hostname: string): string {
  return hostname.toLowerCase().replace(/^www\./, "").replace(/^\[|\]$/g, "").replace(/\.$/, "");
}

export function gamingSourceDomainMatches(domain: string, candidate: string): boolean {
  const normalizedCandidate = normalizeGamingSourceDomain(candidate);
  return domain === normalizedCandidate || domain.endsWith(`.${normalizedCandidate}`);
}

function isInternalIpv4(hostname: string): boolean {
  const octets = hostname.split(".").map(Number);
  if (octets.length !== 4 || octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) {
    return true;
  }
  const [first, second, third] = octets;
  return first === 0
    || first === 10
    || first === 127
    || (first === 100 && second >= 64 && second <= 127)
    || (first === 169 && second === 254)
    || (first === 172 && second >= 16 && second <= 31)
    || (first === 192 && second === 168)
    || (first === 192 && second === 0 && (third === 0 || third === 2))
    || (first === 198 && (second === 18 || second === 19 || (second === 51 && third === 100)))
    || (first === 203 && second === 0 && third === 113)
    || first >= 224;
}

function isInternalHost(hostname: string): boolean {
  const normalized = normalizeGamingSourceDomain(hostname);
  if (normalized === "localhost" || normalized.endsWith(".localhost") || normalized.endsWith(".local")) {
    return true;
  }
  const ipFamily = isIP(normalized);
  if (ipFamily === 4) {
    return isInternalIpv4(normalized);
  }
  if (ipFamily === 6) {
    const compact = normalized.toLowerCase();
    return compact === "::" || compact === "::1" || compact.startsWith("fc") || compact.startsWith("fd")
      || /^fe[89ab]/.test(compact) || /^fe[c-f]/.test(compact) || compact.startsWith("ff")
      || compact === "2001:db8" || compact.startsWith("2001:db8:") || compact.startsWith("::ffff:");
  }
  return false;
}

export const GAMING_SOURCE_ADMISSION_POLICY_VERSION = "gaming-source-admission-v2";

export type GamingSourceAdmissionSubreason =
  | "invalid_url" | "url_too_long" | "unsupported_scheme" | "credentials" | "sensitive_url_material"
  | "forbidden_port" | "private_reserved_destination" | "domain_deny_rule" | "outside_domain_allowlist"
  | "unsupported_document_type" | "account_path" | "search_results" | "shortened_url"
  | "source_category_excluded" | "tracking_limit" | "query_parameter_limit";

export interface GamingSourceAdmissionRejection {
  category: "security" | "source_policy";
  subreason: GamingSourceAdmissionSubreason;
  ruleId: string;
  policyVersion: typeof GAMING_SOURCE_ADMISSION_POLICY_VERSION;
}

export interface GamingSourceAdmissionResult {
  url?: string;
  rejected: boolean;
  /** Internal bounded diagnostics; retain the existing public URL_BLOCKED reason. */
  rejection?: GamingSourceAdmissionRejection;
}

function rejectGamingSourceUrl(
  category: GamingSourceAdmissionRejection["category"],
  subreason: GamingSourceAdmissionSubreason
): GamingSourceAdmissionResult {
  return { rejected: true, rejection: {
    category, subreason, ruleId: `gaming.url.${subreason}`, policyVersion: GAMING_SOURCE_ADMISSION_POLICY_VERSION
  } };
}

export function sanitizeGamingSourceUrl(rawUrl: string, maxUrlChars: number,
  domainPolicy: GamingSourceDomainPolicy = {}): GamingSourceAdmissionResult {
  if (
    typeof rawUrl !== "string"
    || rawUrl.length === 0
    || RAW_URL_CONTROL_CHARACTER_PATTERN.test(rawUrl)
    || rawUrl.includes("\\")
  ) {
    return rejectGamingSourceUrl("security", "invalid_url");
  }
  if (rawUrl.length > maxUrlChars) return rejectGamingSourceUrl("source_policy", "url_too_long");
  try {
    const parsed = new URL(rawUrl.trim());
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return rejectGamingSourceUrl("security", "unsupported_scheme");
    if (parsed.username || parsed.password) return rejectGamingSourceUrl("security", "credentials");
    if (parsed.port) return rejectGamingSourceUrl("security", "forbidden_port");
    const domain = normalizeGamingSourceDomain(parsed.hostname);
    if (!domain || isInternalHost(domain)) {
      return rejectGamingSourceUrl("security", "private_reserved_destination");
    }
    // Decode only for validation. The parser-owned encoded request path is never rewritten.
    const decodedSegments = parsed.pathname.split("/").map((segment) => decodeURIComponent(segment));
    const policyPath = decodedSegments.join("/");
    if (RAW_URL_CONTROL_CHARACTER_PATTERN.test(policyPath) || policyPath.includes("\\")) {
      return rejectGamingSourceUrl("security", "invalid_url");
    }
    // Encoded slashes also delimit policy components; retain whole decoded values for redaction.
    const policySegments = decodedSegments.concat(policyPath.split("/"));
    if (policySegments.some((segment) => SENSITIVE_PATH_MARKER_PATTERN.test(segment)
      || SENSITIVE_VALUE_PATTERN.test(segment) || redactString(segment) === "[REDACTED]")) {
      return rejectGamingSourceUrl("security", "sensitive_url_material");
    }

    let trackingParamCount = 0;
    // Validate all original values before any analytics removal; erasure cannot authorize a signed URL.
    for (const [key, value] of parsed.searchParams.entries()) {
      if (
        SENSITIVE_PARAM_PATTERN.test(key)
        || SENSITIVE_VALUE_PATTERN.test(value)
        || redactString(value) === "[REDACTED]"
        || RAW_URL_CONTROL_CHARACTER_PATTERN.test(key + value)
      ) {
        return rejectGamingSourceUrl("security", "sensitive_url_material");
      }
      if (TRACKING_PARAM_PATTERN.test(key)) trackingParamCount += 1;
    }
    const fragment = decodeURIComponent(parsed.hash.slice(1));
    if (SENSITIVE_VALUE_PATTERN.test(fragment) || redactString(fragment) === "[REDACTED]"
      || RAW_URL_CONTROL_CHARACTER_PATTERN.test(fragment)
      || Array.from(new URLSearchParams(fragment).entries()).some(([key, value]) =>
        SENSITIVE_PARAM_PATTERN.test(key) || SENSITIVE_VALUE_PATTERN.test(value) || redactString(value) === "[REDACTED]")) {
      return rejectGamingSourceUrl("security", "sensitive_url_material");
    }
    // Security material is rejected before product categories, including specialized resolver exceptions.
    const allowlist = domainPolicy.allowlist ?? [];
    const blocklist = domainPolicy.blocklist ?? [];
    if (blocklist.some((candidate) => gamingSourceDomainMatches(domain, candidate))) {
      return rejectGamingSourceUrl("source_policy", "domain_deny_rule");
    }
    if (allowlist.length > 0 && !allowlist.some((candidate) => gamingSourceDomainMatches(domain, candidate))) {
      return rejectGamingSourceUrl("source_policy", "outside_domain_allowlist");
    }
    if (URL_SHORTENER_DOMAINS.some((candidate) => gamingSourceDomainMatches(domain, candidate))) {
      return rejectGamingSourceUrl("source_policy", "shortened_url");
    }
    if (SEARCH_ENGINE_DOMAINS.some((candidate) => gamingSourceDomainMatches(domain, candidate))) {
      return rejectGamingSourceUrl("source_policy", "search_results");
    }
    if (LOW_SIGNAL_DOMAINS.some((candidate) => gamingSourceDomainMatches(domain, candidate)) || CONTENT_FARM_DOMAIN_PATTERN.test(domain)) {
      return rejectGamingSourceUrl("source_policy", "source_category_excluded");
    }
    if (ACCOUNT_PATH_PATTERN.test(policyPath)) return rejectGamingSourceUrl("source_policy", "account_path");
    if (SEARCH_PATH_PATTERN.test(policyPath) || (SEARCH_QUERY_ENDPOINT_PATTERN.test(policyPath)
      && Array.from(parsed.searchParams.keys()).some((key) => SEARCH_QUERY_PARAM_PATTERN.test(key)))) {
      return rejectGamingSourceUrl("source_policy", "search_results");
    }
    if (trackingParamCount >= 5) return rejectGamingSourceUrl("source_policy", "tracking_limit");
    if (Array.from(parsed.searchParams.keys()).filter((key) => !TRACKING_PARAM_PATTERN.test(key)).length > 10) {
      return rejectGamingSourceUrl("source_policy", "query_parameter_limit");
    }
    if (FILE_DOWNLOAD_PATTERN.test(policyPath)) return rejectGamingSourceUrl("source_policy", "unsupported_document_type");
    if (trackingParamCount > 0) {
      // URLSearchParams classifies names, but serializing it would rewrite retained query bytes and ordering.
      parsed.search = parsed.search.slice(1).split("&").filter((part) => {
        const key = new URLSearchParams(part).keys().next().value;
        return key === undefined || !TRACKING_PARAM_PATTERN.test(key);
      }).join("&");
    }
    parsed.hash = "";
    return { url: parsed.toString(), rejected: false };
  } catch {
    return rejectGamingSourceUrl("security", "invalid_url");
  }
}

export const GAMING_DOCUMENT_ACQUISITION_POLICY_VERSION = "gaming-https-acquisition-v1";
const MAX_REDIRECT_TRANSITIONS = 3;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

export interface GamingDocumentAcquisition {
  policyVersion: typeof GAMING_DOCUMENT_ACQUISITION_POLICY_VERSION;
  requestedUrl: string;
  finalUrl: string;
  redirectCount: number;
  transitions: readonly {
    fromUrl: string;
    toUrl: string;
    classification: "same_origin" | "reviewed_publisher_pair";
    ruleId: string;
  }[];
  contentType: string;
  coverage: { selectedTextChars: number; returnedTextChars: number; truncated: boolean; instructionFiltered: boolean };
}

/** Finite diagnostics contain no rejected URL, Location, transport address, or client configuration. */
export class GamingDocumentAcquisitionError extends Error {
  readonly acquisition: {
    stage: "admission" | "redirect" | "transport" | "extraction";
    subreason: string;
    ruleId: string;
    policyVersion: typeof GAMING_DOCUMENT_ACQUISITION_POLICY_VERSION;
    redirectCount: number;
    failingHop: number;
    statusCategory?: "3xx" | "4xx" | "5xx";
  };
  constructor(readonly code: "URL_BLOCKED" | "REDIRECT_NOT_ALLOWED" | "SOURCE_FETCH_FAILED" | "SOURCE_TIMEOUT" | "SOURCE_INACCESSIBLE",
    stage: "admission" | "redirect" | "transport" | "extraction", subreason: string, redirectCount = 0, readonly status?: number,
    ruleId = `gaming.acquisition.${subreason.toLowerCase()}`) {
    super("The source could not be acquired under the public document policy.");
    this.name = "GamingDocumentAcquisitionError";
    this.acquisition = { stage, subreason, ruleId, policyVersion: GAMING_DOCUMENT_ACQUISITION_POLICY_VERSION,
      redirectCount, failingHop: redirectCount, ...(status && status >= 300 && status < 600
        ? { statusCategory: `${Math.floor(status / 100)}xx` as "3xx" | "4xx" | "5xx" } : {}) };
  }
}

/** Apply the resolver's HTTPS-only acquisition requirement to independently admitted URLs. */
export function requireGamingHttpsSourceAdmission(admission: GamingSourceAdmissionResult, redirectCount = 0): string {
  if (!admission.url || admission.rejected) throw new GamingDocumentAcquisitionError("URL_BLOCKED", "admission",
    admission.rejection?.subreason ?? "URL_REJECTED", redirectCount, undefined, admission.rejection?.ruleId);
  if (new URL(admission.url).protocol !== "https:") throw new GamingDocumentAcquisitionError("URL_BLOCKED", "admission",
    "HTTPS_REQUIRED", redirectCount);
  return admission.url;
}

function redirectTransition(from: URL, to: URL): Pick<GamingDocumentAcquisition["transitions"][number], "classification" | "ruleId"> | undefined {
  if (from.origin === to.origin) return { classification: "same_origin", ruleId: "gaming.redirect.same_origin" };
  // These exact host/path pairs already have independently reviewed publisher entries in
  // REVIEWED_GAMING_SOURCE_RULES. A shared suffix or an arbitrary publisher subdomain grants nothing.
  const pairs = [
    { id: "wow-specialist-apex-www", hosts: ["icy-veins.com", "www.icy-veins.com"], path: (value: string) => value.startsWith("/wow/") },
    { id: "swtor-patch-apex-www", hosts: ["swtor.com", "www.swtor.com"], path: (value: string) => value === "/patchnotes" || value.startsWith("/patchnotes/") }
  ];
  const rule = pairs.find(candidate => candidate.hosts.includes(from.hostname) && candidate.hosts.includes(to.hostname)
    && candidate.path(from.pathname) && candidate.path(to.pathname));
  return rule ? { classification: "reviewed_publisher_pair", ruleId: `gaming.redirect.${rule.id}` } : undefined;
}

/** Decide one redirect using the same admission callback as the production resolver; no transport occurs here. */
export function resolveGamingDocumentRedirect(input: {
  currentUrl: string;
  status: number;
  location: unknown;
  redirectCount: number;
  seen: ReadonlySet<string>;
}, admitUrl: (url: string, redirectCount: number) => string): GamingDocumentAcquisition["transitions"][number] {
  const { currentUrl, status, location, redirectCount, seen } = input;
  if (redirectCount >= MAX_REDIRECT_TRANSITIONS) throw new GamingDocumentAcquisitionError("REDIRECT_NOT_ALLOWED", "redirect",
    "REDIRECT_LIMIT", redirectCount, status);
  if (typeof location !== "string" || !location.length || location.length > 2_048
    || location !== location.trim() || /[\u0000-\u0020\u007f-\u009f\\]/u.test(location)
    || (/^https:/iu.test(location) && !/^https:\/\//iu.test(location))) {
    throw new GamingDocumentAcquisitionError("REDIRECT_NOT_ALLOWED", "redirect", "INVALID_LOCATION", redirectCount, status);
  }
  let next: URL;
  try { next = new URL(location, currentUrl); } catch {
    throw new GamingDocumentAcquisitionError("REDIRECT_NOT_ALLOWED", "redirect", "INVALID_LOCATION", redirectCount, status);
  }
  const nextUrl = admitUrl(next.toString(), redirectCount);
  const approved = redirectTransition(new URL(currentUrl), new URL(nextUrl));
  if (!approved) throw new GamingDocumentAcquisitionError("REDIRECT_NOT_ALLOWED", "redirect", "UNAPPROVED_TRANSITION", redirectCount, status);
  if (seen.has(nextUrl)) throw new GamingDocumentAcquisitionError("REDIRECT_NOT_ALLOWED", "redirect", "REDIRECT_LOOP", redirectCount, status);
  return { fromUrl: currentUrl, toUrl: nextUrl, ...approved };
}

export function isGamingDocumentRedirectStatus(status: number): boolean {
  return REDIRECT_STATUSES.has(status);
}
