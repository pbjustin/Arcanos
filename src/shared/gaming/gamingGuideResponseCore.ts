import type { GamingMode, GamingSuccessEnvelope } from "@services/gamingModes.js";

/** Return the trimmed grounded guide, or null when the legacy composer must handle it. */
export function composeGroundedGamingGuideResponse(
  mode: GamingMode,
  backendEnvelope: GamingSuccessEnvelope
): GamingSuccessEnvelope | null {
  if (
    mode !== "guide" ||
    backendEnvelope.data.grounding?.groundingStatus !== "grounded" ||
    backendEnvelope.data.fallbackReason
  ) {
    return null;
  }

  return {
    ...backendEnvelope,
    data: {
      ...backendEnvelope.data,
      response: backendEnvelope.data.response.trim(),
    },
  };
}
