import { getPrompt } from "@platform/runtime/prompts.js";
import { getDefaultModel, getGPT5Model, generateMockResponse } from "./openai.js";
import { fetchAndClean } from "@shared/webFetcher.js";
import { getOpenAIClientOrAdapter } from "./openai/clientBridge.js";
import { getEnv } from "@platform/runtime/env.js";
import { resolveErrorMessage } from "@core/lib/errors/index.js";
import { buildDirectAnswerModeSystemInstruction } from "@services/directAnswerMode.js";
import { tryExtractExactLiteralPromptShortcut } from "@services/exactLiteralPromptShortcut.js";
import { formatGamingSuccess, type GamingMode, type GamingSuccessEnvelope, type ValidatedGamingRequest } from "@services/gamingModes.js";

const FINETUNE_MODEL = getEnv("FINETUNE_MODEL") || getDefaultModel();

type WebSource = GamingSuccessEnvelope["data"]["sources"][number];

type GameplayPipelineInput = Pick<
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

async function buildWebContext(urls: string[]): Promise<{ context: string; sources: WebSource[] }> {
  if (urls.length === 0) {
    return { context: "", sources: [] };
  }

  const uniqueUrls = Array.from(new Set(urls));
  const sources: WebSource[] = [];

  for (const url of uniqueUrls) {
    try {
      const snippet = await fetchAndClean(url, 5000);
      sources.push({ url, snippet });
    } catch (error) {
      sources.push({ url, error: resolveErrorMessage(error, "Unknown fetch error") });
    }
  }

  const context = sources
    .filter((source) => Boolean(source.snippet))
    .map((source, index) => `[Source ${index + 1}] ${source.url}\n${source.snippet}`)
    .join("\n\n");

  return { context, sources };
}

function buildGameplaySystemPrompt(mode: GamingMode): string {
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

function buildGameplayPrompt(params: GameplayPipelineInput, webContext: string, hadSources: boolean): string {
  const modeLabel = `[MODE]\n${params.mode}`;
  const gameLabel = params.game ? `\n\n[GAME]\n${params.game}` : "";
  const webLabel = webContext
    ? `\n\n[WEB CONTEXT]\n${webContext}\n\n${gamingPrompts.webContextInstruction}`
    : hadSources
    ? `\n\n[WEB CONTEXT]\nGuides were provided but no usable snippets were retrieved.\n\n${gamingPrompts.webUncertaintyGuidance}`
    : "";

  return `${modeLabel}${gameLabel}\n\n[REQUEST]\n${params.prompt}${webLabel}`;
}

async function runGameplayPipeline(params: GameplayPipelineInput): Promise<GamingSuccessEnvelope> {
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

  const allUrls = [
    ...(params.guideUrl ? [params.guideUrl] : []),
    ...params.guideUrls
  ];
  const { context: webContext, sources } = await buildWebContext(allUrls);
  const enrichedPrompt = buildGameplayPrompt(params, webContext, allUrls.length > 0);
  const { adapter } = getOpenAIClientOrAdapter();

  if (!adapter) {
    const mock = generateMockResponse(params.prompt, params.mode);
    return formatGamingSuccess({
      mode: params.mode,
      data: {
        response: stringifyMockResult(mock.result),
        sources
      }
    });
  }

  const draftResponse = await adapter.responses.create({
    model: getGPT5Model(),
    messages: [
      { role: "system", content: buildGameplaySystemPrompt(params.mode) },
      { role: "user", content: enrichedPrompt }
    ],
    temperature: 0.2
  });
  const draft = draftResponse.choices[0].message?.content || "";

  if (!params.auditEnabled) {
    return formatGamingSuccess({
      mode: params.mode,
      data: {
        response: draft,
        sources
      }
    });
  }

  const auditResponse = await adapter.responses.create({
    model: FINETUNE_MODEL,
    messages: [
      { role: "system", content: gamingPrompts.auditSystem },
      { role: "user", content: draft }
    ]
  });
  const finalized = auditResponse.choices[0].message?.content || draft;

  return formatGamingSuccess({
    mode: params.mode,
    data: {
      response: finalized,
      sources,
      auditTrace: {
        draft,
        finalized
      }
    }
  });
}

export async function runGuidePipeline(params: Omit<GameplayPipelineInput, "mode">): Promise<GamingSuccessEnvelope> {
  return runGameplayPipeline({ ...params, mode: "guide" });
}

export async function runBuildPipeline(params: Omit<GameplayPipelineInput, "mode">): Promise<GamingSuccessEnvelope> {
  return runGameplayPipeline({ ...params, mode: "build" });
}

export async function runMetaPipeline(params: Omit<GameplayPipelineInput, "mode">): Promise<GamingSuccessEnvelope> {
  return runGameplayPipeline({ ...params, mode: "meta" });
}
