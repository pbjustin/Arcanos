import { getPrompt } from "@platform/runtime/prompts.js";
import {
  buildGamingPrompt as buildGamingPromptCore,
  buildGamingTrinityPrompt as buildGamingTrinityPromptCore,
  type GamingPromptInput,
  type GamingPromptResources
} from "@shared/gaming/gamingPromptCore.js";

export { buildGamingSystemPrompt } from "@shared/gaming/gamingPromptCore.js";
export type { GamingPromptInput } from "@shared/gaming/gamingPromptCore.js";

const gamingPrompts: GamingPromptResources = {
  webUncertaintyGuidance: getPrompt("gaming", "web_uncertainty_guidance"),
  webContextInstruction: getPrompt("gaming", "web_context_instruction"),
  auditSystem: getPrompt("gaming", "audit_system")
};

/** Build the Gaming request prompt with the configured production prompt resources. */
export function buildGamingPrompt(
  params: GamingPromptInput,
  webContext: string,
  hadSources: boolean,
  hasUsableSources: boolean
): string {
  return buildGamingPromptCore(params, webContext, hadSources, hasUsableSources, gamingPrompts);
}

/** Build the complete Trinity prompt with the configured production prompt resources. */
export function buildGamingTrinityPrompt(
  params: GamingPromptInput,
  webContext: string,
  hadSources: boolean,
  hasUsableSources: boolean
): string {
  return buildGamingTrinityPromptCore(params, webContext, hadSources, hasUsableSources, gamingPrompts);
}
