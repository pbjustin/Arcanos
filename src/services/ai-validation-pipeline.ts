import { getUnifiedOpenAI, type ChatMessage } from './unified-openai.js';
import { runDeepResearch } from '../modules/deepResearchHandler.js';
import { webFetchHandler } from '../handlers/webFetchHandler.js';

export interface ValidationAudit {
  contextBlock?: string;
  hrc: { confidence: number; issues: string[] };
  clear: { clarity: number; leverage: number; efficiency: number; alignment: number; resilience: number; notes?: string };
}

export interface ValidationResult {
  output: string;
  audit: ValidationAudit;
  flagged: boolean;
}

export async function runValidationPipeline(query: string): Promise<ValidationResult> {
  const openai = getUnifiedOpenAI(); // [AI-PATCH: RAG+HRC+CLEAR]

  let contextBlock = '';

  // RAG: external context retrieval
  if (query.includes('web:')) {
    const clean = query.replace(/web:/i, '').trim();
    const web = await webFetchHandler(clean, {}); // [AI-PATCH: RAG+HRC+CLEAR]
    if (web?.summary) {
      contextBlock += `Web Search:\n${web.summary}\n`;
    }
  }
  if (query.includes('deep:')) {
    const clean = query.replace(/deep:/i, '').trim();
    const deep = await runDeepResearch(clean, {}); // [AI-PATCH: RAG+HRC+CLEAR]
    contextBlock += 'Deep Research:\n' + Object.values(deep).join('\n') + '\n';
  }

  const messages: ChatMessage[] = [];
  if (contextBlock) {
    messages.push({ role: 'system', content: `Context block:\n${contextBlock}` }); // [AI-PATCH: RAG+HRC+CLEAR]
  }
  messages.push({ role: 'user', content: query }); // [AI-PATCH: RAG+HRC+CLEAR]

  const model = process.env.USE_FT_MODEL ? 'REDACTED_FINE_TUNED_MODEL_ID' : 'gpt-4';

  const draft = await openai.chat(messages, { model, temperature: 0.7 });
  const draftResponse = draft.success ? draft.content : `Model error: ${draft.error}`;

  // HRC: hallucination resistance check
  let hrc = { confidence: 1, issues: [] as string[] };
  try {
    const hrcEval = await openai.chat(
      [
        {
          role: 'system',
          content:
            'Analyze the following response for contradictions, hallucinations, or unverifiable claims. Return JSON {"confidence": number, "issues": string[]}.',
        },
        { role: 'user', content: draftResponse },
      ],
      { model: 'gpt-4', temperature: 0, responseFormat: { type: 'json_object' } }
    );
    if (hrcEval.success) {
      hrc = JSON.parse(hrcEval.content);
    }
  } catch (err) {
    console.warn('HRC analysis failed', err);
  }

  const flagged = (hrc.confidence ?? 0) < 0.65; // [AI-PATCH: RAG+HRC+CLEAR]
  let finalOutput = draftResponse;
  if (flagged) {
    finalOutput = '⚠️ Response could not be validated with high confidence.'; // [AI-PATCH: RAG+HRC+CLEAR]
  }

  // CLEAR 2.0 audit layer
  let clear = {
    clarity: 0,
    leverage: 0,
    efficiency: 0,
    alignment: 0,
    resilience: 0,
    notes: '',
  };
  try {
    const clearEval = await openai.chat(
      [
        {
          role: 'system',
          content:
            'Score the following text on Clarity, Leverage, Efficiency, Alignment, and Resilience (CLEAR 2.0). Return JSON with those numeric fields and optional notes.',
        },
        { role: 'user', content: draftResponse },
      ],
      { model: 'gpt-4', temperature: 0, responseFormat: { type: 'json_object' } }
    );
    if (clearEval.success) {
      clear = JSON.parse(clearEval.content);
    }
  } catch (err) {
    console.warn('CLEAR audit failed', err);
  }

  const audit: ValidationAudit = { contextBlock, hrc, clear }; // [AI-PATCH: RAG+HRC+CLEAR]
  return { output: finalOutput, audit, flagged }; // [AI-PATCH: RAG+HRC+CLEAR]
}
