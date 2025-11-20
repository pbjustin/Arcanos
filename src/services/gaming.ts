import { getOpenAIClient, getDefaultModel, getGPT5Model, generateMockResponse } from './openai.js';
import { fetchAndClean } from './webFetcher.js';

const FINETUNE_MODEL = process.env.FINETUNE_MODEL || getDefaultModel();

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
      const message = error instanceof Error ? error.message : 'Unknown fetch error';
      sources.push({ url, error: message });
    }
  }

  const context = sources
    .filter((source) => Boolean(source.snippet))
    .map((source, index) => `[Source ${index + 1}] ${source.url}\n${source.snippet}`)
    .join('\n\n');

  return { context, sources };
}

const WEB_UNCERTAINTY_GUIDANCE =
  'If you are unsure about mechanics, progression steps, or patch-specific details, ask for a guide URL so the ARCANOS web fetcher can pull the latest info instead of guessing.';

export async function runGaming(userPrompt: string, guideUrl?: string, guideUrls: string[] = []) {
  const openai = getOpenAIClient();
  if (!openai) {
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

    let enrichedPrompt = `${userPrompt}\n\n[WEB CONTEXT]\n${noWebContextNote}\n\n${WEB_UNCERTAINTY_GUIDANCE}`;

    if (webContext) {
      enrichedPrompt = `${userPrompt}\n\n[WEB CONTEXT]\n${webContext}\n\nUse the sources above to keep recommendations current. If the sources do not mention the requested details, say so and ask for a guide URL to fetch rather than guessing.`;
    }

    // Step 1: Fine-tuned ARCANOS Intake
    const intake = await openai.chat.completions.create({
      model: FINETUNE_MODEL,
      messages: [
        { role: 'system', content: 'ARCANOS Intake: Route to Gaming module.' },
        { role: 'user', content: enrichedPrompt }
      ]
    });
    const refinedPrompt = intake.choices[0].message?.content || '';

    // Step 2: GPT-5.1 Reasoning (Hotline Advisor Mode)
    const gpt5 = await openai.chat.completions.create({
      model: getGPT5Model(),
      messages: [
        {
          role: 'system',
          content:
            'You are ARCANOS:GAMING, a Nintendo-style hotline advisor. Provide strategies, hints, tips, and walkthroughs. Speak like a professional hotline guide: friendly, knowledgeable, and interactive.'
        },
        { role: 'user', content: refinedPrompt }
      ],
      temperature: 0.6
    });
    const reasoningOutput = gpt5.choices[0].message?.content || '';

    // Step 3: Fine-tuned ARCANOS Audit
    const audit = await openai.chat.completions.create({
      model: FINETUNE_MODEL,
      messages: [
        { role: 'system', content: 'ARCANOS Audit: Validate Gaming module response for clarity, safety, and alignment.' },
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
