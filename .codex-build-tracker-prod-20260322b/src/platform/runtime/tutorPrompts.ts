import type { ScholarlySource } from "@services/scholarlyFetcher.js";

export const DEFAULT_INTAKE_SYSTEM_PROMPT = 'ARCANOS Intake: Route to Tutor module.';

export const DEFAULT_REASONING_SYSTEM_PROMPT =
  'You are ARCANOS:TUTOR, a professional educator. Provide structured, learner-friendly guidance that builds understanding step by step.';

export const DEFAULT_AUDIT_SYSTEM_PROMPT =
  'ARCANOS Audit: Validate the tutoring response for accuracy, clarity, and pedagogical tone. Fix issues while preserving intent.';

export const RESEARCH_REASONING_PROMPT =
  'You are ARCANOS:TUTOR, an academic mentor. Synthesize the provided material into clear guidance with citations where possible.';

const RESEARCH_BRIEF_PROMPT_TEMPLATE =
  'Create a concise learning brief about {topic} using the numbered academic sources below. Cite them inline as [source #] and highlight key takeaways for students.\n\n{sources}';

const RESEARCH_FALLBACK_PROMPT_TEMPLATE =
  'No scholarly sources were located. Provide a credible overview of {topic} and recommend next steps for finding academic references.';

const GENERIC_TUTOR_PROMPT_TEMPLATE =
  'Process this request as a professional tutor. Respond with clear steps and checks for understanding. Input: {payload}';
const DIRECT_ANSWER_TUTOR_PROMPT_TEMPLATE =
  'Answer this request directly. Do not simulate, role-play, narrate hypothetical workflows, or invent missing context. If required information is missing, say so briefly. Request: {payload}';
const ANTI_SIMULATION_CUE_PATTERN =
  /\b(?:do\s+not|don't)\s+(?:simulate|role-?play|pretend)\b|\bhypothetical\s+run\b|\banswer\s+directly\b/i;

function readPromptLikePayloadValue(payload: unknown): string | undefined {
  if (!payload || typeof payload !== 'object') {
    return undefined;
  }

  for (const key of ['prompt', 'message', 'query', 'text', 'content', 'topic', 'entry', 'flow']) {
    const candidate = (payload as Record<string, unknown>)[key];
    if (typeof candidate === 'string' && candidate.trim().length > 0) {
      return candidate.trim();
    }
  }

  return undefined;
}

function hasAntiSimulationCue(prompt: string | undefined): boolean {
  return typeof prompt === 'string' && ANTI_SIMULATION_CUE_PATTERN.test(prompt);
}

export function formatScholarlySourcesList(sources: ScholarlySource[]): string {
  return sources
    .map((source, index) => `${index + 1}. ${source.title} (${source.year}) - ${source.journal}`)
    .join('\n');
}

export function buildResearchBriefPrompt(topic: string, sources: ScholarlySource[]): string {
  const list = formatScholarlySourcesList(sources);
  return RESEARCH_BRIEF_PROMPT_TEMPLATE.replace('{topic}', topic).replace('{sources}', list);
}

export function buildResearchFallbackPrompt(topic: string): string {
  return RESEARCH_FALLBACK_PROMPT_TEMPLATE.replace('{topic}', topic);
}

export function buildGenericTutorPrompt(payload: unknown): string {
  const promptLikeValue = readPromptLikePayloadValue(payload);
  //audit Assumption: generic tutor prompts should privilege direct operator text over opaque object dumps; failure risk: model receives `{}` or raw transport wrappers instead of the user request; expected invariant: the prompt body contains the clearest available natural-language request; handling strategy: prefer prompt-like fields and fall back to JSON serialization only when no text alias exists.
  const renderedPayload = promptLikeValue ?? JSON.stringify(payload);
  const promptTemplate = hasAntiSimulationCue(promptLikeValue)
    ? DIRECT_ANSWER_TUTOR_PROMPT_TEMPLATE
    : GENERIC_TUTOR_PROMPT_TEMPLATE;
  return promptTemplate.replace('{payload}', renderedPayload);
}
