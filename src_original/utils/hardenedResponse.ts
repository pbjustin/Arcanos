import OpenAI from 'openai';

const client = new OpenAI();

function sanitizeText(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

export function prepareRAGContext(webData: { summary: string }): string {
  const summary = sanitizeText(webData.summary);
  return `\n\n[CONTEXT BLOCK - Internet Source]\n${summary}\n\nONLY use facts from this block. DO NOT speculate, fabricate, or assume.`;
}

export async function generateDraft(query: string, webData: { summary: string }): Promise<string> {
  const contextBlock = prepareRAGContext(webData);
  const prompt = `${query}\n${contextBlock}`;
  const response = await client.responses.create({ model: "gpt-4.1-mini", input: prompt });
  return response.output_text || '';
}

interface HRCResult {
  confidence: number;
  hallucinationDetected: boolean;
}

function extractFacts(summary: string): string[] {
  return summary
    .split(/[\.\n]+/)
    .map((f) => f.trim())
    .filter(Boolean);
}

export function validateWithHRC(draft: string, summary: string): HRCResult {
  const facts = extractFacts(summary);
  const matches = facts.filter((f) => draft.includes(f));
  const confidence = facts.length ? matches.length / facts.length : 1;
  const hallucinationDetected = matches.length !== facts.length;
  return { confidence, hallucinationDetected };
}

interface CLEARAudit {
  clarity: number;
  alignment: boolean;
  resilience: number;
}

function scoreCLEAR(draft: string): CLEARAudit {
  const sentences = draft.split(/[.!?]+/).filter(Boolean);
  const avgLength =
    sentences.reduce((sum, s) => sum + s.split(/\s+/).length, 0) /
    (sentences.length || 1);
  const clarity = avgLength > 30 ? 0.5 : 0.95;
  const alignment = !/unethical|illegal/i.test(draft);
  const resilience = 0.95;
  return { clarity, alignment, resilience };
}

export function passCLEAR(draft: string): boolean {
  const audit = scoreCLEAR(draft);
  return (
    audit.clarity >= 0.85 &&
    audit.alignment === true &&
    audit.resilience >= 0.9
  );
}

export async function hardenedInternetResponse(query: string, webData: { summary: string }) {
  const draft = await generateDraft(query, webData);
  const { confidence, hallucinationDetected } = validateWithHRC(
    draft,
    webData.summary
  );

  if (confidence < 0.9 || hallucinationDetected || !passCLEAR(draft)) {
    return {
      output:
        '⚠️ Unable to confidently generate a verified response from current internet data.',
      meta: {
        blocked: true,
        reason: 'HRC or CLEAR failure',
        source: 'internet',
      },
    };
  }

  return {
    output: draft,
    meta: {
      blocked: false,
      verified: true,
      source: 'internet',
      confidence,
    },
  };
}

