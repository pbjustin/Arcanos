import { resolveErrorMessage } from "@core/lib/errors/index.js";
import { formatGamingSuccess, resolveGamingMode, type GamingErrorEnvelope, type GamingMode, type GamingSuccessEnvelope } from "@services/gamingModes.js";
import { isRecord } from "@shared/typeGuards.js";
import { extractTextPrompt, normalizeStringList } from "@transport/http/payloadNormalization.js";

export type GamingIntentMode = GamingMode | "non-gaming";

export type GamingSpoilerTolerance = "avoid" | "allowed" | "unknown";

export type GamingIntent = {
  mode: GamingIntentMode;
  prompt: string;
  confidence: number;
  routingSignals: string[];
  invalidMode?: string;
  game?: string;
  platform?: string;
  version?: string;
  class?: string;
  role?: string;
  difficulty?: string;
  progressPoint?: string;
  spoilerTolerance: GamingSpoilerTolerance;
  constraints: string[];
  url?: string;
  urls?: string[];
  guideUrls?: string[];
  audit?: boolean;
  hrc?: boolean;
  securityBlocked?: {
    code: "SECURITY_BLOCKED";
    reason: string;
    message: string;
  };
};

export type GamingClarificationResult =
  | { required: false }
  | {
      required: true;
      mode: GamingMode;
      missing: string[];
      question: string;
    };

export type GamingBackendActionPayload = {
  mode: GamingMode;
  prompt: string;
  game?: string;
  url?: string;
  urls?: string[];
  guideUrls?: string[];
  audit?: boolean;
  hrc?: boolean;
};

export type GamingBackendAction = {
  action: "query";
  payload: GamingBackendActionPayload;
};

export type GamingBackendConnector = (
  payload: GamingBackendActionPayload
) => Promise<GamingSuccessEnvelope | GamingErrorEnvelope>;

const KNOWN_GAMES: Array<{ pattern: RegExp; name: string }> = [
  { pattern: /\bSWTOR\b/i, name: "SWTOR" },
  { pattern: /\bStar Wars:\s*The Old Republic\b/i, name: "Star Wars: The Old Republic" },
  { pattern: /\bElden Ring\b/i, name: "Elden Ring" },
  { pattern: /\bMinecraft\b/i, name: "Minecraft" },
  { pattern: /\bDestiny 2\b/i, name: "Destiny 2" },
  { pattern: /\bDiablo\s+(?:4|IV)\b/i, name: "Diablo 4" },
  { pattern: /\bBaldur'?s Gate 3\b/i, name: "Baldur's Gate 3" },
  { pattern: /\bPath of Exile(?: 2)?\b/i, name: "Path of Exile" },
  { pattern: /\bWorld of Warcraft\b|\bWoW\b/i, name: "World of Warcraft" },
  { pattern: /\bLeague of Legends\b|\bLoL\b/i, name: "League of Legends" },
  { pattern: /\bOverwatch 2\b/i, name: "Overwatch 2" },
  { pattern: /\bFortnite\b/i, name: "Fortnite" },
];

const INFERRED_GAME_BLACKLIST = new Set([
  "pc", "ps5", "ps4", "xbox", "switch", "steam", "deck",
  "tank", "healer", "healing", "support", "dps", "damage", "solo", "duo", "carry",
  "mage", "sorcerer", "sorc", "barbarian", "rogue", "druid", "necromancer", "paladin", "warlock", "hunter", "priest", "warrior", "monk",
  "leveling", "beginner", "beginners", "veteran", "veterans", "hardcore", "casual", "casuals", "build", "loadout", "guide", "spec",
  "this", "that", "current", "latest"
]);

const GUIDE_RULES = [
  { label: "guide_help_beat", pattern: /\bhelp\s+me\s+beat\b/i, weight: 0.78 },
  { label: "guide_beat_target", pattern: /\b(?:beat|defeat|kill)\s+[A-Z]?[A-Za-z0-9' -]{2,}\b/i, weight: 0.62 },
  { label: "guide_where_find", pattern: /\bwhere\s+do\s+i\s+(?:find|get|farm)\b/i, weight: 0.72 },
  { label: "guide_how_do_i", pattern: /\bhow\s+do\s+i\b/i, weight: 0.55 },
  { label: "guide_stuck", pattern: /\bstuck\b/i, weight: 0.55 },
  { label: "guide_materials", pattern: /\b(?:upgrade\s+materials?|smithing\s+stones?|crafting\s+materials?)\b/i, weight: 0.62 },
  { label: "guide_walkthrough", pattern: /\bwalkthrough\b/i, weight: 0.66 },
  { label: "guide_objective", pattern: /\b(?:objective|quest|boss|mechanics?|route|leveling|beginner|tips?)\b/i, weight: 0.46 },
];

const BUILD_RULES = [
  { label: "build_best_build", pattern: /\bbest\b[^.!?\n]{0,36}\bbuild\b/i, weight: 0.82 },
  { label: "build_make_build", pattern: /\bmake\s+me\b[^.!?\n]{0,36}\bbuild\b/i, weight: 0.84 },
  { label: "build_explicit", pattern: /\bbuild\b/i, weight: 0.66 },
  { label: "build_loadout", pattern: /\bloadout\b/i, weight: 0.72 },
  { label: "build_skill_tree", pattern: /\b(?:skill\s*tree|talents?|perks?)\b/i, weight: 0.62 },
  { label: "build_gear", pattern: /\bgear(?:ing)?\b/i, weight: 0.52 },
  { label: "build_team_comp", pattern: /\bteam\s*comp(?:osition)?s?\b/i, weight: 0.64 },
  { label: "build_optimize", pattern: /\boptimi[sz](?:e|ation)\b/i, weight: 0.58 },
  { label: "build_rotation", pattern: /\brotation\b/i, weight: 0.50 },
];

const META_RULES = [
  { label: "meta_viable_patch", pattern: /\b(?:still\s+)?viable\b[^.!?\n]{0,32}\b(?:patch|meta|season|right\s+now)\b/i, weight: 0.84 },
  { label: "meta_is_meta", pattern: /\bis\b[^.!?\n]{0,36}\bmeta\b/i, weight: 0.82 },
  { label: "meta_changed_patch", pattern: /\bwhat\s+changed\b(?:[^.!?\n]{0,32}\b(?:patch|version|season|\d+\.\d+)\b)?/i, weight: 0.86 },
  { label: "meta_patch_number", pattern: /\b(?:patch\s*)?\d{1,2}\.\d{1,2}\b/i, weight: 0.68 },
  { label: "meta_tier_list", pattern: /\btier\s*list\b/i, weight: 0.78 },
  { label: "meta_balance", pattern: /\b(?:balance|nerf|buff)s?\b/i, weight: 0.64 },
  { label: "meta_current_state", pattern: /\b(?:current\s+(?:meta|tier|state|patch|season)|right\s+now)\b/i, weight: 0.58 },
  { label: "meta_explicit", pattern: /\bmeta\b/i, weight: 0.62 },
];

const NON_GAMING_PATTERNS = [
  /^\s*ping\s*$/i,
  /\bwrite\s+(?:a\s+)?(?:poem|email|essay|cover letter)\b/i,
  /\brecipe\b/i,
  /\btax\b/i,
  /\blegal\b/i,
  /\bmedical\b/i,
];

const BLOCKED_ACTIONS = new Set([
  "runtime.inspect",
  "workers.status",
  "queue.inspect",
  "self_heal.status",
  "system_state",
  "get_status",
  "get_result",
  "job_status",
  "job_result",
  "diagnostics",
  "root.deep_diagnostics",
  "mcp.invoke",
  "mcp.run",
  "mcp.list_tools",
  "dag.dispatch",
  "dag.status",
  "dag.trace",
  "db.explain",
  "logs.query",
]);

const CONTROL_PROMPT_PATTERNS = [
  /\b(?:show|check|inspect|list|retrieve|get|fetch)\s+(?:the\s+)?(?:runtime|workers?|worker\s+status|queue|system\s+state|diagnostics?|logs?|job\s+(?:result|status)|mcp|database|db|self[-\s]?heal)\b/i,
  /\b(?:runtime|workers?|queue|system\s+state|diagnostics?|self[-\s]?heal)\s+(?:status|health|inspection|report)\b/i,
  /\/(?:internal|gpt-access|jobs|workers\/status|system-state|mcp|queue|runtime|diagnostics?)\b/i,
  /\b(?:bearer\s+token|api\s+key|cookies?|private\s+logs?)\b/i,
];

function getStringField(payload: unknown, key: string): string | undefined {
  if (!isRecord(payload)) {
    return undefined;
  }

  const value = payload[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function getRawStringField(payload: unknown, key: string): string | undefined {
  if (!isRecord(payload)) {
    return undefined;
  }

  const value = payload[key];
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function getBooleanField(payload: unknown, key: string): boolean | undefined {
  if (!isRecord(payload)) {
    return undefined;
  }

  return typeof payload[key] === "boolean" ? payload[key] : undefined;
}

function extractPrompt(payload: unknown): string {
  return extractTextPrompt(payload, ["prompt", "message", "userInput", "text", "content", "query"]);
}

function matchesAny(prompt: string, patterns: RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(prompt));
}

function clampConfidence(value: number): number {
  return Math.max(0, Math.min(1, Number(value.toFixed(2))));
}

function scoreRules(prompt: string, rules: Array<{ label: string; pattern: RegExp; weight: number }>): { score: number; signals: string[] } {
  let score = 0;
  const signals: string[] = [];
  for (const rule of rules) {
    if (!rule.pattern.test(prompt)) {
      continue;
    }

    score += rule.weight;
    signals.push(rule.label);
  }

  return { score, signals };
}

function readNestedAction(payload: unknown): string | null {
  if (!isRecord(payload)) {
    return null;
  }

  const directAction = getStringField(payload, "action") ?? getStringField(payload, "operation");
  if (directAction) {
    return directAction.toLowerCase();
  }

  const mcpAction = isRecord(payload.mcp)
    ? getStringField(payload.mcp, "action") ?? getStringField(payload.mcp, "operation")
    : undefined;
  if (mcpAction) {
    return mcpAction.toLowerCase();
  }

  const dagAction = isRecord(payload.dag)
    ? getStringField(payload.dag, "action") ?? getStringField(payload.dag, "operation")
    : undefined;
  return dagAction ? dagAction.toLowerCase() : null;
}

function detectSecurityBlock(payload: unknown, prompt: string): GamingIntent["securityBlocked"] | undefined {
  const nestedAction = readNestedAction(payload);
  if (nestedAction && (BLOCKED_ACTIONS.has(nestedAction) || nestedAction.startsWith("dag."))) {
    return {
      code: "SECURITY_BLOCKED",
      reason: "blocked_control_action",
      message: "ARCANOS Gaming only handles writing-plane gameplay guidance."
    };
  }

  const mode = getStringField(payload, "mode")?.toLowerCase();
  if (mode === "system_state" || mode === "diagnostic" || mode === "diagnostics") {
    return {
      code: "SECURITY_BLOCKED",
      reason: "blocked_control_mode",
      message: "ARCANOS Gaming only handles writing-plane gameplay guidance."
    };
  }

  const executionMode = getStringField(payload, "executionMode")?.toLowerCase();
  const target = getStringField(payload, "target")?.toLowerCase();
  if (executionMode === "dag" || target === "dag") {
    return {
      code: "SECURITY_BLOCKED",
      reason: "blocked_dag_control_request",
      message: "ARCANOS Gaming does not run DAG, MCP, diagnostic, job, worker, queue, or runtime operations."
    };
  }

  if (matchesAny(prompt, CONTROL_PROMPT_PATTERNS)) {
    return {
      code: "SECURITY_BLOCKED",
      reason: "blocked_control_prompt",
      message: "ARCANOS Gaming does not expose internal runtime, worker, queue, job, MCP, log, database, or diagnostic operations."
    };
  }

  return undefined;
}

function scoreIntent(payload: unknown, prompt: string): { mode: GamingIntentMode; confidence: number; signals: string[] } {
  const explicitMode = resolveGamingMode(payload);
  if (explicitMode) {
    return {
      mode: explicitMode,
      confidence: 1,
      signals: [`explicit_mode_${explicitMode}`],
    };
  }

  if (!prompt) {
    return {
      mode: "non-gaming",
      confidence: 1,
      signals: ["empty_prompt"],
    };
  }

  if (matchesAny(prompt, NON_GAMING_PATTERNS)) {
    return {
      mode: "non-gaming",
      confidence: 0.92,
      signals: ["non_gaming_pattern"],
    };
  }

  const guide = scoreRules(prompt, GUIDE_RULES);
  const build = scoreRules(prompt, BUILD_RULES);
  const meta = scoreRules(prompt, META_RULES);
  const knownGame = extractKnownGame(prompt);
  if (knownGame) {
    guide.score += 0.22;
    build.score += 0.16;
    meta.score += 0.16;
    guide.signals.push("known_game");
    build.signals.push("known_game");
    meta.signals.push("known_game");
  }

  const scoredModes = [
    { mode: "guide" as const, ...guide },
    { mode: "build" as const, ...build },
    { mode: "meta" as const, ...meta },
  ].sort((left, right) => right.score - left.score);
  const best = scoredModes[0];
  const runnerUp = scoredModes[1];

  if (!best || best.score <= 0) {
    return {
      mode: "non-gaming",
      confidence: 0.56,
      signals: ["no_gaming_intent_signal"],
    };
  }

  const confidence = clampConfidence(Math.min(0.98, 0.42 + best.score / 1.5 + Math.max(0, best.score - runnerUp.score) / 1.8));
  return {
    mode: best.mode,
    confidence,
    signals: best.signals,
  };
}

function extractKnownGame(prompt: string): string | undefined {
  const match = KNOWN_GAMES.find((game) => game.pattern.test(prompt));
  return match?.name;
}

function cleanGameCandidate(candidate: string): string | undefined {
  const cleaned = candidate
    .replace(/\b(?:build|loadout|meta|guide|tips|class|team|comp|patch|season|right now)\b.*$/i, "")
    .replace(/[?.!,;:]+$/g, "")
    .trim();

  return cleaned.length > 1 ? cleaned : undefined;
}

function inferGameFromPrompt(prompt: string): string | undefined {
  const known = extractKnownGame(prompt);
  if (known) {
    return known;
  }

  const match = prompt.match(/\b(?:in|for|on)\s+([A-Za-z0-9][A-Za-z0-9'’:.+-]*(?:\s+[A-Za-z0-9][A-Za-z0-9'’:.+-]*){0,5})/i);
  if (!match?.[1]) {
    return undefined;
  }

  const candidate = cleanGameCandidate(match[1]);
  if (!candidate) {
    return undefined;
  }

  const words = candidate.toLowerCase().split(/\s+/);
  if (words.some((word) => INFERRED_GAME_BLACKLIST.has(word))) {
    return undefined;
  }

  return candidate;
}

function extractPlatform(payload: unknown, prompt: string): string | undefined {
  const explicit = getStringField(payload, "platform");
  if (explicit) {
    return explicit;
  }

  const match = prompt.match(/\b(PC|PS5|PS4|Xbox(?: Series [XS])?|Switch|Steam Deck)\b/i);
  return match?.[1];
}

function extractVersion(payload: unknown, prompt: string): string | undefined {
  const explicit = getStringField(payload, "version") ?? getStringField(payload, "patch");
  if (explicit) {
    return explicit;
  }

  if (/\bthis\s+patch\b/i.test(prompt)) {
    return "this patch";
  }

  const match = prompt.match(/\b(?:patch|version|season)\s+([A-Za-z0-9._ -]{1,32})/i) ??
    prompt.match(/\bin\s+(\d{1,2}\.\d{1,2})\b/i);
  return match?.[1]?.trim();
}

function extractClass(payload: unknown, prompt: string): string | undefined {
  const explicit = getStringField(payload, "class") ?? getStringField(payload, "className");
  if (explicit) {
    return explicit;
  }

  const knownClass = prompt.match(/\b(frost\s+mage|fire\s+mage|arcane\s+mage|lightning\s+sorc(?:erer)?|sorc(?:erer)?|barbarian|rogue|druid|necromancer|paladin|warlock|hunter|priest|warrior|monk)\b/i);
  if (knownClass?.[1]) {
    return normalizeEntityValue(knownClass[1]);
  }

  const match = prompt.match(/\b(?:as|for)\s+(?:a\s+|an\s+)?([A-Za-z][A-Za-z -]{1,32})\s+(?:build|loadout|class|spec)\b/i);
  return match?.[1] ? normalizeEntityValue(match[1]) : undefined;
}

function extractRole(payload: unknown, prompt: string): string | undefined {
  const explicit = getStringField(payload, "role");
  if (explicit) {
    return normalizeEntityValue(explicit);
  }

  const match = prompt.match(/\b(tank|healer|healing|support|dps|damage|solo|duo|carry)\b/i);
  if (!match?.[1]) {
    return undefined;
  }

  const role = match[1].toLowerCase();
  if (role === "healing") {
    return "healer";
  }
  if (role === "damage") {
    return "dps";
  }
  return role;
}

function extractDifficulty(payload: unknown, prompt: string): string | undefined {
  const explicit = getStringField(payload, "difficulty");
  if (explicit) {
    return explicit;
  }

  const match = prompt.match(/\b(story|normal|hard|heroic|veteran|master|legendary|nightmare|hardcore)\b/i);
  return match?.[1];
}

function extractProgressPoint(payload: unknown, prompt: string): string | undefined {
  const explicit =
    getStringField(payload, "progressPoint") ??
    getStringField(payload, "progress") ??
    getStringField(payload, "checkpoint");
  if (explicit) {
    return explicit;
  }

  const match = prompt.match(/\b(?:stuck\s+(?:on|at)|at|after|before)\s+([A-Za-z0-9][A-Za-z0-9'’:, -]{1,48})/i);
  if (match?.[1]) {
    return normalizeEntityValue(match[1]);
  }

  const stage = prompt.match(/\b(early\s+game|mid\s*game|late\s+game|endgame|act\s+\d+|chapter\s+\d+|new\s+game\s*\+|ng\+)\b/i);
  return stage?.[1] ? normalizeEntityValue(stage[1]) : undefined;
}

function normalizeEntityValue(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function extractSpoilerTolerance(payload: unknown, prompt: string): GamingSpoilerTolerance {
  const explicit = getStringField(payload, "spoilerTolerance")?.toLowerCase();
  if (explicit === "avoid" || explicit === "none" || explicit === "no spoilers") {
    return "avoid";
  }
  if (explicit === "allowed" || explicit === "ok" || explicit === "spoilers ok") {
    return "allowed";
  }

  if (/\b(?:no|avoid)\s+spoilers?\b/i.test(prompt)) {
    return "avoid";
  }
  if (/\bspoilers?\s+(?:ok|okay|allowed|fine)\b|\binclude\s+spoilers?\b/i.test(prompt)) {
    return "allowed";
  }
  return "unknown";
}

function extractConstraints(payload: unknown, prompt: string): string[] {
  const explicit = normalizeStringList(isRecord(payload) ? payload.constraints : undefined);
  const inferred = [
    /\bsolo\b/i.test(prompt) ? "solo" : "",
    /\bbudget\b/i.test(prompt) ? "budget" : "",
    /\bno\s+DLC\b/i.test(prompt) ? "no DLC" : "",
    /\bbeginner\b/i.test(prompt) ? "beginner" : "",
    /\bPvP\b/i.test(prompt) ? "PvP" : "",
    /\bPvE\b/i.test(prompt) ? "PvE" : "",
  ].filter(Boolean);

  return Array.from(new Set([...explicit, ...inferred]));
}

function rawStringList(...candidates: Array<unknown>): string[] {
  const values: string[] = [];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim().length > 0) {
      values.push(candidate);
      continue;
    }

    if (!Array.isArray(candidate)) {
      continue;
    }

    for (const value of candidate) {
      if (typeof value === "string" && value.trim().length > 0) {
        values.push(value);
      }
    }
  }

  return values;
}

function firstUsefulLine(text: string): string {
  const line = text
    .split(/\r?\n/)
    .map((entry) => entry.trim())
    .find((entry) => entry.length > 0);

  if (!line) {
    return "Backend-supported guidance is available below.";
  }

  const cleanLine = line.replace(/^#+\s*/, "").trim();
  if (!cleanLine) {
    return "Backend-supported guidance is available below.";
  }

  return cleanLine.length > 220 ? `${cleanLine.slice(0, 217)}...` : cleanLine;
}

function spoilerWatchOut(spoilerTolerance: GamingSpoilerTolerance): string {
  if (spoilerTolerance === "avoid") {
    return "Spoilers: avoided by request; any unavoidable story detail should be marked before use.";
  }
  if (spoilerTolerance === "allowed") {
    return "Spoilers: allowed by request.";
  }
  return "Spoilers: not intentionally included; major story reveals are avoided unless necessary.";
}

function patchWatchOut(intent: GamingIntent): string {
  if (intent.mode === "meta") {
    return intent.version
      ? `Patch/version: using supplied context '${intent.version}'.`
      : "Patch/version: no patch or version was supplied, so treat current-state advice as patch-sensitive.";
  }

  if (intent.mode === "build" && !intent.version) {
    return "Patch/version: no patch or version was supplied; verify numbers and balance-sensitive details in-game.";
  }

  return "Context: adjust for your platform, patch, difficulty, and progression point when they differ.";
}

function buildContextLine(intent: GamingIntent): string {
  const parts = [
    intent.game ? `game=${intent.game}` : "",
    intent.platform ? `platform=${intent.platform}` : "",
    intent.version ? `version=${intent.version}` : "",
    intent.class ? `class=${intent.class}` : "",
    intent.role ? `role=${intent.role}` : "",
    intent.difficulty ? `difficulty=${intent.difficulty}` : "",
    intent.progressPoint ? `progress=${intent.progressPoint}` : "",
    intent.constraints.length > 0 ? `constraints=${intent.constraints.join(", ")}` : "",
  ].filter(Boolean);

  return parts.length > 0 ? `Context used: ${parts.join("; ")}.` : "Context used: prompt only.";
}

function hasComposedSections(response: string): boolean {
  return /\bQuick Answer\b/i.test(response) &&
    /\bWhy It Works\b/i.test(response) &&
    /\bWatch Outs\b/i.test(response);
}

function lowConfidenceNote(intent: GamingIntent): string | null {
  if (intent.confidence >= 0.6) {
    return null;
  }

  return `Routing confidence: low (${intent.confidence.toFixed(2)}). If this lands in the wrong mode, specify guide, build, or meta.`;
}

function fallbackBodyForMode(intent: GamingIntent): string {
  if (intent.mode === "build") {
    return [
      "Start with the role you need the build to perform, then prioritize core scaling stats, survivability, and one reliable damage or utility loop.",
      "Test changes in safe content before committing rare materials or ranked attempts.",
    ].join("\n");
  }

  if (intent.mode === "meta") {
    return [
      "Treat meta advice as patch-sensitive until verified against the current game version.",
      "Prefer flexible picks, builds, or team comps that remain useful when a matchup or balance assumption is wrong.",
    ].join("\n");
  }

  return [
    "Confirm the current objective, repair or upgrade gear, stock key consumables, and retry the next encounter while watching for repeatable mechanics.",
    "If progress stalls, lower the difficulty, level up, or narrow the request to the exact boss, quest, route, or checkpoint.",
  ].join("\n");
}

export const IntentRouterAgent = {
  classify(payload: unknown): GamingIntent {
    const prompt = extractPrompt(payload);
    const securityBlocked = detectSecurityBlock(payload, prompt);
    const rawMode = getStringField(payload, "mode");
    const explicitMode = resolveGamingMode(payload);
    const scoredIntent = scoreIntent(payload, prompt);
    const url = getRawStringField(payload, "url") ?? getRawStringField(payload, "guideUrl");
    const urls = rawStringList(isRecord(payload) ? payload.urls : undefined);
    const guideUrls = rawStringList(isRecord(payload) ? payload.guideUrls : undefined);
    const audit = getBooleanField(payload, "audit") ?? getBooleanField(payload, "enableAudit");
    const hrc = getBooleanField(payload, "hrc") ?? getBooleanField(payload, "enableHrc");
    const rawGame = getStringField(payload, "game");
    const rawPlatform = extractPlatform(payload, prompt);
    const rawVersion = extractVersion(payload, prompt);

    return {
      mode: scoredIntent.mode,
      prompt,
      confidence: scoredIntent.confidence,
      routingSignals: scoredIntent.signals,
      ...(rawMode && !explicitMode && !securityBlocked ? { invalidMode: rawMode } : {}),
      game: rawGame ? normalizeEntityValue(rawGame) : inferGameFromPrompt(prompt),
      platform: rawPlatform ? normalizeEntityValue(rawPlatform) : undefined,
      version: rawVersion ? normalizeEntityValue(rawVersion) : undefined,
      class: extractClass(payload, prompt),
      role: extractRole(payload, prompt),
      difficulty: extractDifficulty(payload, prompt),
      progressPoint: extractProgressPoint(payload, prompt),
      spoilerTolerance: extractSpoilerTolerance(payload, prompt),
      constraints: extractConstraints(payload, prompt),
      ...(url ? { url } : {}),
      ...(urls.length > 0 ? { urls } : {}),
      ...(guideUrls.length > 0 ? { guideUrls } : {}),
      ...(audit === true ? { audit: true } : {}),
      ...(hrc === true ? { hrc: true } : {}),
      ...(securityBlocked ? { securityBlocked } : {}),
    };
  },
};

export const ClarificationAgent = {
  evaluate(intent: GamingIntent): GamingClarificationResult {
    if (intent.mode !== "build" && intent.mode !== "meta") {
      return { required: false };
    }

    if (intent.game) {
      return { required: false };
    }

    return {
      required: true,
      mode: intent.mode,
      missing: ["game"],
      question: `Which game should I use for this ${intent.mode} request?`,
    };
  },
};

export const BackendQueryAgent = {
  build(intent: GamingIntent & { mode: GamingMode }): GamingBackendAction {
    const payload: GamingBackendActionPayload = {
      mode: intent.mode,
      prompt: intent.prompt,
    };

    if (intent.game) {
      payload.game = intent.game;
    }
    if (intent.url) {
      payload.url = intent.url;
    }
    if (intent.urls && intent.urls.length > 0) {
      payload.urls = intent.urls;
    }
    if (intent.guideUrls && intent.guideUrls.length > 0) {
      payload.guideUrls = intent.guideUrls;
    }
    if (intent.audit === true) {
      payload.audit = true;
    }
    if (intent.hrc === true) {
      payload.hrc = true;
    }

    return {
      action: "query",
      payload,
    };
  },

  async call(
    action: GamingBackendAction,
    connector: GamingBackendConnector
  ): Promise<GamingSuccessEnvelope | GamingErrorEnvelope> {
    return connector(action.payload);
  },
};

export const ResponseComposerAgent = {
  compose(params: {
    intent: GamingIntent & { mode: GamingMode };
    backendEnvelope: GamingSuccessEnvelope;
  }): GamingSuccessEnvelope {
    const { intent, backendEnvelope } = params;
    const backendResponse = backendEnvelope.data.response.trim();
    const response = hasComposedSections(backendResponse)
      ? [
          backendResponse,
          `- ${spoilerWatchOut(intent.spoilerTolerance)}`,
          `- ${patchWatchOut(intent)}`,
          ...(lowConfidenceNote(intent) ? [`- ${lowConfidenceNote(intent)}`] : []),
        ].join("\n")
      : [
          "Quick Answer",
          `Backend-supported: ${firstUsefulLine(backendResponse)}`,
          "",
          intent.mode === "build" ? "Build" : "Steps",
          backendResponse,
          "",
          "Why It Works",
          "Backend-supported: the guidance above came from the ARCANOS Gaming backend.",
          "Inference: ARCANOS Gaming added the section labels, summary line, and context cautions.",
          buildContextLine(intent),
          "",
          "Watch Outs",
          `- ${spoilerWatchOut(intent.spoilerTolerance)}`,
          `- ${patchWatchOut(intent)}`,
          ...(lowConfidenceNote(intent) ? [`- ${lowConfidenceNote(intent)}`] : []),
        ].join("\n");

    return {
      ...backendEnvelope,
      data: {
        ...backendEnvelope.data,
        response,
      },
    };
  },

  composeBackendFailureFallback(params: {
    intent: GamingIntent & { mode: GamingMode };
    error: unknown;
  }): GamingSuccessEnvelope {
    const { intent, error } = params;
    const fallback = fallbackBodyForMode(intent);
    const response = [
      "Quick Answer",
      "Backend-supported: none. The backend did not return usable guidance.",
      "",
      intent.mode === "build" ? "Build" : "Steps",
      "General Fallback (not backend-supported):",
      fallback,
      "",
      "Why It Works",
      "Backend-supported: none; this is a deterministic fallback because the backend call failed.",
      `Inference: fallback selected from request mode '${intent.mode}' and available prompt context.`,
      buildContextLine(intent),
      "",
      "Watch Outs",
      `- ${spoilerWatchOut(intent.spoilerTolerance)}`,
      `- ${patchWatchOut(intent)}`,
      ...(lowConfidenceNote(intent) ? [`- ${lowConfidenceNote(intent)}`] : []),
      `- Backend failure: ${resolveErrorMessage(error, "unknown backend failure")}`,
    ].join("\n");

    return formatGamingSuccess({
      mode: intent.mode,
      data: {
        response,
        sources: [],
      },
    });
  },
};
