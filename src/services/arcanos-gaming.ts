import { runBuildPipeline, runGuidePipeline, runMetaPipeline } from "@services/gaming.js";
import { evaluateWithHRC } from "./hrcWrapper.js";
import {
  formatGamingError,
  type GamingErrorEnvelope,
  type GamingSuccessEnvelope,
  validateGamingRequest
} from "@services/gamingModes.js";

type GamingEnvelope = GamingSuccessEnvelope | GamingErrorEnvelope;

async function handleGamingRequest(payload: unknown): Promise<GamingEnvelope> {
  const validation = validateGamingRequest(payload);
  if (!validation.ok) {
    return validation.error;
  }

  const { mode, prompt, game, guideUrl, guideUrls, auditEnabled, hrcEnabled } = validation.value;

  let response =
    mode === "guide"
      ? await runGuidePipeline({ prompt, game, guideUrl, guideUrls, auditEnabled })
      : mode === "build"
      ? await runBuildPipeline({ prompt, game, guideUrl, guideUrls, auditEnabled })
      : await runMetaPipeline({ prompt, game, guideUrl, guideUrls, auditEnabled });

  if (!hrcEnabled) {
    return response;
  }

  try {
    const hrc = await evaluateWithHRC(response.data.response);
    return {
      ...response,
      data: {
        ...response.data,
        hrc
      }
    };
  } catch {
    return formatGamingError({
      mode,
      error: {
        code: "MODULE_ERROR",
        message: "HRC evaluation failed."
      }
    });
  }
}

export const ArcanosGaming = {
  name: "ARCANOS:GAMING",
  description: "Deterministic gameplay guide, build, and meta advisor.",
  gptIds: ["arcanos-gaming", "gaming"],
  defaultTimeoutMs: 60000,
  actions: {
    async query(payload: unknown) {
      return handleGamingRequest(payload);
    },
  },
};

export default ArcanosGaming;
