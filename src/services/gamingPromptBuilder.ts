import { getPrompt } from "@platform/runtime/prompts.js";
import { buildDirectAnswerModeSystemInstruction } from "@services/directAnswerMode.js";
import type { GamingMode, ValidatedGamingRequest } from "@services/gamingModes.js";

export type GamingPromptInput = Pick<
  ValidatedGamingRequest,
  "mode" | "prompt" | "game" | "auditEnabled"
>;

const gamingPrompts = {
  webUncertaintyGuidance: getPrompt("gaming", "web_uncertainty_guidance"),
  webContextInstruction: getPrompt("gaming", "web_context_instruction"),
  auditSystem: getPrompt("gaming", "audit_system")
};

const modeInstructions: Record<GamingMode, string> = {
  guide: "Return a practical guide with concrete steps, checkpoints, and missing-info notes instead of simulation.",
  build: "Return a build recommendation with priorities, tradeoffs, and setup guidance. Do not invent patch details.",
  meta: "Return a meta overview with current assumptions, tradeoffs, counters, and explicit uncertainty when patch/version context is missing."
};

function rewriteGuideDirectAnswerCues(prompt: string): string {
  return prompt
    .replace(/\b(?:answer|respond|reply)\s+directly\b/gi, "give practical guidance")
    .replace(/\bjust\s+answer\b/gi, "focus on the answer")
    .replace(/\b(?:do\s+not|don't)\s+simulate\b/gi, "avoid gameplay reenactment")
    .replace(/\bno\s+simulation\b/gi, "avoid gameplay reenactment")
    .replace(/\bwithout\s+simulation\b/gi, "without gameplay reenactment")
    .replace(/\b(?:do\s+not|don't|no|without)\s+role-?play\b/gi, "avoid roleplay framing")
    .replace(/\b(?:do\s+not|don't|no|without)\s+pretend\b/gi, "avoid pretending to play")
    .replace(/\bno\s+hypothetical(?:\s+runs?)?\b/gi, "avoid hypothetical run narration")
    .replace(/\bhypothetical\s+run\b(?!\s+narration)/gi, "run narration")
    .trim();
}

export function buildGamingSystemPrompt(mode: GamingMode): string {
  if (mode === "guide") {
    return [
      "You are ARCANOS:GAMING:GUIDE.",
      modeInstructions.guide,
      "Give concrete guidance with enough structure to complete the requested guide.",
      "Avoid gameplay reenactment, roleplay framing, invented live patch details, hotline banter, and theatrical framing.",
      "If the user requests an exact literal response, return only that literal.",
      "State missing game, platform, class, or version details plainly instead of guessing."
    ].join(" ");
  }

  return buildDirectAnswerModeSystemInstruction({
    moduleLabel: `ARCANOS:GAMING:${mode.toUpperCase()}`,
    domainGuidance: modeInstructions[mode],
    prohibitedBehaviors: [
      "simulate gameplay",
      "role-play a match or run",
      "invent live patch notes",
      "add hotline banter or theatrical framing"
    ],
    missingInfoBehavior: "State missing game, platform, class, or version details plainly instead of guessing."
  });
}

export function buildGamingPrompt(
  params: GamingPromptInput,
  webContext: string,
  hadSources: boolean
): string {
  const modeLabel = `[MODE]\n${params.mode}`;
  const gameLabel = params.game ? `\n\n[GAME]\n${params.game}` : "";
  const requestPrompt = params.mode === "guide" ? rewriteGuideDirectAnswerCues(params.prompt) : params.prompt;
  const webLabel = webContext
    ? `\n\n[WEB CONTEXT]\n${webContext}\n\n${gamingPrompts.webContextInstruction}`
    : hadSources
    ? `\n\n[WEB CONTEXT]\nGuides were provided but no usable snippets were retrieved.\n\n${gamingPrompts.webUncertaintyGuidance}`
    : "";

  return `${modeLabel}${gameLabel}\n\n[REQUEST]\n${requestPrompt}${webLabel}`;
}

export function buildGamingTrinityPrompt(
  params: GamingPromptInput,
  webContext: string,
  hadSources: boolean
): string {
  return [
    buildGamingSystemPrompt(params.mode),
    "",
    buildGamingPrompt(params, webContext, hadSources),
    ...(params.auditEnabled ? ["", gamingPrompts.auditSystem] : [])
  ].join("\n");
}
