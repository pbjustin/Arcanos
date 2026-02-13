import { Tier } from "./tierDetector";

export function buildReasoningConfig(tier: Tier) {
  if (tier === "simple") return undefined;

  return {
    effort: "high"
  };
}
