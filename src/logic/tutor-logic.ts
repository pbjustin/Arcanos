import { callOpenAI, getDefaultModel } from '../services/openai.js';
import { fetchAndClean } from '../services/webFetcher.js';

const DEFAULT_TOKEN_LIMIT = parseInt(process.env.TUTOR_DEFAULT_TOKEN_LIMIT ?? '200', 10);

const credibleHosts = new Set([
  'nature.com',
  'science.org',
  'sciencedirect.com',
  'jstor.org',
  'ieeexplore.ieee.org',
  'ncbi.nlm.nih.gov',
]);

function isCredibleSource(url: string) {
  try {
    const { hostname } = new URL(url);
    const tldCredible =
      hostname.endsWith('.edu') ||
      hostname.endsWith('.ac.uk') ||
      hostname.endsWith('.gov');
    return tldCredible || credibleHosts.has(hostname);
  } catch {
    return false;
  }
}

export interface TutorQuery {
  intent?: string;
  domain?: string;
  module?: string;
  payload?: any;
  sourceUrl?: string;
}

// ---- Pattern Registry (Domains + Modular Instruction) ----
function appendReference(prompt: string, ref?: string) {
  return ref ? `${prompt}\n\nReference:\n${ref}` : prompt;
}

const patterns: Record<string, { id: string; modules: Record<string, (payload: any) => Promise<any> > }> = {
  memory: {
    id: 'pattern_1756454042132',
    modules: {
      explain: async (payload) =>
        await chatWithOpenAI(
          appendReference(`Explain memory logic for: ${payload.topic}`, payload.referenceText)
        ),
      audit: async (payload) =>
        await chatWithOpenAI(
          appendReference(`Audit memory entry: ${payload.entry}`, payload.referenceText)
        ),
    },
  },
  logic: {
    id: 'pattern_1756453493854',
    modules: {
      clarify: async (payload) =>
        await chatWithOpenAI(
          appendReference(`Clarify logic flow: ${payload.flow}`, payload.referenceText)
        ),
    },
  },
  default: {
    id: 'universal_fallback',
    modules: {
      generic: async (payload) =>
        await chatWithOpenAI(
          appendReference(
            `Process generic request as a professional tutor: ${JSON.stringify(payload)}`,
            payload.referenceText
          )
        ),
    },
  },
};

// ---- Helper: OpenAI Chat Wrapper ----
async function chatWithOpenAI(prompt: string, schema: { tokenLimit?: number } = {}) {
  const model = getDefaultModel();
  const limit = schema.tokenLimit ?? DEFAULT_TOKEN_LIMIT;
  try {
    const { output } = await callOpenAI(model, prompt, limit);
    return output;
  } catch (error) {
    console.error('chatWithOpenAI error:', error);
    throw new Error('Tutor query failed');
  }
}

// ---- Core Tutor Handler ----
export async function handleTutorQuery(query: TutorQuery) {
  const audit = {
    received_at: new Date().toISOString(),
    intent_clarified: query.intent || 'Unclear',
    domain_bound: null as string | null,
    instruction_module: null as string | null,
    pattern_ref: null as string | null,
    fallback_invoked: false,
  };

  if (query.sourceUrl) {
    if (isCredibleSource(query.sourceUrl)) {
      try {
        const referenceText = await fetchAndClean(query.sourceUrl);
        query.payload = { ...query.payload, referenceText };
      } catch (err) {
        console.error(`Failed to fetch reference from ${query.sourceUrl}:`, err);
      }
    } else {
      console.warn(`Skipping non-credible source: ${query.sourceUrl}`);
    }
  }

  // 1. Dynamic Schema Binding
  const domain = patterns[query.domain ?? ''] ? (query.domain as string) : 'default';
  audit.domain_bound = domain;

  // 2. Modular Instruction Engine
  const moduleFn =
    patterns[domain]?.modules[query.module ?? ''] || patterns.default.modules.generic;
  audit.instruction_module = query.module || 'generic';

  // 3. Pattern Reference Linking
  audit.pattern_ref = patterns[domain]?.id || 'untracked';

  // 4. Fallback Handling
  let result;
  try {
    result = await moduleFn(query.payload || {});
  } catch {
    result = { redirected_to: 'ARCANOS:RESEARCH' };
    audit.fallback_invoked = true;
  }

  // 5. Return Tutor Output with Audit
  return {
    arcanos_tutor: result,
    audit_trace: audit,
  };
}

// Backwards-compatible dispatcher used by module wrapper
export async function dispatch(payload: TutorQuery) {
  return handleTutorQuery(payload);
}

export default {
  dispatch,
  handleTutorQuery,
};

