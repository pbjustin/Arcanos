import { runTrinityWritingPipeline } from "@core/logic/trinityWritingPipeline.js";
import { createRuntimeBudget } from "@platform/resilience/runtimeBudget.js";
import { getOpenAIClientOrAdapter } from "@services/openai/clientBridge.js";
import { generateMockResponse } from "@services/openai.js";
import { tryExtractExactLiteralPromptShortcut } from "@services/exactLiteralPromptShortcut.js";
import {
  formatGamingSuccess,
  type GamingSuccessEnvelope,
  type ValidatedGamingRequest
} from "@services/gamingModes.js";
import { buildGamingTrinityPrompt } from "@services/gamingPromptBuilder.js";
import {
  buildGamingWebContext,
  collectGamingGuideUrls
} from "@services/gamingWebContext.js";

export type GamingPipelineInput = Pick<
  ValidatedGamingRequest,
  "mode" | "prompt" | "game" | "guideUrl" | "guideUrls" | "auditEnabled"
>;

function stringifyMockResult(result: unknown): string {
  if (typeof result === "string") {
    return result;
  }

  if (result === null || result === undefined) {
    return "";
  }

  try {
    return JSON.stringify(result);
  } catch {
    return String(result);
  }
}

export async function runGameplayPipeline(params: GamingPipelineInput): Promise<GamingSuccessEnvelope> {
  const exactLiteralShortcut = tryExtractExactLiteralPromptShortcut(params.prompt);
  if (exactLiteralShortcut) {
    return formatGamingSuccess({
      mode: params.mode,
      data: {
        response: exactLiteralShortcut.literal,
        sources: []
      }
    });
  }

  const guideUrls = collectGamingGuideUrls(params);
  const { context: webContext, sources } = await buildGamingWebContext(guideUrls);
  const { client } = getOpenAIClientOrAdapter();

  if (!client) {
    const mock = generateMockResponse(params.prompt, params.mode);
    return formatGamingSuccess({
      mode: params.mode,
      data: {
        response: stringifyMockResult(mock.result),
        sources
      }
    });
  }

  const trinityResult = await runTrinityWritingPipeline({
    input: {
      prompt: buildGamingTrinityPrompt(params, webContext, guideUrls.length > 0),
      moduleId: "ARCANOS:GAMING",
      sourceEndpoint: `arcanos-gaming.${params.mode}`,
      requestedAction: "query",
      body: params,
      executionMode: "request"
    },
    context: {
      client,
      runtimeBudget: createRuntimeBudget(),
      runOptions: {
        answerMode: "direct",
        strictUserVisibleOutput: true
      }
    }
  });

  return formatGamingSuccess({
    mode: params.mode,
    data: {
      response: trinityResult.result,
      sources
    }
  });
}
