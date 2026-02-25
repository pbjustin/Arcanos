import { getPrompt } from "@platform/runtime/prompts.js";
import { getDefaultModel, getGPT5Model, generateMockResponse } from './openai.js';
import { fetchAndClean } from "@shared/webFetcher.js";
import { getOpenAIClientOrAdapter } from './openai/clientBridge.js';
import { getEnv } from "@platform/runtime/env.js";
import { resolveErrorMessage } from "@core/lib/errors/index.js";

// Use config layer for env access (adapter boundary pattern)
const FINETUNE_MODEL = getEnv('FINETUNE_MODEL') || getDefaultModel();

type WebSource = {
  url: string;
  snippet?: string;
  error?: string;
};

async function buildWebContext(urls: string[]): Promise<{ context: string; sources: WebSource[] }> {
  if (urls.length === 0) {
    return { context: '', sources: [] };
  }

  const uniqueUrls = Array.from(new Set(urls));
  const sources: WebSource[] = [];

  for (const url of uniqueUrls) {
    try {
      const snippet = await fetchAndClean(url, 5000);
      sources.push({ url, snippet });
    } catch (error) {
      const message = resolveErrorMessage(error, 'Unknown fetch error');
      sources.push({ url, error: message });
    }
  }

  const context = sources
    .filter((source) => Boolean(source.snippet))
    .map((source, index) => `[Source ${index + 1}] ${source.url}\n${source.snippet}`)
    .join('\n\n');

  return { context, sources };
}

const gamingPrompts = {
  hotlineSystem: getPrompt('gaming', 'hotline_system'),
  webUncertaintyGuidance: getPrompt('gaming', 'web_uncertainty_guidance'),
  webContextInstruction: getPrompt('gaming', 'web_context_instruction'),
  intakeSystem: getPrompt('gaming', 'intake_system'),
  auditSystem: getPrompt('gaming', 'audit_system')
};

export async function runGaming(userPrompt: string, guideUrl?: string, guideUrls: string[] = []) {
  const { adapter } = getOpenAIClientOrAdapter();
  if (!adapter) {
    const mock = generateMockResponse(userPrompt, 'guide');
    return {
      gaming_response: mock.result,
      audit_trace: {
        intake: '[MOCK] Intake step not executed',
        reasoning: '[MOCK] Reasoning step not executed',
        finalized: mock.result
      },
      sources: []
    };
  }
  try {
    // Optionally enrich the prompt with a fetched guide
    const allUrls = [];
    if (guideUrl) {
      allUrls.push(guideUrl);
    }
    if (Array.isArray(guideUrls) && guideUrls.length > 0) {
      allUrls.push(...guideUrls);
    }

    const { context: webContext, sources } = await buildWebContext(allUrls);

    const noWebContextNote = allUrls.length > 0
      ? 'Guides were requested but no usable snippets were retrieved.'
      : 'No live sources were provided.';

    let enrichedPrompt = `${userPrompt}\n\n[WEB CONTEXT]\n${noWebContextNote}\n\n${gamingPrompts.webUncertaintyGuidance}`;

    if (webContext) {
      enrichedPrompt = `${userPrompt}\n\n[WEB CONTEXT]\n${webContext}\n\n${gamingPrompts.webContextInstruction}`;
    }

    // Step 1: Fine-tuned ARCANOS Intake
    const intake = await adapter.responses.create({
      model: FINETUNE_MODEL,
      messages: [
        { role: 'system', content: gamingPrompts.intakeSystem },
        { role: 'user', content: enrichedPrompt }
      ]
    });
    const refinedPrompt = intake.choices[0].message?.content || '';

    // Step 2: GPT-5.1 Reasoning (Hotline Advisor Mode)
    const gpt5 = await adapter.responses.create({
      model: getGPT5Model(),
      messages: [
        {
          role: 'system',
          content: gamingPrompts.hotlineSystem
        },
        { role: 'user', content: refinedPrompt }
      ],
      temperature: 0.6
    });
    const reasoningOutput = gpt5.choices[0].message?.content || '';

    // Step 3: Fine-tuned ARCANOS Audit
    const audit = await adapter.responses.create({
      model: FINETUNE_MODEL,
      messages: [
        { role: 'system', content: gamingPrompts.auditSystem },
        { role: 'user', content: reasoningOutput }
      ]
    });

    const finalized = audit.choices[0].message?.content || '';

    return {
      gaming_response: finalized,
      audit_trace: {
        intake: refinedPrompt,
        reasoning: reasoningOutput,
        finalized
      },
      sources
    };
  } catch (err) {
    console.error('❌ ARCANOS:GAMING Error:', err);
    throw err;
  }
}
