import { getPrompt } from "@platform/runtime/prompts.js";
import { runTrinityWritingPipeline } from '@core/logic/trinityWritingPipeline.js';
import { generateMockResponse } from "./openai.js";
import { fetchAndClean } from "@shared/webFetcher.js";
import { getOpenAIClientOrAdapter } from "./openai/clientBridge.js";
import { resolveErrorMessage } from "@core/lib/errors/index.js";
import { buildDirectAnswerModeSystemInstruction } from "@services/directAnswerMode.js";
import { tryExtractExactLiteralPromptShortcut } from "@services/exactLiteralPromptShortcut.js";
import { formatGamingSuccess, type GamingMode, type GamingSuccessEnvelope, type ValidatedGamingRequest } from "@services/gamingModes.js";
import { createRuntimeBudget } from '@platform/resilience/runtimeBudget.js';

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

function rewriteGuideDirectAnswerCues(prompt: string): string {
  return prompt
    .replace(/\b(?:answer|respond|reply)\s+directly\b/gi, 'give practical guidance')
    .replace(/\bjust\s+answer\b/gi, 'focus on the answer')
    .replace(/\b(?:do\s+not|don't)\s+simulate\b/gi, 'avoid gameplay reenactment')
    .replace(/\bno\s+simulation\b/gi, 'avoid gameplay reenactment')
    .replace(/\bwithout\s+simulation\b/gi, 'without gameplay reenactment')
    .replace(/\b(?:do\s+not|don't|no|without)\s+role-?play\b/gi, 'avoid roleplay framing')
    .replace(/\b(?:do\s+not|don't|no|without)\s+pretend\b/gi, 'avoid pretending to play')
    .replace(/\bno\s+hypothetical(?:\s+runs?)?\b/gi, 'avoid hypothetical run narration')
    .replace(/\bhypothetical\s+run\b(?!\s+narration)/gi, 'run narration')
    .trim();
}

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

function buildGameplayPrompt(params: GameplayPipelineInput, webContext: string, hadSources: boolean): string {
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

function buildGameplayRunOptions(mode: GamingMode) {
  if (mode === "guide") {
    return {
      answerMode: "explained" as const,
      requestedVerbosity: "detailed" as const,
      strictUserVisibleOutput: true
    };
  }

  return {
    answerMode: "direct" as const,
    strictUserVisibleOutput: true
  };
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
      prompt: [
        buildGameplaySystemPrompt(params.mode),
        '',
        enrichedPrompt,
        ...(params.auditEnabled ? ['', gamingPrompts.auditSystem] : [])
      ].join('\n'),
      moduleId: 'ARCANOS:GAMING',
      sourceEndpoint: `arcanos-gaming.${params.mode}`,
      requestedAction: 'query',
      body: params,
      executionMode: 'request'
    },
    context: {
      client,
      runtimeBudget: createRuntimeBudget(),
      runOptions: buildGameplayRunOptions(params.mode)
    }
  });
  const finalized = trinityResult.result;

  if (!params.auditEnabled) {
    return formatGamingSuccess({
      mode: params.mode,
      data: {
        response: finalized,
        sources
      }
    });
  }

  return formatGamingSuccess({
    mode: params.mode,
    data: {
      response: finalized,
      sources
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
