import { createHash } from "node:crypto";
import { gunzipSync, inflateRawSync, inflateSync } from "node:zlib";
import { load } from "cheerio";
import { MemoryCache } from "@platform/resilience/cache.js";
import { canonicalizeGamingGameName } from "@services/gamingGameDetection.js";
import {
  GAMING_BUILD_RESOURCE_HARD_LIMITS as LIMITS,
  GAMING_BUILD_RESOURCE_SCHEMA_VERSION,
  NormalizedGamingBuildSchema,
  type GamingBuildResourceAdapter,
  type GamingBuildResourceResult,
  type GamingBuildValidationResult,
  type GamingExtractionQuality,
  type GamingExtractionStrategy,
  type GamingPreparedResourceUrl,
  type GamingResourceClassification,
  type GamingResourceInput,
  type GamingResourceMetadata,
  type GamingResourceType,
  type GamingStructuredFailureReason,
  type NormalizedGamingBuild
} from "@services/gamingBuildResourceSchema.js";

export { GAMING_BUILD_RESOURCE_HARD_LIMITS, GAMING_BUILD_RESOURCE_SCHEMA_VERSION } from "@services/gamingBuildResourceSchema.js";
export type {
  GamingBuildResourceAdapter,
  GamingBuildResourceResult,
  GamingBuildValidationResult,
  GamingExtractionQuality,
  GamingExtractionStrategy,
  GamingPreparedResourceUrl,
  GamingResourceClassification,
  GamingResourceInput,
  GamingResourceMetadata,
  GamingResourceType,
  GamingStructuredFailureReason,
  NormalizedGamingBuild
} from "@services/gamingBuildResourceSchema.js";

const GENERIC_ADAPTER_ID = "generic";
const GENERIC_ADAPTER_VERSION = "1";
const TRACKING_PARAM_PATTERN = /^(?:utm_.+|fbclid|gclid|dclid|msclkid|mc_[ce]id|ref_src|ref_url|source|campaign|campaignid)$/iu;
const SENSITIVE_PARAM_PATTERN = /(?:^|[_-])(?:access|api|auth|bearer|credential|key|password|secret|sig|signature|token)(?:$|[_-])|^x-amz-/iu;
const SENSITIVE_VALUE_PATTERN = /^(?:sk-|gh[opusr]_|eyj[a-z0-9_-]*\.|bearer\s+)|\b(?:password|secret|token|api[_-]?key)\s*[:=]/iu;
const SENSITIVE_PATH_MARKER_PATTERN = /^(?:access[-_]?token|api[-_]?key|assertion|auth|authorization|authorize|bearer|credential|jwt|key|nonce|oauth|password|saml|secret|session|sig|signature|signed|sso|state|ticket|token|x-amz-.+)$/iu;
const JWT_PATH_VALUE_PATTERN = /^eyj[a-z0-9_-]*\.[a-z0-9_-]+\.[a-z0-9_-]+$/iu;
const URL_PAYLOAD_KEY_PATTERN = /^(?:b|build|builddata|code|data|deck|export|import|json|loadout|payload|share|skills?|talents?|tree)$/iu;
const NEVER_PUBLIC_PARAM_PATTERN = /^(?:b|build|builddata|data|deck|export|import|json|loadout|payload|skills?|talents?|tree)$/iu;
const PUBLIC_IDENTITY_PARAMS = new Set([
  "article", "code", "game", "id", "oldid", "p", "page", "profile", "share", "slug", "title", "topic"
]);
const DANGEROUS_KEYS = new Set(["__proto__", "prototype", "constructor"]);
const PROMPT_INJECTION_PATTERN = /\b(?:(?:ignore|disregard|override)\s+(?:all\s+)?(?:previous|prior|system|developer|assistant|user)\s+(?:instructions?|messages?|prompts?)|you\s+are\s+now|new\s+(?:system|developer|assistant)\s+(?:message|prompt|instructions?)|(?:reveal|print|show|expose|exfiltrate)\s+(?:the\s+)?(?:system|developer|secret|credential|token|api\s+key)|(?:call|invoke)\s+(?:the\s+)?(?:tool|function)|(?:execute|run)\s+(?:this\s+)?(?:command|shell|powershell|bash))\b/iu;
const NAVIGATION_ONLY_PATTERN = /^(?:home|menu|navigation|sign in|log in|privacy policy|terms|subscribe|next|previous|search)$/iu;
const SHARE_CODE_PATTERN = /^[a-z0-9._~-]{2,64}$/iu;
const BASE64_PATTERN = /^[a-z0-9+/_-]+={0,2}$/iu;
const BASE64ISH_PATH_PATTERN = /^[a-z0-9+/_=-]{96,}$/iu;
const ADAPTER_ID_PATTERN = /^[a-z0-9][a-z0-9._-]*$/u;

const KNOWN_KEYS = new Set([
  "game", "gamename", "title", "buildname", "role", "archetype", "activity", "patch", "version",
  "character", "class", "subclass", "specialization", "spec", "level", "equipment", "gear", "items", "loadout",
  "weapons", "armor", "deck", "cards", "army", "units", "roster", "skills", "abilities", "spells", "talents",
  "perks", "traits", "stats", "attributes", "rotation", "consumables", "companions", "team", "party", "utility",
  "strengths", "weaknesses", "constraints", "notes", "setup", "settings", "tuning"
]);

const adapters = new Map<string, GamingBuildResourceAdapter>();
const buildCache = new MemoryCache<GamingBuildResourceResult>({
  defaultTtlMs: LIMITS.cacheTtlMs,
  maxEntries: LIMITS.maxCacheEntries,
  cleanupIntervalMs: 60_000
});

type PlainRecord = Record<string, unknown>;

type StructuralInspection = {
  ok: boolean;
  fieldCount: number;
  issue?: "too_large" | "too_deep" | "unsafe_key" | "invalid_value";
};

type DecodedCandidate = {
  value?: unknown;
  decodedSize: number;
  reason?: GamingStructuredFailureReason;
};

type ExtractionState = {
  decodedSize: number;
  sawCandidate: boolean;
  sawOversized: boolean;
  sawMalformed: boolean;
  strategy: GamingExtractionStrategy;
};

export interface GamingBuildResourceOptions {
  adapters?: readonly GamingBuildResourceAdapter[];
  cacheTtlMs?: number;
  useCache?: boolean;
}

function clampConfidence(value: number): number {
  return Number(Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0)).toFixed(4));
}

function normalizeKey(value: string): string {
  return value.toLowerCase().replace(/[\s._:@/-]+/gu, "");
}

function isPlainRecord(value: unknown): value is PlainRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function ownEntries(value: PlainRecord): Array<[string, unknown]> {
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const entries: Array<[string, unknown]> = [];
  for (const key of Object.keys(descriptors)) {
    const descriptor = descriptors[key];
    if (descriptor && "value" in descriptor) {
      entries.push([key, descriptor.value]);
    }
  }
  return entries;
}

function safeString(value: unknown, maxChars: number = LIMITS.maxStringLength): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value
    .replace(/[\u0000-\u001f\u007f]/gu, " ")
    .replace(/https?:\/\/\S+/giu, "[link omitted]")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, Math.max(0, maxChars));
  if (!normalized || PROMPT_INJECTION_PATTERN.test(normalized) || SENSITIVE_VALUE_PATTERN.test(normalized)) {
    return undefined;
  }
  return normalized;
}

function safeIdentifier(value: string, maxChars: number): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9._-]+/gu, "-").slice(0, maxChars) || "unknown";
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function sanitizePublicPath(pathname: string): string {
  const output: string[] = [];
  const preserveTrailingSlash = pathname.length > 1 && pathname.endsWith("/");
  for (const rawSegment of pathname.split("/")) {
    if (!rawSegment) {
      continue;
    }
    let decoded = rawSegment;
    try {
      decoded = decodeURIComponent(rawSegment);
    } catch {
      break;
    }
    if (
      SENSITIVE_PATH_MARKER_PATTERN.test(decoded)
      || SENSITIVE_VALUE_PATTERN.test(decoded)
      || JWT_PATH_VALUE_PATTERN.test(decoded)
      || decoded.length > LIMITS.maxSafePathSegmentChars
      || BASE64ISH_PATH_PATTERN.test(decoded)
      || (decoded.length >= 96 && !/[\s-]/u.test(decoded))
    ) {
      break;
    }
    output.push(rawSegment);
  }
  return `/${output.join("/")}${preserveTrailingSlash ? "/" : ""}`;
}

function isSafePublicParam(key: string, value: string): boolean {
  const normalizedKey = key.toLowerCase();
  if (
    NEVER_PUBLIC_PARAM_PATTERN.test(normalizedKey)
    || SENSITIVE_PARAM_PATTERN.test(normalizedKey)
    || SENSITIVE_VALUE_PATTERN.test(value)
    || !PUBLIC_IDENTITY_PARAMS.has(normalizedKey)
  ) {
    return false;
  }
  const maxChars = normalizedKey === "code" || normalizedKey === "share"
    ? LIMITS.maxSafeShareCodeChars
    : LIMITS.maxSafePublicParamChars;
  if (value.length === 0 || value.length > maxChars) {
    return false;
  }
  return normalizedKey === "code" || normalizedKey === "share"
    ? SHARE_CODE_PATTERN.test(value)
    : !/[\u0000-\u001f\u007f]/u.test(value);
}

/** Parse once, preserve a private extraction/fetch URL, and derive only bounded public forms. */
export function prepareGamingResourceUrl(rawUrl: string): GamingPreparedResourceUrl | null {
  const trimmed = typeof rawUrl === "string" ? rawUrl.trim() : "";
  if (!trimmed || trimmed.length > LIMITS.maxUrlChars) {
    return null;
  }
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return null;
    }
    parsed.username = "";
    parsed.password = "";
    const privateFetchUrl = parsed.toString();
    const payloadMaterial = `${parsed.pathname}\n${parsed.search}\n${parsed.hash}`;
    const publicUrl = new URL(privateFetchUrl);
    publicUrl.username = "";
    publicUrl.password = "";
    publicUrl.pathname = sanitizePublicPath(publicUrl.pathname);
    const safeParams = new URLSearchParams();
    for (const [key, value] of publicUrl.searchParams.entries()) {
      if (!TRACKING_PARAM_PATTERN.test(key) && isSafePublicParam(key, value)) {
        safeParams.append(key, value);
      }
    }
    safeParams.sort();
    publicUrl.search = safeParams.toString();
    publicUrl.hash = "";
    const canonicalPublicUrl = publicUrl.toString();
    return {
      privateFetchUrl,
      publicUrl: canonicalPublicUrl,
      canonicalPublicUrl,
      safeDisplayUrl: canonicalPublicUrl,
      payloadHash: sha256(payloadMaterial),
      payloadLength: Buffer.byteLength(payloadMaterial, "utf8")
    };
  } catch {
    return null;
  }
}

export const sanitizeGamingResourceUrl = prepareGamingResourceUrl;

function inspectStructure(value: unknown, deadline = Number.POSITIVE_INFINITY): StructuralInspection {
  const stack: Array<{ value: unknown; depth: number }> = [{ value, depth: 0 }];
  const seen = new WeakSet<object>();
  let fieldCount = 0;
  while (stack.length > 0) {
    if (Date.now() > deadline) {
      return { ok: false, fieldCount, issue: "too_large" };
    }
    const current = stack.pop()!;
    if (current.depth > LIMITS.maxJsonDepth) {
      return { ok: false, fieldCount, issue: "too_deep" };
    }
    if (typeof current.value === "string") {
      if (current.value.length > LIMITS.maxStringLength) {
        return { ok: false, fieldCount, issue: "too_large" };
      }
      continue;
    }
    if (typeof current.value === "number") {
      if (!Number.isFinite(current.value) || (Number.isInteger(current.value) && !Number.isSafeInteger(current.value))) {
        return { ok: false, fieldCount, issue: "invalid_value" };
      }
      continue;
    }
    if (current.value === null || typeof current.value === "boolean" || current.value === undefined) {
      continue;
    }
    if (typeof current.value !== "object") {
      return { ok: false, fieldCount, issue: "invalid_value" };
    }
    if (seen.has(current.value)) {
      return { ok: false, fieldCount, issue: "invalid_value" };
    }
    seen.add(current.value);
    if (Array.isArray(current.value)) {
      if (current.value.length > LIMITS.maxArrayLength) {
        return { ok: false, fieldCount, issue: "too_large" };
      }
      fieldCount += current.value.length;
      if (fieldCount > LIMITS.maxFieldCount) {
        return { ok: false, fieldCount, issue: "too_large" };
      }
      for (let index = current.value.length - 1; index >= 0; index -= 1) {
        stack.push({ value: current.value[index], depth: current.depth + 1 });
      }
      continue;
    }
    if (!isPlainRecord(current.value) || Object.getOwnPropertySymbols(current.value).length > 0) {
      return { ok: false, fieldCount, issue: "invalid_value" };
    }
    const descriptors = Object.getOwnPropertyDescriptors(current.value);
    const keys = Object.keys(descriptors);
    if (keys.length > LIMITS.maxObjectKeys) {
      return { ok: false, fieldCount, issue: "too_large" };
    }
    fieldCount += keys.length;
    if (fieldCount > LIMITS.maxFieldCount) {
      return { ok: false, fieldCount, issue: "too_large" };
    }
    for (const key of keys) {
      if (DANGEROUS_KEYS.has(key.toLowerCase())) {
        return { ok: false, fieldCount, issue: "unsafe_key" };
      }
      const descriptor = descriptors[key];
      if (!descriptor || !("value" in descriptor)) {
        return { ok: false, fieldCount, issue: "invalid_value" };
      }
      stack.push({ value: descriptor.value, depth: current.depth + 1 });
    }
  }
  return { ok: true, fieldCount };
}

function collectObjectStrings(value: unknown, wantedKeys?: ReadonlySet<string>): string[] {
  const inspection = inspectStructure(value);
  if (!inspection.ok) {
    return [];
  }
  const output: string[] = [];
  const stack: unknown[] = [value];
  while (stack.length > 0 && output.length < 64) {
    const current = stack.pop();
    if (Array.isArray(current)) {
      stack.push(...current.slice(0, LIMITS.maxArrayLength));
    } else if (isPlainRecord(current)) {
      for (const [key, nested] of ownEntries(current)) {
        if (typeof nested === "string" && (!wantedKeys || wantedKeys.has(normalizeKey(key)))) {
          const cleaned = safeString(nested, 240);
          if (cleaned) output.push(cleaned);
        } else if (nested && typeof nested === "object") {
          stack.push(nested);
        }
      }
    }
  }
  return output;
}

function metadataFromHtml(html: string | undefined, deadline = Number.POSITIVE_INFINITY): GamingResourceMetadata {
  if (!html || html.length > LIMITS.maxHtmlChars || Date.now() > deadline) {
    return {};
  }
  const $ = load(html);
  if (Date.now() > deadline) return {};
  const openGraph: Record<string, string> = {};
  $("meta[property^='og:']").slice(0, 32).each((_, element) => {
    const property = safeString($(element).attr("property"), 80);
    const content = safeString($(element).attr("content"), 240);
    if (property && content && !DANGEROUS_KEYS.has(property.toLowerCase())) {
      openGraph[property.toLowerCase()] = content;
    }
  });
  const headings = $("h1, h2, h3").slice(0, 24).map((_, element) => safeString($(element).text(), 240)).get().filter(Boolean) as string[];
  const title = safeString($("title").first().text(), 240);
  const description = safeString($("meta[name='description']").first().attr("content"), 500);
  const canonicalUrl = safeString($("link[rel='canonical']").first().attr("href"), LIMITS.maxUrlChars);
  return {
    ...(title ? { title } : {}),
    ...(description ? { description } : {}),
    ...(canonicalUrl ? { canonicalUrl } : {}),
    ...(Object.keys(openGraph).length > 0 ? { openGraph } : {}),
    ...(headings.length > 0 ? { headings } : {})
  };
}

function mergeMetadata(primary: GamingResourceMetadata | undefined, fallback: GamingResourceMetadata): GamingResourceMetadata {
  return {
    title: primary?.title ?? fallback.title,
    description: primary?.description ?? fallback.description,
    canonicalUrl: primary?.canonicalUrl ?? fallback.canonicalUrl,
    openGraph: primary?.openGraph ?? fallback.openGraph,
    jsonLd: primary?.jsonLd,
    headings: primary?.headings ?? fallback.headings,
    embeddedState: primary?.embeddedState,
    scriptConfiguration: primary?.scriptConfiguration
  };
}

function scoreTextSignals(
  text: string,
  weight: number,
  label: string,
  scores: Record<GamingResourceType, number>,
  signals: Map<GamingResourceType, string[]>
): void {
  const normalized = text.toLowerCase();
  const add = (type: GamingResourceType, pattern: RegExp, multiplier = 1): void => {
    if (pattern.test(normalized)) {
      scores[type] += weight * multiplier;
      const list = signals.get(type) ?? [];
      if (!list.includes(label)) list.push(label);
      signals.set(type, list);
    }
  };
  add("patch_notes", /\b(?:patch(?:[- ]notes?)?|hotfix|changelog|release[- ]notes?|balance[- ]changes?)\b/u, 1.25);
  add("wiki", /(?:^|\b)(?:wiki|reference|database)(?:\b|$)/u);
  add("skill_tree", /\b(?:skill[- ]?tree|talent[- ]?(?:tree|calculator|planner)|passive[- ]?tree)\b/u, 1.35);
  add("loadout", /\b(?:loadout|weapon[- ]?setup|equipment[- ]?set|gear[- ]?set)\b/u, 1.2);
  add("character_profile", /\b(?:character[- ]?(?:profile|sheet)|armory|player[- ]?profile)\b/u, 1.2);
  add("calculator", /\b(?:calculator|optimizer|simulator|damage[- ]?calc|setup[- ]?calc)\b/u, 1.15);
  add("build_planner", /\b(?:build[- ]?(?:planner|builder)|planner|deck[- ]?builder|army[- ]?(?:builder|planner)|team[- ]?(?:builder|planner)|composition[- ]?planner)\b/u, 1.25);
  add("article", /\b(?:articles?|guides?|blogs?|walkthroughs?|how[- ]to|tips?)\b/u);
}

function detectGame(input: GamingResourceInput, metadata: GamingResourceMetadata, parsedUrl: URL | undefined): {
  game?: string;
  confidence: number;
  evidence: string[];
} {
  const gameKeys = new Set(["game", "gamename", "titleid"]);
  for (const source of [metadata.embeddedState, metadata.jsonLd]) {
    const candidate = collectObjectStrings(source, gameKeys)[0];
    if (candidate) {
      return { game: canonicalizeGamingGameName(candidate), confidence: 0.92, evidence: ["embedded_game_field"] };
    }
  }
  const queryGame = parsedUrl ? safeString(parsedUrl.searchParams.get("game"), 120) : undefined;
  if (queryGame && !BASE64_PATTERN.test(queryGame)) {
    return { game: canonicalizeGamingGameName(queryGame), confidence: 0.82, evidence: ["url_game_parameter"] };
  }
  const metadataText = [metadata.title, ...(Array.isArray(metadata.headings) ? metadata.headings : [metadata.headings])]
    .filter((value): value is string => typeof value === "string")
    .join(" | ");
  const match = metadataText.match(/^(.{2,80}?)\s+(?:build|loadout|skill|talent|character|deck|team|army|racing\s+setup)\b/iu);
  const candidate = safeString(match?.[1], 120);
  if (candidate) {
    return { game: canonicalizeGamingGameName(candidate), confidence: 0.58, evidence: ["page_metadata_prefix"] };
  }
  const promptGame = safeString(input.prompt, 240)?.match(/\b(?:for|in)\s+([a-z0-9][a-z0-9'’:.+ -]{1,80}?)(?=[?.!,;]|$)/iu)?.[1];
  const promptCandidate = safeString(promptGame, 120);
  return promptCandidate
    ? { game: canonicalizeGamingGameName(promptCandidate), confidence: 0.45, evidence: ["request_prompt_uncorroborated"] }
    : { confidence: 0, evidence: [] };
}

/** Deterministic multi-signal resource classifier; the hostname is deliberately only one signal. */
export function classifyGamingResource(input: GamingResourceInput): GamingResourceClassification {
  const prepared = prepareGamingResourceUrl(input.url);
  let parsedUrl: URL | undefined;
  try {
    parsedUrl = prepared ? new URL(prepared.privateFetchUrl) : undefined;
  } catch {
    parsedUrl = undefined;
  }
  const metadata = mergeMetadata(input.metadata, input.metadata ? {} : metadataFromHtml(input.html));
  const resourceTypes: GamingResourceType[] = [
    "article", "patch_notes", "wiki", "build_planner", "loadout", "skill_tree", "character_profile", "calculator", "unknown"
  ];
  const scores = Object.fromEntries(resourceTypes.map((type) => [type, 0])) as Record<GamingResourceType, number>;
  const signals = new Map<GamingResourceType, string[]>();
  if (parsedUrl) {
    scoreTextSignals(parsedUrl.hostname.replace(/[._-]+/gu, " "), 0.12, "domain", scores, signals);
    scoreTextSignals(parsedUrl.pathname.replace(/[\/_-]+/gu, " "), 0.28, "url_path", scores, signals);
    scoreTextSignals(Array.from(parsedUrl.searchParams.keys()).join(" "), 0.28, "query_keys", scores, signals);
    scoreTextSignals(parsedUrl.hash.replace(/[=&#/_-]+/gu, " "), 0.2, "fragment", scores, signals);
    if (
      Array.from(parsedUrl.searchParams.keys()).some((key) => URL_PAYLOAD_KEY_PATTERN.test(key))
      || (parsedUrl.hash.length > 2 && /(?:=|\{|%7b|[a-z0-9_-]{16})/iu.test(parsedUrl.hash))
    ) {
      const hintedType = (["skill_tree", "loadout", "character_profile", "calculator", "build_planner"] as const)
        .map((type) => ({ type, score: scores[type] }))
        .sort((left, right) => right.score - left.score || left.type.localeCompare(right.type))[0];
      const payloadType = hintedType && hintedType.score > 0 ? hintedType.type : "build_planner";
      scores[payloadType] += 0.3;
      signals.set(payloadType, [...(signals.get(payloadType) ?? []), "encoded_url_payload"]);
    }
  }
  const titleAndDescription = [metadata.title, metadata.description, ...Object.values(metadata.openGraph ?? {})].filter(Boolean).join(" ");
  scoreTextSignals(titleAndDescription, 0.34, "page_metadata", scores, signals);
  const headings = typeof metadata.headings === "string" ? metadata.headings : metadata.headings?.join(" ") ?? "";
  scoreTextSignals(headings, 0.22, "visible_headings", scores, signals);
  scoreTextSignals(input.text?.slice(0, 4_000) ?? "", 0.12, "visible_text", scores, signals);
  const embeddedStrings = [
    ...collectObjectStrings(metadata.jsonLd),
    ...collectObjectStrings(metadata.embeddedState),
    ...(metadata.scriptConfiguration ?? []).slice(0, LIMITS.maxScripts)
  ].join(" ");
  scoreTextSignals(embeddedStrings.slice(0, LIMITS.maxCumulativeScriptChars), 0.3, "embedded_state", scores, signals);
  const html = input.html && input.html.length <= LIMITS.maxHtmlChars ? input.html : "";
  if (/<(?:table|dl)\b|data-(?:slot|item|skill|talent)=/iu.test(html)) {
    scores.build_planner += 0.22;
    signals.set("build_planner", [...(signals.get("build_planner") ?? []), "visible_structured_html"]);
  }
  if (/application\/(?:ld\+json|json)|__NEXT_DATA__|INITIAL_STATE|PRELOADED_STATE/iu.test(html)) {
    scores.build_planner += 0.2;
    signals.set("build_planner", [...(signals.get("build_planner") ?? []), "embedded_application_state"]);
  }
  if (/application\/json/iu.test(input.contentType ?? "")) {
    scores.build_planner += 0.2;
    signals.set("build_planner", [...(signals.get("build_planner") ?? []), "json_content_type"]);
  }
  const ordered = resourceTypes
    .filter((type) => type !== "unknown")
    .map((type) => ({ type, score: scores[type] }))
    .sort((left, right) => right.score - left.score || left.type.localeCompare(right.type));
  const top = ordered[0] ?? { type: "unknown" as const, score: 0 };
  const runnerUp = ordered[1]?.score ?? 0;
  const ambiguous = top.score < 0.28 || (top.score < 0.5 && top.score - runnerUp < 0.035);
  const type: GamingResourceType = ambiguous ? "unknown" : top.type;
  const typeSignals = type === "unknown" ? [] : signals.get(type) ?? [];
  const hasUrlPayload = ["build_planner", "loadout", "skill_tree", "character_profile", "calculator"]
    .some((resourceType) => (signals.get(resourceType as GamingResourceType) ?? []).includes("encoded_url_payload"));
  const hasEmbedded = (signals.get("build_planner") ?? []).includes("embedded_application_state") || embeddedStrings.length > 0;
  const hasVisible = (signals.get("build_planner") ?? []).includes("visible_structured_html");
  const extractionStrategy: GamingExtractionStrategy = type === "article" || type === "patch_notes" || type === "wiki"
    ? "article"
    : hasUrlPayload
      ? "url_payload"
      : hasEmbedded
        ? "embedded_state"
        : hasVisible
          ? "visible_html"
          : titleAndDescription
            ? "metadata"
            : "none";
  const gameDetection = detectGame(input, metadata, parsedUrl);
  const siteName = safeString(metadata.openGraph?.["og:site_name"], 120);
  const detectedTool = siteName ?? (parsedUrl ? parsedUrl.hostname.replace(/^www\./iu, "") : undefined);
  return {
    type,
    confidence: type === "unknown" ? clampConfidence(top.score) : clampConfidence(0.2 + top.score * 0.65 + Math.max(0, top.score - runnerUp) * 0.25),
    ...(gameDetection.game ? { detectedGame: gameDetection.game } : {}),
    gameConfidence: gameDetection.confidence,
    gameEvidence: gameDetection.evidence,
    ...(detectedTool ? { detectedTool } : {}),
    extractionStrategy,
    reason: type === "unknown" ? "No resource type had enough independent bounded signals." : `Detected from ${typeSignals.slice(0, 6).join(", ") || "bounded metadata"}.`,
    signals: typeSignals.slice(0, 12)
  };
}

function failureFromInspection(inspection: StructuralInspection): GamingStructuredFailureReason {
  return inspection.issue === "too_large" || inspection.issue === "too_deep"
    ? "STRUCTURED_PAYLOAD_TOO_LARGE"
    : "STRUCTURED_PAYLOAD_MALFORMED";
}

function parseJsonCandidate(text: string, deadline: number): DecodedCandidate {
  const normalized = text.replace(/^\uFEFF/u, "").replace(/^\)\]\}',?\s*/u, "").trim();
  const decodedSize = Buffer.byteLength(normalized, "utf8");
  if (!normalized || decodedSize > LIMITS.maxDecodedBytes || Date.now() > deadline) {
    return { decodedSize, reason: "STRUCTURED_PAYLOAD_TOO_LARGE" };
  }
  try {
    const value = JSON.parse(normalized) as unknown;
    const inspection = inspectStructure(value, deadline);
    return inspection.ok
      ? { value, decodedSize }
      : { decodedSize, reason: failureFromInspection(inspection) };
  } catch {
    return { decodedSize, reason: "STRUCTURED_PAYLOAD_MALFORMED" };
  }
}

function decodeBase64(value: string): Buffer | undefined {
  const compact = value.replace(/\s+/gu, "").replace(/-/gu, "+").replace(/_/gu, "/");
  if (compact.length < 8 || compact.length > LIMITS.maxEncodedPayloadChars || !BASE64_PATTERN.test(compact)) {
    return undefined;
  }
  const padded = compact.padEnd(Math.ceil(compact.length / 4) * 4, "=");
  const estimatedBytes = Math.floor(padded.length * 3 / 4);
  if (estimatedBytes > LIMITS.maxDecodedBytes) {
    return undefined;
  }
  try {
    const decoded = Buffer.from(padded, "base64");
    return decoded.length <= LIMITS.maxDecodedBytes ? decoded : undefined;
  } catch {
    return undefined;
  }
}

function decompressBounded(buffer: Buffer): Buffer | undefined {
  const options = { maxOutputLength: LIMITS.maxDecodedBytes };
  const attempts: Array<() => Buffer> = [];
  if (buffer[0] === 0x1f && buffer[1] === 0x8b) {
    attempts.push(() => gunzipSync(buffer, options));
  } else {
    attempts.push(() => inflateSync(buffer, options), () => inflateRawSync(buffer, options));
  }
  for (const attempt of attempts) {
    try {
      const output = attempt();
      if (output.length <= LIMITS.maxDecodedBytes) return output;
    } catch {
      // Malformed compression streams degrade to the next bounded strategy.
    }
  }
  return undefined;
}

function decodePayloadCandidate(rawValue: string, deadline: number): DecodedCandidate {
  if (rawValue.length > LIMITS.maxEncodedPayloadChars) {
    return { decodedSize: 0, reason: "STRUCTURED_PAYLOAD_TOO_LARGE" };
  }
  let value = rawValue.trim();
  value = value.replace(/^(?:json|base64|b64|gzip|gz|deflate):/iu, "");
  if (/%[0-9a-f]{2}/iu.test(value) && !/%(?![0-9a-f]{2})/iu.test(value)) {
    try {
      const decodedUri = decodeURIComponent(value);
      if (decodedUri.length <= LIMITS.maxEncodedPayloadChars) value = decodedUri;
    } catch {
      return { decodedSize: 0, reason: "STRUCTURED_PAYLOAD_MALFORMED" };
    }
  }
  if (value.startsWith("{") || value.startsWith("[")) {
    return parseJsonCandidate(value, deadline);
  }
  const decoded = decodeBase64(value);
  if (!decoded) {
    return { decodedSize: 0, reason: "STRUCTURED_PAYLOAD_DECODE_FAILED" };
  }
  const plainText = decoded.toString("utf8").trim();
  if (plainText.startsWith("{") || plainText.startsWith("[")) {
    return parseJsonCandidate(plainText, deadline);
  }
  const decompressed = decompressBounded(decoded);
  if (!decompressed) {
    return { decodedSize: decoded.length, reason: "STRUCTURED_PAYLOAD_DECODE_FAILED" };
  }
  return parseJsonCandidate(decompressed.toString("utf8"), deadline);
}

function collectUrlPayloadCandidates(prepared: GamingPreparedResourceUrl): string[] {
  const parsed = new URL(prepared.privateFetchUrl);
  const candidates: string[] = [];
  const add = (value: string | null): void => {
    const normalized = value?.trim();
    if (normalized && !candidates.includes(normalized) && candidates.length < LIMITS.maxPayloadCandidates) {
      candidates.push(normalized);
    }
  };
  for (const [key, value] of parsed.searchParams.entries()) {
    if (URL_PAYLOAD_KEY_PATTERN.test(key)) add(value);
  }
  const fragment = parsed.hash.replace(/^#/u, "");
  if (fragment) {
    if (fragment.includes("=")) {
      const fragmentParams = new URLSearchParams(fragment);
      for (const [key, value] of fragmentParams.entries()) {
        if (URL_PAYLOAD_KEY_PATTERN.test(key)) add(value);
      }
    }
    add(fragment);
  }
  const segments = parsed.pathname.split("/").filter(Boolean);
  for (let index = 0; index < segments.length; index += 1) {
    const prior = segments[index - 1] ?? "";
    if (URL_PAYLOAD_KEY_PATTERN.test(prior) || BASE64ISH_PATH_PATTERN.test(segments[index])) {
      try {
        add(decodeURIComponent(segments[index]));
      } catch {
        // A malformed path segment is ignored without exposing it.
      }
    }
  }
  return candidates;
}

function extractBalancedJson(script: string): string | undefined {
  const start = script.search(/[\[{]/u);
  if (start < 0) return undefined;
  const opening = script[start];
  const closing = opening === "{" ? "}" : "]";
  let depth = 0;
  let quote = "";
  let escaped = false;
  for (let index = start; index < script.length; index += 1) {
    const character = script[index];
    if (quote) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === quote) quote = "";
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    if (character === opening) depth += 1;
    if (character === closing) {
      depth -= 1;
      if (depth === 0) return script.slice(start, index + 1);
    }
  }
  return undefined;
}

function collectEmbeddedCandidates(input: GamingResourceInput, metadata: GamingResourceMetadata, deadline: number): unknown[] {
  const output: unknown[] = [];
  const addValue = (value: unknown): void => {
    if (value === undefined || output.length >= LIMITS.maxPayloadCandidates) return;
    const inspection = inspectStructure(value, deadline);
    if (inspection.ok) output.push(value);
  };
  addValue(metadata.jsonLd);
  addValue(metadata.embeddedState);
  for (const configuration of metadata.scriptConfiguration?.slice(0, LIMITS.maxScripts) ?? []) {
    if (Date.now() > deadline || output.length >= LIMITS.maxPayloadCandidates) break;
    const boundedConfiguration = configuration.slice(0, LIMITS.maxScriptChars);
    const jsonText = boundedConfiguration.trim().startsWith("{") || boundedConfiguration.trim().startsWith("[")
      ? boundedConfiguration
      : extractBalancedJson(boundedConfiguration);
    if (!jsonText) continue;
    const parsed = parseJsonCandidate(jsonText, deadline);
    if (parsed.value !== undefined) output.push(parsed.value);
  }
  const html = input.html;
  if (!html || html.length > LIMITS.maxHtmlChars || Date.now() > deadline) return output;
  if (/application\/json/iu.test(input.contentType ?? "")) {
    const parsed = parseJsonCandidate(html, deadline);
    if (parsed.value !== undefined) output.push(parsed.value);
  }
  const $ = load(html);
  let cumulativeChars = 0;
  $("script").slice(0, LIMITS.maxScripts).each((_, element) => {
    if (Date.now() > deadline || output.length >= LIMITS.maxPayloadCandidates) return false;
    const script = $(element).html()?.trim() ?? "";
    if (!script || script.length > LIMITS.maxScriptChars) return;
    cumulativeChars += script.length;
    if (cumulativeChars > LIMITS.maxCumulativeScriptChars) return false;
    const type = ($(element).attr("type") ?? "").toLowerCase();
    const id = ($(element).attr("id") ?? "").toLowerCase();
    let jsonText: string | undefined;
    if (type === "application/ld+json" || type === "application/json" || id === "__next_data__") {
      jsonText = script;
    } else if (/__NEXT_DATA__|INITIAL_STATE|PRELOADED_STATE|initialState|pageProps|build|loadout/iu.test(script.slice(0, 1_000))) {
      jsonText = extractBalancedJson(script);
    }
    if (!jsonText) return;
    const parsed = parseJsonCandidate(jsonText, deadline);
    if (parsed.value !== undefined) output.push(parsed.value);
  });
  return output;
}

function visibleHtmlCandidate(input: GamingResourceInput, deadline = Number.POSITIVE_INFINITY): unknown | undefined {
  const html = input.html;
  if (!html || html.length > LIMITS.maxHtmlChars || Date.now() > deadline) return undefined;
  const $ = load(html);
  if (Date.now() > deadline) return undefined;
  const record: PlainRecord = Object.create(null) as PlainRecord;
  const equipment: unknown[] = [];
  const skills: unknown[] = [];
  const stats: PlainRecord = Object.create(null) as PlainRecord;
  $("[data-slot], [data-item]").slice(0, LIMITS.maxEquipmentEntries).each((_, element) => {
    const name = safeString($(element).attr("data-item") ?? $(element).find("[data-name], .name, .item-name").first().text() ?? $(element).text(), 240);
    if (!name) return;
    const item: PlainRecord = Object.create(null) as PlainRecord;
    item.name = name;
    const slot = safeString($(element).attr("data-slot"), 120);
    if (slot) item.slot = slot;
    equipment.push(item);
  });
  $("[data-skill], [data-talent]").slice(0, LIMITS.maxSkillEntries).each((_, element) => {
    const name = safeString($(element).attr("data-skill") ?? $(element).attr("data-talent") ?? $(element).text(), 240);
    if (name) skills.push(name);
  });
  $("dt").slice(0, LIMITS.maxTableRows).each((_, element) => {
    const key = safeString($(element).text(), 120);
    const value = safeString($(element).next("dd").first().text(), 500);
    if (key && value && !DANGEROUS_KEYS.has(key.toLowerCase())) record[key] = value;
  });
  $("table").slice(0, 16).each((_, table) => {
    const rows = $(table).find("tr").slice(0, LIMITS.maxTableRows).toArray();
    const headers = $(rows[0]).find("th").slice(0, LIMITS.maxTableCellsPerRow).map((__, cell) => safeString($(cell).text(), 80)?.toLowerCase()).get();
    for (const row of rows.slice(headers.length > 0 ? 1 : 0)) {
      const cells = $(row).find("th, td").slice(0, LIMITS.maxTableCellsPerRow).map((__, cell) => safeString($(cell).text(), 500)).get().filter(Boolean) as string[];
      if (cells.length === 2 && headers.length === 0) {
        if (!DANGEROUS_KEYS.has(cells[0].toLowerCase())) stats[cells[0]] = cells[1];
      } else if (headers.length > 0 && cells.length > 0) {
        const rowRecord: PlainRecord = Object.create(null) as PlainRecord;
        headers.forEach((header, index) => { if (header && cells[index]) rowRecord[header] = cells[index]; });
        if (headers.some((header) => /skill|talent|ability|spell/u.test(header ?? ""))) skills.push(rowRecord);
        else if (headers.some((header) => /item|name|weapon|gear|card|unit/u.test(header ?? ""))) equipment.push(rowRecord);
      }
    }
  });
  if (equipment.length > 0) record.equipment = equipment;
  if (skills.length > 0) record.skills = skills;
  if (Object.keys(stats).length > 0) record.stats = stats;
  return Object.keys(record).length > 0 ? record : undefined;
}

function findValue(record: PlainRecord, aliases: readonly string[]): unknown {
  const wanted = new Set(aliases.map(normalizeKey));
  for (const [key, value] of ownEntries(record)) {
    if (wanted.has(normalizeKey(key))) return value;
  }
  return undefined;
}

function recordScore(record: PlainRecord): number {
  return ownEntries(record).reduce((score, [key]) => {
    const normalized = normalizeKey(key);
    if (!KNOWN_KEYS.has(normalized)) return score;
    return score + (/^(?:equipment|gear|items|loadout|skills|abilities|talents|stats|attributes|deck|cards|army|units)$/u.test(normalized) ? 4 : 1);
  }, 0);
}

function findBestBuildRecord(value: unknown): PlainRecord | undefined {
  const inspection = inspectStructure(value);
  if (!inspection.ok) return undefined;
  const stack: unknown[] = [value];
  let best: PlainRecord | undefined;
  let bestScore = 0;
  while (stack.length > 0) {
    const current = stack.pop();
    if (Array.isArray(current)) {
      stack.push(...current);
      continue;
    }
    if (!isPlainRecord(current)) continue;
    const score = recordScore(current);
    if (score > bestScore) {
      best = current;
      bestScore = score;
    }
    for (const [, nested] of ownEntries(current)) {
      if (nested && typeof nested === "object") stack.push(nested);
    }
  }
  return best;
}

function numberValue(value: unknown): number | undefined {
  const candidate = typeof value === "number"
    ? value
    : typeof value === "string" && /^-?\d+(?:\.\d+)?$/u.test(value.trim())
      ? Number(value)
      : Number.NaN;
  return Number.isFinite(candidate) && Math.abs(candidate) <= LIMITS.maxNumericValue ? candidate : undefined;
}

function stringList(value: unknown, preserveDuplicates = false): string[] | undefined {
  const output: string[] = [];
  const seen = new Set<string>();
  const values = Array.isArray(value) ? value : value === undefined || value === null ? [] : [value];
  for (const item of values.slice(0, LIMITS.maxListEntries)) {
    const raw = typeof item === "string" || typeof item === "number"
      ? String(item)
      : isPlainRecord(item)
        ? findValue(item, ["name", "label", "title", "item", "skill", "talent", "value"])
        : undefined;
    const cleaned = safeString(typeof raw === "number" ? String(raw) : raw);
    if (!cleaned || NAVIGATION_ONLY_PATTERN.test(cleaned)) continue;
    const key = cleaned.toLowerCase();
    if (preserveDuplicates || !seen.has(key)) {
      output.push(cleaned);
      seen.add(key);
    }
  }
  return output.length > 0 ? output : undefined;
}

function equipmentEntries(value: unknown, defaultCategory?: string): NormalizedGamingBuild["equipment"] {
  const output: NonNullable<NormalizedGamingBuild["equipment"]> = [];
  const push = (raw: unknown, fallbackSlot?: string): void => {
    if (output.length >= LIMITS.maxEquipmentEntries) return;
    if (typeof raw === "string") {
      const name = safeString(raw, 240);
      if (name) output.push({ ...(fallbackSlot ? { slot: fallbackSlot } : {}), name, ...(defaultCategory ? { category: defaultCategory } : {}) });
      return;
    }
    if (!isPlainRecord(raw)) return;
    const rawName = findValue(raw, ["name", "itemName", "label", "title", "item", "weapon", "card", "unit"]);
    const name = safeString(typeof rawName === "number" ? String(rawName) : rawName, 240);
    if (!name) return;
    const slot = safeString(findValue(raw, ["slot", "position", "location"]) ?? fallbackSlot, 120);
    const category = safeString(findValue(raw, ["category", "type", "kind"]) ?? defaultCategory, 120);
    const rarity = safeString(findValue(raw, ["rarity", "quality", "tier"]), 120);
    const upgrades = stringList(findValue(raw, ["upgrades", "upgrade", "enhancements"]));
    const modifications = stringList(findValue(raw, ["modifications", "mods", "attachments", "gems", "runes", "affixes", "enchantments"]));
    const quantity = numberValue(findValue(raw, ["quantity", "qty", "count", "copies", "amount"]));
    output.push({
      ...(slot ? { slot } : {}),
      name,
      ...(category ? { category } : {}),
      ...(rarity ? { rarity } : {}),
      ...(upgrades ? { upgrades } : {}),
      ...(modifications ? { modifications } : {}),
      ...(quantity !== undefined && Number.isInteger(quantity) && quantity >= 0 ? { quantity } : {})
    });
  };
  if (Array.isArray(value)) {
    value.slice(0, LIMITS.maxEquipmentEntries).forEach((item) => push(item));
  } else if (isPlainRecord(value)) {
    for (const [slot, item] of ownEntries(value).slice(0, LIMITS.maxEquipmentEntries)) {
      if (typeof item === "number") push({ name: slot, quantity: item }, undefined);
      else push(item, safeString(slot, 120));
    }
  } else {
    push(value);
  }
  const seen = new Set<string>();
  return output.filter((item) => {
    const key = `${item.slot?.toLowerCase() ?? ""}\u0000${item.name.toLowerCase()}\u0000${item.quantity ?? ""}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function skillEntries(value: unknown): NormalizedGamingBuild["skills"] {
  const output: NonNullable<NormalizedGamingBuild["skills"]> = [];
  const push = (raw: unknown, fallbackName?: string): void => {
    if (output.length >= LIMITS.maxSkillEntries) return;
    if (typeof raw === "string") {
      const name = safeString(raw, 240);
      if (name) output.push({ name });
      return;
    }
    if (!isPlainRecord(raw)) return;
    const name = safeString(findValue(raw, ["name", "skillName", "label", "title", "skill", "ability", "spell", "talent"]) ?? fallbackName, 240);
    if (!name) return;
    const rank = numberValue(findValue(raw, ["rank", "level", "points", "value"]));
    const category = safeString(findValue(raw, ["category", "type", "tree", "group"]), 120);
    const modifiers = stringList(findValue(raw, ["modifiers", "mods", "upgrades", "runes", "nodes"]));
    output.push({
      name,
      ...(rank !== undefined && Number.isInteger(rank) && rank >= 0 ? { rank } : {}),
      ...(category ? { category } : {}),
      ...(modifiers ? { modifiers } : {})
    });
  };
  if (Array.isArray(value)) value.slice(0, LIMITS.maxSkillEntries).forEach((item) => push(item));
  else if (isPlainRecord(value)) ownEntries(value).slice(0, LIMITS.maxSkillEntries).forEach(([name, item]) => {
    if (typeof item === "number") push({ name, rank: item });
    else push(item, name);
  });
  else push(value);
  const seen = new Set<string>();
  return output.filter((skill) => {
    const key = `${skill.name.toLowerCase()}\u0000${skill.rank ?? ""}\u0000${skill.category?.toLowerCase() ?? ""}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function statEntries(value: unknown): Record<string, string | number> | undefined {
  const output: Record<string, string | number> = {};
  const add = (rawKey: unknown, rawValue: unknown): void => {
    if (Object.keys(output).length >= LIMITS.maxStatEntries) return;
    const key = safeString(rawKey, 120);
    if (!key || DANGEROUS_KEYS.has(key.toLowerCase()) || NAVIGATION_ONLY_PATTERN.test(key)) return;
    const numeric = numberValue(rawValue);
    if (numeric !== undefined) {
      output[key] = numeric;
      return;
    }
    const string = safeString(rawValue, 240);
    if (string) output[key] = string;
  };
  if (Array.isArray(value)) {
    for (const item of value.slice(0, LIMITS.maxStatEntries)) {
      if (!isPlainRecord(item)) continue;
      add(findValue(item, ["name", "stat", "key", "label"]), findValue(item, ["value", "amount", "score", "rating"]));
    }
  } else if (isPlainRecord(value)) {
    for (const [key, nested] of ownEntries(value).slice(0, LIMITS.maxStatEntries)) {
      if (isPlainRecord(nested)) {
        for (const [childKey, childValue] of ownEntries(nested).slice(0, LIMITS.maxStatEntries - Object.keys(output).length)) {
          add(`${key}.${childKey}`, childValue);
        }
      } else add(key, nested);
    }
  }
  return Object.keys(output).length > 0 ? output : undefined;
}

function normalizeBuildCandidate(params: {
  value: unknown;
  metadata: GamingResourceMetadata;
  publicUrl: string;
  resourceType: GamingResourceType;
  extractor: string;
  confidence: number;
}): NormalizedGamingBuild | null {
  const record = findBestBuildRecord(params.value);
  const metadataTitle = safeString(params.metadata.title ?? params.metadata.openGraph?.["og:title"], 240);
  const metadataDescription = safeString(params.metadata.description ?? params.metadata.openGraph?.["og:description"]);
  if (!record && !metadataTitle && !metadataDescription) return null;
  const root = record ?? (Object.create(null) as PlainRecord);
  const game = safeString(findValue(root, ["game", "gameName"]), 120);
  const title = safeString(findValue(root, ["buildName", "title", "name"]), 240) ?? metadataTitle;
  const role = safeString(findValue(root, ["role", "position", "job"]), 120);
  const archetype = safeString(findValue(root, ["archetype", "buildType", "style"]), 120);
  const activity = safeString(findValue(root, ["activity", "mode", "content", "scenario"]), 120);
  const patch = safeString(findValue(root, ["patch", "version", "season"]), 120);
  const characterRaw = findValue(root, ["character", "avatar", "hero", "champion"]);
  const characterRecord = isPlainRecord(characterRaw) ? characterRaw : root;
  const characterClass = safeString(findValue(characterRecord, ["class", "className", "profession"]), 120);
  const subclass = safeString(findValue(characterRecord, ["subclass", "subClass", "advancedClass"]), 120);
  const specialization = safeString(findValue(characterRecord, ["specialization", "spec", "discipline"]), 120);
  const level = numberValue(findValue(characterRecord, ["level", "characterLevel"]));
  const character = characterClass || subclass || specialization || (level !== undefined && Number.isInteger(level) && level >= 0)
    ? {
        ...(characterClass ? { class: characterClass } : {}),
        ...(subclass ? { subclass } : {}),
        ...(specialization ? { specialization } : {}),
        ...(level !== undefined && Number.isInteger(level) && level >= 0 ? { level } : {})
      }
    : undefined;
  const equipment: NonNullable<NormalizedGamingBuild["equipment"]> = [];
  const equipmentSources: Array<[readonly string[], string | undefined]> = [
    [["equipment", "gear", "items", "loadout"], undefined],
    [["weapons"], "weapon"], [["armor"], "armor"], [["deck", "cards"], "card"],
    [["army", "units", "roster"], "unit"]
  ];
  for (const [aliases, category] of equipmentSources) {
    equipment.push(...(equipmentEntries(findValue(root, aliases), category) ?? []));
    if (equipment.length >= LIMITS.maxEquipmentEntries) break;
  }
  const skills: NonNullable<NormalizedGamingBuild["skills"]> = [];
  for (const aliases of [["skills", "abilities", "spells"], ["skillTree", "nodes"]] as const) {
    skills.push(...(skillEntries(findValue(root, aliases)) ?? []));
  }
  const stats = statEntries(findValue(root, ["stats", "attributes", "ratings", "setup", "settings", "tuning"]));
  const talents = stringList(findValue(root, ["talents", "talentChoices"]));
  const perks = stringList(findValue(root, ["perks"]));
  const traits = stringList(findValue(root, ["traits"]));
  const rotation = stringList(findValue(root, ["rotation", "sequence", "priority"]), true);
  const consumables = stringList(findValue(root, ["consumables", "potions", "food"]));
  const companions = stringList(findValue(root, ["companions", "team", "party", "members", "heroes", "champions"]));
  const utility = stringList(findValue(root, ["utility", "tools", "support"]));
  const strengths = stringList(findValue(root, ["strengths", "pros", "advantages"]));
  const weaknesses = stringList(findValue(root, ["weaknesses", "cons", "disadvantages"]));
  const constraints = stringList(findValue(root, ["constraints", "requirements", "limitations"]));
  const notes = stringList(findValue(root, ["notes", "description", "summary"])) ?? (metadataDescription ? [metadataDescription] : undefined);
  return {
    ...(game ? { game: canonicalizeGamingGameName(game) } : {}),
    ...(title ? { title } : {}),
    ...(role ? { role } : {}),
    ...(archetype ? { archetype } : {}),
    ...(activity ? { activity } : {}),
    ...(patch ? { patch } : {}),
    ...(character ? { character } : {}),
    ...(equipment.length > 0 ? { equipment: equipment.slice(0, LIMITS.maxEquipmentEntries) } : {}),
    ...(skills.length > 0 ? { skills: skills.slice(0, LIMITS.maxSkillEntries) } : {}),
    ...(stats ? { stats } : {}),
    ...(rotation ? { rotation } : {}),
    ...(talents ? { talents } : {}),
    ...(perks ? { perks } : {}),
    ...(traits ? { traits } : {}),
    ...(consumables ? { consumables } : {}),
    ...(companions ? { companions } : {}),
    ...(utility ? { utility } : {}),
    ...(strengths ? { strengths } : {}),
    ...(weaknesses ? { weaknesses } : {}),
    ...(constraints ? { constraints } : {}),
    ...(notes ? { notes } : {}),
    source: {
      url: params.publicUrl,
      resourceType: params.resourceType,
      extractor: safeIdentifier(params.extractor, 128),
      confidence: clampConfidence(params.confidence)
    }
  };
}

function canonicalGameKey(value: string): string {
  return canonicalizeGamingGameName(value).toLowerCase().replace(/[^a-z0-9]+/gu, " ").trim();
}

function countBuildFields(build: NormalizedGamingBuild): number {
  const inspection = inspectStructure(build);
  const sourceFields = 4;
  return Math.max(0, inspection.fieldCount - sourceFields);
}

function buildCategoryCount(build: NormalizedGamingBuild): number {
  return [
    build.character && Object.keys(build.character).length > 0,
    Boolean(build.equipment?.length),
    Boolean(build.skills?.length),
    Boolean(build.stats && Object.keys(build.stats).length),
    Boolean(build.rotation?.length),
    Boolean(build.talents?.length || build.perks?.length || build.traits?.length),
    Boolean(build.consumables?.length || build.companions?.length || build.utility?.length),
    Boolean(build.strengths?.length || build.weaknesses?.length || build.constraints?.length),
    Boolean(build.role || build.archetype || build.activity)
  ].filter(Boolean).length;
}

function exclusiveDuplicateSlot(build: NormalizedGamingBuild): boolean {
  const repeatedAllowed = /^(?:accessory|card|companion|hardpoint|high|implant|low|mid|module|ring|trinket|unit|weapon)s?(?:\s*\d+)?$/iu;
  const slots = new Set<string>();
  for (const item of build.equipment ?? []) {
    const slot = item.slot?.trim().toLowerCase();
    if (!slot || repeatedAllowed.test(slot)) continue;
    if (slots.has(slot)) return true;
    slots.add(slot);
  }
  return false;
}

export function validateNormalizedGamingBuild(
  build: NormalizedGamingBuild,
  options: string | { requestedGame?: string; detectedGame?: string } = {}
): GamingBuildValidationResult {
  const normalizedOptions = typeof options === "string" ? { requestedGame: options } : options;
  const issues: string[] = [];
  const inspection = inspectStructure(build);
  if (!inspection.ok) issues.push(inspection.issue === "unsafe_key" ? "UNSAFE_OBJECT_KEY" : "STRUCTURAL_BOUNDS_FAILED");
  const schemaResult = NormalizedGamingBuildSchema.safeParse(build);
  if (!schemaResult.success) issues.push("NORMALIZED_SCHEMA_INVALID");
  if (exclusiveDuplicateSlot(build)) issues.push("DUPLICATE_EXCLUSIVE_EQUIPMENT_SLOT");
  const requestedGame = safeString(normalizedOptions.requestedGame, 120);
  if (requestedGame && build.game && canonicalGameKey(requestedGame) !== canonicalGameKey(build.game)) {
    issues.push("REQUESTED_GAME_MISMATCH");
  }
  if (
    normalizedOptions.detectedGame
    && build.game
    && canonicalGameKey(normalizedOptions.detectedGame) !== canonicalGameKey(build.game)
  ) {
    issues.push("RESOURCE_GAME_METADATA_MISMATCH");
  }
  const equipmentCount = build.equipment?.length ?? 0;
  const skillCount = build.skills?.length ?? 0;
  const statCount = Object.keys(build.stats ?? {}).length;
  const usefulFieldCount = countBuildFields(build);
  const categoryCount = buildCategoryCount(build);
  const hasCoreData = equipmentCount > 0 || skillCount > 0 || statCount > 0 || categoryCount > 0;
  let quality: GamingExtractionQuality;
  if (categoryCount >= 4 && usefulFieldCount >= 12) quality = "complete";
  else if (categoryCount >= 2 && usefulFieldCount >= 6) quality = "substantial";
  else if (hasCoreData && usefulFieldCount >= 2) quality = "partial";
  else if (build.title || build.game || build.patch || build.notes?.length) quality = "metadata-only";
  else quality = "unusable";
  const gameMismatch = issues.includes("REQUESTED_GAME_MISMATCH") || issues.includes("RESOURCE_GAME_METADATA_MISMATCH");
  const hardInvalid = issues.some((issue) => issue !== "RESOURCE_GAME_METADATA_MISMATCH") || gameMismatch;
  const accepted = !hardInvalid && quality !== "unusable";
  const failureReason: GamingStructuredFailureReason | undefined = gameMismatch
    ? "STRUCTURED_RESOURCE_GAME_MISMATCH"
    : quality === "partial"
      ? "STRUCTURED_RESOURCE_PARTIAL"
      : quality === "metadata-only"
        ? "STRUCTURED_RESOURCE_METADATA_ONLY"
        : quality === "unusable" || hardInvalid
          ? "STRUCTURED_PAYLOAD_MALFORMED"
          : undefined;
  return {
    accepted,
    quality,
    normalizedFieldCount: inspection.fieldCount,
    usefulFieldCount,
    categoryCount,
    equipmentCount,
    skillCount,
    statCount,
    issues,
    ...(failureReason ? { failureReason } : {})
  };
}

function listLine(label: string, values: readonly string[] | undefined, limit = 20): string | undefined {
  return values?.length ? `${label}: ${values.slice(0, limit).join(", ")}.` : undefined;
}

export function formatGamingBuildEvidence(build: NormalizedGamingBuild, quality: GamingExtractionQuality): string {
  const equipment = (build.equipment ?? []).slice(0, 32).map((item) => {
    const detail = [item.slot, item.name, item.quantity && item.quantity !== 1 ? `x${item.quantity}` : undefined].filter(Boolean).join(": ");
    const extras = [...(item.upgrades ?? []), ...(item.modifications ?? [])].slice(0, 8);
    return extras.length > 0 ? `${detail} (${extras.join(", ")})` : detail;
  });
  const skills = (build.skills ?? []).slice(0, 40).map((skill) => `${skill.name}${skill.rank !== undefined ? ` rank ${skill.rank}` : ""}`);
  const stats = Object.entries(build.stats ?? {}).slice(0, 40).map(([name, value]) => `${name}: ${String(value)}`);
  const character = build.character
    ? [build.character.class, build.character.subclass, build.character.specialization, build.character.level !== undefined ? `level ${build.character.level}` : undefined].filter(Boolean).join(" / ")
    : undefined;
  const lines = [
    "[STRUCTURED BUILD EVIDENCE - EXTRACTED FACTS ONLY]",
    `Resource type: ${build.source.resourceType}. Extraction quality: ${quality}.`,
    "Unknown fields remain unavailable; no missing item, skill, module, or stat is extracted. Inferred role or synergy must be labeled separately. Recommendations must be labeled separately.",
    build.game ? `Game: ${build.game}.` : "Game: unavailable or uncertain.",
    build.title ? `Build title: ${build.title}.` : undefined,
    character ? `Character: ${character}.` : undefined,
    build.role ? `Role: ${build.role}.` : undefined,
    build.archetype ? `Archetype: ${build.archetype}.` : undefined,
    build.activity ? `Activity: ${build.activity}.` : undefined,
    build.patch ? `Patch/version: ${build.patch}.` : undefined,
    listLine(`Equipment (${build.equipment?.length ?? 0})`, equipment, 32),
    listLine(`Skills (${build.skills?.length ?? 0})`, skills, 40),
    listLine(`Stats (${Object.keys(build.stats ?? {}).length})`, stats, 40),
    listLine("Rotation", build.rotation),
    listLine("Talents", build.talents),
    listLine("Perks", build.perks),
    listLine("Traits", build.traits),
    listLine("Consumables", build.consumables),
    listLine("Companions/team", build.companions),
    listLine("Utility", build.utility),
    listLine("Source-stated strengths", build.strengths),
    listLine("Source-stated weaknesses", build.weaknesses),
    listLine("Constraints", build.constraints),
    listLine("Notes", build.notes)
  ].filter((value): value is string => Boolean(value));
  return lines.join("\n").slice(0, LIMITS.maxEvidenceChars);
}

function publicSnippetFor(build: NormalizedGamingBuild | null, quality: GamingExtractionQuality, structuredDetected: boolean): string {
  if (!build) {
    return structuredDetected
      ? "Structured build resource detected, but the loadout data could not be decoded safely."
      : "Resource metadata was inspected, but no structured build data was recovered.";
  }
  if (quality === "metadata-only") {
    return "Structured build resource detected, but only bounded metadata could be recovered.";
  }
  const upgrades = (build.equipment ?? []).reduce((total, item) => total + (item.upgrades?.length ?? 0) + (item.modifications?.length ?? 0), 0);
  return `Structured build resource detected: ${build.equipment?.length ?? 0} equipment entries, ${upgrades} upgrades or modifications, ${build.skills?.length ?? 0} skills, and ${Object.keys(build.stats ?? {}).length} extracted stats. Extraction quality: ${quality}.`
    .slice(0, LIMITS.maxPublicSnippetChars);
}

function emptyValidation(failureReason: GamingStructuredFailureReason): GamingBuildValidationResult {
  return {
    accepted: false,
    quality: "unusable",
    normalizedFieldCount: 0,
    usefulFieldCount: 0,
    categoryCount: 0,
    equipmentCount: 0,
    skillCount: 0,
    statCount: 0,
    issues: [],
    failureReason
  };
}

function cacheKey(
  prepared: GamingPreparedResourceUrl,
  adapterId: string,
  adapterVersion: string,
  sourcePayloadHash = prepared.payloadHash
): string {
  return sha256(JSON.stringify({
    url: prepared.canonicalPublicUrl,
    payloadHash: sourcePayloadHash,
    adapterId,
    adapterVersion,
    schemaVersion: GAMING_BUILD_RESOURCE_SCHEMA_VERSION
  }));
}

function hashBoundedStructuredValue(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  const inspection = inspectStructure(value);
  if (!inspection.ok) return `invalid-structured-value:${inspection.issue ?? "unknown"}`;
  try {
    return sha256(JSON.stringify(value));
  } catch {
    return "invalid-structured-value:serialization";
  }
}

function buildSourcePayloadHash(
  prepared: GamingPreparedResourceUrl,
  input: GamingResourceInput,
  metadata: GamingResourceMetadata
): string {
  const parts = [prepared.payloadHash];
  const safeOpenGraph: Record<string, string> = {};
  if (isPlainRecord(metadata.openGraph)) {
    for (const [key, value] of ownEntries(metadata.openGraph).slice(0, 32)) {
      const safeKey = safeString(key, 80);
      const safeValue = safeString(value, 240);
      if (safeKey && safeValue && !DANGEROUS_KEYS.has(safeKey.toLowerCase())) {
        safeOpenGraph[safeKey] = safeValue;
      }
    }
  }
  if (input.html && input.html.length <= LIMITS.maxHtmlChars) {
    parts.push(sha256(input.html));
  } else if (input.html) {
    parts.push(`oversized-html:${input.html.length}`);
  }
  if (input.text) {
    parts.push(sha256(input.text.slice(0, LIMITS.maxStringLength)));
  }
  parts.push(sha256(JSON.stringify({
    title: safeString(metadata.title, 240),
    description: safeString(metadata.description, 500),
    headings: Array.isArray(metadata.headings)
      ? metadata.headings.slice(0, 24).map((heading) => safeString(heading, 240))
      : safeString(metadata.headings, 240),
    openGraph: safeOpenGraph
  })));
  for (const structuredValue of [metadata.jsonLd, metadata.embeddedState]) {
    const structuredHash = hashBoundedStructuredValue(structuredValue);
    if (structuredHash) parts.push(structuredHash);
  }
  if (metadata.scriptConfiguration?.length) {
    parts.push(sha256(metadata.scriptConfiguration
      .slice(0, LIMITS.maxScripts)
      .map((configuration) => configuration.slice(0, LIMITS.maxScriptChars))
      .join("\n")));
  }
  return sha256(parts.join("\n"));
}

export function buildGamingBuildResourceCacheKey(
  prepared: GamingPreparedResourceUrl,
  adapterId = GENERIC_ADAPTER_ID,
  adapterVersion = GENERIC_ADAPTER_VERSION
): string {
  return cacheKey(prepared, safeIdentifier(adapterId, LIMITS.maxAdapterIdChars), safeIdentifier(adapterVersion, LIMITS.maxAdapterVersionChars));
}

function cloneResult(result: GamingBuildResourceResult): GamingBuildResourceResult {
  return structuredClone(result);
}

export function clearGamingBuildResourceCache(): void {
  buildCache.clear();
}

export const clearGamingStructuredResourceCache = clearGamingBuildResourceCache;

export function getGamingBuildResourceCacheStats(): ReturnType<typeof buildCache.getStats> {
  return buildCache.getStats();
}

export function registerGamingBuildResourceAdapter(adapter: GamingBuildResourceAdapter): () => void {
  const id = safeIdentifier(adapter.id, LIMITS.maxAdapterIdChars);
  if (!ADAPTER_ID_PATTERN.test(id) || id === "unknown" || adapters.size >= LIMITS.maxAdapters && !adapters.has(id)) {
    throw new Error("Invalid or excessive gaming build resource adapter registration.");
  }
  adapters.set(id, adapter);
  return () => { if (adapters.get(id) === adapter) adapters.delete(id); };
}

export function unregisterGamingBuildResourceAdapter(id: string): boolean {
  return adapters.delete(safeIdentifier(id, LIMITS.maxAdapterIdChars));
}

export function clearGamingBuildResourceAdapters(): void {
  adapters.clear();
}

export function clearGamingBuildResources(): void {
  clearGamingBuildResourceAdapters();
  clearGamingBuildResourceCache();
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, signal?: AbortSignal): Promise<T | undefined> {
  if (signal?.aborted) return Promise.resolve(undefined);
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value: T | undefined): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      resolve(value);
    };
    const abort = (): void => finish(undefined);
    const timer = setTimeout(() => finish(undefined), timeoutMs);
    signal?.addEventListener("abort", abort, { once: true });
    promise.then((value) => finish(value), () => finish(undefined));
  });
}

function boundedAdapterInput(input: GamingResourceInput, prepared: GamingPreparedResourceUrl, metadata: GamingResourceMetadata): GamingResourceInput {
  const safeMetadata: GamingResourceMetadata = {
    title: safeString(metadata.title, 240),
    description: safeString(metadata.description, 500),
    canonicalUrl: prepared.publicUrl,
    openGraph: metadata.openGraph,
    ...(inspectStructure(metadata.jsonLd).ok ? { jsonLd: metadata.jsonLd } : {}),
    headings: metadata.headings,
    ...(inspectStructure(metadata.embeddedState).ok ? { embeddedState: metadata.embeddedState } : {}),
    scriptConfiguration: metadata.scriptConfiguration?.slice(0, LIMITS.maxScripts).map((value) => value.slice(0, LIMITS.maxScriptChars))
  };
  return {
    url: prepared.privateFetchUrl,
    preparedUrl: prepared,
    requestedGame: safeString(input.requestedGame, 120),
    prompt: safeString(input.prompt, 1_000),
    contentType: safeString(input.contentType, 120),
    html: input.html && input.html.length <= LIMITS.maxHtmlChars ? input.html : undefined,
    text: safeString(input.text, LIMITS.maxStringLength),
    metadata: safeMetadata,
    signal: input.signal
  };
}

async function selectAdapter(input: GamingResourceInput, candidates: readonly GamingBuildResourceAdapter[]): Promise<{
  adapter?: GamingBuildResourceAdapter;
  confidence: number;
  elapsedMs: number;
}> {
  const startedAt = Date.now();
  const scored = (await Promise.all(candidates.slice(0, LIMITS.maxAdapters).map(async (adapter) => {
    const confidence = await withTimeout(
      Promise.resolve().then(() => adapter.canHandle(input)),
      LIMITS.maxAdapterCanHandleMs,
      input.signal
    );
    return typeof confidence === "number" && Number.isFinite(confidence)
      ? { adapter, confidence: clampConfidence(confidence) }
      : undefined;
  }))).filter((entry): entry is { adapter: GamingBuildResourceAdapter; confidence: number } => Boolean(entry));
  scored.sort((left, right) => right.confidence - left.confidence || left.adapter.id.localeCompare(right.adapter.id));
  const selected = scored.find((entry) => entry.confidence >= 0.5);
  return { adapter: selected?.adapter, confidence: selected?.confidence ?? 0, elapsedMs: Date.now() - startedAt };
}

function qualityRank(quality: GamingExtractionQuality): number {
  return ({ complete: 5, substantial: 4, partial: 3, "metadata-only": 2, unusable: 1 })[quality];
}

function invalidResult(input: GamingResourceInput): GamingBuildResourceResult {
  const urlTooLarge = typeof input.url === "string" && input.url.length > LIMITS.maxUrlChars;
  const failureReason: GamingStructuredFailureReason = urlTooLarge
    ? "STRUCTURED_PAYLOAD_TOO_LARGE"
    : "STRUCTURED_RESOURCE_UNSUPPORTED";
  return {
    publicUrl: "invalid-source",
    safeDisplayUrl: "invalid-source",
    classification: {
      type: "unknown",
      confidence: 0,
      gameConfidence: 0,
      gameEvidence: [],
      extractionStrategy: "none",
      reason: "The resource URL was invalid or exceeded the bounded URL limit.",
      signals: []
    },
    build: null,
    quality: "unusable",
    validation: emptyValidation(failureReason),
    adapterId: GENERIC_ADAPTER_ID,
    adapterVersion: GENERIC_ADAPTER_VERSION,
    extractionStrategy: "none",
    evidenceText: "",
    publicSnippet: urlTooLarge
      ? "Structured build resource detected, but the loadout data could not be decoded safely."
      : "Resource metadata was inspected, but no structured build data was recovered.",
    metrics: {
      payloadLength: Math.min(typeof input.url === "string" ? input.url.length : 0, LIMITS.maxUrlChars),
      payloadHash: sha256("invalid-source"),
      decodedSize: 0,
      normalizedFieldCount: 0,
      equipmentCount: 0,
      skillCount: 0,
      statCount: 0,
      extractionElapsedMs: 0,
      adapterElapsedMs: 0
    },
    cacheHit: false,
    failureReason
  };
}

function structuredType(type: GamingResourceType): boolean {
  return type === "build_planner" || type === "loadout" || type === "skill_tree"
    || type === "character_profile" || type === "calculator";
}

function genericExtract(params: {
  input: GamingResourceInput;
  prepared: GamingPreparedResourceUrl;
  metadata: GamingResourceMetadata;
  classification: GamingResourceClassification;
  deadline: number;
}): {
  build: NormalizedGamingBuild | null;
  validation: GamingBuildValidationResult;
  state: ExtractionState;
  classification: GamingResourceClassification;
} {
  const state: ExtractionState = {
    decodedSize: 0,
    sawCandidate: false,
    sawOversized: Boolean(params.input.html && params.input.html.length > LIMITS.maxHtmlChars),
    sawMalformed: false,
    strategy: "none"
  };
  const candidates: Array<{ value: unknown; strategy: GamingExtractionStrategy; confidence: number }> = [];
  for (const rawPayload of collectUrlPayloadCandidates(params.prepared)) {
    if (Date.now() > params.deadline) {
      state.sawOversized = true;
      break;
    }
    state.sawCandidate = true;
    const decoded = decodePayloadCandidate(rawPayload, params.deadline);
    state.decodedSize = Math.max(state.decodedSize, decoded.decodedSize);
    if (decoded.value !== undefined) candidates.push({ value: decoded.value, strategy: "url_payload", confidence: 0.9 });
    else if (decoded.reason === "STRUCTURED_PAYLOAD_TOO_LARGE") state.sawOversized = true;
    else state.sawMalformed = true;
  }
  for (const value of collectEmbeddedCandidates(params.input, params.metadata, params.deadline)) {
    state.sawCandidate = true;
    candidates.push({ value, strategy: "embedded_state", confidence: 0.82 });
  }
  const visible = visibleHtmlCandidate(params.input, params.deadline);
  if (visible !== undefined) {
    state.sawCandidate = true;
    candidates.push({ value: visible, strategy: "visible_html", confidence: 0.72 });
  }
  let bestBuild: NormalizedGamingBuild | null = null;
  let bestValidation = emptyValidation("STRUCTURED_RESOURCE_UNSUPPORTED");
  let bestStrategy: GamingExtractionStrategy = "none";
  let effectiveClassification = params.classification;
  for (const candidate of candidates.slice(0, LIMITS.maxPayloadCandidates)) {
    if (Date.now() > params.deadline) {
      state.sawOversized = true;
      break;
    }
    const effectiveType = structuredType(params.classification.type) ? params.classification.type : "build_planner";
    const normalized = normalizeBuildCandidate({
      value: candidate.value,
      metadata: params.metadata,
      publicUrl: params.prepared.publicUrl,
      resourceType: effectiveType,
      extractor: `generic-${candidate.strategy}`,
      confidence: Math.max(params.classification.confidence, candidate.confidence)
    });
    if (!normalized) continue;
    const validation = validateNormalizedGamingBuild(normalized, {
      requestedGame: params.input.requestedGame,
      detectedGame: params.classification.gameConfidence >= 0.8 ? params.classification.detectedGame : undefined
    });
    if (qualityRank(validation.quality) > qualityRank(bestValidation.quality)) {
      bestBuild = normalized;
      bestValidation = validation;
      bestStrategy = candidate.strategy;
    }
  }
  if (!bestBuild && structuredType(params.classification.type)) {
    const metadataBuild = normalizeBuildCandidate({
      value: Object.create(null),
      metadata: params.metadata,
      publicUrl: params.prepared.publicUrl,
      resourceType: params.classification.type,
      extractor: "generic-metadata",
      confidence: params.classification.confidence
    });
    if (metadataBuild) {
      bestBuild = metadataBuild;
      bestValidation = validateNormalizedGamingBuild(metadataBuild, { requestedGame: params.input.requestedGame });
      bestStrategy = "metadata";
    }
  }
  if (bestBuild && params.classification.type === "unknown") {
    effectiveClassification = {
      ...params.classification,
      type: bestBuild.source.resourceType,
      confidence: Math.max(0.6, params.classification.confidence),
      extractionStrategy: bestStrategy,
      reason: "A bounded generic extraction strategy recovered normalized build fields.",
      signals: Array.from(new Set([...params.classification.signals, `generic_${bestStrategy}`])).slice(0, 12)
    };
  }
  state.strategy = bestStrategy;
  return { build: bestBuild, validation: bestValidation, state, classification: effectiveClassification };
}

/**
 * Classify, extract, normalize, validate, and cache one already supplied resource.
 * This function performs no network I/O; callers retain ownership of SSRF-safe fetching.
 */
export async function ingestGamingBuildResource(
  input: GamingResourceInput,
  options: GamingBuildResourceOptions = {}
): Promise<GamingBuildResourceResult> {
  const startedAt = Date.now();
  const deadline = startedAt + LIMITS.maxExtractionMs;
  const prepared = prepareGamingResourceUrl(input.url);
  if (!prepared) return invalidResult(input);
  const metadata = mergeMetadata(input.metadata, metadataFromHtml(input.html, deadline));
  let classification = classifyGamingResource({ ...input, preparedUrl: prepared, metadata });
  const adapterInput = boundedAdapterInput(input, prepared, metadata);
  const registered = options.adapters
    ? [...options.adapters, ...adapters.values()]
    : Array.from(adapters.values());
  const dedupedAdapters = Array.from(new Map(registered.map((adapter) => [safeIdentifier(adapter.id, LIMITS.maxAdapterIdChars), adapter])).values());
  const adapterSelection = await selectAdapter(adapterInput, dedupedAdapters);
  const adapterId = adapterSelection.adapter ? safeIdentifier(adapterSelection.adapter.id, LIMITS.maxAdapterIdChars) : GENERIC_ADAPTER_ID;
  const adapterVersion = adapterSelection.adapter
    ? safeIdentifier(adapterSelection.adapter.version ?? "unversioned", LIMITS.maxAdapterVersionChars)
    : GENERIC_ADAPTER_VERSION;
  const sourcePayloadHash = buildSourcePayloadHash(prepared, input, metadata);
  const requestedGame = safeString(input.requestedGame, 120);
  const safePrompt = safeString(input.prompt, 1_000);
  const requestScopeHash = sha256(JSON.stringify({
    requestedGame: requestedGame ? canonicalGameKey(requestedGame) : null,
    promptHash: safePrompt ? sha256(safePrompt) : null
  }));
  const key = cacheKey(
    prepared,
    adapterId,
    adapterVersion,
    sha256(`${sourcePayloadHash}\n${requestScopeHash}`)
  );
  if (options.useCache !== false) {
    const cached = buildCache.get(key);
    if (cached) return { ...cloneResult(cached), cacheHit: true };
  }
  let build: NormalizedGamingBuild | null = null;
  let validation = emptyValidation("STRUCTURED_RESOURCE_UNSUPPORTED");
  let extractionStrategy: GamingExtractionStrategy = "none";
  let decodedSize = 0;
  let adapterElapsedMs = adapterSelection.elapsedMs;
  let genericState: ExtractionState | undefined;
  if (adapterSelection.adapter) {
    const adapterStartedAt = Date.now();
    const extracted = await withTimeout(
      Promise.resolve().then(() => adapterSelection.adapter!.extract(adapterInput)),
      LIMITS.maxAdapterExtractMs,
      input.signal
    );
    adapterElapsedMs += Date.now() - adapterStartedAt;
    if (extracted) {
      const inspection = inspectStructure(extracted, Date.now() + LIMITS.maxExtractionMs);
      if (inspection.ok) {
        build = normalizeBuildCandidate({
          value: extracted,
          metadata,
          publicUrl: prepared.publicUrl,
          resourceType: structuredType(classification.type) ? classification.type : extracted.source?.resourceType ?? "build_planner",
          extractor: adapterId,
          confidence: Math.max(classification.confidence, adapterSelection.confidence)
        });
        if (build) {
          validation = validateNormalizedGamingBuild(build, {
            requestedGame: input.requestedGame,
            detectedGame: classification.gameConfidence >= 0.8 ? classification.detectedGame : undefined
          });
          extractionStrategy = "adapter";
        }
      }
    }
  }
  if (!build || !validation.accepted) {
    const generic = genericExtract({ input, prepared, metadata, classification, deadline });
    genericState = generic.state;
    decodedSize = generic.state.decodedSize;
    if (!build || qualityRank(generic.validation.quality) >= qualityRank(validation.quality)) {
      build = generic.build;
      validation = generic.validation;
      extractionStrategy = generic.state.strategy;
      classification = generic.classification;
    }
  }
  if (build?.game) {
    classification = {
      ...classification,
      detectedGame: build.game,
      gameConfidence: Math.max(classification.gameConfidence, 0.96),
      gameEvidence: Array.from(new Set([...classification.gameEvidence, "normalized_payload_game"]))
    };
  }
  if (build?.title && metadata.title) {
    const payloadTitleTokens = new Set(build.title.toLowerCase().match(/[a-z0-9]+/gu) ?? []);
    const metadataTitleTokens = (metadata.title.toLowerCase().match(/[a-z0-9]+/gu) ?? [])
      .filter((token) => token.length >= 4 && !["build", "planner", "loadout", "calculator"].includes(token));
    if (metadataTitleTokens.length > 0 && !metadataTitleTokens.some((token) => payloadTitleTokens.has(token))) {
      validation = {
        ...validation,
        issues: [...validation.issues, "RESOURCE_TITLE_PAYLOAD_DISAGREEMENT"]
      };
    }
  }
  if (validation.failureReason === "STRUCTURED_RESOURCE_GAME_MISMATCH") {
    build = null;
  }
  let failureReason = validation.failureReason;
  if (!build && (!failureReason || failureReason === "STRUCTURED_RESOURCE_UNSUPPORTED")) {
    failureReason = genericState?.sawOversized
      ? "STRUCTURED_PAYLOAD_TOO_LARGE"
      : genericState?.sawMalformed
        ? "STRUCTURED_PAYLOAD_DECODE_FAILED"
        : "STRUCTURED_RESOURCE_UNSUPPORTED";
    validation = { ...validation, failureReason };
  }
  const quality = build ? validation.quality : "unusable";
  const structuredDetected = structuredType(classification.type) || Boolean(genericState?.sawCandidate);
  const evidenceText = build ? formatGamingBuildEvidence(build, quality) : "";
  const result: GamingBuildResourceResult = {
    publicUrl: prepared.publicUrl,
    safeDisplayUrl: prepared.safeDisplayUrl,
    classification,
    build,
    quality,
    validation,
    adapterId,
    adapterVersion,
    extractionStrategy,
    evidenceText,
    publicSnippet: publicSnippetFor(build, quality, structuredDetected),
    metrics: {
      payloadLength: prepared.payloadLength,
      payloadHash: sourcePayloadHash,
      decodedSize,
      normalizedFieldCount: validation.normalizedFieldCount,
      equipmentCount: validation.equipmentCount,
      skillCount: validation.skillCount,
      statCount: validation.statCount,
      extractionElapsedMs: Date.now() - startedAt,
      adapterElapsedMs
    },
    cacheHit: false,
    ...(failureReason ? { failureReason } : {})
  };
  if (options.useCache !== false) {
    const ttlMs = Math.max(1, Math.min(options.cacheTtlMs ?? LIMITS.cacheTtlMs, 24 * 60 * 60_000));
    buildCache.set(key, cloneResult(result), ttlMs);
  }
  return result;
}

export const extractGamingBuildResource = ingestGamingBuildResource;
export const ingestGamingStructuredResource = ingestGamingBuildResource;
